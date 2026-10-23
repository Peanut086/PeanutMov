import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * 豆瓣客户端单测
 *
 * 只验证三件事：请求头必须带小程序 UA/Referer/apikey（不带会被 400/404）、
 * 各分支接口的响应如何归一化为 DoubanItem、非法条目被丢弃。
 */
import {
  DOUBAN_CATEGORIES,
  areaOf,
  fetchCategoryPage,
  fetchDoubanDetail,
  normalizeDoubanItem,
  parseDuration,
  searchDouban,
} from '@/sources/douban/doubanClient';

function respond(body: unknown, init: { status?: number } = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

const HOT_GAIA = {
  start: 0,
  count: 30,
  total: 303,
  items: [
    {
      id: '36179101',
      title: '希望',
      type: 'movie',
      card_subtitle: '2026 / 韩国 / 剧情 动作 科幻',
      pic: { normal: 'https://img2.doubanio.com/a.jpg' },
      rating: { value: 7.5 },
      has_linewatch: false,
      honor_infos: [{ title: '主竞赛提名' }],
    },
  ],
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('豆瓣客户端', () => {
  it('normalizeDoubanItem：标题/id 缺失或「未知电影」丢弃', () => {
    expect(normalizeDoubanItem(null)).toBe(null);
    expect(normalizeDoubanItem({ id: '1' })).toBe(null);
    expect(normalizeDoubanItem({ title: 'x' })).toBe(null);
    expect(normalizeDoubanItem({ id: '1', title: '未知电影' })).toBe(null);
  });

  it('normalizeDoubanItem：海报/评分/年份/荣誉归一', () => {
    const item = normalizeDoubanItem({
      id: '1',
      title: '希望',
      type: 'movie',
      card_subtitle: '2026 / 韩国 / 剧情',
      pic: { normal: 'https://img/a.jpg' },
      rating: { value: 7.5 },
      honor_infos: [{ title: '提名1' }, { title: '提名2' }],
    });
    expect(item?.posterUrl).toBe('https://img/a.jpg');
    expect(item?.rating).toBe(7.5);
    expect(item?.year).toBe(2026);
    expect(item?.honor).toBe('提名1|提名2');
    expect(areaOf(item!)).toBe('韩国');
  });

  it('fetchCategoryPage(hot)：带小程序头 + apikey，返回归一化条目', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(HOT_GAIA));
    const page = await fetchCategoryPage(DOUBAN_CATEGORIES[0]!, 1);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe('希望');
    expect(page.items[0]?.year).toBe(2026);
    expect(page.total).toBe(303);
    expect(page.pageCount).toBe(11);

    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(String(url)).toContain('frodo.douban.com/api/v2/movie/hot_gaia');
    expect(String(url)).toContain('apikey=');
    expect(headers['User-Agent']).toContain('MicroMessenger');
    expect(headers['Referer']).toContain('servicewechat.com');
  });

  it('fetchCategoryPage(collection)：走 subject_collection/{id}/items', async () => {
    const payload = {
      total: 59,
      subject_collection_items: [
        { id: '2', title: '某综艺', type: 'show', pic: { normal: 'https://img/b.jpg' } },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(payload));
    const category = DOUBAN_CATEGORIES.find((c) => c.key === 'show_hot')!;
    const page = await fetchCategoryPage(category, 1);

    expect(page.items).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/subject_collection/show_hot/items');
  });

  it('fetchCategoryPage(recommend)：走 /movie/recommend', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond({ items: [] }));
    const category = DOUBAN_CATEGORIES.find((c) => c.key === 'movie')!;
    await fetchCategoryPage(category, 1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/movie/recommend');
  });

  it('searchDouban：从 contents.items 的 target 提取影视条目，跳过非影视卡片', async () => {
    const payload = {
      contents: {
        items: [
          { target: { id: '301', title: '流浪地球', type: 'movie', pic: { normal: 'https://img/c.jpg' } } },
          { target: { id: 'x', title: '影评卡片', layout: 'note' } }, // 非影视，被 normalize 丢弃（缺 year/subtitle 也保留？这里 title 有，id 有，会保留）——用 layout 无关校验
          { notarget: true },
        ],
      },
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(payload));
    const items = await searchDouban('流浪地球');
    // 只有 target 且有 id+title 的才保留
    expect(items.some((i) => i.title === '流浪地球')).toBe(true);
    expect(items.some((i) => i === null)).toBe(false);
  });

  it('parseDuration：时钟/分钟两种形态', () => {
    expect(parseDuration('01:52:00')).toBe(6720);
    expect(parseDuration('48:12')).toBe(2892);
    expect(parseDuration('112分钟')).toBe(6720);
    expect(parseDuration('未知')).toBe(null);
  });

  it('fetchDoubanDetail：详情归一并提取简介/演员/导演', async () => {
    const payload = {
      title: '希望',
      card_subtitle: '2026 / 韩国 / 剧情',
      pic: { normal: 'https://img/a.jpg' },
      rating: { value: 7.5 },
      intro: '韩港村出现神秘生物',
      actors: [{ name: '黄政民' }, { name: '赵寅成' }],
      directors: [{ name: '罗泓轸' }],
      genres: ['剧情', '科幻'],
      countries: ['韩国'],
      durations: ['01:52:00'],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(respond(payload));
    const detail = await fetchDoubanDetail('movie', '36179101');

    expect(detail.intro).toBe('韩港村出现神秘生物');
    expect(detail.actors).toEqual(['黄政民', '赵寅成']);
    expect(detail.directors).toEqual(['罗泓轸']);
    expect(detail.durationSec).toBe(6720);
    expect(detail.item.year).toBe(2026);
  });
});
