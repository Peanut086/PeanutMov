import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { useLibraryStore } from '@/stores/libraryStore';
import type { MediaItem, SearchResult } from '@/types';
import { resetAll } from './helpers';

/**
 * C-12：空态尾词建议（store 侧接线）
 *
 * 芯片只在"确实搜过且没结果"时存在：新搜索开始要立刻清空，否则会拿着
 * 上一个关键词的建议让用户点出一次误搜。
 */
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
    candidates: 1,
    filteredOut: 0,
    skippedSourceIds: [],
    ...overrides,
  };
}

describe('libraryStore.searchTailSuggestions（C-12）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('空结果时给出尾词建议，去掉尾字排第一', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search').mockResolvedValue(result());

    await store.search('今天是太阳雨');

    expect(store.searchState).toBe('empty');
    expect(store.searchTailSuggestions).toEqual(['今天是太阳', '今天', '太阳雨']);
  });

  it('命中结果时不留建议', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search').mockImplementation(async (params) => {
      // 走 onPartial：渐进结果直接进 searchResultsAll，不依赖源是否启用
      params.onPartial?.({
        sourceId: 's1',
        items: [makeItem('s1', '今天是太阳雨')],
        error: null,
        done: 1,
        total: 1,
      });
      return result();
    });

    await store.search('今天是太阳雨');

    expect(store.searchState).toBe('success');
    expect(store.searchTailSuggestions).toEqual([]);
  });

  it('新一轮搜索开始时立刻撤掉上一轮的芯片', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search').mockResolvedValue(result());
    await store.search('庆余年');
    expect(store.searchTailSuggestions).toEqual(['庆余']);

    let captured: string[] = [];
    vi.spyOn(libraryService, 'search').mockImplementation(async () => {
      captured = store.searchTailSuggestions;
      return result();
    });

    await store.search('今天是太阳雨');

    expect(captured).toEqual([]);
    expect(store.searchTailSuggestions).toHaveLength(3);
  });

  it('短词没有缩短空间，宁可不显示也不硬凑', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search').mockResolvedValue(result());

    await store.search('三体');

    expect(store.searchTailSuggestions).toEqual([]);
  });
});
