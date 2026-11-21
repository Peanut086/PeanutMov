/**
 * 选集「胶片墙」的取帧服务（G-B07）
 *
 * 一集一格：取正中间那一秒的画面，整墙摆起来就是这部片子的「胶片」。
 * 与 A-03 进度条胶片、G-B02 原位放映同一口径——**只认本地文件**（在线源没有可随机读的容器），
 * 时长未知的一律不上墙，抽不出来的就留底板，绝不拿海报糊一张假画面。
 *
 * 为什么要排队：原生每格都要独立解码。一墙 24 集并发下去会把解码闸门堵死，
 * 正在播的那条首帧也得跟着排队。所以这里串行、每格之间让一个宏任务给渲染，
 * 单轮上限 `WALL_HIGH` 格——剩下的不必假装在抽，芯片继续老实显示集号。
 */
import { ref, shallowReactive } from 'vue';

import { extractSeekFrames, isMediaToolAvailable } from '@/native/mediaToolPlugin';
import { isLowEndDevice } from '@/shared/deviceTier';
import { logger } from '@/shared/logger';

/** 一轮最多铺几格：低端机减半（与 `useSeekThumbnails` / 原位放映同一档位口径） */
const WALL_HIGH = 24;
const WALL_LOW = 12;
/** 长边像素：墙上一格约 150 宽，168 已经够认画面，再高纯属解码成本 */
const EDGE_HIGH = 168;
const EDGE_LOW = 128;
/** 按路径缓存几格：一格约 8KB base64，48 格 ≈ 400KB */
const CACHE_LIMIT = 48;

/** 想上墙的一集：`path` 必须是成品文件相对路径，`durationSec` 未知就别传 */
export interface EpisodeFilmTarget {
  episodeId: string;
  path: string;
  durationSec: number;
}

/**
 * path → 那一格；空数组 = 确认抽不出（坏文件 / 原生失败），与「还没抽到」区分开。
 *
 * 这里是**普通 Map + 版本计数**（与 A-03 `useSeekThumbnails` 同一口径），不是响应式 Map：
 * LRU 的"摸一下就挪到末尾"发生在读取路径里，如果 Map 本身是响应式的，
 * 读取时的 delete 会立刻把正在计算它的 computed 再弄脏 → 重渲染 → 再读 → 无限循环。
 * 版本计数只在真正写入结果时 +1，读取侧只登记依赖、不产生写入。
 */
const strips = new Map<string, string[]>();
/** 已排进队列、还没出结果的路径：墙据此出等待态，而不是空板 */
const waiting = shallowReactive(new Set<string>());
/** 缓存内容变化计数：`episodeFilmOf` 靠它让调用方的 computed 感知原地写入 */
const version = ref(0);

let queue: EpisodeFilmTarget[] = [];
let running = false;

function remember(path: string, frames: string[]): void {
  strips.delete(path);
  strips.set(path, frames);
  waiting.delete(path);
  while (strips.size > CACHE_LIMIT) {
    const oldest = strips.keys().next();
    if (oldest.done) break;
    strips.delete(oldest.value);
  }
  version.value += 1;
}

/** 命中过的挪到末尾，让淘汰的确实是久未使用的 */
function touch(path: string): string[] | undefined {
  const hit = strips.get(path);
  if (hit === undefined) return undefined;
  strips.delete(path);
  strips.set(path, hit);
  return hit;
}

/**
 * 串行泵：一次只让原生解一集。
 * 每格之间让一个宏任务给渲染，墙在抽帧途中照样能滚、能点。
 */
async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      const lowEnd = isLowEndDevice();
      const edge = lowEnd ? EDGE_LOW : EDGE_HIGH;
      // 取正中那一格：片头字幕和片尾黑场都躲开了，一集一个画面也不用挑边角
      const timeMs = Math.round(target.durationSec * 500);
      let frames: string[] = [];
      try {
        const raw = await extractSeekFrames(target.path, [timeMs], edge);
        frames = (raw ?? []).filter((f): f is string => typeof f === 'string' && f.length > 0);
      } catch (e) {
        // 坏文件留底板即可：反复重试同一个坏容器比空一墙更难看的图更糟
        logger.debug('选集胶片墙抽帧失败（留底板）', {
          episodeId: target.episodeId,
          error: (e as Error)?.message ?? String(e),
        });
        frames = [];
      }
      remember(target.path, frames);
      await yieldToRender();
    }
  } finally {
    running = false;
  }
}

/** 让一个宏任务给渲染：优先 rAF，非浏览器环境退回 setTimeout */
function yieldToRender(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** 原生抽帧能力在不在：决定 UI 要不要给「胶片墙」这一档（Web / 旧 APK 直接没这档） */
export function episodeFilmSupported(): boolean {
  return isMediaToolAvailable();
}

/** 这一集已经抽到的格子；没抽过与抽不出都是空数组，用 `episodeFilmWaiting` 区分 */
export function episodeFilmOf(path: string | null | undefined): string[] {
  if (!path) return [];
  // 单独一行不是笔误：读一次计数，调用方的 computed 才会在新结果写入时重算
  version.value;
  return touch(path) ?? [];
}

/** 已排队未出结果：墙据此出等待态 */
export function episodeFilmWaiting(path: string | null | undefined): boolean {
  if (!path) return false;
  return waiting.has(path);
}

/**
 * 排一墙上要抽的集（幂等，可随滚动反复调）。
 * 只收「有本地文件 + 时长已知」且既没在抽也没结论的集，单轮截到上限，多的留给下一次调用。
 */
export function requestEpisodeFilms(targets: EpisodeFilmTarget[]): void {
  if (!episodeFilmSupported()) return;
  const wallLimit = isLowEndDevice() ? WALL_LOW : WALL_HIGH;
  let added = 0;
  for (const target of targets) {
    if (added >= wallLimit) break;
    if (!target.path || !(target.durationSec > 0)) continue;
    // 已经在抽、或已经有结论（含「抽不出」）的集都不再排：坏文件反复重试只会把闸门堵死
    if (waiting.has(target.path) || strips.has(target.path)) continue;
    waiting.add(target.path);
    queue.push(target);
    added += 1;
  }
  if (added > 0) void drain();
}

/** 仅供测试：清掉模块级缓存与队列，避免用例互相喂到对方的结果 */
export function __resetEpisodeFilmState(): void {
  strips.clear();
  version.value += 1;
  waiting.clear();
  queue = [];
  running = false;
}
