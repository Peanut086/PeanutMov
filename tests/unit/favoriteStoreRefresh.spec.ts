import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { appEvents } from '@/services/events';
import { historyIdOf } from '@/shared/id';
import type { FavoriteRecord } from '@/types';

/**
 * 收藏 store 全量重读的代次守卫
 *
 * `favorites:changed` 订阅与 `toggle`/`remove` 收尾各自发一次 `favoriteService.list()`，
 * 两次读库的完成顺序不确定：晚到的旧快照会把 `items` 盖回去，♥ 按钮的 `isFavorite`
 * 于是"点完跳一下又跳回来"。修复只认最后一次读取的结果。
 */

const list = vi.fn();
const remove = vi.fn();

vi.mock('@/services/favoriteService', () => ({
  favoriteService: {
    list: (order?: string) => list(order),
    remove: (id: string) => remove(id),
    toggle: vi.fn(),
    add: vi.fn(),
    isFavorite: vi.fn(),
    count: vi.fn(),
    markSourceRemoved: vi.fn(),
  },
}));

import { useFavoriteStore } from '@/stores/favoriteStore';

function makeRecord(sourceId: string, mediaId: string, title: string): FavoriteRecord {
  return {
    id: historyIdOf(sourceId, mediaId),
    sourceId,
    mediaId,
    title,
    posterUrl: null,
    type: 'movie',
    year: 2024,
    sourceRemoved: false,
    createdAt: 1_700_000_000_000,
  };
}

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('收藏 store 重读代次守卫', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    appEvents.clear();
    vi.clearAllMocks();
    remove.mockResolvedValue(undefined);
  });

  it('晚到的旧快照不覆盖新结果（isFavorite 不回跳）', async () => {
    const store = useFavoriteStore();
    list.mockResolvedValue([]);
    await store.load();

    // 订阅已建立：此后的重读分别拿到 stale / fresh 两份快照
    const stale = defer<FavoriteRecord[]>();
    const fresh = defer<FavoriteRecord[]>();
    list.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const first = store.remove('a');
    const second = store.remove('b');
    // 后发起的那次先返回，先发起的那次（stale）最后才返回
    fresh.resolve([makeRecord('src-1', 'm2', '盗梦空间')]);
    await second;
    stale.resolve([]);
    await first;

    expect(store.isFavorite('src-1', 'm2')).toBe(true);
    expect(store.items.map((row) => row.id)).toEqual([historyIdOf('src-1', 'm2')]);
  });

  it('最新一次读取仍会正常落地（守卫没有冻结缓存）', async () => {
    list.mockResolvedValue([makeRecord('src-1', 'm1', '肖申克的救赎')]);
    const store = useFavoriteStore();
    await store.load();
    expect(store.items).toHaveLength(1);

    list.mockResolvedValue([]);
    await store.remove(historyIdOf('src-1', 'm1'));
    expect(store.items).toHaveLength(0);
    expect(store.state).toBe('empty');
  });
});
