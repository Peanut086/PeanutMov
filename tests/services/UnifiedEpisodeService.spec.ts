/**
 * 跨源剧集统一映射服务单测（EXT-03）
 *
 * 关注点：
 * 1. 多源聚合：按集号去重合并、每集标注可用源、单源失败不影响其它源；
 * 2. 选源：健康档位 → 延迟排序、`maxSources` 截断、`sourceIds` 过滤、已知候选跳搜；
 * 3. 查找：`findBestEpisode` 命中降级链、未命中返回 null、单源直查兜底的条件；
 * 4. 缓存：命中/TTL/LRU 50 部/`force`/并发去重/`clear()`；
 * 5. 边界：空标题不打源、调用方取消不写缓存、单源超时只记 miss。
 *
 * 全部依赖注入，测试不打网络、不碰 IndexedDB。
 */
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/shared/errors';
import {
  UnifiedEpisodeService,
  unifiedMissText,
  type EpisodeLookupMatch,
  type UnifiedEpisodeDeps,
} from '@/services/UnifiedEpisodeService';
import type {
  Episode,
  GetDetailParams,
  MediaDetail,
  MediaItem,
  PlayLine,
  SearchParams,
  Source,
  SourceHealth,
} from '@/types';

/* ---------------- 夹具 ---------------- */

function makeSource(id: string, overrides: Partial<Source> = {}): Source {
  return {
    id,
    key: `key-${id}`,
    name: id,
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: `https://${id}.example.com`,
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'ok',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface ItemSpec {
  source: Source;
  sourceItemId?: string;
  title: string;
  year?: number | null;
  type?: MediaItem['type'];
}

function makeItem(spec: ItemSpec): MediaItem {
  const sourceItemId = spec.sourceItemId ?? '101';
  return {
    id: `${spec.source.id}:${sourceItemId}`,
    sourceId: spec.source.id,
    sourceItemId,
    title: spec.title,
    originalTitle: null,
    type: spec.type ?? 'series',
    year: spec.year ?? null,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: spec.title.toLowerCase(),
    isDemo: false,
    cachedAt: 1,
    updatedAt: 1,
  };
}

/** 构造详情：`lineCounts` 每项是一条线路的集数（默认一条线路 `count` 集） */
function makeDetail(
  spec: ItemSpec & { count?: number; lineCounts?: number[]; titles?: string[] },
): MediaDetail {
  const item = makeItem(spec);
  const lineCounts = spec.lineCounts ?? [spec.count ?? 1];
  const lines: PlayLine[] = [];
  const episodes: Episode[] = [];
  lineCounts.forEach((count, lineIndex) => {
    const lineId = `${item.id}:${lineIndex}`;
    lines.push({
      id: lineId,
      mediaId: item.id,
      sourceId: spec.source.id,
      name: `线路${lineIndex + 1}`,
      quality: null,
      format: 'hls',
      index: lineIndex,
    });
    for (let i = 0; i < count; i += 1) {
      const number = i + 1;
      episodes.push({
        id: `${lineId}:${number}`,
        mediaId: item.id,
        sourceId: spec.source.id,
        lineId,
        number,
        title: spec.titles?.[i] ?? `第${number}集`,
        durationSec: null,
        subtitles: [],
        updatedAt: 1,
      });
    }
  });
  return { item, lines, episodes };
}

function detailKey(sourceId: string, sourceItemId: string): string {
  return `${sourceId}|${sourceItemId}`;
}

/** 未命中列表 → `{源 id: 原因}`，避免依赖源的排序细节 */
function mapMisses(aggregate: { misses: ReadonlyArray<{ source: Source; reason: string }> }): Record<string, string> {
  return Object.fromEntries(aggregate.misses.map((miss) => [miss.source.id, miss.reason]));
}

interface HarnessOptions {
  sources: Source[];
  /** 源搜索结果：sourceId → 条目 */
  found?: Record<string, MediaItem[]>;
  /** 详情仓库：`sourceId|sourceItemId` → 详情 */
  details?: Record<string, MediaDetail>;
  health?: Record<string, SourceHealth>;
  latency?: Record<string, number | null>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  budgetOf?: (source: Source) => Promise<number>;
  findEpisodeByTitle?: UnifiedEpisodeDeps['findEpisodeByTitle'];
  /** 覆盖搜索实现（超时/异常场景用） */
  searchImpl?: UnifiedEpisodeDeps['search'];
}

interface Harness {
  service: UnifiedEpisodeService;
  deps: UnifiedEpisodeDeps;
  listSources: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  getDetail: ReturnType<typeof vi.fn>;
}

function makeHarness(options: HarnessOptions): Harness {
  const found = options.found ?? {};
  const details = options.details ?? {};
  const health = options.health ?? {};
  const latency = options.latency ?? {};

  const listSources = vi.fn(async (): Promise<Source[]> => options.sources);
  const search = vi.fn(
    options.searchImpl ??
      (async (params: SearchParams): Promise<MediaItem[]> => found[params.source.id] ?? []),
  );
  const getDetail = vi.fn(async (params: GetDetailParams): Promise<MediaDetail> => {
    const detail = details[detailKey(params.source.id, params.sourceItemId)];
    if (detail === undefined) throw new AppError('E_NOT_FOUND');
    return detail;
  });

  const deps: UnifiedEpisodeDeps = {
    listSources,
    search,
    getDetail,
    qualityOf: async (sourceId: string) => ({
      health: health[sourceId] ?? 'ok',
      latencyMs: latency[sourceId] === undefined ? 100 : latency[sourceId],
    }),
    findEpisodeByTitle: options.findEpisodeByTitle,
    budgetOf: options.budgetOf,
    now: options.now ?? (() => Date.now()),
  };

  const service = new UnifiedEpisodeService(deps, {
    ttlMs: options.ttlMs,
    maxEntries: options.maxEntries,
    now: options.now,
  });
  return { service, deps, listSources, search, getDetail };
}

/* ---------------- 聚合与合并 ---------------- */

describe('UnifiedEpisodeService / 多源聚合', () => {
  it('按集号合并多源剧集，每集带可用源且指向各自线路/剧集', async () => {
    const a = makeSource('a');
    const b = makeSource('b', { type: 'spider', sort: 2 });
    const itemA = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const itemB = makeItem({ source: b, sourceItemId: '2', title: '庆余年 第一季', year: 2019 });
    const h = makeHarness({
      sources: [a, b],
      found: { a: [itemA], b: [itemB] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 3 }),
        [detailKey('b', '2')]: makeDetail({ source: b, sourceItemId: '2', title: '庆余年 第一季', year: 2019, count: 5 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes.map((entry) => entry.number)).toEqual([1, 2, 3, 4, 5]);
    expect(aggregate.episodes[0]?.sources.map((ref) => ref.source.id)).toEqual(['a', 'b']);
    expect(aggregate.episodes[4]?.sources.map((ref) => ref.source.id)).toEqual(['b']);
    expect(aggregate.episodes[0]?.sources[0]?.lineId).toBe('a:1:0');
    expect(aggregate.episodes[0]?.sources[1]?.episodeId).toBe('b:2:0:1');
    expect(aggregate.episodes[0]?.title).toBe('第1集');
    expect(aggregate.sources.map((entry) => entry.episodeCount)).toEqual([3, 5]);
    expect(aggregate.misses).toEqual([]);
    expect(aggregate.cached).toBe(false);
  });

  it('每个源的详情只取一次，搜索按片名/年份筛选', async () => {
    const a = makeSource('a');
    const hit = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const other = makeItem({ source: a, sourceItemId: '2', title: '庆余年 第二季', year: 2024 });
    const h = makeHarness({
      sources: [a],
      found: { a: [other, hit] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
        [detailKey('a', '2')]: makeDetail({ source: a, sourceItemId: '2', title: '庆余年 第二季', year: 2024, count: 9 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes).toHaveLength(2);
    expect(aggregate.misses).toEqual([]);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.getDetail).toHaveBeenCalledTimes(1);
    expect(h.getDetail.mock.calls[0]?.[0]).toMatchObject({ sourceItemId: '1' });
  });

  it('片名不匹配的源只记 miss，不影响其它源', async () => {
    const a = makeSource('a');
    const b = makeSource('b');
    const itemA = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const itemB = makeItem({ source: b, sourceItemId: '9', title: '赘婿', year: 2021 });
    const h = makeHarness({
      sources: [a, b],
      found: { a: [itemA], b: [itemB] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes).toHaveLength(2);
    expect(aggregate.misses).toHaveLength(1);
    expect(aggregate.misses[0]?.source.id).toBe('b');
    expect(aggregate.misses[0]?.reason).toBe('title_mismatch');
    expect(unifiedMissText(aggregate.misses[0]!.reason)).toBe('片名不匹配');
  });

  it('年份不一致记 year_mismatch', async () => {
    const a = makeSource('a');
    const item = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2024 });
    const h = makeHarness({
      sources: [a],
      found: { a: [item] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2024, count: 2 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes).toEqual([]);
    expect(aggregate.misses[0]?.reason).toBe('year_mismatch');
  });

  it('搜不到记 no_result，详情无剧集记 no_episodes', async () => {
    const empty = makeSource('empty');
    const bare = makeSource('bare');
    const item = makeItem({ source: bare, sourceItemId: '1', title: '庆余年', year: 2019 });
    const h = makeHarness({
      sources: [empty, bare],
      found: { bare: [item] },
      details: {
        [detailKey('bare', '1')]: makeDetail({ source: bare, sourceItemId: '1', title: '庆余年', year: 2019, count: 0 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes).toEqual([]);
    expect(mapMisses(aggregate)).toEqual({ empty: 'no_result', bare: 'no_episodes' });
  });

  it('详情故障与「不支持剧集查询」区分归类', async () => {
    const broken = makeSource('broken');
    const bare = makeSource('unsupported');
    const itemBroken = makeItem({ source: broken, sourceItemId: '1', title: '庆余年', year: 2019 });
    const itemBare = makeItem({ source: bare, sourceItemId: '2', title: '庆余年', year: 2019 });
    const h = makeHarness({
      sources: [broken, bare],
      found: { broken: [itemBroken], unsupported: [itemBare] },
    });
    h.getDetail.mockImplementation(async (params: GetDetailParams): Promise<MediaDetail> => {
      if (params.source.id === 'broken') throw new AppError('E_HTTP_5XX');
      throw new AppError('E_NOT_IMPLEMENTED');
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    const reasons = mapMisses(aggregate);
    expect(reasons['broken']).toBe('detail_failed');
    expect(reasons['unsupported']).toBe('detail_unavailable');
  });

  it('全部源失败时返回空剧集，不抛错', async () => {
    const a = makeSource('a');
    const h = makeHarness({ sources: [a], found: { a: [] } });

    await expect(h.service.getUnifiedEpisodes('media-1', '庆余年')).resolves.toMatchObject({ episodes: [] });
  });

  it('空片名直接返回空聚合，不列源不搜索', async () => {
    const a = makeSource('a');
    const h = makeHarness({ sources: [a] });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '   ');

    expect(aggregate.episodes).toEqual([]);
    expect(h.listSources).not.toHaveBeenCalled();
    expect(h.search).not.toHaveBeenCalled();
  });

  it('非可播源（douban / demo）与停用源不参与聚合', async () => {
    const douban = makeSource('db', { type: 'douban' });
    const demo = makeSource('demo', { type: 'demo' });
    const disabled = makeSource('off', { enabled: false });
    const healthy = makeSource('ok');
    const item = makeItem({ source: healthy, sourceItemId: '1', title: '庆余年', year: 2019 });
    const h = makeHarness({
      sources: [douban, demo, disabled, healthy],
      found: { ok: [item] },
      details: {
        [detailKey('ok', '1')]: makeDetail({ source: healthy, sourceItemId: '1', title: '庆余年', year: 2019, count: 1 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.sources.map((entry) => entry.source.id)).toEqual(['ok']);
    expect(h.search).toHaveBeenCalledTimes(1);
  });
});

/* ---------------- 选源与排序 ---------------- */

describe('UnifiedEpisodeService / 选源排序', () => {
  it('健康档位优先于源顺序：异常源排到最后', async () => {
    const bad = makeSource('bad', { sort: 1, health: 'unreachable' });
    const good = makeSource('good', { sort: 9 });
    const itemA = makeItem({ source: bad, sourceItemId: '1', title: '庆余年', year: 2019 });
    const h = makeHarness({
      sources: [bad, good],
      found: { bad: [itemA], good: [{ ...itemA, id: 'good:1', sourceId: 'good' }] },
      health: { bad: 'unreachable', good: 'ok' },
      latency: { bad: 30, good: 1500 },
      details: {
        [detailKey('bad', '1')]: makeDetail({ source: bad, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
        [detailKey('good', '1')]: makeDetail({ source: good, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes[0]?.sources.map((ref) => ref.source.id)).toEqual(['good', 'bad']);
    expect(aggregate.episodes[0]?.sources[0]?.tier).toBe('fair');
  });

  it('同档位按探测延迟升序', async () => {
    const slow = makeSource('slow');
    const fast = makeSource('fast');
    const h = makeHarness({
      sources: [slow, fast],
      found: {
        slow: [makeItem({ source: slow, sourceItemId: '1', title: '庆余年', year: 2019 })],
        fast: [makeItem({ source: fast, sourceItemId: '1', title: '庆余年', year: 2019 })],
      },
      latency: { slow: 600, fast: 120 },
      details: {
        [detailKey('slow', '1')]: makeDetail({ source: slow, sourceItemId: '1', title: '庆余年', year: 2019, count: 1 }),
        [detailKey('fast', '1')]: makeDetail({ source: fast, sourceItemId: '1', title: '庆余年', year: 2019, count: 1 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes[0]?.sources.map((ref) => ref.source.id)).toEqual(['fast', 'slow']);
  });

  it('maxSources 先按质量排序再截断，坏源不占预算', async () => {
    const bad = makeSource('bad', { health: 'auth_failed' });
    const good = makeSource('good');
    const h = makeHarness({
      sources: [bad, good],
      found: {},
      health: { bad: 'auth_failed', good: 'ok' },
      latency: { bad: 10, good: 200 },
    });

    await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019, maxSources: 1 });

    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search.mock.calls[0]?.[0]).toMatchObject({ source: { id: 'good' } });
  });

  it('sourceIds 限定参与聚合的源', async () => {
    const a = makeSource('a');
    const b = makeSource('b');
    const h = makeHarness({ sources: [a, b] });

    await h.service.getUnifiedEpisodes('media-1', '庆余年', { sourceIds: ['b'] });

    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.search.mock.calls[0]?.[0]).toMatchObject({ source: { id: 'b' } });
  });

  it('给已知候选时跳过列源与搜索，直接取候选详情', async () => {
    const a = makeSource('a');
    const b = makeSource('b');
    const itemA = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const itemB = makeItem({ source: b, sourceItemId: '2', title: '赘婿', year: 2021 });
    const h = makeHarness({
      sources: [a, b],
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', {
      year: 2019,
      candidates: [
        { source: a, item: itemA },
        { source: b, item: itemB },
      ],
    });

    expect(h.listSources).not.toHaveBeenCalled();
    expect(h.search).not.toHaveBeenCalled();
    expect(aggregate.episodes).toHaveLength(2);
    expect(aggregate.misses).toHaveLength(1);
    expect(aggregate.misses[0]?.source.id).toBe('b');
    expect(aggregate.misses[0]?.reason).toBe('title_mismatch');
  });

  it('详情实现可替换（detailOf 注入）', async () => {
    const a = makeSource('a');
    const item = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const h = makeHarness({ sources: [a] });
    const detailOf = vi.fn(async () =>
      makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 4 }),
    );

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', {
      candidates: [{ source: a, item }],
      detailOf,
    });

    expect(detailOf).toHaveBeenCalledTimes(1);
    expect(h.getDetail).not.toHaveBeenCalled();
    expect(aggregate.episodes).toHaveLength(4);
  });
});

/* ---------------- 查找某一集 ---------------- */

describe('UnifiedEpisodeService / findBestEpisode', () => {
  function seed(): {
    a: Source;
    b: Source;
    h: Harness;
  } {
    const a = makeSource('a');
    const b = makeSource('b', { sort: 2 });
    const h = makeHarness({
      sources: [a, b],
      found: {
        a: [makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 })],
        b: [makeItem({ source: b, sourceItemId: '2', title: '庆余年', year: 2019 })],
      },
      latency: { a: 100, b: 900 },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 3 }),
        [detailKey('b', '2')]: makeDetail({
          source: b,
          sourceItemId: '2',
          title: '庆余年',
          year: 2019,
          count: 3,
          titles: ['第1集', '第2集', '第3集'],
        }),
      },
    });
    return { a, b, h };
  }

  it('命中返回按质量排好的降级链', async () => {
    const { h } = seed();

    const hit = await h.service.findBestEpisode('庆余年', 2, { mediaId: 'media-1', year: 2019 });

    expect(hit).not.toBeNull();
    expect(hit?.number).toBe(2);
    expect(hit?.candidates.map((ref) => ref.source.id)).toEqual(['a', 'b']);
    expect(hit?.candidates[0]?.episodeId).toBe('a:1:0:2');
    expect(hit?.candidates[1]?.episodeId).toBe('b:2:0:2');
  });

  it('没有这一集且不支持直查时返回 null（不降级到第一集）', async () => {
    const { h } = seed();

    await expect(h.service.findBestEpisode('庆余年', 9, { mediaId: 'media-1', year: 2019 })).resolves.toBeNull();
  });

  it('非法片名 / 集数直接返回 null，不打源', async () => {
    const { h } = seed();

    await expect(h.service.findBestEpisode('   ', 1)).resolves.toBeNull();
    await expect(h.service.findBestEpisode('庆余年', 0)).resolves.toBeNull();
    expect(h.listSources).not.toHaveBeenCalled();
  });

  it('聚合未命中时对失败源做单源直查兜底', async () => {
    const a = makeSource('a');
    const item = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const match: EpisodeLookupMatch = {
      source: a,
      item,
      line: {
        id: 'a:1:0',
        mediaId: 'a:1',
        sourceId: 'a',
        name: '线路1',
        quality: null,
        format: 'hls',
        index: 0,
      },
      episode: {
        id: 'a:1:0:7',
        mediaId: 'a:1',
        sourceId: 'a',
        lineId: 'a:1:0',
        number: 7,
        title: '第7集',
        durationSec: null,
        subtitles: [],
        updatedAt: 1,
      },
      lineId: 'a:1:0',
      episodeId: 'a:1:0:7',
      episodeNumber: 7,
      episodeTitle: '第7集',
    };
    const findEpisodeByTitle = vi.fn(
      async (_input: { source: Source; title: string; episodeIndex: number; year: number | null }) => match,
    );
    const h = makeHarness({
      sources: [a],
      found: { a: [] },
      latency: { a: 120 },
      findEpisodeByTitle,
    });

    const hit = await h.service.findBestEpisode('庆余年', 7, { mediaId: 'media-1', year: 2019 });

    expect(findEpisodeByTitle).toHaveBeenCalledTimes(1);
    expect(findEpisodeByTitle.mock.calls[0]?.[0]).toMatchObject({
      source: { id: 'a' },
      title: '庆余年',
      episodeIndex: 7,
      year: 2019,
    });
    expect(hit?.candidates[0]?.source.id).toBe('a');
    expect(hit?.candidates[0]?.tier).toBe('fast');
  });

  it('片名/年份不匹配与「不支持查询」的源不做直查兜底', async () => {
    const mismatch = makeSource('mismatch');
    const unsupported = makeSource('unsupported');
    const findEpisodeByTitle = vi.fn(async () => null);
    const h = makeHarness({
      sources: [mismatch, unsupported],
      found: {
        mismatch: [makeItem({ source: mismatch, sourceItemId: '1', title: '赘婿', year: 2021 })],
        unsupported: [makeItem({ source: unsupported, sourceItemId: '2', title: '庆余年', year: 2019 })],
      },
      findEpisodeByTitle,
    });
    h.getDetail.mockRejectedValueOnce(new AppError('E_NOT_IMPLEMENTED'));

    await expect(h.service.findBestEpisode('庆余年', 1, { mediaId: 'media-1', year: 2019 })).resolves.toBeNull();
    expect(findEpisodeByTitle).not.toHaveBeenCalled();
  });

  it('直查返回的集号与请求不一致时判未命中', async () => {
    const a = makeSource('a');
    const item = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const detail = makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 });
    const findEpisodeByTitle = vi.fn(async (): Promise<EpisodeLookupMatch | null> => {
      const selection = detail.episodes[0]!;
      return {
        source: a,
        item,
        line: detail.lines[0]!,
        episode: selection,
        lineId: selection.lineId,
        episodeId: selection.id,
        episodeNumber: 1,
        episodeTitle: selection.title,
      };
    });
    const h = makeHarness({ sources: [a], found: { a: [] }, findEpisodeByTitle });

    await expect(h.service.findBestEpisode('庆余年', 5, { mediaId: 'media-1' })).resolves.toBeNull();
  });

  it('fallbackLookup=false 时不直查', async () => {
    const a = makeSource('a');
    const findEpisodeByTitle = vi.fn(async () => null);
    const h = makeHarness({ sources: [a], found: { a: [] }, findEpisodeByTitle });

    await expect(
      h.service.findBestEpisode('庆余年', 1, { mediaId: 'media-1', fallbackLookup: false }),
    ).resolves.toBeNull();
    expect(findEpisodeByTitle).not.toHaveBeenCalled();
  });

  it('给候选时不走直查（候选即权威集合）', async () => {
    const a = makeSource('a');
    const item = makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 });
    const match = vi.fn(async () => null);
    const h = makeHarness({
      sources: [a],
      findEpisodeByTitle: match,
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    await expect(
      h.service.findBestEpisode('庆余年', 8, { mediaId: 'media-1', candidates: [{ source: a, item }] }),
    ).resolves.toBeNull();
    expect(match).not.toHaveBeenCalled();
  });
});

/* ---------------- 缓存 ---------------- */

describe('UnifiedEpisodeService / 缓存', () => {
  it('同一作品二次聚合命中缓存，不再打源站', async () => {
    const a = makeSource('a');
    const h = makeHarness({
      sources: [a],
      found: { a: [makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 })] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    const first = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });
    const second = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.getDetail).toHaveBeenCalledTimes(1);
    expect(h.service.stats()).toMatchObject({ entries: 1, cacheHits: 1, aggregations: 1 });
  });

  it('TTL 到点后重新聚合', async () => {
    const a = makeSource('a');
    let clock = 1_000;
    const h = makeHarness({
      sources: [a],
      now: () => clock,
      ttlMs: 500,
      found: { a: [makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 })] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });
    clock += 400;
    await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });
    expect(h.search).toHaveBeenCalledTimes(1);

    clock += 200;
    await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });
    expect(h.search).toHaveBeenCalledTimes(2);
  });

  it('force 绕过缓存重新聚合', async () => {
    const a = makeSource('a');
    const h = makeHarness({
      sources: [a],
      found: { a: [makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 })] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });
    await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019, force: true });

    expect(h.search).toHaveBeenCalledTimes(2);
    expect(h.service.stats().aggregations).toBe(2);
  });

  it('LRU 上限 50 部：第 51 部挤掉最久未用的作品', async () => {
    const a = makeSource('a');
    const found: Record<string, MediaItem[]> = { a: [] };
    const details: Record<string, MediaDetail> = {};
    for (let i = 1; i <= 51; i += 1) {
      const title = `作品${i}`;
      found['a']!.push(makeItem({ source: a, sourceItemId: String(i), title }));
      details[detailKey('a', String(i))] = makeDetail({ source: a, sourceItemId: String(i), title, count: 1 });
    }
    const h = makeHarness({ sources: [a], found, details, maxEntries: 50 });

    for (let i = 1; i <= 51; i += 1) {
      await h.service.getUnifiedEpisodes(`media-${i}`, `作品${i}`);
    }
    expect(h.service.stats().entries).toBe(50);

    // 第 1 部已被淘汰 → 重新聚合；第 51 部仍在缓存
    await h.service.getUnifiedEpisodes('media-1', '作品1');
    expect(h.service.stats().aggregations).toBe(52);
    await h.service.getUnifiedEpisodes('media-51', '作品51');
    expect(h.service.stats().aggregations).toBe(52);
  });

  it('并发请求同一作品只聚合一次', async () => {
    const a = makeSource('a');
    const h = makeHarness({
      sources: [a],
      found: { a: [makeItem({ source: a, sourceItemId: '1', title: '庆余年', year: 2019 })] },
      details: {
        [detailKey('a', '1')]: makeDetail({ source: a, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
    });

    const [first, second] = await Promise.all([
      h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 }),
      h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 }),
    ]);

    expect(first.episodes).toHaveLength(2);
    expect(second.episodes).toHaveLength(2);
    expect(h.search).toHaveBeenCalledTimes(1);
    expect(h.service.stats()).toMatchObject({ aggregations: 1, inFlight: 0 });
  });

  it('clear() 清空缓存与统计', async () => {
    const a = makeSource('a');
    const h = makeHarness({ sources: [a], found: { a: [] } });

    await h.service.getUnifiedEpisodes('media-1', '庆余年');
    expect(h.service.stats().entries).toBe(1);

    h.service.clear();
    expect(h.service.stats()).toMatchObject({ entries: 0, inFlight: 0, cacheHits: 0, aggregations: 0 });
  });

  it('作品 id 缺省时按片名共享缓存', async () => {
    const a = makeSource('a');
    const h = makeHarness({ sources: [a], found: { a: [] } });

    await h.service.getUnifiedEpisodes('', '庆余年', { year: 2019 });
    await h.service.getUnifiedEpisodes('', ' 庆余年 ', { year: 2019 });

    expect(h.listSources).toHaveBeenCalledTimes(1);
  });
});

/* ---------------- 中止与超时 ---------------- */

describe('UnifiedEpisodeService / 中止与超时', () => {
  it('调用方取消时抛错且不写缓存', async () => {
    const a = makeSource('a');
    const h = makeHarness({ sources: [a], found: { a: [] } });
    const controller = new AbortController();
    controller.abort();

    await expect(
      h.service.getUnifiedEpisodes('media-1', '庆余年', { signal: controller.signal }),
    ).rejects.toBeTruthy();
    expect(h.service.stats().entries).toBe(0);
    expect(h.search).not.toHaveBeenCalled();
  });

  it('单源超时只记 timeout，其它源照常聚合', async () => {
    const slow = makeSource('slow');
    const fast = makeSource('fast');
    const h = makeHarness({
      sources: [slow, fast],
      found: { fast: [makeItem({ source: fast, sourceItemId: '1', title: '庆余年', year: 2019 })] },
      details: {
        [detailKey('fast', '1')]: makeDetail({ source: fast, sourceItemId: '1', title: '庆余年', year: 2019, count: 2 }),
      },
      budgetOf: async () => 20,
      searchImpl: async (params: SearchParams): Promise<MediaItem[]> => {
        if (params.source.id === 'slow') {
          // 模拟不响应超时的慢源：只在收到中止信号时收尾
          return new Promise((_resolve, reject) => {
            params.signal?.addEventListener('abort', () => reject(new AppError('E_ABORTED')), { once: true });
          });
        }
        return [makeItem({ source: fast, sourceItemId: '1', title: '庆余年', year: 2019 })];
      },
    });

    const aggregate = await h.service.getUnifiedEpisodes('media-1', '庆余年', { year: 2019 });

    expect(aggregate.episodes).toHaveLength(2);
    expect(aggregate.misses.map((miss) => [miss.source.id, miss.reason])).toEqual([['slow', 'timeout']]);
  });
});
