/**
 * danmu_api（LogVar 弹幕 API）自建聚合源 Provider（弹幕 Phase2）
 *
 * 契约取自上游仓库 `huangxd-/danmu_api` 的 `dandan-api.js` 源码与
 * `https://bks.indevs.in/knowledge/api-reference`，本用例锁住核实到的事实，防止按弹弹play官方口径倒推：
 * - 基址由用户提供（可含 TOKEN 路径段），TOKEN 错/缺是 401；`matchMode` 上游只解构 `{ fileName }`，
 *   多余的字段会被忽略，因此请求体只有 fileName；
 * - `/api/v2/comment/{id}` 必须显式带 `format=json`：`DANMU_OUTPUT_FORMAT` 允许部署者把默认改成 xml；
 * - 弹幕 `p` 的第 4 段是 `[来源]` 标签（弹弹play是用户ID），我们不读第 4 段，两套口径共用同一解析；
 * - `matches[].shift` 上游恒为 0（集号在服务端解析），`offsetSec` 随之为 0；
 * - 上游不通时（401/404/429 由 nativeHttp 抛错）不在 Provider 内吞掉，交回退链的 try/catch 继续下一级。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  danmuApiProvider,
  getDanmuApiBaseUrl,
  normalizeDanmuApiBaseUrl,
  setDanmuApiBaseUrl,
} from '@/services/danmaku/provider';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
  // nativeHttp 的 Web 通路只用到 httpClient；这里补上它 import 的其余符号避免运行期 undefined
  mapStatusError: (status: number) => new Error(`http ${status}`),
}));

const mockedRequest = vi.mocked(httpClient.request);

const BASE = 'http://192.168.1.7:9321';
/** 上游把 TOKEN 放在基址路径里（默认 87654321 可省），拼路径必须保留这一段 */
const BASE_WITH_TOKEN = 'https://danmu.example.com/MyToken';

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

function requestOptions(index: number): { url: string; init: Record<string, unknown> } {
  const call = mockedRequest.mock.calls[index] as [string, Record<string, unknown>];
  return { url: call[0], init: call[1] ?? {} };
}

function urls(): string[] {
  return mockedRequest.mock.calls.map((call) => call[0] as string);
}

const MATCH_OK = {
  success: true,
  errorCode: 0,
  isMatched: true,
  matches: [
    {
      episodeId: 10001,
      animeId: 3011,
      animeTitle: '狂飙',
      episodeTitle: '第01集',
      type: 'tv',
      typeDescription: '电视剧',
      shift: 0,
    },
  ],
};
const COMMENTS_OK = {
  count: 2,
  comments: [
    { cid: 1, p: '8.20,1,16711680,[BiliBili]', m: '来源标签不参与解析' },
    { cid: 2, p: '12.00,4,255,[Tencent]', m: '底部弹幕' },
    // 坏时间戳与空文本都要丢掉，不能让渲染层拿到 NaN
    { cid: 3, p: 'bad,1,255,[Iqiyi]', m: '坏行' },
    { cid: 4, p: '20.00,1,255,[Youku]', m: '   ' },
  ],
};

describe('normalizeDanmuApiBaseUrl（用户填写地址的口径）', () => {
  it('只接受带 scheme 的 http(s) 绝对地址，末尾斜杠与 /api/v2 尾巴被摘掉', () => {
    expect(normalizeDanmuApiBaseUrl('  ')).toBeNull();
    // 不补 http://：填错就该停用，静默改地址会让「连不上」变成无从排查
    expect(normalizeDanmuApiBaseUrl('192.168.1.7:9321')).toBeNull();
    expect(normalizeDanmuApiBaseUrl('ftp://192.168.1.7:9321')).toBeNull();
    expect(normalizeDanmuApiBaseUrl('http://192.168.1.7:9321/')).toBe('http://192.168.1.7:9321');
    expect(normalizeDanmuApiBaseUrl('http://192.168.1.7:9321/api/v2')).toBe('http://192.168.1.7:9321');
    expect(normalizeDanmuApiBaseUrl('http://192.168.1.7:9321/api/v2/')).toBe('http://192.168.1.7:9321');
  });

  it('保留 TOKEN 路径段，但丢弃账号密码、查询串与片段（弹幕基址不该携带凭据）', () => {
    expect(normalizeDanmuApiBaseUrl('https://danmu.example.com/MyToken')).toBe(BASE_WITH_TOKEN);
    expect(normalizeDanmuApiBaseUrl('https://danmu.example.com/MyToken/')).toBe(BASE_WITH_TOKEN);
    expect(normalizeDanmuApiBaseUrl('https://danmu.example.com/MyToken?t=1')).toBe(BASE_WITH_TOKEN);
    expect(normalizeDanmuApiBaseUrl('https://danmu.example.com/MyToken#frag')).toBe(BASE_WITH_TOKEN);
    expect(normalizeDanmuApiBaseUrl('https://user:pass@danmu.example.com')).toBeNull();
  });

  it('写入即存归一化结果；清空即停用（非法输入由设置页先拦，不走到这里）', () => {
    expect(setDanmuApiBaseUrl('http://192.168.1.7:9321/api/v2/')).toBe(BASE);
    expect(getDanmuApiBaseUrl()).toBe(BASE);
    expect(danmuApiProvider.available()).toBe(true);
    expect(setDanmuApiBaseUrl('')).toBeNull();
    expect(getDanmuApiBaseUrl()).toBeNull();
    expect(danmuApiProvider.available()).toBe(false);
  });
});

describe('danmu-api Provider（上游真实契约）', () => {
  beforeEach(() => {
    mockedRequest.mockReset();
    setDanmuApiBaseUrl(BASE);
  });

  it('命中链路：POST /match 只发 fileName，再按 episodeId 拉 json 弹幕', async () => {
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': COMMENTS_OK });
    const result = await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    const match = requestOptions(0);
    expect(match.url).toBe(`${BASE}/api/v2/match`);
    expect(match.init.method).toBe('POST');
    // 上游解构 `{ fileName }`，matchMode 会被忽略；集号解析在服务端完成
    expect(JSON.parse(match.init.body as string)).toEqual({ fileName: '狂飙.2023.S01E01' });
    expect(Object.keys(match.init.headers as Record<string, string>)).toEqual(['Content-Type']);

    // 必须显式 format=json：部署者可用 DANMU_OUTPUT_FORMAT 把默认改成 xml；withRelated 是弹弹play专属参数
    expect(requestOptions(1).url).toBe(`${BASE}/api/v2/comment/10001?format=json`);
    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('狂飙');
    // 上游 shift 恒为 0
    expect(result!.offsetSec).toBe(0);
    expect(result!.comments).toEqual([
      { time: 8.2, mode: 'scroll', color: 0xff0000, text: '来源标签不参与解析' },
      { time: 12, mode: 'bottom', color: 0x0000ff, text: '底部弹幕' },
    ]);
  });

  it('TOKEN 写在基址路径里时，三个接口都拼在同一前缀下', async () => {
    setDanmuApiBaseUrl(BASE_WITH_TOKEN);
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': COMMENTS_OK });
    await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    expect(urls()).toEqual([
      `${BASE_WITH_TOKEN}/api/v2/match`,
      `${BASE_WITH_TOKEN}/api/v2/comment/10001?format=json`,
    ]);
  });

  it('基址未配置时不可用且一请求都不发（不内置任何公共实例）', async () => {
    setDanmuApiBaseUrl('');
    route({ '/api/v2/match': MATCH_OK });

    expect(danmuApiProvider.available()).toBe(false);
    expect(await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
    expect(mockedRequest).not.toHaveBeenCalled();
  });

  it('/match 回 success:false（TOKEN 失效、限流等）时直接放弃，不再打弹幕接口', async () => {
    route({ '/api/v2/match': { errorCode: 401, success: false, errorMessage: 'Unauthorized', isMatched: false } });

    expect(await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
    expect(urls().some((url) => url.includes('/api/v2/comment/'))).toBe(false);
  });

  it('/match 认不出这一集时走 search/episodes 兜底，仍按集号复核候选', async () => {
    route({
      '/api/v2/match': { errorCode: 0, success: true, isMatched: false, matches: null },
      '/api/v2/search/episodes': {
        success: true,
        hasMore: false,
        animes: [
          {
            animeId: 3012,
            animeTitle: '狂飙',
            episodes: [
              { episodeId: 10007, episodeTitle: '第05集' },
              { episodeId: 10003, episodeTitle: '第03集' },
            ],
          },
        ],
      },
      '/api/v2/comment/': { count: 1, comments: [{ cid: 9, p: '3.00,5,16777215,[Mgtv]', m: '兜底命中' }] },
    });

    const result = await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 3 });

    expect(requestOptions(1).url).toBe(
      `${BASE}/api/v2/search/episodes?anime=%E7%8B%82%E9%A3%99&episode=3`,
    );
    // 剧集检索不带任何鉴权头（弹弹play的 X-AppId/X-AppSecret 不会外传给自建服务）
    expect(requestOptions(1).init.headers).toEqual({});
    expect(requestOptions(2).url).toBe(`${BASE}/api/v2/comment/10003?format=json`);
    expect(result!.matchedTitle).toBe('狂飙');
    expect(result!.comments[0]!.text).toBe('兜底命中');
  });

  it('候选串到别的集号时不采用（时间轴错位比没弹幕更糟），且绝不去拉弹幕', async () => {
    route({
      '/api/v2/match': {
        success: true,
        isMatched: true,
        matches: [{ episodeId: 10001, animeTitle: '狂飙', episodeTitle: '第09集', shift: 0 }],
      },
      '/api/v2/search/episodes': { success: true, animes: [] },
    });

    expect(await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
    expect(urls().some((url) => url.includes('/api/v2/comment/'))).toBe(false);
  });

  it('弹幕为空不算命中，让回退链继续走 dandanplay / 本地 xml', async () => {
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': { count: 0, comments: [] } });
    expect(await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).toBeNull();
  });

  it('401/404/429 由请求层抛错：Provider 不吞，交回退链 try/catch 决定下一级', async () => {
    // 未知 episodeId 是 404、限流默认 3 次/分/IP 是 429，都在 nativeHttp 变成异常
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': new Error('http 404') });
    await expect(danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).rejects.toThrow('http 404');

    route({ '/api/v2/match': new Error('http 429') });
    await expect(danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 })).rejects.toThrow('http 429');
  });

  it('每次都读当前基址：改了地址不需要重启进程即生效', async () => {
    route({ '/api/v2/match': MATCH_OK, '/api/v2/comment/': COMMENTS_OK });
    await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 });
    setDanmuApiBaseUrl(BASE_WITH_TOKEN);
    mockedRequest.mockClear();
    await danmuApiProvider.match({ title: '狂飙', year: 2023, episode: 1 });

    expect(requestOptions(0).url).toBe(`${BASE_WITH_TOKEN}/api/v2/match`);
  });
});
