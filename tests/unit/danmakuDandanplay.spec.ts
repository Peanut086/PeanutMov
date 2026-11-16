/**
 * 弹弹play开放弹幕网络 Provider（弹幕 Phase1）
 *
 * 协议事实取自官方 `https://api.dandanplay.net/swagger/v2/swagger.json` 与
 * `https://doc.dandanplay.com/open/`，本用例把这几条锁住，防止再次凭想象写回旧形状：
 * - 鉴权是 `X-AppId` + `X-AppSecret`（凭证模式）；`X-Secret` 不存在，官方直接 403；
 * - `/api/v2/match` 的请求 `matchMode` 只有 `hashAndFileName|fileNameOnly|hashOnly`，
 *   响应是 `ResponseBase + { isMatched, matches[] }`，`matches` 一项就是一个节目（无按季分层）；
 * - `/api/v2/comment/{id}` 的每条弹幕是 `{ cid, p, m }`，`p` = `出现时间,模式,颜色,用户ID`，
 *   文本在 `m`；
 * - `matches[].shift` 是该弹幕库的时间轴偏移（秒，正数=延迟），落到 `offsetSec`。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dandanplayProvider, setDandanplayCredentials } from '@/services/danmaku/provider';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
  // nativeHttp 的 Web 通路只用到 httpClient；这里补上它 import 的其余符号避免运行期 undefined
  mapStatusError: (status: number) => new Error(`http ${status}`),
}));

const mockedRequest = vi.mocked(httpClient.request);

/** 一次命中所需的最小响应集：按 URL 关键字分派 */
function route(handlers: Record<string, unknown | Error>): void {
  mockedRequest.mockImplementation(((url: string) => {
    for (const [keyword, value] of Object.entries(handlers)) {
      if (url.includes(keyword)) {
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      }
    }
    return Promise.resolve({});
  }) as never);
}

const MATCH_OK = {
  success: true,
  errorCode: 0,
  isMatched: true,
  matches: [
    {
      episodeId: 179140001,
      animeId: 4730,
      animeTitle: '庆余年',
      episodeTitle: '第01集',
      type: 'tv',
      typeDescription: '电视剧',
      shift: 2.5,
    },
  ],
};
const COMMENTS_OK = {
  count: 3,
  comments: [
    { cid: 1, p: '12.34,1,16711680,1001', m: '前方高能' },
    { cid: 2, p: '15.00,5,255,1002', m: '顶部弹幕' },
    // 空文本与坏时间戳都要丢掉，不能让渲染层拿到 NaN
    { cid: 3, p: 'bad,1,255,1003', m: '坏行' },
    { cid: 4, p: '20.00,1,255,1004', m: '   ' },
  ],
};

function requestOptions(index: number): { url: string; init: Record<string, unknown> } {
  const call = mockedRequest.mock.calls[index] as [string, Record<string, unknown>];
  return { url: call[0], init: call[1] ?? {} };
}

describe('dandanplay Provider（协议口径）', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
    setDandanplayCredentials('test-app', 'test-secret');
  });

  it('无凭据时不可用，且清空任一项即停用', () => {
    setDandanplayCredentials('', 'test-secret');
    expect(dandanplayProvider.available()).toBe(false);
    setDandanplayCredentials('test-app', '  ');
    expect(dandanplayProvider.available()).toBe(false);
    setDandanplayCredentials('test-app', 'test-secret');
    expect(dandanplayProvider.available()).toBe(true);
  });

  it('凭证模式发 X-AppSecret，不再发不存在的 X-Secret', async () => {
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': COMMENTS_OK });
    await dandanplayProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    const match = requestOptions(0);
    expect(match.url).toBe('https://api.dandanplay.net/api/v2/match');
    expect(match.init.headers).toMatchObject({ 'X-AppId': 'test-app', 'X-AppSecret': 'test-secret' });
    expect(Object.keys(match.init.headers as Record<string, string>)).not.toContain('X-Secret');
    // 弹幕接口是 302 跳转后再取体，同样要带凭据头
    expect(requestOptions(1).init.headers).toMatchObject({ 'X-AppId': 'test-app', 'X-AppSecret': 'test-secret' });
  });

  it('matchMode 用服务端支持的 fileNameOnly，文件名带年份与集号', async () => {
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': COMMENTS_OK });
    await dandanplayProvider.match({ title: '庆余年', year: 2019, episode: 3 });

    const body = JSON.parse(requestOptions(0).init.body as string);
    expect(body).toEqual({ fileName: '庆余年.2019.S01E03', matchMode: 'fileNameOnly' });
  });

  it('按 p/m 组装弹幕，并把 shift 作为 offsetSec 返回', async () => {
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': COMMENTS_OK });
    const result = await dandanplayProvider.match({ title: '庆余年', year: 2019, episode: 1 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('庆余年');
    expect(result!.offsetSec).toBe(2.5);
    expect(result!.comments).toEqual([
      { time: 12.34, mode: 'scroll', color: 0xff0000, text: '前方高能' },
      { time: 15, mode: 'top', color: 0x0000ff, text: '顶部弹幕' },
    ]);
  });

  it('候选里没有目标集号且都带别的集号时不采用（串时间轴比没弹幕更糟）', async () => {
    route({
      '/api/v2/match': {
        success: true,
        isMatched: false,
        matches: [{ episodeId: 1, animeTitle: '庆余年', episodeTitle: '第07集', shift: 0 }],
      },
    });

    expect(await dandanplayProvider.match({ title: '庆余年', year: 2019, episode: 1 })).toBeNull();
    // /match 没谈成只允许再补一次剧集检索，绝不能直接去拉弹幕
    const urls = mockedRequest.mock.calls.map((call) => call[0] as string);
    expect(urls.some((url) => url.includes('/api/v2/comment/'))).toBe(false);
  });

  it('success:false（额度/参数错误）直接放弃，不再打弹幕接口', async () => {
    route({
      '/api/v2/match': { success: false, errorCode: 5, errorMessage: '配额已用尽', matches: null },
    });

    expect(await dandanplayProvider.match({ title: '庆余年', year: 2019, episode: 1 })).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('/match 认不出这一集时走 search/episodes 兜底（弹弹play 按季登记成独立作品）', async () => {
    route({
      '/api/v2/match': { success: true, isMatched: false, matches: [] },
      '/api/v2/search/episodes': {
        success: true,
        hasMore: false,
        animes: [{ animeId: 8890, animeTitle: '庆余年 第二季', episodes: [{ episodeId: 555, episodeTitle: '第03话' }] }],
      },
      '/api/v2/comment/': { count: 1, comments: [{ cid: 9, p: '3.00,1,16777215,1005', m: '兜底命中' }] },
    });

    const result = await dandanplayProvider.match({ title: '庆余年', year: 2024, episode: 3 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('庆余年 第二季');
    // 服务端剧集检索不给 shift，偏移按 0
    expect(result!.offsetSec).toBe(0);
    expect(result!.comments[0]!.text).toBe('兜底命中');
    const search = requestOptions(1);
    expect(search.url).toContain('/api/v2/search/episodes?anime=%E5%BA%86%E4%BD%99%E5%B9%B4&episode=3');
    expect(requestOptions(2).url).toContain('/api/v2/comment/555?withRelated=true');
  });

  it('弹幕为空时不算命中（让回退链继续）', async () => {
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': { count: 0, comments: [] } });
    expect(await dandanplayProvider.match({ title: '庆余年', year: 2019, episode: 1 })).toBeNull();
  });

  it('没有凭据时一请求都不发（不打官方接口）', async () => {
    setDandanplayCredentials('', '');
    route({ '/api/v2/match': MATCH_OK });
    expect(await dandanplayProvider.match({ title: '庆余年', year: 2019, episode: 1 })).toBeNull();
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
