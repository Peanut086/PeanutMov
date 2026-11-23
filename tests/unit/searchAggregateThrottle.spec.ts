/**
 * P1-5（D18）：搜索分组重算节流
 *
 * 旧口径下渐进回调每到一个源就整体替换 `searchResultsAll`，`searchGroups` 立刻重跑
 * 「去重 + 分组 + 三级排序」；96 源扇出时这是搜索期间主线程长任务的集中来源。
 * 新口径把追加按 `SEARCH_AGGREGATE_MERGE_MS` 合并成一批，同时保证：
 * 1. 窗口内多次追加只重算一次（不是每次追加一轮全量计算）；
 * 2. 终态精确——搜索结束、扩展命中、清空/换词这些"要被人看见"的时刻不等窗口；
 * 3. 分批只改时机，不改结果：终态与"直接对全量条目分组"的分组口径一致，与到达顺序无关。
 */
import { createPinia, setActivePinia } from 'pinia';
import { watchEffect, type WatchStopHandle } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stats = vi.hoisted(() => ({ groupCalls: 0 }));

vi.mock('@/services/searchAggregate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/searchAggregate')>();
  return {
    ...actual,
    groupSearchResults: (
      ...args: Parameters<typeof actual.groupSearchResults>
    ): ReturnType<typeof actual.groupSearchResults> => {
      stats.groupCalls += 1;
      return actual.groupSearchResults(...args);
    },
  };
});

import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSourceStore } from '@/stores/sourceStore';
import { SEARCH_AGGREGATE_MERGE_MS } from '@/shared/constants';
import type { MediaItem, SearchResult, SearchResultGroup, Source } from '@/types';
import { resetAll, tick } from './helpers';

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

function makeSource(id: string): Source {
  return {
    id,
    key: id,
    name: id,
    type: 'site',
    enabled: true,
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

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    items: [],
    sourceIds: ['s1'],
    failed: [],
    candidates: 1,
    filteredOut: 0,
    skippedSourceIds: [],
    ...overrides,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 把 `libraryService.search` 换成"手动喂渐进结果、手动收束"的管子 */
function stubSearch() {
  let emit: ((sourceId: string, items: MediaItem[]) => void) | null = null;
  let settleWith: ((result: SearchResult) => void) | null = null;
  vi.spyOn(libraryService, 'search').mockImplementation(
    (params) =>
      new Promise<SearchResult>((resolve) => {
        emit = (sourceId, items) =>
          params.onPartial?.({ sourceId, items, error: null, done: 1, total: 3 });
        settleWith = resolve;
      }),
  );
  return {
    emit(sourceId: string, items: MediaItem[]): void {
      emit?.(sourceId, items);
    },
    settle(searchResult: SearchResult): void {
      settleWith?.(searchResult);
    },
  };
}

/** 模拟渲染期订阅：SearchView 会读 `searchGroups`，正是它驱动了重算 */
function renderGroups(store: ReturnType<typeof useLibraryStore>): WatchStopHandle {
  return watchEffect(() => {
    void store.searchGroups.length;
  });
}

/** 分组口径（组 + 组成员），不含"同分时按插入序"这一表现层细节 */
function groupShape(groups: SearchResultGroup[]): string[] {
  return groups
    .map((group) => `${group.key}=>[${group.items.map((item) => item.id).sort().join(',')}]`)
    .sort();
}

beforeEach(async () => {
  vi.clearAllMocks();
  stats.groupCalls = 0;
  await resetAll();
  settingsService.__resetCache();
  setActivePinia(createPinia());
  useSourceStore().sources = [makeSource('s1'), makeSource('s2')];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('搜索分组重算的合并窗口（P1-5）', () => {
  it('窗口内的多次渐进追加只重算一次，而不是每次追加全量重算', async () => {
    const store = useLibraryStore();
    const stop = renderGroups(store);
    const pipe = stubSearch();

    const pending = store.search('庆余年');
    await tick();
    stats.groupCalls = 0;

    const batches = [
      [makeItem('s1', '庆余年')],
      [makeItem('s2', '庆余年 第二季')],
      [makeItem('s1', '庆余年 第三季')],
      [makeItem('s2', '庆余年 第四季')],
    ];
    for (const batch of batches) {
      pipe.emit('s1', batch);
      await tick();
    }
    // 4 次追加都落在同一个窗口里：此刻一次重算都不该发生
    expect(stats.groupCalls).toBe(0);

    await sleep(SEARCH_AGGREGATE_MERGE_MS + 60);
    expect(stats.groupCalls).toBe(1);
    expect(store.searchGroups).toHaveLength(4);

    pipe.settle(result());
    await pending;
    expect(store.searchState).toBe('success');
    stop();
  });

  it('搜索结束立刻对齐终态，最后一批不必再等一个窗口', async () => {
    const store = useLibraryStore();
    const stop = renderGroups(store);
    const pipe = stubSearch();

    const pending = store.search('庆余年');
    await tick();
    pipe.emit('s1', [makeItem('s1', '庆余年')]);
    await tick();
    pipe.settle(result({ items: [makeItem('s2', '庆余年 第二季')] }));
    await pending;

    // 同步读：合并窗口还没到点，终态也必须已经是全量
    expect(store.searchState).toBe('success');
    expect(store.searchResultsAll).toHaveLength(2);
    expect(store.searchResults).toHaveLength(2);
    stop();
  });

  it('分批只改时机不改结果：终态与直接分组一致，且与到达顺序无关', async () => {
    const { groupSearchResults } = await vi.importActual<
      typeof import('@/services/searchAggregate')
    >('@/services/searchAggregate');
    const batchA = [makeItem('s1', '庆余年'), makeItem('s2', '庆余年 第二季')];
    const batchB = [makeItem('s1', '庆余年 第三季')];

    async function runInOrder(batches: MediaItem[][]): Promise<SearchResultGroup[]> {
      setActivePinia(createPinia());
      useSourceStore().sources = [makeSource('s1'), makeSource('s2')];
      const scoped = useLibraryStore();
      const pipe = stubSearch();
      const pending = scoped.search('庆余年');
      await tick();
      for (const batch of batches) {
        pipe.emit('s1', batch);
        await tick();
      }
      pipe.settle(result());
      await pending;
      return scoped.searchGroups;
    }

    const forward = await runInOrder([batchA, batchB]);
    const backward = await runInOrder([batchB, batchA]);

    expect(groupShape(forward)).toEqual(groupShape(backward));
    expect(groupShape(forward)).toEqual(
      groupShape(
        groupSearchResults(
          [...batchA, ...batchB],
          '庆余年',
          () => 'unknown',
          () => null,
          () => 'unknown',
        ),
      ),
    );
  });

  it('换词与清空当场归零，不把上一词的结果留给新词', async () => {
    const store = useLibraryStore();
    const stop = renderGroups(store);
    const pipe = stubSearch();

    const pending = store.search('庆余年');
    await tick();
    pipe.emit('s1', [makeItem('s1', '庆余年')]);
    await tick();
    pipe.settle(result());
    await pending;
    expect(store.searchGroups).toHaveLength(1);

    const next = stubSearch();
    const pending2 = store.search('繁花');
    await tick();
    expect(store.searchResultsAll).toEqual([]);
    expect(store.searchGroups).toEqual([]);

    next.settle(result());
    await pending2;
    store.clearSearch();
    expect(store.searchGroups).toEqual([]);
    stop();
  });

  it('空结果扩展命中后当场可见，不再多等一个合并窗口', async () => {
    const store = useLibraryStore();
    const stop = renderGroups(store);
    vi.spyOn(libraryService, 'search').mockImplementation(async (params) => {
      if (params.keyword !== '庆余年第8季') return result();
      return result({ items: [makeItem('s1', '庆余年 第8季')] });
    });

    await store.search('庆余年 第八季');
    expect(store.searchState).toBe('empty');

    await vi.waitFor(() => expect(store.searchExpandedNote).toBe('庆余年第8季'), { timeout: 3000 });
    // 扩展命中即终态：此刻读到的就应该是救回来的那条，而不是 100ms 后的补账
    expect(store.searchResults).toHaveLength(1);
    expect(store.searchState).toBe('success');
    stop();
  });
});
