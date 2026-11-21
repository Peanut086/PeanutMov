/**
 * 长按「原位放映」的取帧服务（G-B02）
 *
 * 只回答一个问题：海报墙上这一个条目，能不能就地放一小段？
 *
 * 与进度条胶片（A-03）同一口径——抽帧只认相对 `Directory.Data` 的本地文件，
 * 在线源没有可随机读的容器，一律退回海报，由 UI 挂一句诚实的角标，不假装在播。
 *
 * 放哪一集：先看观看历史落在哪一集，没有历史就取已下载的最小集号，并把选中的集号
 * 回传给画面下方说明。多集影片没有历史时确实可能不是用户想看的那一集，所以集号必须写出来。
 */
import type { DownloadTask, HistoryRecord, MediaItem } from '@/types';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { finalFilePathOf } from '@/services/downloadService';
import {
  extractSeekFrames,
  isMediaToolAvailable,
  verifyRemuxedMedia,
} from '@/native/mediaToolPlugin';
import { isLowEndDevice } from '@/shared/deviceTier';
import { logger } from '@/shared/logger';

/** 一次循环放几帧：低端机减半（与 `useSeekThumbnails` 的档位口径一致） */
const PEEK_FRAMES_HIGH = 12;
const PEEK_FRAMES_LOW = 6;
/** 长边像素：放映台约 350 宽，320 已够认画面，再高纯属解码成本 */
const PEEK_EDGE_HIGH = 320;
const PEEK_EDGE_LOW = 224;
/** 缓存几部：一次 12 帧 ≈ 200KB base64，同 `useSeekThumbnails` 的量级取舍 */
const CACHE_LIMIT = 8;

/** 只能放海报的原因（UI 据此出一句人话，不统一写成"不支持"） */
export type PeekFallback = 'no-tool' | 'no-download' | 'no-file' | 'no-duration' | 'no-frames';

export interface PeekClip {
  /** 已下载任务这一集的集号（播放路由要带它才能走本地快路径） */
  episodeId: string;
  /** 任务当初解析到的线路，口径与 `DownloadsView.onPlay` 一致 */
  lineId: string | null;
  /** 画面下方要说清"放的是哪一集" */
  episodeLabel: string;
  durationSec: number;
  /** 已滤掉取不到的帧，下标即循环顺序 */
  frames: string[];
}

export interface PeekPreview {
  clip: PeekClip | null;
  fallback: PeekFallback | null;
}

export interface PeekAnchorRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** 卡片长按那一刻交给页面的东西：条目 + 形变起点 + 触点（键盘触发没有触点） */
export interface PeekRequest {
  item: MediaItem;
  rect: PeekAnchorRect | null;
  origin: { x: number; y: number } | null;
}

/** 起点确实量到了的那一份——页面拿它渲染放映台，类型上不用再兜 null */
export interface PeekActive extends PeekRequest {
  rect: PeekAnchorRect;
}

/**
 * 放映台收起的原因。
 *
 * 只有 `release`（松手但没滑动）意味着「看完还是回到原来那三件事」，页面要补开长按快捷面板；
 * `swipe` 是上滑/下滑已经就地执行了动作，其余三种（滚动 / Esc / 点外面）都只是关掉。
 */
export type PeekDismissReason = 'release' | 'swipe' | 'scroll' | 'key' | 'scrim';

const EMPTY: PeekPreview = { clip: null, fallback: 'no-download' };

/** 按抽帧路径缓存成品与时长：同一集反复长按不该再解码第二遍 */
const frameCache = new Map<string, string[]>();
const durationCache = new Map<string, number>();

function remember<K>(map: Map<K, unknown>, key: K, value: unknown): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** 命中过的挪到末尾，让淘汰的确实是久未使用的 */
function touch<K, V>(map: Map<K, V>, key: K): V | undefined {
  const hit = map.get(key);
  if (hit === undefined) return undefined;
  map.delete(key);
  map.set(key, hit);
  return hit;
}

function episodeLabelOf(task: DownloadTask): string {
  if (task.episodeNumber !== null && task.episodeNumber !== undefined) {
    return `第 ${task.episodeNumber} 集`;
  }
  return task.episodeTitle ?? '已下载内容';
}

function clipOf(task: DownloadTask, durationSec: number, frames: string[]): PeekClip {
  return {
    episodeId: task.episodeId,
    lineId: task.lineId ?? null,
    episodeLabel: episodeLabelOf(task),
    durationSec,
    frames,
  };
}

/**
 * 挑一集：历史那集优先（集号或集 id 任一对上），否则取已下载的最小集号。
 * 这里不复用 `selectCompletedTask`：它在"多集 + 没给身份"时直接返回 null，
 * 而原位放映宁可明确放第 1 集并标出来，也不要一整屏只有一张静止海报。
 */
function pickTask(completed: DownloadTask[], hint: HistoryRecord | null): DownloadTask | null {
  if (completed.length === 0) return null;
  if (hint?.episodeId) {
    const exact = completed.find((t) => t.episodeId === hint.episodeId);
    if (exact) return exact;
  }
  if (hint?.episodeNumber !== null && hint?.episodeNumber !== undefined) {
    const byNumber = completed.find((t) => t.episodeNumber === hint.episodeNumber);
    if (byNumber) return byNumber;
  }
  return [...completed].sort(
    (a, b) =>
      (a.episodeNumber ?? Number.MAX_SAFE_INTEGER) - (b.episodeNumber ?? Number.MAX_SAFE_INTEGER),
  )[0]!;
}

/** 时长只认「历史记录的正是这一集」，否则拿别的集的时长铺帧会铺歪 */
function durationOfHint(task: DownloadTask, hint: HistoryRecord | null): number {
  if (!hint || !(hint.durationSec > 0)) return 0;
  const sameEpisode =
    (hint.episodeId !== null && hint.episodeId === task.episodeId) ||
    (hint.episodeNumber !== null && hint.episodeNumber === task.episodeNumber);
  const single = task.episodeNumber === null || task.episodeNumber === undefined;
  return sameEpisode || single ? hint.durationSec : 0;
}

/**
 * 没看过这一集就没有任何时长线索，只能现场探一次容器时长。
 *
 * `verifyMedia` 的名字是"复检交付件"，但它顺手回的就是 `MediaExtractor` 读到的时长，
 * 原生没有更便宜的时长入口；结论只取时长，不判合格与否。失败/旧 APK 一律当"取不到时长"。
 */
async function probeDurationSec(path: string): Promise<number> {
  const cached = touch(durationCache, path);
  if (cached !== undefined) return cached;
  let seconds = 0;
  try {
    const probed = await verifyRemuxedMedia(path);
    const us = probed?.durationUs ?? 0;
    if (us > 0) seconds = us / 1_000_000;
  } catch (e) {
    logger.debug('原位放映时长探测失败（退回海报）', { error: (e as Error)?.message ?? String(e) });
  }
  if (seconds > 0) remember(durationCache, path, seconds);
  return seconds;
}

export async function resolvePeekPreview(item: MediaItem): Promise<PeekPreview> {
  if (!isMediaToolAvailable()) return { clip: null, fallback: 'no-tool' };

  const [history, tasks] = await Promise.all([
    historyRepo.getByMedia(item.id).catch(() => null),
    downloadRepo.listByMedia(item.id).catch(() => [] as DownloadTask[]),
  ]);
  const hint = history && history.sourceId === item.sourceId ? history : null;
  const task = pickTask(tasks.filter((t) => t.status === 'completed'), hint);
  if (!task) return EMPTY;

  // blob sink 没有文件可开，与 A-03 同一个判断
  const path = task.sink === 'filesystem' ? finalFilePathOf(task) : null;
  if (!path) return { clip: null, fallback: 'no-file' };

  const fromHistory = durationOfHint(task, hint);
  const durationSec = fromHistory > 0 ? fromHistory : await probeDurationSec(path);
  if (!(durationSec > 0)) return { clip: null, fallback: 'no-duration' };

  const lowEnd = isLowEndDevice();
  const count = lowEnd ? PEEK_FRAMES_LOW : PEEK_FRAMES_HIGH;
  const edge = lowEnd ? PEEK_EDGE_LOW : PEEK_EDGE_HIGH;

  const cached = touch(frameCache, path);
  if (cached && cached.length > 0) return { clip: clipOf(task, durationSec, cached), fallback: null };

  const timesMs: number[] = [];
  for (let i = 0; i < count; i += 1) {
    timesMs.push(Math.round(((i + 0.5) * durationSec * 1000) / count));
  }
  const raw = await extractSeekFrames(path, timesMs, edge);
  const frames = (raw ?? []).filter((f): f is string => typeof f === 'string' && f.length > 0);
  if (frames.length === 0) return { clip: null, fallback: 'no-frames' };

  remember(frameCache, path, frames);
  return { clip: clipOf(task, durationSec, frames), fallback: null };
}

/** 放映台角标：每一种"只能放海报"都说明白，不共用一句"仅海报预览"糊过去 */
export function peekFallbackNote(fallback: PeekFallback): string {
  switch (fallback) {
    case 'no-tool':
      return '本机暂不支持抽帧 · 仅海报预览';
    case 'no-download':
      return '在线源 · 仅海报预览';
    case 'no-file':
      return '本地文件取不到 · 仅海报预览';
    case 'no-duration':
      return '读不到时长 · 仅海报预览';
    case 'no-frames':
      return '这一集抽不出画面 · 仅海报预览';
  }
}

/** 仅供测试：清掉模块级缓存，避免用例互相喂到对方的结果 */
export function __resetPeekCache(): void {
  frameCache.clear();
  durationCache.clear();
}
