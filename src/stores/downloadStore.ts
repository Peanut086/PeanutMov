/**
 * 下载 Store（API-14）
 *
 * 订阅 `downloadService.on('download')` 实时更新任务与汇总，
 * 避免 UI 轮询；事件在 store 首次 `load()` 时注册。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { downloadService } from '@/services/downloadService';
import { downloadRateLimiter, type RateStats } from '@/services/downloadRateLimiter';
import { toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type {
  AppErrorShape,
  CreateDownloadInput,
  DownloadSpeedLimit,
  DownloadSummary,
  DownloadTask,
  HlsQuality,
  LoadState,
} from '@/types';
import type { PreflightOptions, PreflightResult } from '@/services/downloadPreflight';

function emptySummary(): DownloadSummary {
  return {
    total: 0,
    queued: 0,
    downloading: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    totalBytes: 0,
    downloadedBytes: 0,
  };
}

export const useDownloadStore = defineStore('download', () => {
  const tasks = ref<DownloadTask[]>([]);
  const summary = ref<DownloadSummary>(emptySummary());
  const state = ref<LoadState>('idle');
  const error = ref<AppErrorShape | null>(null);
  /** EXT-04/FR-60/FR-64：后处理阶段（taskId → 阶段状态），供列表项展示"转封装中/字幕已下载" */
  const postprocess = ref<Record<string, {
    stage: 'remux' | 'subtitles';
    state: 'start' | 'progress' | 'done' | 'skipped' | 'failed';
    progress?: number;
    reason?: string;
  }>>({});
  /** EXT-04/FR-63：当前合计速率（3s 滑窗），由 UI 定时 `refreshSpeed()` 拉取 */
  const speed = ref<RateStats>({ windowMs: 3000, totalBps: 0, tasks: [] });

  let unsubscribe: (() => void) | null = null;

  async function refresh(): Promise<void> {
    const [rows, sum] = await Promise.all([downloadService.list(), downloadService.getSummary()]);
    tasks.value = rows;
    summary.value = sum;
    state.value = rows.length === 0 ? 'empty' : 'success';
  }

  async function load(): Promise<void> {
    state.value = 'loading';
    error.value = null;
    try {
      await refresh();
      if (!unsubscribe) {
        unsubscribe = downloadService.on('download', (event) => {
          if (event.type === 'queue') {
            summary.value = event.summary;
            return;
          }
          if (event.type === 'postprocess') {
            const next = { ...postprocess.value };
            next[event.task.id] = {
              stage: event.stage,
              state: event.state,
              progress: event.state === 'done' || event.state === 'skipped' ? 1 : event.progress,
              reason: event.reason,
            };
            postprocess.value = next;
            return;
          }
          const index = tasks.value.findIndex((task) => task.id === event.task.id);
          if (index >= 0) {
            const next = [...tasks.value];
            next[index] = event.task;
            tasks.value = next;
          } else {
            tasks.value = [...tasks.value, event.task];
          }
        });
      }
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      state.value = 'error';
    }
  }

  /** 单集创建：返回是否命中已有有效任务（FR-30 重复下载提示） */
  async function create(input: CreateDownloadInput): Promise<{ existed: boolean }> {
    error.value = null;
    try {
      const result = await downloadService.create(input);
      await refresh();
      return { existed: result.existed };
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

  /**
   * 批量创建：回传 `{ created, skipped }`，UI 据此提示"该集已在下载列表中"（REV-15 / FR-30）。
   */
  async function createMany(
    inputs: CreateDownloadInput[],
  ): Promise<{ created: DownloadTask[]; skipped: DownloadTask[] }> {
    error.value = null;
    try {
      const result = await downloadService.createMany(inputs);
      await refresh();
      return result;
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

  /** 下载前体积预检：Web 端单文件超过 1GB 时给出改用 App 的提示（REV-07 / AC-76） */
  const checkLargeFile = async (inputs: CreateDownloadInput[]): Promise<string | null> => {
    if (inputs.length === 0) return null;
    try {
      const sizes = await Promise.all(
        inputs.map(async (input) => {
          const size = await downloadService.preflightSize(input.url, input.headers ?? {});
          return size;
        }),
      );
      const oversizedCount = sizes.filter((size) => downloadService.needsAppForLargeFile(size)).length;
      if (oversizedCount === 0) return null;
      const maxSize = Math.max(...sizes.filter((size) => size !== null).map((size) => size ?? 0));
      return `有 ${oversizedCount} 个文件超过 1GB（最大 ${maxSize} 字节），浏览器环境建议改用 App 下载`;
    } catch (e) {
      // 预检失败不阻断下载，交给引擎层同阈值拒绝
      logger.debug('下载体积预检失败（放行）', toErrorShape(e).message);
      return null;
    }
  };

  async function pause(id: string): Promise<void> {
    await downloadService.pause(id);
  }

  async function resume(id: string): Promise<void> {
    await downloadService.resume(id);
  }

  async function cancel(id: string): Promise<void> {
    await downloadService.cancel(id);
  }

  async function retry(id: string): Promise<void> {
    await downloadService.retry(id);
  }

  async function remove(id: string, deleteFile?: boolean): Promise<{ fileLeftBehind: boolean }> {
    const result = await downloadService.remove(id, { deleteFile });
    await refresh();
    return result;
  }

  async function pauseAll(): Promise<void> {
    await downloadService.pauseAll('user');
    await refresh();
  }

  async function resumeAll(): Promise<void> {
    await downloadService.resumeAll();
    await refresh();
  }

  async function clearCompleted(): Promise<{ removed: number; filesLeftBehind: number }> {
    const result = await downloadService.clearCompleted();
    await refresh();
    return result;
  }

  /** 功能扩展-10：批量删除 */
  async function removeMany(
    ids: string[],
    deleteFile?: boolean,
  ): Promise<{ removed: number; filesLeftBehind: number; failed: number }> {
    const result = await downloadService.removeMany(ids, { deleteFile });
    await refresh();
    return result;
  }

  /** 功能扩展-10：清理失败任务 */
  async function clearFailed(): Promise<{ removed: number; filesLeftBehind: number }> {
    const result = await downloadService.clearFailed();
    await refresh();
    return result;
  }

  /** 功能扩展-10：存储占用 */
  async function calculateStorageUsage(): Promise<{ totalBytes: number; fileCount: number }> {
    return downloadService.calculateStorageUsage();
  }

  /* ---------------- EXT-04：预检 / 批量 / 限速 ---------------- */

  /** FR-65：下载前预检（1~50 条） */
  async function preflight(inputs: CreateDownloadInput[], options: PreflightOptions = {}): Promise<PreflightResult> {
    error.value = null;
    try {
      return await downloadService.preflight(inputs, options);
    } catch (e) {
      const shape = toErrorShape(e);
      if (shape.code !== 'E_ABORTED') error.value = shape;
      throw e;
    }
  }

  /** FR-65：批量预检（同 master 复用清单缓存） */
  async function preflightBatch(inputs: CreateDownloadInput[], options: PreflightOptions = {}): Promise<PreflightResult> {
    error.value = null;
    try {
      return await downloadService.preflightBatch(inputs, options);
    } catch (e) {
      const shape = toErrorShape(e);
      if (shape.code !== 'E_ABORTED') error.value = shape;
      throw e;
    }
  }

  /** FR-61：批量创建（容量裁决 + batchId） */
  async function createBatch(
    inputs: CreateDownloadInput[],
    options: {
      hlsQuality?: HlsQuality;
      batchId?: string;
      allowOverCapacity?: boolean;
      preflight?: PreflightResult;
    } = {},
  ): Promise<Awaited<ReturnType<typeof downloadService.createBatch>>> {
    error.value = null;
    try {
      const result = await downloadService.createBatch(inputs, options);
      await refresh();
      return result;
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

  /** FR-61：重试本批失败项 */
  async function retryBatch(batchId: string): Promise<{ retried: number; skipped: number; failedIds: string[] }> {
    error.value = null;
    try {
      const result = await downloadService.retryBatch(batchId);
      await refresh();
      return result;
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

  /** FR-61：删除本批已完成项 */
  async function deleteBatch(batchId: string): Promise<{ deleted: number }> {
    error.value = null;
    try {
      const result = await downloadService.deleteBatch(batchId);
      await refresh();
      return result;
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

  /** FR-63：切换限速档位 */
  async function setSpeedLimit(limit: DownloadSpeedLimit): Promise<void> {
    error.value = null;
    try {
      await downloadService.setSpeedLimit(limit);
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

  /** FR-63：刷新当前合计速率（UI 定时调用，3s 滑窗） */
  function refreshSpeed(): RateStats {
    speed.value = downloadRateLimiter.stats();
    return speed.value;
  }

  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    postprocess.value = {};
  }

  return {
    tasks,
    summary,
    state,
    error,
    load,
    create,
    createMany,
    checkLargeFile,
    pause,
    resume,
    cancel,
    retry,
    remove,
    removeMany,
    pauseAll,
    resumeAll,
    clearCompleted,
    clearFailed,
    calculateStorageUsage,
    preflight,
    preflightBatch,
    createBatch,
    retryBatch,
    deleteBatch,
    setSpeedLimit,
    refreshSpeed,
    postprocess,
    speed,
    $dispose,
  };
});

export type DownloadStore = ReturnType<typeof useDownloadStore>;
