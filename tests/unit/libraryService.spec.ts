/**
 * 媒体库服务单测（BUG-01：分类切换未过滤）
 *
 * 覆盖点：
 * 1. 按分类浏览必须回源适配器，返回条数 < 全量且每条类型与分类一致；
 * 2. 回到「全部」（categoryId = null）且无筛选时命中第 1 页缓存快速路径（不调用 adapter.browse）；
 * 3. 离线 + 分类非空：`MediaItem` 无分类字段，缓存无法还原分类维度 → 明确 E_NETWORK（离线态），不得返回全量；
 * 4. 离线 + 「全部」：仍按 AC-27 返回缓存。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_CATEGORIES, DEMO_ITEMS } from '@/data/demo/demoCatalog';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { libraryService } from '@/services/libraryService';
import { sourceService } from '@/services/sourceService';
import { sourceRegistry } from '@/sources/registry';
import { categoryIdFor } from '@/sources/base/normalize';
import { PAGE_SIZE } from '@/shared/constants';
import type { LibraryFilters, MediaType } from '@/types';

import { resetAll } from './helpers';

const NO_FILTERS: LibraryFilters = { type: null, yearFrom: null, yearTo: null, area: null };

function categoryIdOf(value: string): string {
  return categoryIdFor(DEMO_SOURCE_ID, value);
}

function expectedCount(type: MediaType): number {
  return DEMO_ITEMS.filter((seed) => seed.type === type).length;
}

/** 覆盖 navigator.onLine（happy-dom 默认恒为 true） */
function setOnline(online: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
}

describe('媒体库服务 browse（BUG-01 分类过滤）', () => {
  beforeEach(async () => {
    await resetAll();
    setOnline(true);
    await seedDemoData();
  });

  afterEach(() => {
    setOnline(true);
  });

  it('第 1 页「全部」返回全部演示条目（基线 12 条）', async () => {
    const result = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters: NO_FILTERS,
      page: 1,
      pageSize: PAGE_SIZE,
    });
    expect(result.items).toHaveLength(DEMO_ITEMS.length);
    expect(result.total).toBe(DEMO_ITEMS.length);
    expect(result.hasMore).toBe(false);
  });

  it('按分类浏览回源适配器：条数 < 全量且每条类型匹配', async () => {
    const all = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters: NO_FILTERS,
      page: 1,
      pageSize: PAGE_SIZE,
    });

    for (const category of DEMO_CATEGORIES) {
      const result = await libraryService.browse({
        sourceId: DEMO_SOURCE_ID,
        categoryId: categoryIdOf(category.value),
        filters: NO_FILTERS,
        page: 1,
        pageSize: PAGE_SIZE,
      });

      expect(result.items.length).toBe(expectedCount(category.value as MediaType));
      expect(result.items.length).toBeLessThan(all.items.length);
      expect(result.items.every((item) => item.type === category.value)).toBe(true);
      expect(result.total).toBe(result.items.length);
    }
  });

  it('分类 + 筛选同时生效（电影 + 年份区间）', async () => {
    const result = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: categoryIdOf('movie'),
      filters: { ...NO_FILTERS, yearFrom: 2010 },
      page: 1,
      pageSize: PAGE_SIZE,
    });
    const expected = DEMO_ITEMS.filter((seed) => seed.type === 'movie' && seed.year !== null && seed.year >= 2010);
    expect(result.items.map((item) => item.sourceItemId).sort()).toEqual(
      expected.map((seed) => seed.itemId).sort(),
    );
  });

  it('回到「全部」命中第 1 页缓存快速路径（不调用 adapter.browse）', async () => {
    const adapter = sourceRegistry.get('demo');
    const browseSpy = vi.spyOn(adapter, 'browse');

    // 先按分类浏览：必须回源一次
    const movies = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: categoryIdOf('movie'),
      filters: NO_FILTERS,
      page: 1,
      pageSize: PAGE_SIZE,
    });
    expect(movies.items.every((item) => item.type === 'movie')).toBe(true);
    expect(browseSpy).toHaveBeenCalledTimes(1);

    // 切回「全部」：缓存新鲜 → 快速路径，不再回源
    const back = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters: NO_FILTERS,
      page: 1,
      pageSize: PAGE_SIZE,
    });
    expect(browseSpy).toHaveBeenCalledTimes(1);
    expect(back.items).toHaveLength(DEMO_ITEMS.length);
  });

  it('离线 + 「全部」仍返回缓存（AC-27），且不回源', async () => {
    const browseSpy = vi.spyOn(sourceRegistry.get('demo'), 'browse');
    setOnline(false);

    const result = await libraryService.browse({
      sourceId: DEMO_SOURCE_ID,
      categoryId: null,
      filters: NO_FILTERS,
      page: 1,
      pageSize: PAGE_SIZE,
      refresh: true,
    });
    expect(result.items).toHaveLength(DEMO_ITEMS.length);
    expect(browseSpy).not.toHaveBeenCalled();
  });

  it('离线 + 分类非空：抛 E_NETWORK 明确离线态，不返回全量', async () => {
    const browseSpy = vi.spyOn(sourceRegistry.get('demo'), 'browse');
    setOnline(false);

    await expect(
      libraryService.browse({
        sourceId: DEMO_SOURCE_ID,
        categoryId: categoryIdOf('movie'),
        filters: NO_FILTERS,
        page: 1,
        pageSize: PAGE_SIZE,
        refresh: true,
      }),
    ).rejects.toMatchObject({ code: 'E_NETWORK' });

    // 错误文案需明确是"离线无法按分类浏览"，而不是泛化的网络提示
    await expect(
      libraryService.browse({
        sourceId: DEMO_SOURCE_ID,
        categoryId: categoryIdOf('movie'),
        filters: NO_FILTERS,
        page: 1,
        pageSize: PAGE_SIZE,
        refresh: true,
      }),
    ).rejects.toThrow(/离线/);

    expect(browseSpy).not.toHaveBeenCalled();
  });

  it('离线 + 分类非空（另一分类）同样抛 E_NETWORK', async () => {
    setOnline(false);
    await expect(
      libraryService.browse({
        sourceId: DEMO_SOURCE_ID,
        categoryId: categoryIdOf('anime'),
        filters: NO_FILTERS,
        page: 1,
        pageSize: PAGE_SIZE,
      }),
    ).rejects.toMatchObject({ code: 'E_NETWORK' });
  });
});

describe('pickFallbackSource（CHG-08：失效跳过排除演示源）', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
  });

  /** 建一个 site 源并按 health 落库 */
  async function makeSource(name: string, health: 'ok' | 'unreachable'): Promise<string> {
    const source = await sourceService.create({
      name,
      type: 'site',
      baseUrl: `https://${name}.example.com`,
    });
    await sourceService.markHealth(source.id, health);
    return source.id;
  }

  it('其它源全失效时返回 null，不再回落到内置演示源', async () => {
    const failed = await makeSource('坏源', 'unreachable');
    await makeSource('另一坏源', 'unreachable');
    // 演示源（builtin）健康且启用，但按 CHG-08 不得作为替代候选
    await expect(libraryService.pickFallbackSource(failed)).resolves.toBeNull();
  });

  it('存在健康的非演示源时正常返回（演示源被排除不参与排序）', async () => {
    const failed = await makeSource('坏源', 'unreachable');
    const good = await makeSource('好源', 'ok');
    const picked = await libraryService.pickFallbackSource(failed);
    expect(picked?.id).toBe(good);
  });

  it('失败源自身不进入候选', async () => {
    const failed = await makeSource('坏源', 'unreachable');
    await makeSource('好源', 'ok');
    await sourceService.markHealth(failed, 'ok'); // 失效标记晚于健康快照的场景
    const picked = await libraryService.pickFallbackSource(failed);
    expect(picked).not.toBeNull();
    expect(picked?.id).not.toBe(failed);
  });
});

describe('search 空结果诊断（CHG-15）', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
  });

  /** 建一个 site 源并按 health 落库 */
  async function makeSource(name: string, health: 'ok' | 'unreachable'): Promise<string> {
    const source = await sourceService.create({
      name,
      type: 'site',
      baseUrl: `https://${name}.example.com`,
    });
    await sourceService.markHealth(source.id, health);
    return source.id;
  }

  it('启用源全被体检过滤 → candidates=0 且 filteredOut 透出（不再伪装成"没搜到"）', async () => {
    const a = await makeSource('坏源A', 'unreachable');
    const b = await makeSource('坏源B', 'unreachable');
    // sourceIds 限定被测源（内置演示源恒健康，不参与本断言）
    const result = await libraryService.search({ keyword: '战狼', sourceIds: [a, b] });
    expect(result.items).toHaveLength(0);
    expect(result.candidates).toBe(0);
    expect(result.filteredOut).toBe(2);
  });

  it('forceAll 跳过体检过滤：candidates 恢复；全失败时明确抛错', async () => {
    const a = await makeSource('坏源A', 'unreachable');
    const b = await makeSource('坏源B', 'unreachable');
    // 演示源恒健康（搜索 0 结果算成功），保证调用不因全失败而抛错，能观察到计数
    const result = await libraryService.search({
      keyword: '战狼',
      sourceIds: [a, b, DEMO_SOURCE_ID],
      forceAll: true,
    });
    expect(result.candidates).toBe(3);
    expect(result.filteredOut).toBe(0);
    // 全部参与的源都失败 → 抛第一个错误（而不是静默空结果）
    await expect(
      libraryService.search({ keyword: '战狼', sourceIds: [a, b], forceAll: true }),
    ).rejects.toBeDefined();
  });
});
