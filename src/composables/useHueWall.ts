/**
 * 媒体库「色相墙」的取色与重排（G-B01）。
 *
 * 三件事：把已缓存的海报主色读出来（`peekPalette`，只读缓存不联网）、按色相环重排、
 * 按色相窗收拢。排序是**视图层的变换**——`libraryStore` 里的数据顺序一个字都不动，
 * 关掉色相模式就回到原样，滚动位置也因此天然保留。
 *
 * 网络上刻意保守：
 * - 整墙先只做 IndexedDB 读（几十次本地读，代价可忽略）；
 * - 只有「从没取过色」的海报才补取，且每轮最多 `HUE_PROBE_BATCH` 张——翻页才会带进新的
 *   候选，所以补取量跟着用户真正看到的行数走，而不是整库；
 * - 灰调海报有负记录，不会被反复解码。
 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';

import { paletteForPoster, peekPalette } from '@/services/paletteService';
import type { MediaItem } from '@/types';

/** 色相窗宽预设：半宽角度，360 = 不收拢（只重排） */
export const HUE_WINDOWS: { value: string; label: string }[] = [
  { value: '30', label: '窄' },
  { value: '60', label: '中' },
  { value: '120', label: '宽' },
  { value: '360', label: '全部' },
];

export const HUE_WINDOW_DEFAULT = 60;
/** 每轮最多补取几张海报 */
export const HUE_PROBE_BATCH = 12;
/** 补取并发：这是顺带工作，不该和海报图本身抢带宽 */
const HUE_PROBE_CONCURRENCY = 2;
/**
 * 补取结果攒批提交的窗口。逐张落地会让整墙每张新取到色的海报都重排一次，
 * FLIP 于是连续触发；攒一批只排一次位移，代价是海报晚 220ms 归位（判收口径 300ms）。
 */
const HUE_FLUSH_MS = 220;

/** 色相是环，距离要取两头里近的那一头 */
export function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

export interface HueWallOptions {
  /** 是否处于色相模式；关掉后不再取色 */
  enabled: () => boolean;
  /** 色相窗中心（0~360） */
  center: Ref<number>;
  /** 色相窗半宽（0~360，360 = 全部） */
  window: Ref<number>;
}

export interface HueWallStats {
  /** 命中色相窗 */
  hit: number;
  /** 有主色但在窗外 */
  outside: number;
  /** 还没有主色（未取色 / 灰调 / 无海报） */
  unknown: number;
  /** 正在补取的海报数 */
  probing: number;
}

export function useHueWall(source: () => MediaItem[], options: HueWallOptions) {
  /** url → 主色角度；`null` = 判定过没有主色（灰调或无图），缺席 = 还不知道 */
  const hueByUrl = ref(new Map<string, number | null>());
  /** 已经发起过缓存查询的 url，避免每次列表变化都重读一遍 */
  const checked = new Set<string>();
  const probing = ref(0);

  let queue: string[] = [];
  let running = 0;
  /** 关闭模式即作废在飞结果：不该在用户退出后还往墙上改排序 */
  let epoch = 0;
  /** 补取结果先攒在这里，到点一次性写进 `hueByUrl`（见 `HUE_FLUSH_MS`） */
  const pending = new Map<string, number | null>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPending(): void {
    flushTimer = null;
    for (const [url, hue] of pending) hueByUrl.value.set(url, hue);
    pending.clear();
  }

  function commitHue(url: string, hue: number | null): void {
    pending.set(url, hue);
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flushPending, HUE_FLUSH_MS);
  }

  function hueOf(item: MediaItem): number | null | undefined {
    const url = item.posterUrl;
    return url ? hueByUrl.value.get(url) : undefined;
  }

  const wall = computed((): { items: MediaItem[]; hit: number; outside: number; unknown: number } => {
    const items = source();
    if (!options.enabled()) return { items, hit: 0, outside: 0, unknown: 0 };

    const half = options.window.value;
    const center = options.center.value;
    const hits: MediaItem[] = [];
    const outside: MediaItem[] = [];
    const unknown: MediaItem[] = [];
    for (const item of items) {
      const hue = hueOf(item);
      if (hue === undefined || hue === null) {
        unknown.push(item);
      } else if (half >= 360 || hueDistance(hue, center) <= half) {
        hits.push(item);
      } else {
        outside.push(item);
      }
    }
    const byHue = (a: MediaItem, b: MediaItem): number => (hueOf(a) ?? 0) - (hueOf(b) ?? 0);
    // 窗外与未取色的排到后面：墙收拢时「退后」，但人不丢，仍然能点开
    return {
      items: [...hits.sort(byHue), ...outside.sort(byHue), ...unknown],
      hit: hits.length,
      outside: outside.length,
      unknown: unknown.length,
    };
  });

  const ordered = computed(() => wall.value.items);
  const stats = computed<HueWallStats>(() => ({
    hit: wall.value.hit,
    outside: wall.value.outside,
    unknown: wall.value.unknown,
    probing: probing.value,
  }));

  function pump(): void {
    while (running < HUE_PROBE_CONCURRENCY && queue.length > 0) {
      const url = queue.shift() as string;
      const myEpoch = epoch;
      running += 1;
      probing.value = running;
      void paletteForPoster(url)
        .then((seed) => {
          // 主色是关于这张海报的事实，即使模式已经关掉也记下来：作废它只会让下次进模式重取一遍。
          // 关着的时候 `wall` 不读这张表，所以记录不会引发任何重排。
          commitHue(url, seed ? seed.h : null);
        })
        .catch(() => undefined)
        .finally(() => {
          if (myEpoch !== epoch) return;
          running -= 1;
          probing.value = running;
          pump();
        });
    }
  }

  /** 读缓存，把「根本没结论」的排进补取队列 */
  function sync(items: MediaItem[]): void {
    if (!options.enabled()) return;
    const fresh: string[] = [];
    for (const item of items) {
      const url = item.posterUrl;
      if (!url || checked.has(url)) continue;
      checked.add(url);
      fresh.push(url);
    }
    if (fresh.length === 0) return;

    const myEpoch = epoch;
    void Promise.all(fresh.map(async (url) => [url, await peekPalette(url)] as const))
      .then((pairs) => {
        if (myEpoch !== epoch || !options.enabled()) return;
        const cold: string[] = [];
        for (const [url, peek] of pairs) {
          if (!peek.known) cold.push(url);
          else hueByUrl.value.set(url, peek.seed?.h ?? null);
        }
        if (cold.length === 0) return;
        queue = queue.concat(cold.slice(0, HUE_PROBE_BATCH));
        pump();
      })
      .catch(() => undefined);
  }

  function stop(): void {
    epoch += 1;
    queue = [];
    running = 0;
    probing.value = 0;
    // 攒着的结果是已经花掉网络的事实，落定即可，不必丢掉重来
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushPending();
    }
  }

  watch(source, sync, { immediate: true });
  watch(
    () => options.enabled(),
    (on) => {
      if (on) sync(source());
      else stop();
    },
  );

  onBeforeUnmount(stop);

  return { ordered, stats, hueOf, stop };
}
