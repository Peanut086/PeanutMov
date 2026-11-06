/**
 * 集数映射服务单测（FIX-05）
 *
 * 关注点：
 * 1. 豆瓣剧集标识的解析/构造（含历史 `douban-{mediaId}-{index}` 写法）；
 * 2. 详情内按集号定位：线路优先级（集数多的优先）、标题集号兜底、越界不降级；
 * 3. 跨源映射：片名/季号/年份校验、命中/未命中原因、否定结论也进缓存；
 * 4. 两级缓存（详情级 + 映射级）、TTL、`clear()`。
 */
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/shared/errors';
import {
  EpisodeMappingService,
  buildDoubanEpisodeId,
  episodeMissText,
  parseDoubanEpisodeId,
  selectEpisodeInDetail,
  type EpisodeMappingCandidate,
  type EpisodeMappingOptions,
  type EpisodeMappingRequest,
} from '@/sources/mapping/EpisodeMappingService';
import type { Episode, GetDetailParams, MediaDetail, MediaItem, PlayLine, Source } from '@/types';

/* ---------------- 夹具 ---------------- */

function makeSource(id: string, name = id, enabled = true): Source {
  return {
    id,
    key: `key-${id}`,
    name,
    type: 'spider',
    enabled,
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
  };
}

interface DetailSpec {
  sourceId: string;
  sourceItemId: string;
  title: string;
  year?: number | null;
  /** 每条线路的集数 */
  lineCounts: number[];
  lineNames?: string[];
  /** 覆盖集号（默认 1..N，每条线路各自从 1 起） */
  numbers?: number[];
  /** 覆盖集标题（默认 `第N集`） */
  titles?: string[];
}

function makeItem(spec: DetailSpec): MediaItem {
  return {
    id: `${spec.sourceId}:${spec.sourceItemId}`,
    sourceId: spec.sourceId,
    sourceItemId: spec.sourceItemId,
    title: spec.title,
    originalTitle: null,
    type: 'series',
    year: spec.year ?? null,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: spec.lineCounts.length > 0 ? Math.max(...spec.lineCounts) : null,
    titleLower: spec.title.toLowerCase(),
    isDemo: false,
    cachedAt: 1,
    updatedAt: 1,
  };
}

function makeDetail(spec: DetailSpec): MediaDetail {
  const item = makeItem(spec);
  const lines: PlayLine[] = [];
  const episodes: Episode[] = [];
  spec.lineCounts.forEach((count, lineIndex) => {
    const lineId = `${item.id}:${lineIndex}`;
    lines.push({
      id: lineId,
      mediaId: item.id,
      sourceId: spec.sourceId,
      name: spec.lineNames?.[lineIndex] ?? `线路${lineIndex + 1}`,
      quality: null,
      format: 'hls',
      index: lineIndex,
    });
    for (let i = 0; i < count; i += 1) {
      const number = spec.numbers?.[i] ?? i + 1;
      episodes.push({
        id: `${item.id}:${lineId}:${number}`,
        mediaId: item.id,
        sourceId: spec.sourceId,
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

function candidateOf(source: Source, detail: MediaDetail): EpisodeMappingCandidate {
  return { source, item: detail.item };
}

function request(body: Partial<EpisodeMappingRequest> & Pick<EpisodeMappingRequest, 'candidates'>): EpisodeMappingRequest {
  return {
    title: '庆余年',
    year: 2024,
    episodeIndex: 1,
    ...body,
  };
}

function makeService(
  details: Record<string, MediaDetail>,
  options: EpisodeMappingOptions = {},
): {
  service: EpisodeMappingService;
  getDetail: ReturnType<typeof vi.fn>;
} {
  const getDetail = vi.fn(async (params: GetDetailParams): Promise<MediaDetail> => {
    const key = `${params.source.id}|${params.sourceItemId}`;
    const detail = details[key];
    if (!detail) throw new AppError('E_NOT_FOUND');
    return detail;
  });
  return { service: new EpisodeMappingService({ getDetail }, options), getDetail };
}

/* ---------------- 标识解析/构造 ---------------- */

describe('EpisodeMappingService / 豆瓣剧集标识', () => {
  it('buildDoubanEpisodeId 生成 douban_{movieId}_{episodeIndex}', () => {
    expect(buildDoubanEpisodeId('100', 1)).toBe('douban_100_1');
    expect(buildDoubanEpisodeId('100', 12)).toBe('douban_100_12');
    expect(buildDoubanEpisodeId(' 100 ', 3)).toBe('douban_100_3');
  });

  it('buildDoubanEpisodeId 对非法集数兜到第 1 集', () => {
    expect(buildDoubanEpisodeId('100', 0)).toBe('douban_100_1');
    expect(buildDoubanEpisodeId('100', Number.NaN)).toBe('douban_100_1');
  });

  it('parseDoubanEpisodeId 解析规范形态', () => {
    expect(parseDoubanEpisodeId('douban_100_5')).toEqual({ movieId: '100', episodeIndex: 5 });
    expect(parseDoubanEpisodeId(buildDoubanEpisodeId('100', 7))).toEqual({ movieId: '100', episodeIndex: 7 });
  });

  it('parseDoubanEpisodeId 兼容历史写法 douban-{mediaId}-{index}', () => {
    expect(parseDoubanEpisodeId('douban-100-1')).toEqual({ movieId: '100', episodeIndex: 1 });
    expect(parseDoubanEpisodeId('douban-src:100~x-2')).toEqual({ movieId: 'src:100~x', episodeIndex: 2 });
  });

  it('空标识视为第 1 集（电影只有一个「正片」）', () => {
    expect(parseDoubanEpisodeId('')).toEqual({ movieId: '', episodeIndex: 1 });
    expect(parseDoubanEpisodeId(null)).toEqual({ movieId: '', episodeIndex: 1 });
    expect(parseDoubanEpisodeId(undefined)).toEqual({ movieId: '', episodeIndex: 1 });
  });

  it('无法识别的标识返回 null（由调用方报错，不猜集数）', () => {
    expect(parseDoubanEpisodeId('abc')).toBeNull();
    expect(parseDoubanEpisodeId('douban_100_0')).toBeNull();
    expect(parseDoubanEpisodeId('douban__3')).toBeNull();
  });
});

/* ---------------- 详情内定位 ---------------- */

describe('EpisodeMappingService / selectEpisodeInDetail', () => {
  it('按集号精确命中', () => {
    const detail = makeDetail({ sourceId: 's1', sourceItemId: '100', title: '庆余年', lineCounts: [12] });
    const hit = selectEpisodeInDetail(detail, 5);
    expect(hit).not.toBeNull();
    expect(hit?.episode.number).toBe(5);
    expect(hit?.line.id).toBe(`${detail.item.id}:0`);
  });

  it('线路优先级：集数多的线路优先（预告单集线不抢第 1 集）', () => {
    const detail = makeDetail({
      sourceId: 's1',
      sourceItemId: '100',
      title: '庆余年',
      lineCounts: [1, 12],
      lineNames: ['预告', '正片'],
    });
    const hit = selectEpisodeInDetail(detail, 1);
    expect(hit?.line.name).toBe('正片');
    expect(hit?.episode.number).toBe(1);
  });

  it('集号缺失时按剧集标题里的集号兜底', () => {
    const detail = makeDetail({
      sourceId: 's1',
      sourceItemId: '100',
      title: '庆余年',
      lineCounts: [3],
      numbers: [101, 102, 103],
      titles: ['第7集', '第8集', '第9集'],
    });
    const hit = selectEpisodeInDetail(detail, 7);
    expect(hit?.episode.title).toBe('第7集');
  });

  it('越界返回 null（不降级到第一集）', () => {
    const detail = makeDetail({ sourceId: 's1', sourceItemId: '100', title: '庆余年', lineCounts: [12] });
    expect(selectEpisodeInDetail(detail, 13)).toBeNull();
  });

  it('没有任何剧集返回 null', () => {
    const detail = makeDetail({ sourceId: 's1', sourceItemId: '100', title: '庆余年', lineCounts: [] });
    expect(selectEpisodeInDetail(detail, 1)).toBeNull();
  });

  it('非法集号返回 null', () => {
    const detail = makeDetail({ sourceId: 's1', sourceItemId: '100', title: '庆余年', lineCounts: [12] });
    expect(selectEpisodeInDetail(detail, 0)).toBeNull();
    expect(selectEpisodeInDetail(detail, Number.NaN)).toBeNull();
  });
});

/* ---------------- 跨源映射 ---------------- */

describe('EpisodeMappingService / resolve 命中', () => {
  it('标题 + 集号命中目标源，返回可直接交给目标适配器的 id', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年 第二季', year: 2024, lineCounts: [12] });
    const { service, getDetail } = makeService({ 'src-a|900': detail });

    const result = await service.resolve(
      request({ title: '庆余年第二季', year: 2024, episodeIndex: 5, candidates: [candidateOf(source, detail)] }),
    );

    expect(result.misses).toEqual([]);
    expect(result.targets).toHaveLength(1);
    const target = result.targets[0];
    expect(target?.source.id).toBe('src-a');
    expect(target?.episodeNumber).toBe(5);
    expect(target?.episodeTitle).toBe('第5集');
    expect(target?.lineId).toBe(`${detail.item.id}:0`);
    expect(target?.episodeId).toBe(`${detail.item.id}:${detail.item.id}:0:5`);
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  it('多候选：片名不匹配的候选跳过，后续候选命中（保持候选顺序）', async () => {
    const wrongSource = makeSource('src-wrong', '错源');
    const rightSource = makeSource('src-right', '对源');
    const wrongDetail = makeDetail({ sourceId: 'src-wrong', sourceItemId: '1', title: '完全不同的片子', year: 2024, lineCounts: [12] });
    const rightDetail = makeDetail({ sourceId: 'src-right', sourceItemId: '2', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service, getDetail } = makeService({ 'src-right|2': rightDetail });

    const result = await service.resolve(
      request({
        title: '庆余年',
        year: 2024,
        episodeIndex: 3,
        candidates: [candidateOf(wrongSource, wrongDetail), candidateOf(rightSource, rightDetail)],
      }),
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]?.source.id).toBe('src-right');
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0]).toMatchObject({ sourceId: 'src-wrong', reason: 'title_mismatch' });
    // 片名不匹配时不应浪费一次详情请求
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  it('年份任一侧缺失时跳过年份校验', async () => {
    const source = makeSource('src-a');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: null, lineCounts: [6] });
    const { service } = makeService({ 'src-a|900': detail });

    const result = await service.resolve(
      request({ title: '庆余年', year: 2024, episodeIndex: 2, candidates: [candidateOf(source, detail)] }),
    );
    expect(result.targets).toHaveLength(1);
  });
});

describe('EpisodeMappingService / resolve 未命中（不降级）', () => {
  it('目标源没有这一集 → 返回空 targets + episode_out_of_range', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service } = makeService({ 'src-a|900': detail });

    const result = await service.resolve(
      request({ title: '庆余年', year: 2024, episodeIndex: 20, candidates: [candidateOf(source, detail)] }),
    );

    expect(result.targets).toEqual([]);
    expect(result.misses[0]).toMatchObject({ reason: 'episode_out_of_range', detail: '共 12 集' });
  });

  it('季号冲突 → season_mismatch', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年 第一季', year: 2019, lineCounts: [46] });
    const { service } = makeService({ 'src-a|900': detail });

    const result = await service.resolve(
      request({ title: '庆余年第二季', year: null, episodeIndex: 1, candidates: [candidateOf(source, detail)] }),
    );
    expect(result.misses[0]?.reason).toBe('season_mismatch');
  });

  it('年份不一致 → year_mismatch', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2019, lineCounts: [46] });
    const { service } = makeService({ 'src-a|900': detail });

    const result = await service.resolve(
      request({ title: '庆余年', year: 2024, episodeIndex: 1, candidates: [candidateOf(source, detail)] }),
    );
    expect(result.misses[0]).toMatchObject({ reason: 'year_mismatch', detail: '2024 / 2019' });
  });

  it('目标源没有剧集 → no_episodes', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [] });
    const { service } = makeService({ 'src-a|900': detail });

    const result = await service.resolve(
      request({ title: '庆余年', year: 2024, episodeIndex: 1, candidates: [candidateOf(source, detail)] }),
    );
    expect(result.misses[0]?.reason).toBe('no_episodes');
  });

  it('详情接口失败 → detail_failed（保留原始错误文案）', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const getDetail = vi.fn(async () => {
      throw new AppError('E_NETWORK', '网络不可用');
    });
    const service = new EpisodeMappingService({ getDetail });

    const result = await service.resolve(
      request({ title: '庆余年', year: 2024, episodeIndex: 1, candidates: [candidateOf(source, detail)] }),
    );
    expect(result.misses[0]).toMatchObject({ reason: 'detail_failed', detail: '网络不可用' });
  });

  it('目标源不支持详情查询 → detail_unavailable', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const getDetail = vi.fn(async () => {
      throw new AppError('E_NOT_IMPLEMENTED');
    });
    const service = new EpisodeMappingService({ getDetail });

    const result = await service.resolve(
      request({ title: '庆余年', year: 2024, episodeIndex: 1, candidates: [candidateOf(source, detail)] }),
    );
    expect(result.misses[0]?.reason).toBe('detail_unavailable');
  });

  it('同一候选重复出现只算一次', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const candidate = candidateOf(source, detail);
    const { service } = makeService({ 'src-a|900': detail });

    const result = await service.resolve(
      request({ title: '庆余年', year: 2024, episodeIndex: 2, candidates: [candidate, candidate] }),
    );
    expect(result.targets).toHaveLength(1);
    expect(result.misses).toEqual([]);
  });

  it('非法集号抛 E_INVALID_INPUT', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service } = makeService({ 'src-a|900': detail });

    await expect(
      service.resolve(request({ title: '庆余年', year: 2024, episodeIndex: 0, candidates: [candidateOf(source, detail)] })),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });

  it('已中止的信号不再发起请求', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service, getDetail } = makeService({ 'src-a|900': detail });
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.resolve(
        request({
          title: '庆余年',
          year: 2024,
          episodeIndex: 1,
          candidates: [candidateOf(source, detail)],
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDetail).not.toHaveBeenCalled();
  });

  it('未命中原因都有可读文案', () => {
    expect(episodeMissText('title_mismatch')).toBe('片名不匹配');
    expect(episodeMissText('season_mismatch')).toBe('季/部数不一致');
    expect(episodeMissText('year_mismatch')).toBe('年份不一致');
    expect(episodeMissText('episode_out_of_range')).toBe('没有这一集');
    expect(episodeMissText('no_episodes')).toBe('没有剧集');
    expect(episodeMissText('detail_unavailable')).toBe('不支持剧集查询');
    expect(episodeMissText('detail_failed')).toBe('详情读取失败');
  });
});

/* ---------------- 缓存 ---------------- */

describe('EpisodeMappingService / 缓存', () => {
  it('相同请求第二次命中映射缓存，不再取详情', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service, getDetail } = makeService({ 'src-a|900': detail });
    const req = request({ title: '庆余年', year: 2024, episodeIndex: 4, candidates: [candidateOf(source, detail)] });

    const first = await service.resolve(req);
    const second = await service.resolve(req);

    expect(first.cacheHits).toBe(0);
    expect(second.cacheHits).toBe(1);
    expect(getDetail).toHaveBeenCalledTimes(1);
    expect(service.stats()).toMatchObject({ detailEntries: 1, mappingEntries: 1, detailFetches: 1, cacheHits: 1 });
  });

  it('否定结论也缓存（没有这一集不会反复打源站）', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service, getDetail } = makeService({ 'src-a|900': detail });
    const req = request({ title: '庆余年', year: 2024, episodeIndex: 99, candidates: [candidateOf(source, detail)] });

    await service.resolve(req);
    const second = await service.resolve(req);

    expect(second.targets).toEqual([]);
    expect(second.misses[0]?.reason).toBe('episode_out_of_range');
    expect(second.cacheHits).toBe(1);
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  it('详情级缓存：换集号仍复用同一次详情请求', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service, getDetail } = makeService({ 'src-a|900': detail });
    const candidate = candidateOf(source, detail);

    await service.resolve(request({ title: '庆余年', year: 2024, episodeIndex: 1, candidates: [candidate] }));
    const second = await service.resolve(request({ title: '庆余年', year: 2024, episodeIndex: 2, candidates: [candidate] }));

    expect(second.targets[0]?.episodeNumber).toBe(2);
    // 映射键不同 → 映射级未命中；但详情复用 → 只有 1 次 detail 调用
    expect(second.cacheHits).toBe(0);
    expect(getDetail).toHaveBeenCalledTimes(1);
  });

  it('TTL 过期后重新取详情', async () => {
    let clock = 1_000;
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service, getDetail } = makeService({ 'src-a|900': detail }, { ttlMs: 1_000, now: () => clock });
    const req = request({ title: '庆余年', year: 2024, episodeIndex: 4, candidates: [candidateOf(source, detail)] });

    await service.resolve(req);
    clock += 500;
    const inTtl = await service.resolve(req);
    clock += 1_500;
    const expired = await service.resolve(req);

    expect(inTtl.cacheHits).toBe(1);
    expect(expired.cacheHits).toBe(0);
    expect(getDetail).toHaveBeenCalledTimes(2);
  });

  it('clear() 清空缓存与统计', async () => {
    const source = makeSource('src-a', '源A');
    const detail = makeDetail({ sourceId: 'src-a', sourceItemId: '900', title: '庆余年', year: 2024, lineCounts: [12] });
    const { service } = makeService({ 'src-a|900': detail });
    const req = request({ title: '庆余年', year: 2024, episodeIndex: 4, candidates: [candidateOf(source, detail)] });

    await service.resolve(req);
    await service.resolve(req);
    expect(service.stats().cacheHits).toBe(1);

    service.clear();
    expect(service.stats()).toEqual({ detailEntries: 0, mappingEntries: 0, cacheHits: 0, detailFetches: 0 });
  });

  it('缓存条数受 maxEntries 限制（LRU 淘汰）', async () => {
    const source = makeSource('src-a', '源A');
    const details: Record<string, MediaDetail> = {};
    for (let i = 0; i < 4; i += 1) {
      details[`src-a|${i}`] = makeDetail({
        sourceId: 'src-a',
        sourceItemId: String(i),
        title: '庆余年',
        year: 2024,
        lineCounts: [12],
      });
    }
    const { service } = makeService(details, { maxEntries: 2 });
    for (let i = 0; i < 4; i += 1) {
      const detail = details[`src-a|${i}`];
      if (detail === undefined) continue;
      await service.resolve(
        request({ title: '庆余年', year: 2024, episodeIndex: 1, candidates: [candidateOf(source, detail)] }),
      );
    }
    expect(service.stats().mappingEntries).toBeLessThanOrEqual(2);
    expect(service.stats().detailEntries).toBeLessThanOrEqual(2);
  });
});
