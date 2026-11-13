import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appEvents } from '@/services/events';
import type { HistoryRecord, SaveProgressInput } from '@/types';

/**
 * 播放期历史双刷新：一次写入只读一遍。
 *
 * 缺陷链：进度每 10s 落一次库，而一次落库要付两遍全量读——
 * `historyStore.save()` 自己 `await refresh()`，`saveProgress` 里 emit 的
 * `history:changed` 又触发一次 `refresh()`；每次 refresh 内部再分别调
 * `list()`（listAll 500 条）和 `listContinueWatching()`（又一次 listAll 500 条）。
 *
 * （读库次数与演示判定的批量回查在 `historyContinueWatchingBatch.spec.ts` 里测，
 * 那个文件不 mock `historyService`，才能跑真实实现。）
 */

const listWithContinueWatching = vi.fn();
const saveProgress = vi.fn();

vi.mock('@/services/historyService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/historyService')>();
  return {
    ...actual,
    historyService: {
      ...actual.historyService,
      listWithContinueWatching: (limit?: number) => listWithContinueWatching(limit),
      saveProgress: (input: SaveProgressInput) => saveProgress(input),
    },
  };
});

import { historyService } from '@/services/historyService';
import { useHistoryStore } from '@/stores/historyStore';

type Snapshot = { items: HistoryRecord[]; continueWatching: HistoryRecord[] };

function record(mediaId: string, updatedAt: number): HistoryRecord {
  return {
    id: `src-1:${mediaId}`,
    sourceId: 'src-1',
    mediaId,
    episodeId: `${mediaId}:e1`,
    episodeNumber: 1,
    title: `影片 ${mediaId}`,
    posterUrl: null,
    positionSec: 120,
    durationSec: 600,
    progress: 0.2,
    finished: false,
    totalEpisodes: 1,
    createdAt: updatedAt,
    updatedAt,
  };
}

function snapshot(items: HistoryRecord[]): Snapshot {
  return { items, continueWatching: items.filter((row) => !row.finished) };
}

function inputFor(mediaId: string): SaveProgressInput {
  return {
    sourceId: 'src-1',
    mediaId,
    episodeId: `${mediaId}:e1`,
    episodeNumber: 1,
    title: `影片 ${mediaId}`,
    posterUrl: null,
    positionSec: 120,
    durationSec: 600,
    totalEpisodes: 1,
    mediaSnapshot: { sourceItemId: mediaId, type: 'movie', year: null, episodeCount: null, originalTitle: null },
  };
}

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('历史 store 刷新合并（一次写入一遍读）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    appEvents.clear();
    vi.clearAllMocks();
    listWithContinueWatching.mockResolvedValue(snapshot([]));
  });

  it('save 一次只读一遍（订阅与收尾共用同一次刷新）', async () => {
    const store = useHistoryStore();
    await store.load();
    expect(listWithContinueWatching).toHaveBeenCalledTimes(1);

    // 生产代码里 emit 发生在落库之后、返回之前
    saveProgress.mockImplementation(async (input: SaveProgressInput) => {
      const row = record(input.mediaId, 2_000);
      listWithContinueWatching.mockResolvedValueOnce(snapshot([row]));
      appEvents.emit('history:changed', { id: row.id });
      return row;
    });

    await store.save(inputFor('m1'));
    expect(listWithContinueWatching).toHaveBeenCalledTimes(2);
    expect(store.items.map((row) => row.id)).toEqual(['src-1:m1']);
    expect(store.continueWatching.map((row) => row.id)).toEqual(['src-1:m1']);
  });

  it('并发写入：后一次折叠进在飞的读取，收尾补读保证不丢', async () => {
    const store = useHistoryStore();
    await store.load();
    listWithContinueWatching.mockClear();

    const first = defer<Snapshot>();
    const second = defer<Snapshot>();
    listWithContinueWatching.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    saveProgress.mockImplementation(async (input: SaveProgressInput) => {
      appEvents.emit('history:changed', { id: `src-1:${input.mediaId}` });
      return record(input.mediaId, 2_000);
    });

    const a = store.save(inputFor('m1'));
    expect(listWithContinueWatching).toHaveBeenCalledTimes(1);

    const b = store.save(inputFor('m2'));
    first.resolve(snapshot([record('m1', 2_000)]));
    // 折叠进来的那次必须补读，否则 m2 永远看不见
    await vi.waitFor(() => expect(listWithContinueWatching).toHaveBeenCalledTimes(2));
    second.resolve(snapshot([record('m1', 2_000), record('m2', 2_000)]));
    await Promise.all([a, b]);

    expect(store.items.map((row) => row.id)).toEqual(['src-1:m1', 'src-1:m2']);
  });

  it('刷新失败后仍能继续刷新（在飞标记一定被清掉）', async () => {
    const store = useHistoryStore();
    await store.load();

    listWithContinueWatching.mockRejectedValueOnce(new Error('boom'));
    appEvents.emit('history:changed', { id: null });
    await vi.waitFor(() => expect(store.state).toBe('error'));

    listWithContinueWatching.mockResolvedValueOnce(snapshot([record('m3', 2_000)]));
    appEvents.emit('history:changed', { id: 'src-1:m3' });
    await vi.waitFor(() => expect(store.state).toBe('success'));
    expect(store.items.map((row) => row.id)).toEqual(['src-1:m3']);
  });

  it('没装订阅时退回自己读一遍（空态不会被守卫吞掉）', async () => {
    const store = useHistoryStore();
    // 不调用 load()：没有 `history:changed` 订阅，事件也无人接
    saveProgress.mockImplementation(async (input: SaveProgressInput) => {
      appEvents.emit('history:changed', { id: `src-1:${input.mediaId}` });
      return record(input.mediaId, 2_000);
    });
    listWithContinueWatching.mockResolvedValueOnce(snapshot([record('m9', 2_000)]));

    await store.save(inputFor('m9'));
    expect(store.items.map((row) => row.id)).toEqual(['src-1:m9']);
  });

  it('remove 同样只读一遍', async () => {
    const store = useHistoryStore();
    await store.load();
    listWithContinueWatching.mockClear();

    const remove = vi.spyOn(historyService, 'remove').mockImplementation(async (id: string) => {
      appEvents.emit('history:changed', { id });
      listWithContinueWatching.mockResolvedValueOnce(snapshot([]));
    });

    await store.remove('src-1:m1');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(listWithContinueWatching).toHaveBeenCalledTimes(1);
    expect(store.items).toHaveLength(0);
  });
});
