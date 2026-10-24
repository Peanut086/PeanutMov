/**
 * 筛选优化（P0/P1）单测：
 * 1. `filterDimensionsOf`：TVBox `filters` 配置 → 服务端筛选维度；
 * 2. `categoriesOf` 把维度挂到对应分类；
 * 3. 本地筛选的聚合分页：跨原始页凑满一页、翻页不重不漏、hasMore 正确。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_ITEMS } from '@/data/demo/demoCatalog';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { categoriesOf, filterDimensionsOf } from '@/sources/site/tvboxNormalize';
import type { TvboxListResponse } from '@/sources/site/tvboxTypes';
import { libraryService, resetAggregateState } from '@/services/libraryService';
import { sourceRegistry } from '@/sources/registry';
import type { LibraryFilters } from '@/types';

import { resetAll } from './helpers';

const NO_FILTERS: LibraryFilters = { type: null, yearFrom: null, yearTo: null, area: null };

const FILTER_RESPONSE: TvboxListResponse = {
  class: [
    { type_id: 1, type_name: '电影' },
    { type_id: 2, type_name: '剧集' },
  ],
  filters: {
    '1': [
      {
        key: 'class',
        name: '类型',
        value: [
          { n: '全部', v: '' },
          { n: '喜剧', v: '喜剧' },
        ],
      },
      {
        key: 'by',
        name: '排序',
        value: [
          { n: '时间', v: 'time' },
          { n: '人气', v: 'hits' },
        ],
      },
    ],
    '2': [{ key: '', name: '坏维度', value: [{ n: 'x', v: 'x' }] }],
  },
};

describe('filterDimensionsOf（TVBox filters 配置解析）', () => {
  it('解析出维度与选项；v 为空的“全部”选项丢弃（取消选中即不限）', () => {
    const dims = filterDimensionsOf(FILTER_RESPONSE, '1');
    expect(dims).not.toBeNull();
    expect(dims).toHaveLength(2);
    expect(dims?.[0]).toEqual({
      key: 'class',
      name: '类型',
      options: [{ value: '喜剧', label: '喜剧' }],
    });
    expect(dims?.[1]?.key).toBe('by');
  });

  it('缺 key 的维度丢弃；全坏返回 null（UI 回退本地模式）', () => {
    expect(filterDimensionsOf(FILTER_RESPONSE, '2')).toBeNull();
    expect(filterDimensionsOf(FILTER_RESPONSE, '404')).toBeNull();
    expect(filterDimensionsOf(null, '1')).toBeNull();
  });

  it('categoriesOf 把维度挂到对应分类', () => {
    const source = { id: 's1' } as never;
    const cats = categoriesOf(source, FILTER_RESPONSE.class, FILTER_RESPONSE);
    expect(cats).toHaveLength(2);
    expect(cats[0]?.filters?.[0]?.key).toBe('class');
    expect(cats[0]?.filters).toHaveLength(2);
    expect(cats[1]?.filters).toBeNull();
  });
});

describe('browse 本地筛选聚合分页', () => {
  beforeEach(async () => {
    await resetAll();
    resetAggregateState();
    await seedDemoData();
  });

  it('源不支持服务端筛选时：跨原始页凑满一页，翻页不重不漏，hasMore 正确', async () => {
    const adapter = sourceRegistry.get('demo');
    const RAW_PAGE = 3;
    // 模拟「源只按页返回原始数据，忽略筛选条件」的适配器
    const spy = vi.spyOn(adapter, 'browse').mockImplementation(async (params) => {
      const start = (params.page - 1) * RAW_PAGE;
      const slice = DEMO_ITEMS.slice(start, start + RAW_PAGE);
      const now = Date.now();
      return {
        items: slice.map((seed) => ({
          id: `${DEMO_SOURCE_ID}:${seed.itemId}`,
          sourceId: DEMO_SOURCE_ID,
          sourceItemId: seed.itemId,
          title: seed.title,
          originalTitle: null,
          type: seed.type,
          year: seed.year,
          area: seed.area,
          genres: [],
          tags: [],
          rating: null,
          posterUrl: null,
          backdropUrl: null,
          description: null,
          durationSec: null,
          episodeCount: null,
          titleLower: seed.title.toLowerCase(),
          isDemo: true,
          cachedAt: now,
          updatedAt: now,
        })),
        page: params.page,
        pageSize: RAW_PAGE,
        total: DEMO_ITEMS.length,
        hasMore: start + RAW_PAGE < DEMO_ITEMS.length,
      };
    });

    const filters: LibraryFilters = { ...NO_FILTERS, type: 'movie' };
    const expected = DEMO_ITEMS.filter((seed) => seed.type === 'movie');

    const page1 = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters,
      page: 1,
      pageSize: 5,
    });
    expect(page1.items).toHaveLength(5);
    expect(page1.items.every((item) => item.type === 'movie')).toBe(true);
    expect(page1.hasMore).toBe(true);
    // 一页 5 条来自 2 个原始页（3+3）
    expect(spy).toHaveBeenCalledTimes(2);

    const page2 = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters,
      page: 2,
      pageSize: 5,
    });
    const ids1 = new Set(page1.items.map((item) => item.id));
    expect(page2.items.every((item) => !ids1.has(item.id))).toBe(true);
    expect(page2.items.every((item) => item.type === 'movie')).toBe(true);

    // 全部翻完后无重叠无遗漏（含第 1 页）
    const allIds = [...page1.items.map((i) => i.id)];
    const rest: string[] = [...page2.items.map((i) => i.id)];
    let hasMore = page2.hasMore;
    let page = 2;
    while (hasMore && page < 10) {
      page += 1;
      const next = await libraryService.browse({
        sourceId: DEMO_SOURCE_ID,
        categoryId: null,
        filters,
        page,
        pageSize: 5,
      });
      for (const id of next.items.map((i) => i.id)) {
        expect(allIds).not.toContain(id);
        expect(rest).not.toContain(id);
        rest.push(id);
      }
      hasMore = next.hasMore;
    }
    expect([...allIds, ...rest].sort()).toEqual(
      expected.map((seed) => `${DEMO_SOURCE_ID}:${seed.itemId}`).sort(),
    );
    expect(hasMore).toBe(false);

    spy.mockRestore();
  });

  it('筛选结果不足一页且源已拉尽：hasMore=false', async () => {
    const result = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters: { ...NO_FILTERS, type: 'movie', area: '不存在的地区' },
      page: 1,
      pageSize: 10,
    });
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it('无本地筛选时不走聚合（单次回源）', async () => {
    const adapter = sourceRegistry.get('demo');
    const spy = vi.spyOn(adapter, 'browse');
    await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters: { ...NO_FILTERS, ext: { class: '喜剧' } },
      page: 1,
      pageSize: 5,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0].filters.ext).toEqual({ class: '喜剧' });
    spy.mockRestore();
  });
});
