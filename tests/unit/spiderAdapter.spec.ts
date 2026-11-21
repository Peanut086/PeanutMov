import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Source } from '@/types';

/**
 * 爬虫源适配器契约（AC-01 / API-01）
 *
 * 用录制的 TVBox JSON 走完整链路：加载 → 分类 → 浏览 → 搜索 → 详情 → 播放。
 * 原生插件（DexClassLoader）在 Node 环境不存在，按 `isNative()===false`
 * 与 mock 两条路径分别验证。
 */
const HOME_JSON = JSON.stringify({
  class: [
    { type_id: 1, type_name: '电影' },
    { type_id: 2, type_name: '剧集' },
  ],
  list: [
    { vod_id: 101, vod_name: '示例影片', type_name: '动作', vod_pic: 'https://img.example.com/a.jpg' },
  ],
});

const CATEGORY_JSON = JSON.stringify({
  page: 1,
  pagecount: 3,
  limit: 20,
  total: 60,
  list: [
    {
      vod_id: 102,
      vod_name: '第二部',
      type_name: '剧情',
      vod_year: '2024',
      vod_remarks: 'HD',
    },
  ],
});

const DETAIL_JSON = JSON.stringify({
  list: [
    {
      vod_id: 102,
      vod_name: '第二部',
      vod_pic: 'https://img.example.com/b.jpg',
      vod_play_from: '线路1$$$线路2',
      vod_play_url:
        '第1集$https://cdn.example.com/e1.m3u8#第2集$https://cdn.example.com/e2.m3u8$$$第1集$https://cdn.example.com/f1.mp4',
    },
  ],
});

const SEARCH_JSON = JSON.stringify({
  list: [{ vod_id: 103, vod_name: '搜索结果', type_name: '科幻' }],
});

const PLAYER_JSON = JSON.stringify({
  url: 'https://cdn.example.com/e2.m3u8',
  header: { 'User-Agent': 'Mozilla/5.0' },
  parse: 0,
});

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-spider',
    key: 'csp_XBPQ',
    name: '爬虫源',
    type: 'spider',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://jihulab.com/xiaohutx/meisha/-/raw/main/1.jar',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: {
      kind: 'jar',
      api: 'csp_XBPQ',
      jarUrl: 'https://jihulab.com/xiaohutx/meisha/-/raw/main/1.jar;md5;bb155c3f0133bbce4756ad52003f5968',
      initExt: '{"分类url":"https://freeok.vip/vod-show/{cateId}.html"}',
      searchable: true,
    },
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

/** 按方法名回放录制的 JSON；`proxyResult` 配置爬虫代理的返回 */
function mockPlugin(
  responses: Record<string, string | null>,
  proxyResult?: { url: string | null; headers?: Record<string, string> } | Error,
) {
  const load = vi.fn().mockResolvedValue({ handle: 'sp-1' });
  const invoke = vi.fn(async (opts: { method: string }) => {
    if (!(opts.method in responses)) {
      throw new Error(`unexpected method ${opts.method}`);
    }
    return { json: responses[opts.method], logs: [] };
  });
  const proxy = vi.fn();
  if (proxyResult instanceof Error) {
    proxy.mockRejectedValue(proxyResult);
  } else if (proxyResult) {
    proxy.mockResolvedValue(proxyResult);
  } else {
    proxy.mockRejectedValue(new Error('unexpected proxy call'));
  }
  vi.doMock('@/native/spiderPlugin', () => ({
    Spider: { load, invoke, proxy, unload: vi.fn(), isSupported: vi.fn() },
    isSpiderAvailable: vi.fn().mockResolvedValue(true),
    spiderInvoke: vi.fn(),
  }));
  return { load, invoke, proxy };
}

/**
 * mock 两段式探活 A 段（HEAD jar）。
 * `error` 用 {code, httpStatus} 描述而非 AppError 实例：`vi.resetModules()` 会重建
 * 模块注册表，spec 顶层 import 的 AppError 是旧实例，adapter 里 `instanceof` 不成立；
 * 因此在工厂运行时动态 import，拿到与 adapter 同实例的 AppError 再抛出。
 */
function mockHttpHead(error: { code: string; httpStatus?: number | null } | null = null) {
  const request = vi.fn(async (_url: string, _options?: unknown) => {
    if (error) {
      const { AppError: FreshAppError } = await import('@/shared/errors');
      throw new FreshAppError(error.code as never, undefined, { httpStatus: error.httpStatus ?? null });
    }
  });
  vi.doMock('@/sources/base/httpClient', () => ({ httpClient: { request } }));
  return { request };
}

/** 取出某次 invoke 的调用参数（断言 List 形参走 arrayArgs） */
function callArgsOf(invoke: ReturnType<typeof vi.fn>, index: number) {
  return invoke.mock.calls[index]?.[0] as {
    method: string;
    args: unknown[];
    arrayArgs?: Record<number, string[]>;
  };
}

const ALL: Record<string, string | null> = {
  homeContent: HOME_JSON,
  categoryContent: CATEGORY_JSON,
  detailContent: DETAIL_JSON,
  searchContent: SEARCH_JSON,
  playerContent: PLAYER_JSON,
};

describe('SpiderAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    mockHttpHead();
    mockPlugin(ALL);
  });

  it('H5 环境：探活与调用均抛 E_NOT_IMPLEMENTED', async () => {
    vi.resetModules();
    vi.doMock('@/shared/platform', () => ({ isNative: () => false }));
    mockPlugin(ALL);
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    const result = await adapter.testConnection(makeSource());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_NOT_IMPLEMENTED');
    expect(result.error?.message).toContain('App 内');
  });

  it('探活：加载 jar 并调用 homeContent，返回条目数', async () => {
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const result = await adapter.testConnection(source);
    expect(result.ok).toBe(true);
    expect(result.health).toBe('ok');
    expect(result.itemCount).toBe(1);
  });

  it('探活 A 段：HEAD jar 403 → 直接判 auth_failed，不做原生加载', async () => {
    const { request } = mockHttpHead({ code: 'E_HTTP_403', httpStatus: 403 });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    const result = await adapter.testConnection(makeSource());
    expect(result.ok).toBe(false);
    expect(result.health).toBe('auth_failed');
    // A 段已判死，B 段（原生 jar 下载 + homeContent）不得执行
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'https://jihulab.com/xiaohutx/meisha/-/raw/main/1.jar',
      { method: 'HEAD', responseType: 'none', timeoutMs: 3000, retries: 0 },
    );
  });

  it('探活 A 段：HEAD 超时 → 结论不确定，继续 B 段完整加载', async () => {
    mockHttpHead({ code: 'E_TIMEOUT' });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    const result = await adapter.testConnection(makeSource());
    expect(result.ok).toBe(true);
    expect(result.itemCount).toBe(1);
  });

  it('探活 A 段：服务端不支持 HEAD（405）→ 继续 B 段', async () => {
    mockHttpHead({ code: 'E_HTTP_400', httpStatus: 405 });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    const result = await adapter.testConnection(makeSource());
    expect(result.ok).toBe(true);
  });

  it('探活 A 段：剥掉 jar 地址的 ;md5; 后缀再 HEAD', async () => {
    const { request } = mockHttpHead();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await adapter.testConnection(makeSource());
    const calledUrl = request.mock.calls[0]?.[0] as string;
    expect(calledUrl).not.toContain(';md5;');
  });

  it('listCategories：从 homeContent 的 class 映射', async () => {
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const categories = await adapter.listCategories(makeSource());
    expect(categories.map((c) => c.name)).toEqual(['电影', '剧集']);
    expect(categories[0]?.sourceId).toBe('src-spider');
  });

  it('browse：翻页参数与 hasMore 由 pagecount/total 推导', async () => {
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();
    const page = await adapter.browse({
      source,
      categoryId: 'src-spider::1',
      page: 1,
      pageSize: 20,
      filters: { type: null, yearFrom: null, yearTo: null, area: null },
      signal: undefined,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe('第二部');
    expect(page.total).toBe(60);
    expect(page.hasMore).toBe(true);
  });

  it('search：keyword 透传，返回归一化条目', async () => {
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const items = await adapter.search({
      source: makeSource(),
      keyword: '科幻',
      page: 1,
      pageSize: 20,
      signal: undefined,
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('搜索结果');
    expect(items[0]?.sourceItemId).toBe('103');
  });

  it('getDetail：线路与剧集按 `$$$`/`#` 解析', async () => {
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const detail = await adapter.getDetail({ source: makeSource(), sourceItemId: '102' });

    expect(detail.item.title).toBe('第二部');
    expect(detail.lines).toHaveLength(2);
    expect(detail.lines[0]?.name).toBe('线路1');
    expect(detail.episodes).toHaveLength(3);
    expect(detail.episodes[1]?.title).toBe('第2集');
  });

  it('resolvePlayUrl：playerContent 取直链并带上源 header', async () => {
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource({ headers: { Referer: 'https://freeok.vip' } });

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    const secondEpisode = detail.episodes.find((e) => e.title === '第2集');
    const play = await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: secondEpisode!.id,
    });

    expect(play.url).toBe('https://cdn.example.com/e2.m3u8');
    expect(play.format).toBe('hls');
    // 源 headers 与爬虫返回 header 合并
    expect(play.headers['Referer']).toBe('https://freeok.vip');
    expect(play.headers['User-Agent']).toBe('Mozilla/5.0');
  });

  /**
   * 真机实测（DL-P1-3 jar 源）：XBPQ 这类爬虫把 header 塞成 JSON 字符串而不是对象
   * （Java 侧 `JSONObject.toString()` 直接 put）。摊进 `{...played.header}` 就变成
   * `"0".."80"` 一串单字符头——UA/Referer 一个都没发出去，CDN 一律 403。
   */
  it('resolvePlayUrl：header 是 JSON 字符串时先解析再合并，不摊成字符下标头', async () => {
    mockPlugin({
      ...ALL,
      playerContent: JSON.stringify({
        url: 'https://cdn.example.com/e2.m3u8',
        header: '{"User-Agent":"Mozilla/5.0","Referer":"https://freeok.vip/"}',
        parse: 0,
      }),
    });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    const play = await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: detail.episodes[1]!.id,
    });

    expect(play.headers['User-Agent']).toBe('Mozilla/5.0');
    expect(play.headers['Referer']).toBe('https://freeok.vip/');
    // 摊平的老毛病会留下一堆 "0"、"1"…… 的单字符键
    expect(Object.keys(play.headers).filter((k) => /^\d+$/.test(k))).toEqual([]);
  });

  it('resolvePlayUrl：header 是不像 JSON 的垃圾串时忽略它，而不是发出字符头', async () => {
    mockPlugin({
      ...ALL,
      playerContent: JSON.stringify({
        url: 'https://cdn.example.com/e2.m3u8',
        header: 'not-json',
        parse: 0,
      }),
    });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource({ headers: { Referer: 'https://freeok.vip' } });

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    const play = await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: detail.episodes[1]!.id,
    });

    expect(play.headers).toEqual({ Referer: 'https://freeok.vip' });
  });

  it('resolvePlayUrl：parse=1（需解析接口）→ E_NO_PLAY_URL', async () => {
    mockPlugin({ ...ALL, playerContent: JSON.stringify({ url: 'https://x.com/a.mp4', parse: 1 }) });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    await expect(
      adapter.resolvePlayUrl({
        source,
        mediaId: detail.item.id,
        sourceItemId: '102',
        lineId: detail.lines[0]!.id,
        episodeId: detail.episodes[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'E_NO_PLAY_URL' });
  });

  it('resolvePlayUrl：proxy=1 → 走爬虫代理换直链，headers 合并', async () => {
    const { proxy } = mockPlugin(
      {
        ...ALL,
        playerContent: JSON.stringify({
          url: 'https://pan.example.com/raw?token=x',
          parse: 0,
          proxy: 1,
        }),
      },
      { url: 'https://cdn.example.com/direct.m3u8', headers: { Referer: 'https://pan.example.com' } },
    );
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource({ headers: { Referer: 'https://freeok.vip' } });

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    const play = await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: detail.episodes[0]!.id,
    });

    expect(proxy).toHaveBeenCalledWith({
      handle: 'sp-1',
      url: 'https://pan.example.com/raw?token=x',
    });
    expect(play.url).toBe('https://cdn.example.com/direct.m3u8');
    expect(play.format).toBe('hls');
    // 代理返回的 header 覆盖源 header，爬虫 header 仍保留
    expect(play.headers['Referer']).toBe('https://pan.example.com');
  });

  it('resolvePlayUrl：proxy:// 协议地址 → 走爬虫代理换直链', async () => {
    const { proxy } = mockPlugin(
      {
        ...ALL,
        playerContent: JSON.stringify({
          url: 'proxy://do=push&url=https%3A%2F%2Fcdn.example.com%2Fb.m3u8',
          parse: 0,
        }),
      },
      { url: 'https://cdn.example.com/b.m3u8', headers: {} },
    );
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    const play = await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: detail.episodes[0]!.id,
    });

    expect(proxy).toHaveBeenCalledWith({
      handle: 'sp-1',
      url: 'proxy://do=push&url=https%3A%2F%2Fcdn.example.com%2Fb.m3u8',
    });
    expect(play.url).toBe('https://cdn.example.com/b.m3u8');
  });

  it('resolvePlayUrl：代理未返回直链 → E_NO_PLAY_URL', async () => {
    mockPlugin(
      { ...ALL, playerContent: JSON.stringify({ url: 'proxy://do=push', parse: 0, proxy: 1 }) },
      { url: null, headers: {} },
    );
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    await expect(
      adapter.resolvePlayUrl({
        source,
        mediaId: detail.item.id,
        sourceItemId: '102',
        lineId: detail.lines[0]!.id,
        episodeId: detail.episodes[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'E_NO_PLAY_URL' });
  });

  it('resolvePlayUrl：代理调用失败 → E_SOURCE_UNAVAILABLE', async () => {
    mockPlugin(
      { ...ALL, playerContent: JSON.stringify({ url: 'proxy://do=push', parse: 0, proxy: 1 }) },
      new Error('proxy failed'),
    );
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    await expect(
      adapter.resolvePlayUrl({
        source,
        mediaId: detail.item.id,
        sourceItemId: '102',
        lineId: detail.lines[0]!.id,
        episodeId: detail.episodes[0]!.id,
      }),
    ).rejects.toMatchObject({ code: 'E_SOURCE_UNAVAILABLE' });
  });

  it('resolvePlayUrl：TVBox 本地代理地址（127.0.0.1:9978/proxy?do=m3u8&url=...）→ 取内层直链', async () => {
    const innerUrl = 'https://cdn.example.com/real.m3u8';
    const proxyUrl = `http://127.0.0.1:9978/proxy?do=m3u8&url=${encodeURIComponent(innerUrl)}`;
    mockPlugin({
      ...ALL,
      playerContent: JSON.stringify({ url: proxyUrl, parse: 0 }),
    });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    const play = await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: detail.episodes[0]!.id,
    });

    expect(play.url).toBe(innerUrl);
    expect(play.format).toBe('hls');
  });

  it('resolvePlayUrl：proxy://do=m3u8&url=... → 取内层直链，不走爬虫代理', async () => {
    const { proxy } = mockPlugin({
      ...ALL,
      playerContent: JSON.stringify({
        url: 'proxy://do=m3u8&url=https%3A%2F%2Fcdn.example.com%2Finner.m3u8',
        parse: 0,
      }),
    });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    const play = await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: detail.episodes[0]!.id,
    });

    expect(play.url).toBe('https://cdn.example.com/inner.m3u8');
    // proxy://do=m3u8 被解包，不应调用爬虫代理
    expect(proxy).not.toHaveBeenCalled();
  });

  it('爬虫返回非法 JSON → E_PARSE', async () => {
    mockPlugin({ ...ALL, categoryContent: 'not-json' });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    await expect(
      adapter.browse({
        source: makeSource(),
        categoryId: 'src-spider::1',
        page: 1,
        pageSize: 20,
        filters: { type: null, yearFrom: null, yearTo: null, area: null },
        signal: undefined,
      }),
    ).rejects.toMatchObject({ code: 'E_PARSE' });
  });

  it('缺少 jar 配置 → E_UNSUPPORTED_FORMAT', async () => {
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource({ ext: { kind: 'jar', api: 'csp_XBPQ', jarUrl: null, initExt: '' } });
    await expect(adapter.testConnection(source)).resolves.toMatchObject({
      ok: false,
      error: { code: 'E_UNSUPPORTED_FORMAT' },
    });
  });

  it('加载失败 → 错误原因透传（HTTP 404 → E_HTTP_404，健康态 unreachable）', async () => {
    vi.resetModules();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    vi.doMock('@/native/spiderPlugin', () => ({
      Spider: {
        load: vi.fn().mockRejectedValue(new Error('HTTP 404')),
        invoke: vi.fn(),
        proxy: vi.fn(),
        unload: vi.fn(),
      },
      isSpiderAvailable: vi.fn().mockResolvedValue(true),
      spiderInvoke: vi.fn(),
    }));
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const result = await adapter.testConnection(makeSource());
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_HTTP_404');
    expect(result.health).toBe('unreachable');
  });

  it('规则下载拿到 HTML 页 → E_SOURCE_UNAVAILABLE，且保留可读原因', async () => {
    vi.resetModules();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    vi.doMock('@/native/spiderPlugin', () => ({
      Spider: { load: vi.fn(), invoke: vi.fn(), proxy: vi.fn(), unload: vi.fn() },
      isSpiderAvailable: vi.fn().mockResolvedValue(true),
      spiderInvoke: vi.fn(),
    }));
    vi.doMock('@/native/drpyPlugin', () => ({
      Drpy: {
        load: vi
          .fn()
          .mockRejectedValue(
            new Error('规则加载失败: 返回的是 HTML 页面而非 JS 源码（885 字节）：https://x.test/JustLive.js'),
          ),
        invoke: vi.fn(),
        unload: vi.fn(),
      },
      isDrpyAvailable: vi.fn().mockResolvedValue(true),
    }));
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource({
      ext: { kind: 'js', api: null, jarUrl: null, initExt: 'https://x.test/JustLive.js', searchable: true },
    });
    const result = await adapter.testConnection(source);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_SOURCE_UNAVAILABLE');
    // 不能退化成泛化的「该源暂不可用」——用户要能看出是源站返回了网页
    expect(result.error?.message).toContain('HTML 页面而非 JS 源码');
  });

  it('P1-3：同一坏 jar 本进程内不重跑第二次，文案与第一次一致；换版本才重新真跑', async () => {
    vi.resetModules();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    mockHttpHead();
    const load = vi.fn().mockRejectedValue(
      new Error('爬虫加载失败: java.lang.IncompatibleClassChangeError: csp_PanWebShare'),
    );
    vi.doMock('@/native/spiderPlugin', () => ({
      Spider: { load, invoke: vi.fn(), proxy: vi.fn(), unload: vi.fn(), isSupported: vi.fn() },
      isSpiderAvailable: vi.fn().mockResolvedValue(true),
      spiderInvoke: vi.fn(),
    }));
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const first = await adapter.testConnection(source);
    expect(first.ok).toBe(false);
    const afterFirst = load.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    // 第二次不再敲原生：缺类还是缺类，重跑要付下载 + dex + 防护初始化的全价，还白占爬虫池
    const second = await adapter.testConnection(source);
    expect(second.ok).toBe(false);
    expect(load.mock.calls.length).toBe(afterFirst);
    // 同一条对症文案（第一次收敛过，第二次不能把英文堆栈甩给用户）
    expect(second.error?.message).toBe(first.error?.message);
    expect(second.error?.message).not.toContain('IncompatibleClassChangeError');

    // 源站换了文件（jarUrl 含 ;md5; 后缀即版本）→ 是新证据，必须重新真跑一次
    const updated = makeSource({
      ext: {
        kind: 'jar',
        api: 'csp_XBPQ',
        jarUrl: 'https://jihulab.com/xiaohutx/meisha/-/raw/main/2.jar;md5;ffffffffffffffffffffffffffffffff',
        initExt: '{}',
        searchable: true,
      },
    });
    const third = await adapter.testConnection(updated);
    expect(third.ok).toBe(false);
    expect(load.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('P2-8：drpy 搜索把页码透传给规则（缺省会拼出 page=undefined）', async () => {
    vi.resetModules();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    vi.doMock('@/native/spiderPlugin', () => ({
      Spider: { load: vi.fn(), invoke: vi.fn(), proxy: vi.fn(), unload: vi.fn() },
      isSpiderAvailable: vi.fn().mockResolvedValue(true),
      spiderInvoke: vi.fn(),
    }));
    const drpyInvoke = vi.fn(async (_opts: { handle: string; method: string; arg: string }) => ({
      json: SEARCH_JSON,
      logs: [],
    }));
    vi.doMock('@/native/drpyPlugin', () => ({
      Drpy: { load: vi.fn().mockResolvedValue({ handle: 'js-1' }), invoke: drpyInvoke, unload: vi.fn() },
      isDrpyAvailable: vi.fn().mockResolvedValue(true),
    }));
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource({
      ext: { kind: 'js', api: null, jarUrl: null, initExt: 'https://x.test/rule.js', searchable: true },
    });

    await adapter.search({ source, keyword: '测试', page: 3, pageSize: 20, signal: undefined });

    const call = drpyInvoke.mock.calls.find((c) => (c[0] as { method: string }).method === 'search');
    expect(call).toBeDefined();
    expect(JSON.parse((call![0] as { arg: string }).arg)).toMatchObject({ wd: '测试', pg: 3 });
  });
});

describe('SpiderAdapter List 形参（arrayArgs）', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
  });

  it('detailContent 的 ids 走 arrayArgs，args 只放占位字符串', async () => {
    const { invoke } = mockPlugin({ ...ALL, detailContent: DETAIL_JSON });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await adapter.getDetail({ source: makeSource(), sourceItemId: '102' });

    const call = callArgsOf(invoke, 0);
    expect(call.method).toBe('detailContent');
    expect(call.args).toEqual(['102']);
    // List 形参必须显式声明：Capacitor 桥接会把嵌套数组展平成字符串
    expect(call.arrayArgs).toEqual({ 0: ['102'] });
  });

  it('playerContent 的 vipFlags 走 arrayArgs 空数组', async () => {
    const { invoke } = mockPlugin(ALL);
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    await adapter.resolvePlayUrl({
      source,
      mediaId: detail.item.id,
      sourceItemId: '102',
      lineId: detail.lines[0]!.id,
      episodeId: detail.episodes[0]!.id,
    });

    const call = callArgsOf(invoke, invoke.mock.calls.length - 1);
    expect(call.method).toBe('playerContent');
    expect(call.arrayArgs).toEqual({ 2: [] });
  });

  it('categoryContent 的 HashMap 走 args 对象（不需要 arrayArgs）', async () => {
    const { invoke } = mockPlugin(ALL);
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await adapter.browse({
      source: makeSource(),
      categoryId: 'src-spider::1',
      page: 1,
      pageSize: 20,
      filters: { type: null, yearFrom: null, yearTo: null, area: null },
      signal: undefined,
    });

    const call = callArgsOf(invoke, 0);
    expect(call.method).toBe('categoryContent');
    // 第 4 参是 HashMap，必须是对象而非字符串 '{}'
    expect(call.args).toEqual([':1', 1, true, {}]);
    expect(call.arrayArgs).toBeUndefined();
  });
});

/**
 * 空 tid 回退（CHG-29）
 *
 * UI 默认选中「全部」时 `categoryId` 为 null，`parseCategoryValue` 返回 null。
 * 旧行为传空串给 categoryContent——实测枫叶源 8 个分类全部因此返回空列表。
 * 新行为：回退用 homeContent 的第一个 `type_id`（对齐 TVBox 客户端约定）。
 */
describe('SpiderAdapter 空 tid 回退', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    mockHttpHead();
  });

  it('categoryId 为 null → 用 homeContent 首个分类的 type_id', async () => {
    const { invoke } = mockPlugin(ALL);
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await adapter.browse({
      source: makeSource(),
      categoryId: null,
      page: 1,
      pageSize: 20,
      filters: { type: null, yearFrom: null, yearTo: null, area: null },
      signal: undefined,
    });

    const index = invoke.mock.calls.findIndex((c) => (c[0] as { method: string }).method === 'categoryContent');
    expect(callArgsOf(invoke, index).args[0]).toBe('1');
  });

  it('显式分类优先于回退值', async () => {
    const { invoke } = mockPlugin(ALL);
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await adapter.browse({
      source: makeSource(),
      categoryId: 'src-spider:2',
      page: 2,
      pageSize: 20,
      filters: { type: null, yearFrom: null, yearTo: null, area: null },
      signal: undefined,
    });

    const index = invoke.mock.calls.findIndex((c) => (c[0] as { method: string }).method === 'categoryContent');
    expect(callArgsOf(invoke, index).args[0]).toBe('2');
  });

  it('homeContent 无分类时仍传空串（保持旧行为）', async () => {
    const { invoke } = mockPlugin({
      ...ALL,
      homeContent: JSON.stringify({ list: [] }),
      categoryContent: JSON.stringify({ list: [] }),
    });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await adapter.browse({
      source: makeSource(),
      categoryId: null,
      page: 1,
      pageSize: 20,
      filters: { type: null, yearFrom: null, yearTo: null, area: null },
      signal: undefined,
    });

    const index = invoke.mock.calls.findIndex((c) => (c[0] as { method: string }).method === 'categoryContent');
    expect(callArgsOf(invoke, index).args[0]).toBe('');
  });

  it('P1-4：magnet: 播放地址 → E_UNSUPPORTED_FORMAT，detail 带原始磁力链接', async () => {
    mockPlugin({ ...ALL, playerContent: JSON.stringify({ url: 'magnet:?xt=urn:btih:abc123' }) });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const detail = await adapter.getDetail({ source, sourceItemId: '102' });
    await expect(
      adapter.resolvePlayUrl({
        source,
        mediaId: detail.item.id,
        sourceItemId: '102',
        lineId: detail.lines[0]!.id,
        episodeId: detail.episodes[0]!.id,
      }),
    ).rejects.toMatchObject({
      code: 'E_UNSUPPORTED_FORMAT',
      retryable: false,
      detail: 'magnet:?xt=urn:btih:abc123',
    });
  });

  it('P1-5：规则脚本原始异常不外泄（统一成「规则脚本异常」）', async () => {
    const { invoke } = mockPlugin({ ...ALL });
    invoke.mockImplementation(async (opts: { method: string }) => {
      if (opts.method === 'searchContent') throw new Error("搜索执行失败: expecting ';'");
      return { json: ALL[opts.method] ?? null, logs: [] };
    });
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await expect(
      adapter.search({ source: makeSource(), keyword: '测试', page: 1, pageSize: 20, signal: undefined }),
    ).rejects.toMatchObject({ message: '规则脚本异常（源站问题）' });
  });

  it('P2-8：drpy（kind=js）搜索透传页码，jar 保持两参', async () => {
    const { invoke } = mockPlugin(ALL);
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();

    await adapter.search({ source: makeSource(), keyword: '测试', page: 2, pageSize: 20, signal: undefined });
    const jarIndex = invoke.mock.calls.findIndex((c) => (c[0] as { method: string }).method === 'searchContent');
    expect(callArgsOf(invoke, jarIndex).args).toEqual(['测试', true]);
  });
});
