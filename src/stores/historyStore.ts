/**
 * 观看历史 Store（API-14）
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { historyService } from '@/services/historyService';
import { appEvents } from '@/services/events';
import { toErrorShape } from '@/shared/errors';
import { historyIdOf } from '@/shared/id';
import type { AppErrorShape, HistoryRecord, LoadState, SaveProgressInput } from '@/types';

export const useHistoryStore = defineStore('history', () => {
  const items = ref<HistoryRecord[]>([]);
  const continueWatching = ref<HistoryRecord[]>([]);
  const state = ref<LoadState>('idle');
  const error = ref<AppErrorShape | null>(null);

  let unsubscribe: (() => void) | null = null;

  async function refresh(): Promise<void> {
    try {
      const [all, pending] = await Promise.all([
        historyService.list(),
        historyService.listContinueWatching(),
      ]);
      items.value = all;
      continueWatching.value = pending;
      state.value = all.length === 0 ? 'empty' : 'success';
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      state.value = 'error';
    }
  }

  async function load(): Promise<void> {
    state.value = 'loading';
    error.value = null;
    await refresh();
    if (!unsubscribe) {
      unsubscribe = appEvents.on('history:changed', () => {
        void refresh();
      });
    }
  }

  async function save(input: SaveProgressInput): Promise<HistoryRecord> {
    const record = await historyService.saveProgress(input);
    await refresh();
    return record;
  }

  async function remove(id: string): Promise<void> {
    await historyService.remove(id);
    await refresh();
  }

  async function clear(): Promise<void> {
    await historyService.clear();
    items.value = [];
    continueWatching.value = [];
    state.value = 'empty';
  }

  function progressOf(sourceId: string, mediaId: string): HistoryRecord | null {
    const id = historyIdOf(sourceId, mediaId);
    return items.value.find((record) => record.id === id) ?? null;
  }

  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    items,
    continueWatching,
    state,
    error,
    load,
    save,
    remove,
    clear,
    progressOf,
    $dispose,
  };
});

export type HistoryStore = ReturnType<typeof useHistoryStore>;
