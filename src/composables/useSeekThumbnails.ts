/**
 * 进度条胶片预览的数据层（A 批次·A-03）
 *
 * 只做三件事：算格子、按需抽帧、缓存结果。**不碰 DOM、不认识 SeekBar**。
 *
 * 为什么一次抽「整条」而不是「手指下面那一格」：原生每帧都要独立解码，逐格请求会把
 * 用户刚拖动的那几百毫秒排成一长队，结果最该先出现的画面反而最后到；一次 20 格在
 * 最低优先级线程上跑完，第一次拖动就能铺满，后续拖动全部命中缓存。
 *
 * 为什么只服务本地文件：在线源没有可随机读的容器，预览要靠雪碧图（另一套方案，
 * 本批次不做）。所以 `enabled` 对在线源恒为 false，UI 据此退回纯时间气泡。
 */
import { computed, ref, type ComputedRef } from 'vue';

import type { PlaybackSource } from '@/types';

import { extractSeekFrames, isMediaToolAvailable } from '@/native/mediaToolPlugin';

/** 高档机一格约 5% 时长；低档机砍一半，抽帧耗时与占用内存都跟着减半 */
const CELLS_HIGH = 20;
const CELLS_LOW = 10;
/** 与原生 `MediaToolPlugin.MAX_FRAMES` 对齐：超过这个数会被后端整批拒绝 */
const CELLS_PER_CALL = 24;
/**
 * 传给原生解码器的长边提示（px）。胶片格只画 72px，但同一张图还要铺满主画面，
 * 192 是"横屏看着能认、一次 20 格不至于占 2MB 内存"的折中；再高就纯属解码成本。
 */
const FRAME_MAX_EDGE = 192;
/** 同时缓存几部影片：一格约 15KB base64，20 格 × 6 部 ≈ 2MB */
const CACHE_LIMIT = 6;

/** 槽位数组：下标即格号，null = 尚未就绪或这一帧取不到 */
type FilmSlots = (string | null)[];

const EMPTY: FilmSlots = [];

/** 本机大致属于哪一档：拿不到指标时按高档处理（宁可多抽几帧） */
function deviceCellCount(): number {
  if (typeof navigator === 'undefined') return CELLS_HIGH;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const cores = navigator.hardwareConcurrency ?? 0;
  const lowEnd = (memory !== undefined && memory > 0 && memory < 4) || (cores > 0 && cores <= 4);
  return lowEnd ? CELLS_LOW : CELLS_HIGH;
}

/**
 * 以文件相对路径为 key 的抽帧结果缓存（模块级：同一集反复进出播放页不必重抽）。
 * 只跑过一批抽帧的文件才进 `passedFiles`，失败帧也照样登记——否则每次拖动都会
 * 重试同一个坏文件，卡在坏帧上比空胶片更糟。
 */
const frameCache = new Map<string, FilmSlots>();
const passedFiles = new Set<string>();

/** 缓存内容变化计数：`slots` 靠它感知 Map 的原地写入 */
const cacheVersion = ref(0);

function cacheTouch(path: string, cells: number): void {
  const hit = frameCache.get(path);
  if (hit) {
    // 命中即挪到末尾，让 CACHE_LIMIT 淘汰的是真正久未使用的文件
    frameCache.delete(path);
    frameCache.set(path, hit);
    return;
  }
  frameCache.set(path, new Array<FilmSlots[number]>(cells).fill(null));
}

function cacheStore(path: string, slots: FilmSlots): void {
  frameCache.delete(path);
  frameCache.set(path, slots);
  passedFiles.add(path);
  while (frameCache.size > CACHE_LIMIT) {
    const oldest = frameCache.keys().next();
    if (oldest.done) break;
    frameCache.delete(oldest.value);
    passedFiles.delete(oldest.value);
  }
  cacheVersion.value += 1;
}

export interface SeekThumbnails {
  /** 胶片格数（设备档位决定，一次播放内不变） */
  readonly count: number;
  /** 每格的 JPEG data URL，下标即格号；未抽过或在线源为空数组 */
  readonly slots: ComputedRef<FilmSlots>;
  /** 当前源是否具备出图条件（原生插件 + 本地文件 + 时长已知） */
  readonly enabled: ComputedRef<boolean>;
  /** 幂等地铺满整条胶片：拖动开始与过程中都可以反复调 */
  prepare(): void;
  /** 取某时刻所在格的缩略图，未就绪返回 null */
  frameAt(sec: number): string | null;
}

/**
 * @param getSource   当前播放源（在线源 / blob 兜底会让 `enabled` 自动为 false）
 * @param getDuration 当前时长（秒）；时长未知时不抽帧
 */
export function useSeekThumbnails(
  getSource: () => PlaybackSource | null,
  getDuration: () => number,
): SeekThumbnails {
  const count = Math.min(CELLS_PER_CALL, deviceCellCount());

  /** 只认 filesystem sink 的相对路径：blob 没有可供 MediaMetadataRetriever 打开的文件 */
  const pathOf = computed(() => {
    const source = getSource();
    return source?.isLocal && source.localPath ? source.localPath : null;
  });
  const durationOf = computed(() => {
    const value = getDuration();
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const enabled = computed(() => durationOf.value > 0 && pathOf.value !== null && isMediaToolAvailable());

  /**
   * 直接由缓存推导：换源（切集 / 退回在线线路）时 `pathOf` 一变，旧胶片立刻消失，
   * 不需要额外维护"当前是哪一部"的状态，也不会有迟到结果盖到新画面上的问题。
   */
  const slots = computed<FilmSlots>(() => {
    cacheVersion.value;
    const path = pathOf.value;
    return path ? frameCache.get(path) ?? EMPTY : EMPTY;
  });

  let inFlight = false;
  let rerun = false;

  /** 第 i 格代表的时间（秒）：取格子中心，两格交界处拖动才不会看起来慢了半格 */
  function cellSec(index: number): number {
    return ((index + 0.5) * durationOf.value) / count;
  }

  /** 同一时刻只保留一路原生抽帧；期间新来的请求置 rerun，跑完当前这路再补一次 */
  async function drain(): Promise<void> {
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    try {
      do {
        rerun = false;
        const path = pathOf.value;
        if (!path || !enabled.value || passedFiles.has(path)) break;
        const base = frameCache.get(path) ?? EMPTY;
        const next = base.slice(0, count);
        while (next.length < count) next.push(null);

        const timesMs: number[] = [];
        for (let i = 0; i < count; i++) timesMs.push(Math.round(cellSec(i) * 1000));

        const result = await extractSeekFrames(path, timesMs, FRAME_MAX_EDGE);
        if (result) {
          for (let i = 0; i < count; i++) next[i] = result[i] ?? null;
        }
        cacheStore(path, next);
      } while (rerun);
    } finally {
      inFlight = false;
    }
  }

  function prepare(): void {
    if (!enabled.value) return;
    const path = pathOf.value!;
    cacheTouch(path, count);
    if (passedFiles.has(path)) return;
    void drain();
  }

  function frameAt(sec: number): string | null {
    if (!enabled.value || durationOf.value <= 0) return null;
    const index = Math.min(count - 1, Math.max(0, Math.floor((sec / durationOf.value) * count)));
    return slots.value[index] ?? null;
  }

  return { count, slots, enabled, prepare, frameAt };
}
