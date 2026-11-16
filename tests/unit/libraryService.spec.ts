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
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { mediaIdOf } from '@/shared/id';
import { AppError } from '@/shared/errors';
import { PAGE_SIZE } from '@/shared/constants';
import type { Episode, LibraryFilters, MediaItem, MediaType, PlayLine } from '@/types';

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
    const thrown = await libraryService
      .search({ keyword: '战狼', sourceIds: [a, b], forceAll: true })
      .catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AppError);
    // OPT-13：抛错时把「覆盖缺口」放进 meta，否则错误态下 store 拿不到 skipped/candidates
    const meta = (thrown as AppError).meta as Record<string, unknown>;
    expect(meta.candidates).toBe(2);
    expect(meta.filteredOut).toBe(0);
    expect(meta.skippedSourceIds).toEqual([]);
    // 并发扇出下 failed 的到达顺序不稳定，按集合比
    expect([...(meta.failedSourceIds as string[])].sort()).toEqual([a, b].sort());
  });
});

describe('渐进搜索即时落库与详情兜底（CHG-28）', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
  });

  /** 构造一个不在库里的搜索结果条目 */
  function makeFreshItem(sourceId: string, itemId: string, title: string): MediaItem {
    const now = Date.now();
    return {
      id: mediaIdOf(sourceId, itemId),
      sourceId,
      sourceItemId: itemId,
      title,
      originalTitle: null,
      type: 'movie',
      year: 2026,
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
    };
  }

  it('单源结果在 onPartial 上屏时已可从 mediaRepo 读到（渐进期间点击不再 E_NOT_FOUND）', async () => {
    const fresh = makeFreshItem(DEMO_SOURCE_ID, 'fresh-race-001', '渐进搜索验证片');
    const searchSpy = vi.spyOn(sourceRegistry.get('demo'), 'search').mockResolvedValue([fresh]);

    let durableAtPaint: Promise<boolean> | null = null;
    const result = await libraryService.search({
      keyword: '渐进搜索验证片',
      sourceIds: [DEMO_SOURCE_ID],
      onPartial: (event) => {
        // 上屏瞬间（用户可点击的最早时刻）条目必须已经落库
        if (event.items.length > 0 && durableAtPaint === null) {
          durableAtPaint = mediaRepo.get(event.items[0]!.id).then((row) => row !== null);
        }
      },
    });

    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => item.id)).toContain(fresh.id);
    expect(durableAtPaint).not.toBeNull();
    await expect(durableAtPaint).resolves.toBe(true);
  });

  it('getDetail：条目未落库且无 hint → E_NOT_FOUND；带 hint → 直接回源并落库', async () => {
    const source = await sourceService.create({
      name: '详情兜底源',
      type: 'site',
      baseUrl: 'https://hint.example.com',
    });
    const mediaId = mediaIdOf(source.id, 'x-1');
    const hint = makeFreshItem(source.id, 'x-1', '兜底验证片');
    const line: PlayLine = {
      id: `${mediaId}~l0`,
      mediaId,
      sourceId: source.id,
      name: '主线',
      quality: null,
      format: 'mp4',
      index: 0,
    };
    const episode: Episode = {
      id: `${mediaId}~e1`,
      mediaId,
      sourceId: source.id,
      lineId: line.id,
      number: 1,
      title: '第 1 集',
      durationSec: null,
      subtitles: [],
      updatedAt: Date.now(),
    };
    const detailSpy = vi
      .spyOn(sourceRegistry.get('site'), 'getDetail')
      .mockResolvedValue({ item: hint, lines: [line], episodes: [episode] });

    await expect(libraryService.getDetail(mediaId)).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    expect(detailSpy).not.toHaveBeenCalled();

    const detail = await libraryService.getDetail(mediaId, { item: hint });
    expect(detailSpy).toHaveBeenCalledTimes(1);
    expect(detail.item.id).toBe(mediaId);
    expect(await mediaRepo.get(mediaId)).not.toBeNull();
  });
});

describe('findAlternateByTitle：候选必须真有剧集（空壳源跳过）', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
  });

  function makeItem(sourceId: string, itemId: string, title: string): MediaItem {
    const now = Date.now();
    return {
      id: mediaIdOf(sourceId, itemId),
      sourceId,
      sourceItemId: itemId,
      title,
      originalTitle: null,
      type: 'movie',
      year: 2026,
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
    };
  }

  it('详情可加载但 0 集 → 跳过，换到有剧集的同名源', async () => {
    const emptySource = await sourceService.create({
      name: '空壳源',
      type: 'site',
      baseUrl: 'https://empty.example.com',
    });
    const playableSource = await sourceService.create({
      name: '可播源',
      type: 'site',
      baseUrl: 'https://playable.example.com',
    });
    const title = '同名片测试';
    const emptyItem = makeItem(emptySource.id, 'e-1', title);
    const playableItem = makeItem(playableSource.id, 'p-1', title);

    vi.spyOn(sourceRegistry.get('site'), 'search').mockImplementation(async (params) => {
      if (params.source.id === emptySource.id) return [emptyItem];
      if (params.source.id === playableSource.id) return [playableItem];
      return [];
    });

    const line: PlayLine = {
      id: `${playableItem.id}~l0`,
      mediaId: playableItem.id,
      sourceId: playableSource.id,
      name: '主线',
      quality: null,
      format: 'mp4',
      index: 0,
    };
    const episode: Episode = {
      id: `${playableItem.id}~e1`,
      mediaId: playableItem.id,
      sourceId: playableSource.id,
      lineId: line.id,
      number: 1,
      title: '第 1 集',
      durationSec: null,
      subtitles: [],
      updatedAt: Date.now(),
    };
    const detailSpy = vi
      .spyOn(sourceRegistry.get('site'), 'getDetail')
      .mockImplementation(async (params) => {
        if (params.source.id === emptySource.id) {
          return { item: emptyItem, lines: [], episodes: [] };
        }
        return { item: playableItem, lines: [line], episodes: [episode] };
      });

    const alternate = await libraryService.findAlternateByTitle(title, 2026, DEMO_SOURCE_ID);

    expect(alternate).toEqual({ mediaId: playableItem.id, sourceName: '可播源' });
    expect(detailSpy).toHaveBeenCalled();
  });

  it('所有候选都没有剧集 → 返回 null（不再换到空壳源）', async () => {
    const emptySource = await sourceService.create({
      name: '空壳源',
      type: 'site',
      baseUrl: 'https://empty-only.example.com',
    });
    const title = '空壳片测试';
    const emptyItem = makeItem(emptySource.id, 'e-2', title);

    vi.spyOn(sourceRegistry.get('site'), 'search').mockImplementation(async (params) =>
      params.source.id === emptySource.id ? [emptyItem] : [],
    );
    vi.spyOn(sourceRegistry.get('site'), 'getDetail').mockResolvedValue({
      item: emptyItem,
      lines: [],
      episodes: [],
    });

    await expect(libraryService.findAlternateByTitle(title, 2026, DEMO_SOURCE_ID)).resolves.toBeNull();
  });
});
