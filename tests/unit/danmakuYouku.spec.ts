/**
 * 优酷直连弹幕源单测：openapi 快路径、SSR 回退与防串片校验、mtop 签名与分片解析
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { md5 } from '@/services/danmaku/md5';
import { youkuProvider } from '@/services/danmaku/youku';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

const SHOW_ID = 'cbff984c962411de83b1';
const TOKEN_TK = '0123456789abcdef0123456789abcdef_1794286545045';
/** 与 youku.ts 同步的优酷前端常量 */
const MSG_SALT = 'MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr';

function searchResponse(feature: string, displayName = '甄嬛传') {
  return { pageComponentList: [{ commonData: { showId: SHOW_ID, episodeTotal: 76, feature, titleDTO: { displayName } } }] };
}

/** openapi 分集：甄嬛传 76 集全量返回 */
const OPEN_EPISODES = {
  total: 76,
  videos: [
    { id: 'vidEp1', stage: '1', seq: '1', duration: '2706.16', title: '甄嬛传 01' },
    { id: 'vidEp2', stage: '2', seq: '2', duration: '2706.16', title: '甄嬛传 02' },
    { id: 'vidEp3', stage: '3', seq: '3', duration: '330', title: '甄嬛传 03' },
  ],
};

/** openapi 对未授权剧返回空列表，需要走 SSR */
const OPEN_EMPTY = { total: 0, videos: [] };

const TOKEN_RESPONSE = {
  data: '',
  status: 200,
  headers: new Headers({
    'set-cookie': '_m_h5_tk=0123456789abcdef0123456789abcdef_1794286545045; Path=/; _m_h5_tk_enc=fedcba9876543210fedcba9876543210; Path=/',
  }),
};

function segmentPayload(items: unknown[]) {
  return { ret: ['SUCCESS::调用成功'], data: { result: JSON.stringify({ code: 1, data: { result: items } }) } };
}

/** 该片无弹幕时优酷回 code=-1 */
const NO_DANMU = { ret: ['SUCCESS::调用成功'], data: { result: JSON.stringify({ code: -1 }) } };

/** SSR 播放页：videoMap.showId 决定选集是否属于目标剧 */
function playPage(showId: string, episodes: Array<{ stage: number; vid: string }>) {
  return `window.__INITIAL_DATA__ = ${JSON.stringify({
    videoMap: { showId, videoId: episodes[0]?.vid, showName: '甄嬛传' },
    moduleList: [
      {
        components: [
          {
            componentId: 'h5-detail-anthology',
            dataNode: episodes.map((item) => ({ data: { stage: item.stage, action: { type: 'JUMP_TO_VIDEO', value: item.vid } } })),
          },
        ],
      },
    ],
  })};`;
}

describe('youkuProvider', () => {
  const mockedRequest = vi.mocked(httpClient.request);
  const mockedWithMeta = vi.mocked(httpClient.requestWithMeta);

  beforeEach(() => {
    mockedRequest.mockReset();
    mockedWithMeta.mockReset();
    mockedWithMeta.mockResolvedValue(TOKEN_RESPONSE);
  });

  it('openapi 命中：签名分片请求，按 playat/propertis 映射时间与样式', async () => {
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2011 · 电视剧 · 中国 · 76集全(完结)'))
      .mockResolvedValueOnce(OPEN_EPISODES)
      .mockResolvedValueOnce(
        segmentPayload([
          { content: '前方高能', playat: 0, propertis: '{"color":16711680,"pos":3}' },
          { content: '顶部弹幕', playat: 31_000, propertis: '{"color":"16777215","pos":1}' },
          { content: '底部弹幕', playat: 45_500, propertis: '{"pos":2}' },
          { content: '样式损坏', playat: 59_000, propertis: 'not-json' },
          { content: '', playat: 1000 },
          { content: '坏时间', playat: 'x' },
        ]),
      )
      .mockResolvedValue(NO_DANMU);

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2011, episode: 3 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('甄嬛传');
    expect(result!.comments).toEqual([
      { time: 0, mode: 'scroll', color: 0xff0000, text: '前方高能' },
      { time: 31, mode: 'top', color: 0xffffff, text: '顶部弹幕' },
      { time: 45.5, mode: 'bottom', color: 0xffffff, text: '底部弹幕' },
      { time: 59, mode: 'scroll', color: 0xffffff, text: '样式损坏' },
    ]);
    // 330s → 6 个 60s 分片
    expect(mockedRequest).toHaveBeenCalledTimes(2 + 6);
  });

  it('分片签名：外层 md5(tk& t&appKey&data)，内层 md5(base64(msg)+盐)', async () => {
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2011 · 电视剧'))
      .mockResolvedValueOnce(OPEN_EPISODES)
      .mockResolvedValue(segmentPayload([]));

    await youkuProvider.match({ title: '甄嬛传', year: 2011, episode: 1 });

    const [url, options] = mockedRequest.mock.calls[2] ?? [];
    const body = String(options?.body ?? '');
    expect(url).toContain('api=mopen.youku.danmu.list');
    expect(url).toContain('appKey=24679788');
    expect(url).toMatch(/sign=[0-9a-f]{32}/);
    expect(options?.method).toBe('POST');
    expect(options?.headers?.Cookie).toContain('_m_h5_tk=0123456789abcdef0123456789abcdef_');
    expect(body.startsWith('data=')).toBe(true);

    const msg = JSON.parse(decodeURIComponent(body.slice('data='.length))) as { vid: string; msg: string; sign: string };
    expect(msg.vid).toBe('vidEp1');
    expect(msg.sign).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(atob(msg.msg)).mat).toBe(0);
    // 内层：签的是 base64 后的 msg 本体
    expect(msg.sign).toBe(md5(`${msg.msg}${MSG_SALT}`));
    // 外层：md5(tk 前 32 位 & t & appKey & data)
    const params = new URL(String(url)).searchParams;
    const data = decodeURIComponent(body.slice('data='.length));
    expect(params.get('sign')).toBe(
      md5([TOKEN_TK.slice(0, 32), params.get('t'), '24679788', data].join('&')),
    );
  });

  it('openapi 空结果时走 SSR 选集，并补取时长', async () => {
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2023 · 电视剧 · 中国 · 共40集'))
      .mockResolvedValueOnce(OPEN_EMPTY)
      .mockResolvedValueOnce(playPage(SHOW_ID, [{ stage: 1, vid: 'ssrVid1' }, { stage: 2, vid: 'ssrVid2' }]))
      .mockResolvedValueOnce(playPage(SHOW_ID, [{ stage: 1, vid: 'ssrVid1' }, { stage: 2, vid: 'ssrVid2' }]))
      .mockResolvedValueOnce({ duration: '330', title: '第2集' })
      .mockResolvedValueOnce(segmentPayload([{ content: 'SSR 弹幕', playat: 1000 }]))
      .mockResolvedValue(NO_DANMU);

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2023, episode: 2 });

    expect(result!.comments).toEqual([{ time: 1, mode: 'scroll', color: 0xffffff, text: 'SSR 弹幕' }]);
    expect(mockedRequest.mock.calls[2]?.[0]).toBe(`https://m.youku.com/video/id_${SHOW_ID}.html`);
    expect(mockedRequest.mock.calls[4]?.[0]).toContain('videos/show.json');
    expect(mockedRequest.mock.calls[4]?.[0]).toContain('video_id=ssrVid2');
  });

  it('SSR 入口 vid 属于别的剧时放弃（防串片）', async () => {
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2023 · 电视剧'))
      .mockResolvedValueOnce(OPEN_EMPTY)
      .mockResolvedValueOnce(playPage('otherShowId', [{ stage: 1, vid: 'otherVid' }]))
      .mockResolvedValueOnce(playPage('otherShowId', [{ stage: 1, vid: 'otherVid' }]))
      .mockResolvedValue(segmentPayload([{ content: '别剧弹幕', playat: 1000 }]));

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2023, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(4);
  });

  it('年份对不上时只发一次搜索请求', async () => {
    mockedRequest.mockResolvedValueOnce(searchResponse('2011 · 电视剧'));

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2024, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('片名不符时不发起分集请求', async () => {
    mockedRequest.mockResolvedValueOnce({ pageComponentList: [{ commonData: { showId: SHOW_ID, feature: '2011 · 电视剧', titleDTO: { displayName: '甄嬛传 美国版' } } }] });

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2011, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('token 取不到时不请求分片', async () => {
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2011 · 电视剧'))
      .mockResolvedValueOnce(OPEN_EPISODES);
    mockedWithMeta.mockResolvedValue({ data: '', status: 200, headers: new Headers() });

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2011, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it('分片返回令牌过期时换新 token 重试该片', async () => {
    // 330s → 6 片一批：mat0 回令牌过期，mat1~5 无弹幕，随后 mat0 的二次请求才拿到数据
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2011 · 电视剧'))
      .mockResolvedValueOnce(OPEN_EPISODES)
      .mockResolvedValueOnce({ ret: ['FAIL_SYS_TOKEN_EXPIRED::令牌过期'], data: {} })
      .mockResolvedValueOnce(NO_DANMU)
      .mockResolvedValueOnce(NO_DANMU)
      .mockResolvedValueOnce(NO_DANMU)
      .mockResolvedValueOnce(NO_DANMU)
      .mockResolvedValueOnce(NO_DANMU)
      .mockResolvedValueOnce(segmentPayload([{ content: '重试成功', playat: 1000 }]));
    mockedWithMeta.mockResolvedValue(TOKEN_RESPONSE);

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2011, episode: 3 });

    expect(result!.comments).toEqual([{ time: 1, mode: 'scroll', color: 0xffffff, text: '重试成功' }]);
    // 首片失败后重新引导 token：弱网接口被调用两次
    expect(mockedWithMeta).toHaveBeenCalledTimes(2);
  });

  it('单片失败不影响整集', async () => {
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2011 · 电视剧'))
      .mockResolvedValueOnce(OPEN_EPISODES)
      .mockRejectedValueOnce(new Error('segment down'))
      .mockResolvedValueOnce(segmentPayload([{ content: '幸存弹幕', playat: 61_000 }]))
      .mockResolvedValue(NO_DANMU);

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2011, episode: 3 });

    expect(result!.comments).toEqual([{ time: 61, mode: 'scroll', color: 0xffffff, text: '幸存弹幕' }]);
  });

  it('集号越界返回 null', async () => {
    // openapi 已给出全部 3 集且无第 99 集，SSR 选集同样命中不到 → 不请求分片
    mockedRequest
      .mockResolvedValueOnce(searchResponse('2011 · 电视剧'))
      .mockResolvedValueOnce({ ...OPEN_EPISODES, total: 3 })
      .mockResolvedValue(playPage(SHOW_ID, [{ stage: 1, vid: 'ssrVid1' }, { stage: 2, vid: 'ssrVid2' }]));

    const result = await youkuProvider.match({ title: '甄嬛传', year: 2011, episode: 99 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(4);
  });
});
