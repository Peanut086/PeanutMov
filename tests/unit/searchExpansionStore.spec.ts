import { createPinia, setActivePinia } from 'pinia';
import type { Source } from '@/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSourceStore } from '@/stores/sourceStore';
import type { MediaItem, SearchResult } from '@/types';
import { resetAll, tick } from './helpers';

/**
 * SO-ALIAS：空结果查询扩展的 store 侧接线
 *
 * 口径：只在原词 0 结果时触发；扩展命中才改写结果与状态；
 * 命中的条目仍要过「源存在且启用」过滤；新一轮搜索必须中止旧扩展。
 */
function makeItem(sourceId: string, title: string): MediaItem {
  const now = Date.now();
  return {
    id: `${sourceId}:${title}`,
    sourceId,
    sourceItemId: title,
    title,
    originalTitle: null,
    type: 'series',
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
    candidates: 1,
    filteredOut: 0,
    skippedSourceIds: [],
    localTruncated: false,
    ...overrides,
  };
}

function makeSource(id: string, enabled: boolean): Source {
  return {
    id,
    key: id,
    name: id,
    type: 'spi',
    enabled,
    builtin: false,
    sort: 1,
    baseUrl: 'https://example.com/api.php',
    pathPrefix: null,
    auth: {},
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as Source;
}

describe('libraryStore 查询扩展（SO-ALIAS）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    setActivePinia(createPinia());
    useSourceStore().sources = [makeSource('s1', true)];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('原词 0 结果、扩展词命中：并入结果并标注扩展词', async () => {
    const store = useLibraryStore();
    const calls: string[] = [];
    vi.spyOn(libraryService, 'search').mockImplementation(async (params) => {
      calls.push(params.keyword);
      if (params.keyword === '庆余年第8季') {
        return result({ items: [makeItem('s1', '庆余年 第8季')] });
      }
      return result();
    });

    await store.search('庆余年 第八季');
    // 扩展前的别名查询要读 IndexedDB，命中时刻不确定——waitFor 而不是数 tick
    await vi.waitFor(() => expect(store.searchExpandedNote).toBe('庆余年第8季'), { timeout: 3000 });
    expect(store.searchState).toBe('success');
    expect(store.searchTailSuggestions).toEqual([]);
    expect(store.searchResultsAll.map((item) => item.title)).toContain('庆余年 第8季');
    expect(calls).toContain('庆余年第8季');
  });

  it('原词已有结果：不发起扩展', async () => {
    const store = useLibraryStore();
    const spy = vi.spyOn(libraryService, 'search').mockImplementation(async (params) => {
      if (params.keyword === '庆余年 第八季') {
        params.onPartial?.({
          sourceId: 's1',
          items: [makeItem('s1', '庆余年 第八季')],
          error: null,
          done: 1,
          total: 1,
        });
      }
      return result();
    });

    await store.search('庆余年 第八季');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(spy.mock.calls.map((call) => call[0].keyword)).toEqual(['庆余年 第八季']);
    expect(store.searchExpandedNote).toBeNull();
  });

  it('扩展也无结果：保持空态与尾词建议，不留标注', async () => {
    const store = useLibraryStore();
    const spy = vi.spyOn(libraryService, 'search').mockResolvedValue(result());

    await store.search('庆余年 第八季');
    // 等两个扩展词都发起完再断言，避免残留的 IndexedDB 读拖住下一个 resetAll
    await vi.waitFor(
      () =>
        expect(spy.mock.calls.map((call) => call[0].keyword)).toEqual(
          expect.arrayContaining(['庆余年第8季', '庆余年S8']),
        ),
      { timeout: 3000 },
    );

    expect(store.searchState).toBe('empty');
    expect(store.searchExpandedNote).toBeNull();
    expect(store.searchTailSuggestions.length).toBeGreaterThan(0);
  });

  it('扩展命中但源未启用：不并入，仍为空态', async () => {
    useSourceStore().sources = [makeSource('s1', false)];
    const store = useLibraryStore();
    const spy = vi.spyOn(libraryService, 'search').mockImplementation(async (params) => {
      if (params.keyword === '庆余年第8季') {
        return result({ items: [makeItem('s1', '庆余年 第8季')] });
      }
      return result();
    });

    await store.search('庆余年 第八季');
    await vi.waitFor(
      () =>
        expect(spy.mock.calls.map((call) => call[0].keyword)).toEqual(
          expect.arrayContaining(['庆余年第8季', '庆余年S8']),
        ),
      { timeout: 3000 },
    );

    expect(store.searchState).toBe('empty');
    expect(store.searchExpandedNote).toBeNull();
    expect(store.searchResultsAll).toEqual([]);
  });

  it('新一轮搜索开始时中止进行中的扩展', async () => {
    const store = useLibraryStore();
    let expansionSignal: AbortSignal | null = null;
    let settleExpansion: ((value: SearchResult) => void) | null = null;
    vi.spyOn(libraryService, 'search').mockImplementation((params) => {
      if (params.keyword === '庆余年 第八季') return Promise.resolve(result());
      if (params.keyword === '庆余年第8季') {
        expansionSignal = params.signal ?? null;
        return new Promise<SearchResult>((resolve) => {
          settleExpansion = resolve;
        });
      }
      return Promise.resolve(result());
    });

    await store.search('庆余年 第八季');
    await vi.waitFor(() => expect(expansionSignal).not.toBeNull(), { timeout: 3000 });

    await store.search('三体');

    // 闭包赋值不更新 TS 收窄，读取处显式回类型
    expect((expansionSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(store.searchExpandedNote).toBeNull();

    // 让被中止的扩展扇出落地（aborted 后直接 return），不给下一个 resetAll 留尾巴
    (settleExpansion as ((value: SearchResult) => void) | null)?.(result());
    await tick();
  });
});
