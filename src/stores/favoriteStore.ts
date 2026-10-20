/**
 * 收藏 Store（API-14）
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { favoriteService } from '@/services/favoriteService';
import { appEvents } from '@/services/events';
import { toErrorShape } from '@/shared/errors';
import { historyIdOf } from '@/shared/id';
import type { AppErrorShape, FavoriteInput, FavoriteRecord, LoadState } from '@/types';

export const useFavoriteStore = defineStore('favorite', () => {
  const items = ref<FavoriteRecord[]>([]);
  const state = ref<LoadState>('idle');
  const order = ref<'created' | 'title'>('created');
  const error = ref<AppErrorShape | null>(null);

  let unsubscribe: (() => void) | null = null;

  async function refresh(): Promise<void> {
    try {
      const rows = await favoriteService.list(order.value);
      items.value = rows;
      state.value = rows.length === 0 ? 'empty' : 'success';
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      state.value = 'error';
    }
  }

  async function load(nextOrder?: 'created' | 'title'): Promise<void> {
    if (nextOrder && nextOrder !== order.value) order.value = nextOrder;
    state.value = 'loading';
    error.value = null;
    await refresh();
    if (!unsubscribe) {
      unsubscribe = appEvents.on('favorites:changed', () => {
        void refresh();
      });
    }
  }

  function isFavorite(sourceId: string, mediaId: string): boolean {
    const id = historyIdOf(sourceId, mediaId);
    return items.value.some((record) => record.id === id);
  }

  async function toggle(input: FavoriteInput): Promise<boolean> {
    const sourceExists = true;
    const result = await favoriteService.toggle(input, sourceExists);
    await refresh();
    return result.favorited;
  }

  async function remove(id: string): Promise<void> {
    await favoriteService.remove(id);
    await refresh();
  }

  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    items,
    state,
    order,
    error,
    load,
    isFavorite,
    toggle,
    remove,
    $dispose,
  };
});

export type FavoriteStore = ReturnType<typeof useFavoriteStore>;
