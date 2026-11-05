/**
 * 下载 Store（API-14）
 *
 * 订阅 `downloadService.on('download')` 实时更新任务与汇总，
 * 避免 UI 轮询；事件在 store 首次 `load()` 时注册。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { downloadService } from '@/services/downloadService';
import { toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type {
  AppErrorShape,
  CreateDownloadInput,
  DownloadSummary,
  DownloadTask,
  LoadState,
} from '@/types';

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

  async function remove(id: string, deleteFile?: boolean): Promise<void> {
    await downloadService.remove(id, { deleteFile });
    await refresh();
  }

  async function pauseAll(): Promise<void> {
    await downloadService.pauseAll('user');
    await refresh();
  }

  async function resumeAll(): Promise<void> {
    await downloadService.resumeAll();
    await refresh();
  }

  async function clearCompleted(): Promise<void> {
    await downloadService.clearCompleted();
    await refresh();
  }

  /** 功能扩展-10：批量删除 */
  async function removeMany(ids: string[], deleteFile?: boolean): Promise<void> {
    await downloadService.removeMany(ids, { deleteFile });
    await refresh();
  }

  /** 功能扩展-10：清理失败任务 */
  async function clearFailed(): Promise<void> {
    await downloadService.clearFailed();
    await refresh();
  }

  /** 功能扩展-10：存储占用 */
  async function calculateStorageUsage(): Promise<{ totalBytes: number; fileCount: number }> {
    return downloadService.calculateStorageUsage();
  }

  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
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
    $dispose,
  };
});

export type DownloadStore = ReturnType<typeof useDownloadStore>;
