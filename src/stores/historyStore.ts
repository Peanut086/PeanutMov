/**
 * 观看历史 Store（API-14）
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { historyService } from '@/services/historyService';
import { appEvents } from '@/services/events';
import { resolveLatestPlaybackProgress, resolvePlaybackProgress } from '@/services/playbackProgressService';
import type { PlaybackProgressMatch, PlaybackProgressTarget } from '@/services/playbackProgressService';
import { toErrorShape } from '@/shared/errors';
import { historyIdOf } from '@/shared/id';
import type { AppErrorShape, HistoryRecord, LoadState, SaveProgressInput } from '@/types';

export const useHistoryStore = defineStore('history', () => {
  const items = ref<HistoryRecord[]>([]);
  const continueWatching = ref<HistoryRecord[]>([]);
  const state = ref<LoadState>('idle');
  const error = ref<AppErrorShape | null>(null);

  let unsubscribe: (() => void) | null = null;
  /**
   * 在飞的刷新。
   *
   * 事件风暴（连续删除、并发落库）会连着发多个 `history:changed`，每个都要求重读全量。
   * 合并成一次读取；读完后若有折叠进来的调用，说明可能撞上了本轮事务快照之前的写，
   * 再补读一次——宁多多读一轮，也不漏掉写入。
   */
  let running: Promise<void> | null = null;
  let rerunRequested = false;
  /** 订阅在 emit 当时发起的那次刷新，供写完的 `save`/`remove` 直接等它 */
  let eventRefresh: Promise<void> | null = null;

  async function read(): Promise<void> {
    try {
      const { items: all, continueWatching: pending } = await historyService.listWithContinueWatching();
      items.value = all;
      continueWatching.value = pending;
      state.value = all.length === 0 ? 'empty' : 'success';
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      state.value = 'error';
    }
  }

  async function refresh(): Promise<void> {
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      do {
        rerunRequested = false;
        await read();
      } while (rerunRequested);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /**
   * 等「本次写入之后」发起的刷新。
   *
   * 服务的写方法都是「落库 → 同步 emit `history:changed`」，订阅方已经发起了本轮唯一的
   * 读取，这里等它即可；此前 `save`/`remove` 又各自 `await refresh()`，于是播放期每次
   * 进度落库都要读两遍全量（500 条，每条都带 `mediaSnapshot`）。
   * 没有订阅（没调用过 `load()`）时退回自己读一次。
   */
  async function awaitPostWriteRefresh(): Promise<void> {
    const started = eventRefresh;
    eventRefresh = null;
    await (started ?? refresh());
  }

  async function load(): Promise<void> {
    state.value = 'loading';
    error.value = null;
    await refresh();
    if (!unsubscribe) {
      unsubscribe = appEvents.on('history:changed', () => {
        eventRefresh = refresh();
      });
    }
  }

  async function save(input: SaveProgressInput): Promise<HistoryRecord> {
    const record = await historyService.saveProgress(input);
    await awaitPostWriteRefresh();
    return record;
  }

  async function remove(id: string): Promise<void> {
    await historyService.remove(id);
    await awaitPostWriteRefresh();
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

  /** 当前源精确续播优先；无精确记录时再解析其他源的同季同集候选。 */
  function resolveProgress(target: PlaybackProgressTarget): Promise<PlaybackProgressMatch | null> {
    return resolvePlaybackProgress(target, items.value);
  }

  function resolveLatestProgress(target: PlaybackProgressTarget): Promise<PlaybackProgressMatch | null> {
    return resolveLatestPlaybackProgress(target, items.value);
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
    resolveProgress,
    resolveLatestProgress,
    $dispose,
  };
});

export type HistoryStore = ReturnType<typeof useHistoryStore>;
