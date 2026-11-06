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
};

export type DownloadBatch = typeof downloadBatch;
