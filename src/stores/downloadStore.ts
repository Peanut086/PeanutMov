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

  async function create(input: CreateDownloadInput): Promise<void> {
    error.value = null;
    try {
      await downloadService.create(input);
      await refresh();
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

  async function createMany(inputs: CreateDownloadInput[]): Promise<void> {
    error.value = null;
    try {
      await downloadService.createMany(inputs);
      await refresh();
    } catch (e) {
      error.value = toErrorShape(e);
      throw e;
    }
  }

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
    pause,
    resume,
    cancel,
    retry,
    remove,
    pauseAll,
    resumeAll,
    clearCompleted,
    $dispose,
  };
});

export type DownloadStore = ReturnType<typeof useDownloadStore>;
