/**
 * OPT-13：全部源失败时的覆盖缺口披露（store 层）
 *
 * `libraryService.search` 在「所有参与的源都失败」时是**抛错**返回的，正常结果里的
 * `skippedSourceIds / candidates / filteredOut` 随之丢失——错误态下 SearchView 的
 * 「继续搜索剩余 N 个源」既没有数字也没有数据。服务层把这些字段放进 `AppError.meta`，
 * 这里验证 store 会把它们捞回来，并且捞回后「继续搜索」真的只搜那批未启动的源。
 */
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/shared/errors';
import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { useLibraryStore } from '@/stores/libraryStore';
import type { SearchResult } from '@/types';
import { resetAll } from './helpers';

function allFailedError(meta: Record<string, unknown>): AppError {
  return new AppError('E_NETWORK', '全部源搜索失败', { meta });
}

describe('libraryStore.search 全失败态（OPT-13）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('错误态下从 meta 回填 skipped / candidates / filteredOut', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search').mockRejectedValue(
      allFailedError({
        skippedSourceIds: ['s9', 's10'],
        candidates: 12,
        filteredOut: 3,
        failedSourceIds: ['s1'],
      }),
    );

    await store.search(' 庆余年 ');

    expect(store.searchState).toBe('error');
    expect(store.error?.code).toBe('E_NETWORK');
    expect(store.searchSkippedIds).toEqual(['s9', 's10']);
    expect(store.searchCandidates).toBe(12);
    expect(store.searchFilteredOut).toBe(3);
  });

  it('回填后「继续搜索剩余」只搜未启动的源', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search')
      .mockRejectedValueOnce(allFailedError({ skippedSourceIds: ['s9', 's10'], candidates: 12, filteredOut: 0 }))
      .mockResolvedValueOnce(emptyResult());

    await store.search('庆余年');
    await store.continueSearchSkipped();

    const second = vi.mocked(libraryService.search).mock.calls[1]![0];
    expect(second.sourceIds).toEqual(['s9', 's10']);
    // 已启动过的源被移出 skipped（无论这轮成败）
    expect(store.searchSkippedIds).toEqual([]);
  });

  it('meta 缺失（非全失败抛出的异常）时不把状态改成半披露', async () => {
    const store = useLibraryStore();
    store.searchCandidates = 7;
    store.searchFilteredOut = 2;
    store.searchSkippedIds = ['stale'];
    vi.spyOn(libraryService, 'search').mockRejectedValue(new AppError('E_NETWORK', '离线'));

    await store.search('庆余年');

    expect(store.searchState).toBe('error');
    // skipped 清空（本轮没有任何 skipped 证据），但 candidates/filteredOut 不被伪造
    expect(store.searchSkippedIds).toEqual([]);
    expect(store.searchCandidates).toBe(7);
    expect(store.searchFilteredOut).toBe(2);
  });
});

function emptyResult(): SearchResult {
  return { items: [], sourceIds: [], failed: [], candidates: 0, filteredOut: 0, skippedSourceIds: [], localTruncated: false };
}
