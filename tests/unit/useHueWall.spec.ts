import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref, type Ref } from 'vue';

import { HUE_PROBE_BATCH, hueDistance, useHueWall } from '@/composables/useHueWall';
import { paletteForPoster, peekPalette } from '@/services/paletteService';
import type { MediaItem } from '@/types';

/**
 * G-B01 色相墙的排序与取色节制。
 *
 * 判收的两条硬线都在这里：一是「未取色排末尾 + 补取到后归位」，
 * 二是「不为排版批量拉海报」——所以补取必须既限量（每轮 `HUE_PROBE_BATCH` 张）
 * 又限并发，并且关掉模式后在飞结果要作废。
 */
vi.mock('@/services/paletteService', () => ({
  peekPalette: vi.fn(async () => ({ known: false, seed: null })),
  paletteForPoster: vi.fn(async () => null),
}));

/** 补取结果攒批提交的间隔（与 `useHueWall` 内部 `HUE_FLUSH_MS` 同值） */
const FLUSH_MS = 220;

/** `paletteForPoster().then().catch().finally()` 要走好几个微任务，一次走干 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

/** 列表变化（pre-flush watcher）+ 取色链路（异步）都走完 */
async function flush(): Promise<void> {
  await nextTick();
  await settle();
}

function item(index: number, hueUrl = `https://cdn/p${index}.jpg`): MediaItem {
  return {
    id: `m${index}`,
    sourceId: 'mock',
    sourceItemId: `s${index}`,
    title: `影片 ${index}`,
    originalTitle: null,
    type: 'movie',
    year: 2020,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: hueUrl,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: `影片 ${index}`,
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

/** 挂一个空组件只为给 composable 提供 setup 上下文（onBeforeUnmount 需要实例） */
function withSetup<T>(setup: () => T): { result: T; unmount: () => void } {
  let result!: T;
  const wrapper = mount(
    defineComponent({
      setup() {
        result = setup();
        return () => null;
      },
    }),
  );
  return { result, unmount: () => wrapper.unmount() };
}

interface Harness {
  items: Ref<MediaItem[]>;
  on: Ref<boolean>;
  center: Ref<number>;
  window: Ref<number>;
  ordered: { value: MediaItem[] };
  stats: { value: { hit: number; outside: number; unknown: number; probing: number } };
  unmount: () => void;
}

function harness(initial: MediaItem[], opts?: { on?: boolean; center?: number; window?: number }): Harness {
  const items = ref(initial);
  const on = ref(opts?.on ?? true);
  const center = ref(opts?.center ?? 210);
  const window = ref(opts?.window ?? 60);
  const { result, unmount } = withSetup(() =>
    useHueWall(() => items.value, { enabled: () => on.value, center, window }),
  );
  return { items, on, center, window, ordered: result.ordered, stats: result.stats, unmount };
}

/** 让缓存里就有色相：整墙不该为了排序去联网 */
function seedCache(hues: Record<number, number | null>): void {
  vi.mocked(peekPalette).mockImplementation(async (url) => {
    const idx = Number(/p(\d+)\.jpg$/.exec(String(url))?.[1]);
    if (!Number.isInteger(idx) || !(idx in hues)) return { known: false, seed: null };
    const hue = hues[idx] as number | null;
    return { known: true, seed: hue === null ? null : { h: hue, s: 0.6, l: 0.5 } };
  });
}

beforeEach(() => {
  vi.mocked(peekPalette).mockReset();
  vi.mocked(paletteForPoster).mockReset();
  vi.mocked(peekPalette).mockImplementation(async () => ({ known: false, seed: null }));
  vi.mocked(paletteForPoster).mockImplementation(async () => null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hueDistance', () => {
  it('色相环上的距离取近的那一头', () => {
    expect(hueDistance(350, 10)).toBeCloseTo(20);
    expect(hueDistance(10, 350)).toBeCloseTo(20);
    expect(hueDistance(0, 180)).toBeCloseTo(180);
    expect(hueDistance(120, 120)).toBe(0);
  });
});

describe('useHueWall · 排序', () => {
  it('未开启时顺序与数据源一字不动，也不读缓存', async () => {
    const list = [item(0), item(1), item(2)];
    const h = harness(list, { on: false });
    await flush();

    expect(h.ordered.value).toEqual(list);
    expect(h.stats.value).toMatchObject({ hit: 0, outside: 0, unknown: 0 });
    expect(peekPalette).not.toHaveBeenCalled();
  });

  it('命中窗内按色相升序，窗外其次，未取色恒在末尾', async () => {
    seedCache({ 0: 200, 1: 215, 2: 10, 3: 205 });
    const h = harness([item(0), item(1), item(2), item(3), item(4)]);
    await flush();

    expect(h.ordered.value.map((x) => x.id)).toEqual(['m0', 'm3', 'm1', 'm2', 'm4']);
    expect(h.stats.value).toMatchObject({ hit: 3, outside: 1, unknown: 1 });
  });

  it('窗宽 360 时只重排不收拢', async () => {
    seedCache({ 0: 200, 1: 10 });
    const h = harness([item(0), item(1)], { window: 360 });
    await flush();

    expect(h.ordered.value.map((x) => x.id)).toEqual(['m1', 'm0']);
    expect(h.stats.value).toMatchObject({ hit: 2, outside: 0 });
  });

  it('判定过灰调的海报算「未分类」，排末尾且不再取色', async () => {
    seedCache({ 0: null, 1: 120 });
    const h = harness([item(0), item(1)]);
    await flush();

    expect(h.ordered.value.map((x) => x.id)).toEqual(['m1', 'm0']);
    expect(h.stats.value.unknown).toBe(1);
    expect(paletteForPoster).not.toHaveBeenCalled();
  });

  it('改中心/窗宽即时改变命中集合', async () => {
    seedCache({ 0: 200, 1: 10 });
    const h = harness([item(0), item(1)], { center: 210, window: 60 });
    await flush();
    expect(h.ordered.value.map((x) => x.id)).toEqual(['m0', 'm1']);
    expect(h.stats.value).toMatchObject({ hit: 1, outside: 1 });

    h.center.value = 10;
    await flush();
    expect(h.ordered.value.map((x) => x.id)).toEqual(['m1', 'm0']);
    expect(h.stats.value).toMatchObject({ hit: 1, outside: 1 });

    h.window.value = 180;
    await flush();
    expect(h.stats.value).toMatchObject({ hit: 2, outside: 0 });
  });
});

describe('useHueWall · 补取节制', () => {
  it('每轮最多补取 HUE_PROBE_BATCH 张，且并发不超过 2', async () => {
    let inFlight = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    vi.mocked(paletteForPoster).mockImplementation(
      () =>
        new Promise((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          gates.push(() => {
            inFlight -= 1;
            resolve(null);
          });
        }),
    );
    const list = Array.from({ length: HUE_PROBE_BATCH + 8 }, (_, i) => item(i));
    const h = harness(list);
    await flush();

    // 队列一次只铺 2 张：补取是顺带工作，不能把海报图的带宽吃光
    expect(paletteForPoster).toHaveBeenCalledTimes(2);
    expect(peak).toBeLessThanOrEqual(2);
    expect(h.stats.value.probing).toBe(2);

    // 逐个放行，验证队列不会一次全铺开
    while (gates.length > 0) {
      const release = gates.shift() as () => void;
      release();
      await settle();
      expect(inFlight).toBeLessThanOrEqual(2);
    }
    expect(paletteForPoster).toHaveBeenCalledTimes(HUE_PROBE_BATCH);
    expect(h.stats.value.probing).toBe(0);
  });

  it('同一海报的缓存只查一次，翻页带进新条目才补查', async () => {
    const h = harness([item(0)]);
    await flush();
    expect(peekPalette).toHaveBeenCalledTimes(1);

    h.items.value = [item(0), item(1)];
    await flush();
    expect(peekPalette).toHaveBeenCalledTimes(2);
    expect(peekPalette).toHaveBeenLastCalledWith('https://cdn/p1.jpg');
  });

  it('补取结果攒批落地：中途不重排，一批一起归位', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(v: { h: number; s: number; l: number } | null) => void> = [];
    vi.mocked(paletteForPoster).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const h = harness([item(0), item(1)], { center: 300, window: 60 });
    await flush();
    expect(resolvers).toHaveLength(2);

    resolvers[0]!({ h: 300, s: 0.6, l: 0.5 });
    await settle();
    expect(h.stats.value.unknown).toBe(2);

    vi.advanceTimersByTime(100);
    resolvers[1]!({ h: 100, s: 0.6, l: 0.5 });
    await settle();
    expect(h.stats.value.unknown).toBe(2);

    vi.advanceTimersByTime(FLUSH_MS);
    await settle();
    expect(h.stats.value).toMatchObject({ hit: 1, outside: 1, unknown: 0 });
    expect(h.ordered.value.map((x) => x.id)).toEqual(['m0', 'm1']);
  });

  it('关掉模式后在飞结果照样记账，重新开启不必重取', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(v: { h: number; s: number; l: number } | null) => void> = [];
    vi.mocked(paletteForPoster).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const h = harness([item(0), item(1)], { center: 300, window: 60 });
    await flush();

    h.on.value = false;
    await flush();
    for (const resolve of resolvers) resolve({ h: 300, s: 0.6, l: 0.5 });
    await settle();
    expect(h.stats.value).toMatchObject({ hit: 0, outside: 0, unknown: 0 });

    h.on.value = true;
    await flush();
    vi.advanceTimersByTime(FLUSH_MS);
    await settle();
    expect(peekPalette).toHaveBeenCalledTimes(2);
    expect(paletteForPoster).toHaveBeenCalledTimes(2);
    expect(h.stats.value).toMatchObject({ hit: 2, outside: 0, unknown: 0 });
  });

  it('卸载后停止一切取色', async () => {
    const h = harness([item(0)]);
    await flush();
    expect(paletteForPoster).toHaveBeenCalledTimes(1);

    h.unmount();
    h.items.value = [item(0), item(9)];
    await flush();
    expect(peekPalette).toHaveBeenCalledTimes(1);
  });
});
