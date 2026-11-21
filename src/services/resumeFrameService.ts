/**
 * 「继续观看」停在哪儿的那一帧（G-B08）
 *
 * 历史卡片今天只有海报 + 剩余时间，看不出"上次看到的是哪个画面"。这一层把
 * 记录里的 `positionSec` 变成一张图：**取的就是用户停下的那一秒**，不是海报、不是封面。
 *
 * 与 A-03 进度条胶片、G-B02 原位放映、G-B07 选集墙同一套口径：
 * 只认本机已下载成品文件（在线源没有可随机读的容器），抽不出来就留空由调用方退回海报——
 * 退回海报是诚实的，拿别的画面冒充才是骗人。
 *
 * 为什么按 4 秒归桶：首页每次回前台、每次下载状态变化都会重新请求。逐秒出键会把同一片段
 * 抽成十几张几乎一样的图，既烧解码又把缓存挤空；4 秒在一枚小图上看不出错，
 * 还能让"同一集还停在原地"直接命中缓存。键由本服务推导，调用方只负责问。
 */
import { shallowReactive, ref } from 'vue';

import type { DownloadTask, HistoryRecord } from '@/types';

import { finalFilePathOf } from '@/services/downloadService';
import { extractSeekFrames, isMediaToolAvailable } from '@/native/mediaToolPlugin';
import { isLowEndDevice } from '@/shared/deviceTier';
import { logger } from '@/shared/logger';

/** 单轮最多补几帧：首页一行 10 条，低端机减半 */
const ROUND_HIGH = 8;
const ROUND_LOW = 4;
/** 长边像素：卡片位 96 宽，160 已经过头了，再高纯属解码成本 */
const EDGE = 160;
const BUCKET_SEC = 4;
/** 缓存帧数上限：一帧约 12KB，16 帧 ≈ 200KB */
const CACHE_LIMIT = 16;

/** 想补一帧：`path` 是本机成品文件，`positionSec` 是用户停在哪儿 */
export interface ResumeFrameTarget {
  path: string;
  positionSec: number;
}

/**
 * key → 画面 data URL；值为 `null` 表示确认抽不出，与"还没抽"区分开。
 *
 * 普通 Map + 版本计数（同 A-03 / G-B07）：LRU 的"摸一下挪到末尾"在读取路径里，
 * 响应式 Map 会让读取把自己正在服务的 computed 弄脏，重渲染 → 再读 → 无限循环。
 */
const frames = new Map<string, string | null>();
const waiting = shallowReactive(new Set<string>());
/** 缓存内容变化计数：`resumeFrameOf` 靠它让调用方的 computed 感知原地写入 */
const version = ref(0);

let queue: ResumeFrameTarget[] = [];
let running = false;

/** 归桶后的位置（秒）：抽帧的时刻与缓存键都用它，两者必须同源 */
export function resumeFrameBucket(positionSec: number): number {
  // 不可信的位置（NaN / Infinity）归到 0：0 桶在排队时会被丢掉，不会抽出一张"停在开头"的假帧
  if (!Number.isFinite(positionSec)) return 0;
  return Math.max(0, Math.round(positionSec / BUCKET_SEC) * BUCKET_SEC);
}

/**
 * 缓存键：路径 + 归桶后的位置。
 *
 * 读写两侧都必须经过这里——自己拼键会把"看了 30 秒再回首页"读成半分钟前的画面。
 */
export function resumeFrameKey(path: string, positionSec: number): string {
  return `${path}@${resumeFrameBucket(positionSec)}`;
}

/**
 * 这条历史在本机的成品文件；没有就返回 null，卡片继续用海报。
 *
 * 只认「这部片子 + 这一集」下载完成且落盘成文件的任务：blob 没有可随机读的文件，
 * 集号对不上则是另一集的画面——那种"停在哪儿"是假的，宁可不出。
 */
export function resumeLocalPathOf(
  rec: Pick<HistoryRecord, 'mediaId' | 'episodeId' | 'positionSec'>,
  tasks: DownloadTask[],
): string | null {
  if (!(rec.positionSec > 0)) return null;
  for (const task of tasks) {
    if (task.mediaId !== rec.mediaId || task.status !== 'completed' || task.sink !== 'filesystem') continue;
    if (rec.episodeId && task.episodeId !== rec.episodeId) continue;
    return finalFilePathOf(task);
  }
  return null;
}

function remember(key: string, frame: string | null): void {
  frames.delete(key);
  frames.set(key, frame);
  waiting.delete(key);
  while (frames.size > CACHE_LIMIT) {
    const oldest = frames.keys().next();
    if (oldest.done) break;
    frames.delete(oldest.value);
  }
  version.value += 1;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) break;
      // 抽的是归桶后的那一秒，不是原始位置：键与画面必须同源
      const atSec = resumeFrameBucket(target.positionSec);
      const key = resumeFrameKey(target.path, atSec);
      let frame: string | null = null;
      try {
        const raw = await extractSeekFrames(target.path, [Math.round(atSec * 1000)], EDGE);
        const first = raw?.[0];
        frame = typeof first === 'string' && first.length > 0 ? first : null;
      } catch (e) {
        // 坏文件、坏容器：留空让卡片退回海报，反复重试只会一直堵着解码闸门
        logger.debug('续播帧抽帧失败（退回海报）', {
          key,
          error: (e as Error)?.message ?? String(e),
        });
        frame = null;
      }
      remember(key, frame);
      await yieldToRender();
    }
  } finally {
    running = false;
  }
}

function yieldToRender(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** 有没有抽帧桥（Web / 旧 APK 没有）：调用方据此决定要不要提"停在哪儿" */
export function resumeFrameSupported(): boolean {
  return isMediaToolAvailable();
}

/** 已经抽到的那一帧；没抽过与抽不出都是 null */
export function resumeFrameOf(key: string | null | undefined): string | null {
  if (!key) return null;
  // 单独一行不是笔误：读一次计数，调用方的 computed 才会在新结果写入时重算
  version.value;
  const hit = frames.get(key);
  if (hit === undefined) return null;
  // 摸过的往后挪，被淘汰的确实是久未使用的那条历史
  frames.delete(key);
  frames.set(key, hit);
  return hit;
}

/** 已排队未出结果 */
export function resumeFrameWaiting(key: string | null | undefined): boolean {
  if (!key) return false;
  return waiting.has(key);
}

/**
 * 排队补帧（幂等）：已经在抽的、已经有结论的都不再排，单轮截上限。
 * 位置随观看推进会变，键跟着变，所以同一条历史看多了会补新帧、旧帧等淘汰。
 */
export function requestResumeFrames(targets: ResumeFrameTarget[]): void {
  if (!resumeFrameSupported()) return;
  const limit = isLowEndDevice() ? ROUND_LOW : ROUND_HIGH;
  let added = 0;
  for (const target of targets) {
    if (added >= limit) break;
    // 位置为 0（没看过）或不可信（NaN / 负）都不抽：那一格本来就该是海报
    if (!target.path || !Number.isFinite(target.positionSec) || target.positionSec <= 0) continue;
    const key = resumeFrameKey(target.path, target.positionSec);
    if (waiting.has(key) || frames.has(key)) continue;
    waiting.add(key);
    queue.push(target);
    added += 1;
  }
  if (added > 0) void drain();
}

/** 仅供测试：清掉模块级缓存与队列 */
export function __resetResumeFrameState(): void {
  frames.clear();
  version.value += 1;
  waiting.clear();
  queue = [];
  running = false;
}
