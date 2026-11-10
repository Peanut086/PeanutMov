/**
 * 芒果TV 直连弹幕源单测：搜索选片、分集翻页与正片优选、cid 提取、60s 分片与字段映射
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mgtvProvider } from '@/services/danmaku/mgtv';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

/** 真实形态：标题带 `<em>` 高亮，desc 里第三行是「地区 / 类型 / 年份」 */
const SEARCH_RESPONSE = {
  code: 20000,
  data: {
    contents: [
      {
        data: [
          { title: '<em>国色芳华</em>', vid: 615428, desc: ['电视剧', '内地', '2025'] },
          { title: '国色芳华 看点精华', vid: 620001, desc: ['综艺', '内地', '2025'] },
          { title: '<em>国色芳华</em>', vid: 500001, desc: ['电视剧', '内地', '2019'] },
        ],
      },
    ],
  },
};

/** 分集：同集号并存正片（45:40）与预告（01:29），接口按 30 条一页返回 */
const EPISODES_RESPONSE = {
  data: {
    total: 3,
    info: { title: '国色芳华' },
    list: [
      { t1: '第1集', video_id: 22328411, url: 'https://www.mgtv.com/b/615428/22328411.html', time: '45:40' },
      { t1: '第2集', video_id: 22328412, url: 'https://www.mgtv.com/b/615428/22328412.html', time: '45:40' },
      { t1: '第2集', video_id: 22328499, url: 'https://www.mgtv.com/b/615428/22328499.html', time: '01:29' },
    ],
  },
};

function barrage(items: Array<{ content: string; time: number }>) {
  return { status: 0, data: { items, interval: 60 } };
}

describe('mgtvProvider', () => {
  const mockedRequest = vi.mocked(httpClient.request);

  function route(episodes = EPISODES_RESPONSE, handler: (time: number) => unknown = () => barrage([])) {
    mockedRequest.mockImplementation(((url: string) => {
      if (url.startsWith('https://mobileso.bz.mgtv.com')) return Promise.resolve(SEARCH_RESPONSE);
      if (url.startsWith('https://pcweb.api.mgtv.com')) return Promise.resolve(episodes);
      const time = Number(new URL(url).searchParams.get('time'));
      const value = handler(time);
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }) as never);
  }

  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('同名候选按年份选季，同集号并存时取最长正片', async () => {
    route();
    await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 2 });

    expect(new URL(String(mockedRequest.mock.calls[1]?.[0])).searchParams.get('video_id')).toBe('615428');
    // 预告 01:29 被排除，取 22328412；cid 由播放链接 /b/615428/ 提取
    const danmuUrls = mockedRequest.mock.calls.slice(2).map((call) => new URL(String(call[0])));
    expect(danmuUrls[0]?.searchParams.get('vid')).toBe('22328412');
    expect(danmuUrls[0]?.searchParams.get('cid')).toBe('615428');
    expect(danmuUrls[0]?.searchParams.get('time')).toBe('0');
  });

  it('45:40 → 46 个 60s 窗口，条目 time 是毫秒且相对视频起点', async () => {
    route(EPISODES_RESPONSE, (time) => {
      if (time === 0) {
        return barrage([
          { content: '开场', time: 1_000 },
          { content: '窗口尾部', time: 59_999 },
          { content: '空文本', time: 2_000 },
          { content: '   ', time: 3_000 },
          { content: '负时间', time: -1 },
        ]);
      }
      return barrage([{ content: `窗口${time}`, time: time + 500 }]);
    });

    const result = await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 2 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('国色芳华');
    expect(result!.comments.slice(0, 2)).toEqual([
      { time: 1, mode: 'scroll', color: 0xffffff, text: '开场' },
      { time: 59.999, mode: 'scroll', color: 0xffffff, text: '窗口尾部' },
    ]);
    // rdbarrage 只给文本与时间，样式统一按滚动
    expect(result!.comments.every((c) => c.mode === 'scroll')).toBe(true);
    expect(result!.comments.some((c) => c.text.trim().length === 0)).toBe(false);
    expect(result!.comments.some((c) => c.time < 0)).toBe(false);

    const starts = mockedRequest.mock.calls
      .slice(2)
      .map((call) => Number(new URL(String(call[0])).searchParams.get('time')));
    expect(starts).toHaveLength(46);
    expect(starts[45]).toBe(2_700_000);
  });

  it('接口 status 非 0 视为该片无弹幕', async () => {
    route(EPISODES_RESPONSE, () => ({ status: 401, data: null }));
    expect(await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 2 })).toBeNull();
  });

  it('单窗口失败不影响整集（返回已成功的部分）', async () => {
    route(EPISODES_RESPONSE, (time) => (time === 0 ? new Error('segment down') : barrage([{ content: `窗口${time}`, time: 1 }])));

    const result = await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 2 });

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(45);
  });

  it('分集超过一页时翻页取全（第 31 集不在首页）', async () => {
    const page1 = { data: { total: 32, info: { title: '国色芳华' }, list: Array.from({ length: 30 }, (_, i) => ({ t1: `第${i + 1}集`, video_id: 900000 + i, url: `https://www.mgtv.com/b/615428/${900000 + i}.html`, time: '45:00' })) } };
    const page2 = { data: { total: 32, info: { title: '国色芳华' }, list: [{ t1: '第31集', video_id: 900031, url: 'https://www.mgtv.com/b/615428/900031.html', time: '45:00' }, { t1: '第32集', video_id: 900032, url: 'https://www.mgtv.com/b/615428/900032.html', time: '45:00' }] } };
    const pages = [page1, page2];
    mockedRequest.mockImplementation(((url: string) => {
      if (url.startsWith('https://mobileso.bz.mgtv.com')) return Promise.resolve(SEARCH_RESPONSE);
      if (url.startsWith('https://pcweb.api.mgtv.com')) return Promise.resolve(pages.shift() ?? page2);
      return Promise.resolve(barrage([{ content: '弹幕', time: 1000 }]));
    }) as never);

    const result = await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 31 });

    expect(result).not.toBeNull();
    expect(new URL(String(mockedRequest.mock.calls[1]?.[0])).searchParams.get('page')).toBe('1');
    expect(new URL(String(mockedRequest.mock.calls[2]?.[0])).searchParams.get('page')).toBe('2');
    expect(new URL(String(mockedRequest.mock.calls[3]?.[0])).searchParams.get('vid')).toBe('900031');
  });

  it('目标集号已在首页命中时不再翻第二页', async () => {
    route();
    await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 2 });
    expect(mockedRequest.mock.calls.filter((call) => String(call[0]).includes('episode/list'))).toHaveLength(1);
  });

  it('年份对不上时只发一次搜索请求（不串到别的季）', async () => {
    mockedRequest.mockResolvedValueOnce(SEARCH_RESPONSE);

    const result = await mgtvProvider.match({ title: '国色芳华', year: 2021, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('本集时长低于 5 分钟按预告处理，不取弹幕', async () => {
    route({ data: { total: 1, info: { title: '国色芳华' }, list: [{ t1: '第2集', video_id: 1, url: 'https://www.mgtv.com/b/615428/1.html', time: '01:29' }] } });

    const result = await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 2 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it('缺少 cid（播放链接不含 /b/专辑号/）时放弃', async () => {
    route({ data: { total: 1, info: { title: '国色芳华' }, list: [{ t1: '第2集', video_id: 22328412, url: 'https://www.mgtv.com/h/615428.html', time: '45:40' }] } });

    const result = await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 2 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(2);
  });

  it('片名完全不符时不发分集请求', async () => {
    mockedRequest.mockResolvedValueOnce({ code: 20000, data: { contents: [{ data: [{ title: '完全无关的片', vid: 1, desc: ['2020'] }] }] } });

    const result = await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('集号小于 1 直接放弃', async () => {
    expect(await mgtvProvider.match({ title: '国色芳华', year: 2025, episode: 0 })).toBeNull();
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
