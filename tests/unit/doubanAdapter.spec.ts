import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 豆瓣适配器契约
 *
 * 只验证：归一化、豆瓣分类/浏览/详情、resolvePlayUrl 的跨源借用分支。
 * HTTP 层由 doubanClient.spec.ts 覆盖，这里用 mock 拦截。
 */
import { DoubanAdapter, doubanRuntime } from '@/sources/douban/DoubanAdapter';
import type { Source } from '@/types';

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-douban',
    key: 'drpy_js_豆瓣',
    name: '豆瓣发现',
    type: 'douban',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://jihulab.com/yydfys/yydf/-/raw/main/yydf/lib/douban.js',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: { kind: 'douban', api: null, jarUrl: null, initExt: '', searchable: true },
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  doubanRuntime.resolvePlayFrom = null;
  doubanRuntime.adapterGetter = null;
});

const HOT = {
  total: 303,
  items: [
    { id: '100', title: '希望', type: 'movie', card_subtitle: '2026 / 韩国 / 剧情', pic: { normal: 'https://img/1.jpg' }, rating: { value: 7.5 } },
  ],
};
const DETAIL = {
  title: '希望',
  card_subtitle: '2026 / 韩国 / 剧情',
  pic: { normal: 'https://img/1.jpg' },
  rating: { value: 7.5 },
  intro: '韩港村的怪物',
  actors: [{ name: '黄政民' }],
  directors: [{ name: '罗泓轸' }],
  genres: ['剧情'],
  countries: ['韩国'],
  durations: ['01:52:00'],
};

describe('DoubanAdapter', () => {
  it('probe：豆瓣接口可用则 ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(HOT));
    const adapter = new DoubanAdapter();
    const result = await adapter.testConnection(makeSource());
    expect(result.ok).toBe(true);
    expect(result.itemCount).toBeGreaterThan(0);
  });

  it('listCategories：7 个豆瓣分类', async () => {
    const adapter = new DoubanAdapter();
    const categories = await adapter.listCategories(makeSource());
    expect(categories).toHaveLength(7);
    expect(categories.map((c) => c.name)).toEqual([
      '热门电影',
      '热播剧集',
      '热播综艺',
      '电影筛选',
      '电视筛选',
      '电影榜单',
      '电视榜单',
    ]);
  });

  it('browse：热门分类归一化为 MediaItem 并带年份/评分', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(HOT));
    const adapter = new DoubanAdapter();
    const page = await adapter.browse({
      source: makeSource(),
      categoryId: null,
      page: 1,
      pageSize: 30,
      filters: { type: null, yearFrom: null, yearTo: null, area: null },
      signal: undefined,
    });
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.title).toBe('希望');
    expect(item.year).toBe(2026);
    expect(item.rating).toBe(7.5);
    expect(item.area).toBe('韩国');
    expect(page.hasMore).toBe(true);
  });

  it('getDetail：返回正片线路/剧集与简介', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(DETAIL));
    const adapter = new DoubanAdapter();
    const detail = await adapter.getDetail({ source: makeSource(), sourceItemId: '100' });
    expect(detail.item.title).toBe('希望');
    expect(detail.item.description).toBe('韩港村的怪物');
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]?.name).toBe('正片');
    expect(detail.episodes).toHaveLength(1);
    expect(detail.episodes[0]?.title).toBe('正片');
  });

  it('resolvePlayUrl（未装配时）：E_NO_PLAY_URL 且不再沉默', async () => {
    const adapter = new DoubanAdapter();
    const source = makeSource();
    // 详情必须先落库（resolvePlayUrl 以此为依据取片名/年份）
    await expect(
      adapter.resolvePlayUrl({
        source,
        mediaId: 'douban-src-douban:100~x',
        sourceItemId: '100',
        episodeId: 'douban-100-1',
        lineId: 'douban-100',
      }),
    ).rejects.toMatchObject({ code: 'E_NO_PLAY_URL' });
  });

  it('resolvePlayUrl（装配 + 无候选）：报「没有找到可播放的源」', async () => {
    doubanRuntime.resolvePlayFrom = async () => [];
    doubanRuntime.adapterGetter = () => ({
      resolvePlayUrl: async () => ({ url: 'x', format: 'mp4', headers: {}, subtitles: [], lineId: '', quality: null, expiresAt: null, isLocal: false }),
    });
    const adapter = new DoubanAdapter();
    await expect(
      adapter.resolvePlayUrl({
        source: makeSource(),
        mediaId: 'douban-src-douban:100~x',
        sourceItemId: '100',
        episodeId: 'douban-100-1',
        lineId: 'douban-100',
      }),
    ).rejects.toMatchObject({ code: 'E_NO_PLAY_URL', message: expect.stringContaining('没有找到') });
  });

  it('resolvePlayUrl（CHG-12 回退）：首候选失败顺延次候选成功', async () => {
    const good = makeSource({ id: 'src-good', name: '好源', type: 'site' });
    const bad = makeSource({ id: 'src-bad', name: '坏源', type: 'site' });
    doubanRuntime.resolvePlayFrom = async () => [
      { source: bad, item: { id: 'x', sourceId: bad.id, sourceItemId: '100', originalTitle: null, title: '希望', type: 'movie', year: 2026, area: null, genres: [], tags: [], rating: null, posterUrl: null, backdropUrl: null, description: null, durationSec: null, episodeCount: null, titleLower: '希望', isDemo: false, cachedAt: 1, updatedAt: 1 } },
      { source: good, item: { id: 'y', sourceId: good.id, sourceItemId: '200', originalTitle: null, title: '希望', type: 'movie', year: 2026, area: null, genres: [], tags: [], rating: null, posterUrl: null, backdropUrl: null, description: null, durationSec: null, episodeCount: null, titleLower: '希望', isDemo: false, cachedAt: 1, updatedAt: 1 } },
    ];
    const attempted: string[] = [];
    doubanRuntime.adapterGetter = (source) => ({
      resolvePlayUrl: async () => {
        attempted.push(source.id);
        if (source.id === 'src-bad') throw new (await import('@/shared/errors')).AppError('E_NO_PLAY_URL', '该线路需要解析接口');
        return { url: 'https://cdn/x.m3u8', format: 'hls', headers: {}, subtitles: [], lineId: '', quality: null, expiresAt: null, isLocal: false };
      },
    });
    const adapter = new DoubanAdapter();
    const play = await adapter.resolvePlayUrl({
      source: makeSource(),
      mediaId: 'douban-src-douban:100~x',
      sourceItemId: '100',
      episodeId: 'douban-100-1',
      lineId: 'douban-100',
    });
    expect(attempted).toEqual(['src-bad', 'src-good']);
    expect(play.url).toBe('https://cdn/x.m3u8');
  });

  it('resolvePlayUrl（CHG-12 回退）：全部候选失败 → 聚合报错并带明细', async () => {
    const a = makeSource({ id: 'src-a', name: 'A 源', type: 'site' });
    const b = makeSource({ id: 'src-b', name: 'B 源', type: 'site' });
    doubanRuntime.resolvePlayFrom = async () => [
      { source: a, item: { id: 'x', sourceId: a.id, sourceItemId: '1', originalTitle: null, title: '希望', type: 'movie', year: 2026, area: null, genres: [], tags: [], rating: null, posterUrl: null, backdropUrl: null, description: null, durationSec: null, episodeCount: null, titleLower: '希望', isDemo: false, cachedAt: 1, updatedAt: 1 } },
      { source: b, item: { id: 'y', sourceId: b.id, sourceItemId: '2', originalTitle: null, title: '希望', type: 'movie', year: 2026, area: null, genres: [], tags: [], rating: null, posterUrl: null, backdropUrl: null, description: null, durationSec: null, episodeCount: null, titleLower: '希望', isDemo: false, cachedAt: 1, updatedAt: 1 } },
    ];
    doubanRuntime.adapterGetter = (source) => ({
      resolvePlayUrl: async () => {
        throw new (await import('@/shared/errors')).AppError('E_NO_PLAY_URL', `${source.name} 无地址`);
      },
    });
    const adapter = new DoubanAdapter();
    await expect(
      adapter.resolvePlayUrl({
        source: makeSource(),
        mediaId: 'douban-src-douban:100~x',
        sourceItemId: '100',
        episodeId: 'douban-100-1',
        lineId: 'douban-100',
      }),
    ).rejects.toMatchObject({
      code: 'E_NO_PLAY_URL',
      message: expect.stringContaining('2 个候选源均无法解析'),
    });
  });
});
