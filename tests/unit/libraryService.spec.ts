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
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { beginPlaybackDemand, endPlaybackDemand } from '@/services/prewarmState';
import { mediaIdOf } from '@/shared/id';
import { AppError } from '@/shared/errors';
import { PAGE_SIZE } from '@/shared/constants';
import { SOURCE_BUSY_MESSAGE } from '@/shared/sourceFailure';
import type {
  Episode,
  LibraryFilters,
  MediaDetail,
  MediaItem,
  MediaType,
  PlaybackSource,
  PlayLine,
  Source,
  SourceAdapter,
} from '@/types';

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

/**
 * P1-3：分档落到 `libraryService` 这一侧的后果（真机「集号来回跳 + 所有线路都失败」的放大链）
 *
 * 覆盖点：
 * 1. 「源正忙」不再被当成死源：不即时重投第二次（第二次排的还是同一个原生实例）；
 * 2. 真·瞬态失败仍然重投一次——分档只收紧"忙"，没有顺手关掉原有的止血；
 * 3. 重投前的陪等取自 `busyStateOf().inFlightMs`（真实在飞时长），僵尸的 30 秒封顶 2 秒；
 * 4. 取消（E_ABORTED）不算瞬态失败，不重投；
 * 5. 详情请求有自己的预算：到期取消、给对症文案、计时器不残留；
 * 6. 点播在途时后台预热让路（否则用户看到的就是「该源正忙（约 N 秒后结束）」，N 是刚被预热吃掉的加载）。
 */
describe('源忙分档、详情预算与预热让路（P1-3）', () => {
  /** site 适配器是单例：能力探针（busyStateOf）逐用例挂摘，爬虫源才有这个方法 */
  const siteAdapter = (): SourceAdapter => sourceRegistry.get('site');

  beforeEach(async () => {
    await resetAll();
    setOnline(true);
    endPlaybackDemand();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (siteAdapter() as unknown as { busyStateOf?: unknown }).busyStateOf;
  });

  /**
   * 落一份「源 + 条目」（可选线路与剧集）。
   * `withLines: false` 时缓存详情视为不存在——`getDetail` 的刷新失败兜底会返回缓存，
   * 要观察 `withDetailBudget` 抛出的错误就必须让缓存为空。
   */
  async function seedPlayable(
    opts?: { withLines?: boolean },
  ): Promise<{ source: Source; item: MediaItem; line: PlayLine; episodeId: string }> {
    const source = await sourceService.create({
      name: '分档源',
      type: 'site',
      baseUrl: 'https://busy.example.com',
    });
    const now = Date.now();
    const mediaId = mediaIdOf(source.id, 'b-1');
    const item: MediaItem = {
      id: mediaId,
      sourceId: source.id,
      sourceItemId: 'b-1',
      title: '分档验证片',
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
      titleLower: '分档验证片',
      isDemo: false,
      cachedAt: now,
      updatedAt: now,
    };
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
      updatedAt: now,
    };
    await mediaRepo.save(item);
    if (opts?.withLines !== false) {
      await lineRepo.saveMany([line]);
      await episodeRepo.saveMany([episode]);
    }
    return { source, item, line, episodeId: episode.id };
  }

  function playbackOf(lineId: string): PlaybackSource {
    return {
      url: 'https://cdn.example.com/1.mp4',
      format: 'mp4',
      headers: {},
      subtitles: [],
      lineId,
      quality: null,
      expiresAt: null,
      isLocal: false,
    };
  }

  it('源正忙：原样抛出、不重投第二次（第二次只是把原生池越占越满）', async () => {
    const { item, episodeId } = await seedPlayable();
    const resolveSpy = vi.spyOn(siteAdapter(), 'resolvePlayUrl').mockRejectedValue(
      new AppError('E_SOURCE_BUSY', `${SOURCE_BUSY_MESSAGE}（约 14 秒后结束）`),
    );

    const thrown = await libraryService.resolvePlay({ mediaId: item.id, episodeId }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('E_SOURCE_BUSY');
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('真·瞬态失败仍重投一次（分档只收紧「忙」，没有关掉原有止血）', async () => {
    const { item, line, episodeId } = await seedPlayable();
    const resolveSpy = vi
      .spyOn(siteAdapter(), 'resolvePlayUrl')
      .mockRejectedValueOnce(
        // 爬虫 jar 惰性初始化的 Java 空指针：确定性不是"源站下线"，值得再投一次
        new AppError('E_SOURCE_UNAVAILABLE', '爬虫调用失败: NullPointerException: Attempt to invoke virtual method'),
      )
      .mockResolvedValueOnce(playbackOf(line.id));

    const playback = await libraryService.resolvePlay({ mediaId: item.id, episodeId });

    expect(playback.url).toBe('https://cdn.example.com/1.mp4');
    expect(resolveSpy).toHaveBeenCalledTimes(2);
  });

  it('重投前的陪等来自真实在飞时长，僵尸的 30 秒封顶 2 秒', async () => {
    const { item, line, episodeId } = await seedPlayable();
    const probe = siteAdapter() as unknown as { busyStateOf?: (id: string) => { inFlightMs: number; queueDepth: number } };

    // ① 常态：挡回它的那次调用只剩 300ms → 陪着等这么久再投第二次
    probe.busyStateOf = () => ({ inFlightMs: 300, queueDepth: 1 });
    const quick = vi
      .spyOn(siteAdapter(), 'resolvePlayUrl')
      .mockRejectedValueOnce(new AppError('E_SOURCE_UNAVAILABLE', '爬虫调用失败: NullPointerException: x'))
      .mockResolvedValueOnce(playbackOf(line.id));
    const t0 = Date.now();
    await libraryService.resolvePlay({ mediaId: item.id, episodeId });
    const waitedQuick = Date.now() - t0;
    expect(quick).toHaveBeenCalledTimes(2);
    expect(waitedQuick).toBeGreaterThanOrEqual(250);
    expect(waitedQuick).toBeLessThan(1_500);

    // ② 僵尸：在飞 30 秒不能把用户按在转圈里，预算封顶后照样只重投一次
    libraryService.invalidatePlayCache(item.id);
    probe.busyStateOf = () => ({ inFlightMs: 30_000, queueDepth: 1 });
    const slow = vi
      .spyOn(siteAdapter(), 'resolvePlayUrl')
      .mockRejectedValueOnce(new AppError('E_SOURCE_UNAVAILABLE', '爬虫调用失败: NullPointerException: x'))
      .mockResolvedValueOnce(playbackOf(line.id));
    const t1 = Date.now();
    await libraryService.resolvePlay({ mediaId: item.id, episodeId });
    const waitedZombie = Date.now() - t1;
    expect(slow).toHaveBeenCalledTimes(2);
    expect(waitedZombie).toBeLessThan(3_000);
    expect(waitedZombie).toBeGreaterThanOrEqual(1_900);
  });

  it('取消不算瞬态失败：即使文案是瞬态形态也不重投', async () => {
    const { item, episodeId } = await seedPlayable();
    const resolveSpy = vi
      .spyOn(siteAdapter(), 'resolvePlayUrl')
      // 文案本身会被归成 source_internal（可重试），只有错误码说明这是用户取消
      .mockRejectedValue(new AppError('E_ABORTED', '爬虫调用失败: NullPointerException: Attempt to invoke virtual method'));

    const thrown = await libraryService.resolvePlay({ mediaId: item.id, episodeId }).catch((e: unknown) => e);

    expect((thrown as AppError).code).toBe('E_ABORTED');
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  it('慢详情按预算取消并清掉计时器（不再裸奔等原生 30 秒回执）', async () => {
    const adapter = siteAdapter() as SourceAdapter & { searchTimeoutMs?: number };
    const originalTimeout = adapter.searchTimeoutMs;
    // 预算下限 3s（SEARCH_BUDGET_MIN_MS）：把基线压到下限，用例只等 3 秒
    adapter.searchTimeoutMs = 1;
    const { item } = await seedPlayable({ withLines: false });
    let seenSignal: AbortSignal | undefined;
    const detailSpy = vi
      .spyOn(adapter, 'getDetail')
      // 真适配器被取消时会中断在途请求；模拟这个契约，才能看到"预算到期"确实把请求取消了
      .mockImplementation(
        (params) =>
          new Promise<MediaDetail>((_resolve, reject) => {
            seenSignal = params.signal;
            params.signal?.addEventListener('abort', () => reject(new AppError('E_ABORTED')), { once: true });
          }),
      );

    // 计时器泄漏的实证口径：预算计时器确实被 clearTimeout 摘掉（而不是留在池里等下一轮）
    // id 类型按运行时给的原样记（DOM 是 number，Node 侧是 Timeout 对象）
    const created = new Set<unknown>();
    const cleared = new Set<unknown>();
    const realSet = globalThis.setTimeout.bind(globalThis);
    const realClear = globalThis.clearTimeout.bind(globalThis);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const id = realSet(fn, ms, ...rest);
      created.add(id);
      return id;
    }) as unknown as typeof setTimeout);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id?: unknown) => {
      cleared.add(id);
      realClear(id as ReturnType<typeof setTimeout>);
    }) as unknown as typeof clearTimeout);

    const started = Date.now();
    const thrown = await libraryService.getDetail(item.id, { refresh: true }).catch((e: unknown) => e);
    const waited = Date.now() - started;
    // 先把基线还回去再断言：断言失败也不能把 1ms 的超时留给后面的用例
    adapter.searchTimeoutMs = originalTimeout;

    expect(detailSpy).toHaveBeenCalledTimes(1);
    expect((thrown as AppError).code).toBe('E_TIMEOUT');
    expect((thrown as AppError).message).toMatch(/详情加载超过 \d+ 秒（源站响应过慢）/);
    // 到期真的把请求取消，并且把预算计时器摘掉（不留"看起来还在等"的悬空状态）
    expect(seenSignal?.aborted).toBe(true);
    expect(waited).toBeLessThan(6_000);
    expect([...created].some((id) => cleared.has(id))).toBe(true);
  });

  it('点播在途时详情刷新的后台预热让路，点播结束后恢复', async () => {
    const { item, line } = await seedPlayable({ withLines: false });
    // `warmup` 在接口上是可选方法，spy 的类型要按实现里确实存在的那一份声明
    const warmupSpy = vi
      .spyOn(siteAdapter() as SourceAdapter & { warmup: (source: Source) => Promise<void> }, 'warmup')
      .mockResolvedValue(undefined);
    vi.spyOn(siteAdapter(), 'getDetail').mockResolvedValue({ item, lines: [line], episodes: [] });

    beginPlaybackDemand();
    await libraryService.getDetail(item.id, { refresh: true });
    expect(warmupSpy).not.toHaveBeenCalled();

    endPlaybackDemand();
    await libraryService.getDetail(item.id, { refresh: true });
    expect(warmupSpy).toHaveBeenCalledTimes(1);
  });
});
