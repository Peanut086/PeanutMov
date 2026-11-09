/**
 * OPT-04：只重试失败源（store 层）
 *
 * 覆盖 `libraryStore.retryFailedSources()`：
 * - 只把失败源 id 传给 `libraryService.search`（`sourceIds` + `forceAll`），不重查全部
 * - 失败源去重
 * - 前置守卫：无关键词 / 无失败源 / 正在重试 / 主搜索进行中 时零请求
 * - 新结果合并且不重复；仍失败的源保留；重试整体失败时给 toast 反馈
 */
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useLibraryStore } from '@/stores/libraryStore';
import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { appEvents } from '@/services/events';
import type { AppErrorShape, MediaItem, SearchResult } from '@/types';
import { resetAll } from './helpers';

function err(code: string, message = '搜索失败'): AppErrorShape {
  return { code, message, detail: null, retryable: true, httpStatus: null } as AppErrorShape;
}

function makeItem(sourceId: string, title: string): MediaItem {
  const now = Date.now();
  return {
    id: `${sourceId}:${title}`,
    sourceId,
    sourceItemId: title,
    title,
    originalTitle: null,
    type: 'movie',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: title.toLowerCase(),
    isDemo: false,
    cachedAt: now,
    updatedAt: now,
  } as MediaItem;
}

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    items: [],
    sourceIds: [],
    failed: [],
    candidates: 0,
    filteredOut: 0,
    skippedSourceIds: [],
    ...overrides,
  };
}

describe('libraryStore.retryFailedSources（OPT-04）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('只重试失败的源：sourceIds 去重 + forceAll + 当前关键词', async () => {
    const store = useLibraryStore();
    store.searchKeyword = ' 庆余年 ';
    store.searchFailed = [
      { sourceId: 's1', error: err('E_TIMEOUT') },
      { sourceId: 's2', error: err('E_NETWORK') },
      { sourceId: 's1', error: err('E_TIMEOUT') },
    ];
    const spy = vi.spyOn(libraryService, 'search').mockResolvedValue(result());

    await store.retryFailedSources();

    expect(spy).toHaveBeenCalledTimes(1);
    const params = spy.mock.calls[0]![0];
    expect(params.sourceIds).toEqual(['s1', 's2']);
    expect(params.forceAll).toBe(true);
    expect(params.keyword).toBe('庆余年');
    // 不带 onPartial：重试是补齐动作，不需要再走一遍渐进回调
    expect(params.onPartial).toBeUndefined();
  });

  it('没有失败源时零请求', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '庆余年';
    const spy = vi.spyOn(libraryService, 'search');

    await store.retryFailedSources();

    expect(spy).not.toHaveBeenCalled();
  });

  it('关键词为空时零请求（避免把空串打到所有失败源）', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '   ';
    store.searchFailed = [{ sourceId: 's1', error: err('E_TIMEOUT') }];
    const spy = vi.spyOn(libraryService, 'search');

    await store.retryFailedSources();

    expect(spy).not.toHaveBeenCalled();
  });

  it('正在重试时重复点击不会并发请求', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '庆余年';
    store.searchFailed = [{ sourceId: 's1', error: err('E_TIMEOUT') }];
    store.searchRetrying = true;
    const spy = vi.spyOn(libraryService, 'search');

    await store.retryFailedSources();

    expect(spy).not.toHaveBeenCalled();
  });

  it('主搜索进行中（loading）时不插队', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '庆余年';
    store.searchState = 'loading';
    store.searchFailed = [{ sourceId: 's1', error: err('E_TIMEOUT') }];
    const spy = vi.spyOn(libraryService, 'search');

    await store.retryFailedSources();

    expect(spy).not.toHaveBeenCalled();
  });

  it('成功：新结果合并、已有条目去重、仍失败的源保留在失败列表', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '庆余年';
    store.searchState = 'success';
    store.searchResultsAll = [makeItem('s1', '庆余年')];
    store.searchFailed = [
      { sourceId: 's1', error: err('E_TIMEOUT') },
      { sourceId: 's2', error: err('E_TIMEOUT') },
    ];
    vi.spyOn(libraryService, 'search').mockResolvedValue(
      result({
        // s1 翻案成功；s2 仍失败；带一条重复标题（不应重复出现）
        items: [makeItem('s1', '庆余年'), makeItem('s1', '庆余年 第二季')],
        sourceIds: ['s1'],
        failed: [{ sourceId: 's2', error: err('E_TIMEOUT') }],
        candidates: 2,
      }),
    );

    await store.retryFailedSources();

    expect(store.searchRetrying).toBe(false);
    expect(store.searchFailed).toEqual([{ sourceId: 's2', error: expect.objectContaining({ code: 'E_TIMEOUT' }) }]);
    // 平铺列表（原始）按标题去重：已有「庆余年」不重复插入，新片名照常追加
    expect(store.searchResultsAll).toHaveLength(2);
    expect(store.searchResultsAll.map((item) => item.title)).toEqual(['庆余年', '庆余年 第二季']);
    // 聚合视图：同根标题归为一组，只返回代表条目
    expect(store.searchResults).toHaveLength(1);
    expect(store.searchState).toBe('success');
  });

  it('全部翻案：失败列表清空，结果非空 → success', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '庆余年';
    store.searchState = 'success';
    store.searchResultsAll = [makeItem('s9', '其它片')];
    store.searchFailed = [{ sourceId: 's1', error: err('E_TIMEOUT') }];
    vi.spyOn(libraryService, 'search').mockResolvedValue(result({ items: [makeItem('s1', '庆余年')] }));

    await store.retryFailedSources();

    expect(store.searchFailed).toEqual([]);
    expect(store.searchResults).toHaveLength(2);
    expect(store.searchState).toBe('success');
  });

  it('重试整体失败（服务抛错）：保留失败列表并 toast，不把页面打成 error 白屏', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '庆余年';
    store.searchState = 'success';
    store.searchResultsAll = [makeItem('s9', '其它片')];
    const failed = [{ sourceId: 's1', error: err('E_NETWORK') }];
    store.searchFailed = failed;
    const toasts: string[] = [];
    const off = appEvents.on('toast', (payload) => {
      toasts.push((payload as { text: string }).text);
    });
    vi.spyOn(libraryService, 'search').mockRejectedValue(err('E_NETWORK', '全都挂了'));

    await store.retryFailedSources();
    off();

    expect(store.searchRetrying).toBe(false);
    expect(store.searchFailed).toEqual(failed);
    expect(store.searchResults).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain('重试失败源');
  });
});
