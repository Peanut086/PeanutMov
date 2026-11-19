/**
 * 批量下载与容量裁决（EXT-04 / FR-61 / D-05）
 *
 * 设计要点：
 * - **状态机不动**：`DownloadQueue` 的并发/重试/状态流转保持原样，容量是服务层策略，
 *   在这里做"入队前裁决"，队列只负责执行；
 * - 单次批量上限 50、队列非终态任务上限默认 200（`settings.download.maxQueueTasks` 可调）；
 * - 超容量集进入 `rejected`（`E_INVALID_STATE` + "队列已满(n)"），**不整批失败**（AC-144）；
 * - 批内重试只挑 `failed`（`canceled` 不参与），按集号升序（AC-145）。
 */
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { DOWNLOAD_BATCH_MAX, DOWNLOAD_QUEUE_MAX } from '@/shared/constants';
import { AppError } from '@/shared/errors';
// P3-3：作品身份口径与搜索归组（P1-7）共用同一套根标题/季号判定
import { showIdentityOf } from '@/services/searchAggregate';
import type { DownloadSettings, DownloadTask } from '@/types';

/** 非终态 = 仍占用队列容量的任务（completed / canceled 之外） */
const TERMINAL_STATUSES: ReadonlySet<DownloadTask['status']> = new Set(['completed', 'canceled']);

export interface BatchQueueState {
  before: number;
  after: number;
  capacity: number;
  full: boolean;
}

export interface BatchProgress {
  total: number;
  completed: number;
  failed: number;
  active: number;
  canceled: number;
}

/** `batch_${ts}_${rand}`（API-16 §3.1.2 缺省格式） */
export function createBatchId(now: number = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `batch_${now}_${rand}`;
}

/** 单次批量上限校验（超限抛 E_INVALID_INPUT） */
export function assertBatchSize(count: number): void {
  if (count <= 0 || count > DOWNLOAD_BATCH_MAX) {
    throw new AppError('E_INVALID_INPUT', `单次批量需为 1~${DOWNLOAD_BATCH_MAX} 集`);
  }
}

/** 队列上限：设置值优先；非法值回落默认 200 */
export function resolveQueueCapacity(settings: Pick<DownloadSettings, 'maxQueueTasks'> | null | undefined): number {
  const value = settings?.maxQueueTasks;
  return value === 50 || value === 100 || value === 200 || value === 500 ? value : DOWNLOAD_QUEUE_MAX;
}

/** 当前占用队列容量的任务数（非终态） */
export async function countOccupied(all?: DownloadTask[]): Promise<number> {
  const rows = all ?? (await downloadRepo.listAll());
  return rows.reduce((count, task) => (TERMINAL_STATUSES.has(task.status) ? count : count + 1), 0);
}

/** 按 batchId 取批内任务（按集号升序，集号缺失排后） */
export async function tasksOfBatch(batchId: string, all?: DownloadTask[]): Promise<DownloadTask[]> {
  const rows = all ?? (await downloadRepo.listAll());
  return rows
    .filter((task) => task.batchId === batchId)
    .sort((a, b) => {
      const left = a.episodeNumber ?? Number.MAX_SAFE_INTEGER;
      const right = b.episodeNumber ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.createdAt - b.createdAt;
    });
}

/** 批内可重试项：仅 failed，按集号升序（AC-145） */
export function selectRetryable(tasks: DownloadTask[]): DownloadTask[] {
  return tasks
    .filter((task) => task.status === 'failed')
    .sort((a, b) => {
      const left = a.episodeNumber ?? Number.MAX_SAFE_INTEGER;
      const right = b.episodeNumber ?? Number.MAX_SAFE_INTEGER;
      if (left !== right) return left - right;
      return a.createdAt - b.createdAt;
    });
}

/** 批内可清理项：仅 completed（"删除本批已完成"） */
export function selectCompleted(tasks: DownloadTask[]): DownloadTask[] {
  return tasks.filter((task) => task.status === 'completed');
}

/** 批次进度汇总（UI「已完成 n/总数」） */
export function summarizeBatch(tasks: DownloadTask[]): BatchProgress {
  let completed = 0;
  let failed = 0;
  let active = 0;
  let canceled = 0;
  for (const task of tasks) {
    switch (task.status) {
      case 'completed':
        completed += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'canceled':
        canceled += 1;
        break;
      default:
        active += 1;
    }
  }
  return { total: tasks.length, completed, failed, active, canceled };
}

/**
 * 完成提示的分组键（P2-4）：同一次「缓存整季」归一条，无批号的任务自成一组。
 * 前缀区分两种命名空间，避免某个任务的 id 恰好等于别人的 batchId 时被并成一条。
 */
export function completionGroupKey(task: DownloadTask): string {
  return task.batchId ? `batch:${task.batchId}` : `solo:${task.id}`;
}

/** 一集在提示里的名字：优先用与列表同源的分集标题，退化到集号 */
function episodeLabelOf(task: DownloadTask): string {
  const title = task.episodeTitle?.trim();
  if (title) return title;
  if (task.episodeNumber !== null && task.episodeNumber !== undefined) return `第 ${task.episodeNumber} 集`;
  return '';
}

/**
 * 把「刚完成的任务」压成提示文案（P2-4）
 *
 * 旧口径逐项各弹一条 `「片名」下载完成`：真机实测 13 集的批次里两集完成就弹了两条一模一样的
 * 「绝命毒师 第四季」下载完成——看不出是哪一集，也把真正需要单独通知的下载淹掉了。
 *
 * 现在按批分组（同批在一个提示窗口内只出一条），且文案点名到集：
 * - 单集：`「剧名」第 3 集已下载`
 * - 同批多集：`「剧名」第 1 集、第 2 集、第 3 集等已下载（共 5 集）`
 * - 没有分集概念的单文件：维持 `「片名」下载完成`
 *
 * @param fresh 本提示窗口内新完成的任务
 * @returns 至多「分组数」条文案
 */
export function planCompletionToasts(fresh: DownloadTask[]): string[] {
  const groups = new Map<string, DownloadTask[]>();
  for (const task of fresh) {
    const key = completionGroupKey(task);
    const bucket = groups.get(key);
    if (bucket) bucket.push(task);
    else groups.set(key, [task]);
  }

  const lines: string[] = [];
  for (const items of groups.values()) {
    const title = items[0]?.title?.trim() || '下载';
    const labels = items.map((task) => episodeLabelOf(task));
    if (labels.some((label) => label === '')) {
      // 单文件下载（无集号）维持原话术；混着有集号的批次按项数报
      lines.push(items.length === 1 ? `「${title}」下载完成` : `「${title}」${items.length} 项下载完成`);
      continue;
    }
    if (items.length === 1) {
      lines.push(`「${title}」${labels[0]}已下载`);
      continue;
    }
    const head = labels.slice(0, 3).join('、');
    lines.push(`「${title}」${head}${labels.length > 3 ? '等' : ''}已下载（共 ${items.length} 集）`);
  }
  return lines;
}

/**
 * 容量裁决：给定"想创建的集数"，返回本次可入队条数与队列前后水位。
 * 已存在任务不计入 `requested`（由调用方先剔除并计入 `skipped`）。
 */
export function adjudicateCapacity(before: number, requested: number, capacity: number): {
  accepted: number;
  queue: BatchQueueState;
} {
  const room = Math.max(0, capacity - before);
  const accepted = Math.min(requested, room);
  return {
    accepted,
    queue: {
      before,
      after: before + accepted,
      capacity,
      full: before + accepted >= capacity,
    },
  };
}

/**
 * 批量创建用的"已存在"判定键：同 `mediaId+episodeId` 的非 canceled 任务视为已存在（AC-70）。
 */
export function existingKeyOf(mediaId: string, episodeId: string): string {
  return `${mediaId}::${episodeId}`;
}

/* ---------- P3-3：换线路重复下载 ---------- */

/**
 * `existingKeyOf` 只认字面 `mediaId+episodeId`：换一条线路（不同源、不同 id）就判不出重复，
 * 于是本地可以攒下同一集的若干份。这里按「同一部作品 + 同一集」比对，让下单前能把这件事
 * 说清楚——不阻断，用户换线路往往正因为上一份下不动。
 *
 * 作品身份复用 P1-7 归组同一口径（`showIdentityOf`）：搜索里合并成一组的内容，在这里也不算两部。
 */
export interface EpisodeProbe {
  mediaId: string;
  /** 作品标题（含季号写法） */
  title: string;
  episodeNumber?: number | null;
  episodeTitle?: string | null;
}

/** 已在列表里的那一条：多带状态，用于挑「以哪条为准提示用户」 */
export interface ExistingEpisodeProbe extends EpisodeProbe {
  status?: DownloadTask['status'];
}

export interface CrossLineDuplicate<P extends EpisodeProbe, R extends EpisodeProbe> {
  planned: P;
  existing: R;
}

/** 内容标题里的集号（`第5集` / `EP05` / `5集` / `05话`） */
const EPISODE_NO_IN_TITLE =
  /(?:第\s*([0-9]{1,4})\s*[集话期]|ep\.?\s*([0-9]{1,4})|([0-9]{1,4})\s*[集话期])/i;

/** 集号：优先显式 `episodeNumber`，其次从分集标题取；都没有返回 null */
function episodeNoOf(row: EpisodeProbe): number | null {
  const direct = row.episodeNumber;
  if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return Math.trunc(direct);
  const match = (row.episodeTitle ?? '').match(EPISODE_NO_IN_TITLE);
  if (!match) return null;
  const n = parseInt(match[1] ?? match[2] ?? match[3] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 标题兜底比对用的写法：去空白与标点，只留字面和数字 */
function episodeTextOf(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 同一集的判定：两边都有集号按集号；否则按归一化后的分集标题。
 *
 * 两边都拿不出分集信息（电影常见的只有片名一条）时按「同一部内容」算——那正是换线路重复
 * 下载最频繁的形态。只有一边拿得出来就不判：宁可漏报，也不把用户正在下的东西拦下来。
 */
function isSameEpisode(a: EpisodeProbe, b: EpisodeProbe): boolean {
  const noA = episodeNoOf(a);
  const noB = episodeNoOf(b);
  if (noA !== null && noB !== null) return noA === noB;
  const textA = episodeTextOf(a.episodeTitle ?? '');
  const textB = episodeTextOf(b.episodeTitle ?? '');
  if (noA === null && noB === null && textA === '' && textB === '') return true;
  if (textA === '' || textB === '') return false;
  return textA === textB;
}

/** 作品键（根标题 + 季号）；跨季打包条目不参与比对——它覆盖整部，集号不可比 */
function workKeyOf(identity: { root: string; season: number | null; crossSeason: boolean }): string | null {
  if (identity.root === '' || identity.crossSeason) return null;
  return `${identity.root}#${identity.season ?? '-'}`;
}

/**
 * 找出「本次要下的这些集里，哪些在别线路上已经下过」。
 *
 * 同一 `mediaId`（同一条线路）的重复不在这里报——`createMany` 会直接跳过并提示「已在下载列表中」。
 * 已取消的任务不算：它没有留下的成品。
 */
export function findCrossLineDuplicates<P extends EpisodeProbe, R extends ExistingEpisodeProbe>(
  planned: P[],
  existing: R[],
): Array<CrossLineDuplicate<P, R>> {
  if (planned.length === 0 || existing.length === 0) return [];

  const byWork = new Map<string, R[]>();
  for (const row of existing) {
    if (row.status === 'canceled') continue;
    const key = workKeyOf(showIdentityOf(row.title));
    if (!key) continue;
    const bucket = byWork.get(key);
    if (bucket) bucket.push(row);
    else byWork.set(key, [row]);
  }

  const out: Array<CrossLineDuplicate<P, R>> = [];
  for (const row of planned) {
    const key = workKeyOf(showIdentityOf(row.title));
    if (!key) continue;
    const candidates = (byWork.get(key) ?? []).filter((other) => other.mediaId !== row.mediaId);
    const hit = candidates.find((other) => isSameEpisode(row, other));
    if (hit) out.push({ planned: row, existing: hit });
  }
  return out;
}

/**
 * 把重复项压成下单前的一句确认文案（P3-3）。
 *
 * 只说三件用户决策要用的事：几集重复、跟列表里哪条重复、重复的部分大概占多少空间。
 * 体积全未知时不报「约 …」——空口说"会占空间"不如不说。
 */
export function describeCrossLineDuplicates(
  matches: Array<CrossLineDuplicate<EpisodeProbe, DownloadTask>>,
  formatSize: (bytes: number) => string,
): string {
  if (matches.length === 0) return '';

  const sizeOf = (task: DownloadTask): number | null => {
    const bytes = task.totalBytes ?? task.downloadedBytes;
    return typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0 ? bytes : null;
  };
  const labelOf = (task: DownloadTask): string => episodeLabelOf(task) || '整部内容';

  const groups = new Map<string, Array<CrossLineDuplicate<EpisodeProbe, DownloadTask>>>();
  for (const m of matches) {
    const key = m.existing.title.trim() || '已下载内容';
    const bucket = groups.get(key);
    if (bucket) bucket.push(m);
    else groups.set(key, [m]);
  }

  const parts: string[] = [];
  let totalBytes = 0;
  let anySize = false;
  for (const [title, rows] of groups) {
    const labels = rows.map((r) => labelOf(r.existing));
    const head = labels.slice(0, 2).join('、');
    const more = labels.length > 2 ? ` 等 ${labels.length} 项` : '';
    parts.push(`「${title}」的${head}${more}`);
    for (const r of rows) {
      const bytes = sizeOf(r.existing);
      if (bytes !== null) {
        totalBytes += bytes;
        anySize = true;
      }
    }
  }

  const sizeHint = anySize ? `（约 ${formatSize(totalBytes)}）` : '';
  return `本次要下的内容与下载列表重复：${parts.join('；')}${sizeHint}。\n换线路会再下一份，同样的空间占两次，确定继续吗？`;
}

export const downloadBatch = {
  createBatchId,
  assertBatchSize,
  resolveQueueCapacity,
  countOccupied,
  tasksOfBatch,
  selectRetryable,
  selectCompleted,
  summarizeBatch,
  adjudicateCapacity,
  existingKeyOf,
  findCrossLineDuplicates,
  describeCrossLineDuplicates,
};

export type DownloadBatch = typeof downloadBatch;
