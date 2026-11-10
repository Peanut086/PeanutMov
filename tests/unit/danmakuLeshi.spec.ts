/**
 * 乐视直连弹幕源单测：搜索块解析、防串片、集号命中与电影 playVid 回退、正片/时长校验、样式映射
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { leshiProvider } from '@/services/danmaku/leshi';
import { httpClient } from '@/sources/base/httpClient';

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: vi.fn(), requestWithMeta: vi.fn() },
}));

/** 真实搜索块形态：data-info 是 JS 对象字面量，标题在 j-baidu-a 锚点的 title 上 */
function tvBlock(title: string, year: number, episodes: Array<{ episode: number; vid: string }>) {
  const vidEpisode = episodes.map((item) => `${item.episode}-${item.vid}`).join(',');
  return `<div class="So-detail Tv-so" data-statectn="specialResult" data-info="{pid:'10014722',keyWord:'${title}${year}电视剧',type:'tv',total:'${episodes.length}',vidEpisode:'${vidEpisode}',previewEpisode:'',blockedEpisodes:''}">
    <div class="so-cont"><div class="left"><div>
      <a href="http://www.le.com/tv/10014722.html " class="img-w180 j-baidu-a" target="_blank" title="${title}"><img title="${title}">
    </a></div></div></div>
  </div>`;
}

function movieBlock(title: string, year: number, vid: string) {
  return `<div class="So-detail Tv-cinema" data-info="{pid:'10026462',keyWord:'${title}${year}电影',type:'movie',total:'1',vidEpisode:'',previewEpisode:''}">
    <div class="so-cont"><div class="left"><div>
      <a title="${title}" href="http://www.le.com/ptv/vplay/${vid}.html " class="img-w180 j-baidu-a" target="_blank"><img title="${title}">
    </a></div></div></div>
  </div>`;
}

/** 侧栏广告块：不带 data-info，必须被跳过 */
const NOISE_BLOCK = '<div class="So-detail side-ad"><a href="#" class="j-baidu-a" title="广告位">广告</a></div>';

const SEARCH_HTML = [
  NOISE_BLOCK,
  tvBlock('白鹿原', 2017, [
    { episode: 1, vid: '28834428' },
    { episode: 2, vid: '29393681' },
    { episode: 3, vid: '29393813' },
  ]),
  tvBlock('极速看懂白鹿原', 2017, [{ episode: 1, vid: '28879327' }]),
  tvBlock('白鹿原纪录片', 2017, [{ episode: 1, vid: '29570212' }]),
].join('\n');

const MOVIE_HTML = movieBlock('捉妖记', 2015, '20012799');

/** 播放页内联配置：时长 45:40 = 2740s，正片 */
function playPage(title = '白鹿原', duration = '45:40', type = '正片') {
  return `var flashvars = { vid:'29393813', duration:'${duration}', videotypeName:"${type}", pTitle:"${title}" };`;
}

function danmu(list: Array<{ txt: string; start: number; color?: string; position?: number }>) {
  return { code: 200, data: { list } };
}

describe('leshiProvider', () => {
  const mockedRequest = vi.mocked(httpClient.request);

  /** 按 URL 前缀分派，避免 10 个并发分片的顺序耦合 */
  function route(search: string, play: string, handler: (start: number) => unknown) {
    mockedRequest.mockImplementation(((url: string) => {
      if (url.startsWith('https://so.le.com/s')) return Promise.resolve(search);
      if (url.startsWith('https://www.le.com/ptv/vplay/')) return Promise.resolve(play);
      const start = Number(new URL(url).searchParams.get('start'));
      return Promise.resolve(handler(start));
    }) as never);
  }

  beforeEach(() => {
    mockedRequest.mockReset();
  });

  it('搜索→播放页→300s 窗口，按 position/color 映射样式', async () => {
    route(SEARCH_HTML, playPage(), (start) =>
      start === 5
        ? danmu([
            { txt: '顶部弹幕', start: 30, color: 'FF1964', position: 1 },
            { txt: '滚动弹幕', start: 60, color: 'ffffff', position: 2 },
            { txt: '底部弹幕', start: 90, color: '000000', position: 3 },
            { txt: '默认样式', start: 120 },
            { txt: '  ', start: 130 },
            { txt: '坏时间', start: -1 },
          ])
        : danmu([{ txt: '后段弹幕', start: start + 10, color: 'zzz', position: 4 }]),
    );

    const result = await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 3 });

    expect(result).not.toBeNull();
    expect(result!.matchedTitle).toBe('白鹿原');
    expect(result!.comments.slice(0, 4)).toEqual([
      { time: 30, mode: 'top', color: 0xff1964, text: '顶部弹幕' },
      { time: 60, mode: 'scroll', color: 0xffffff, text: '滚动弹幕' },
      { time: 90, mode: 'bottom', color: 0x000000, text: '底部弹幕' },
      { time: 120, mode: 'scroll', color: 0xffffff, text: '默认样式' },
    ]);
    // 非法时间/空文本丢弃；坏色值回落白
    expect(result!.comments.some((c) => c.text === '后段弹幕' && c.color === 0xffffff)).toBe(true);
    expect(result!.comments.some((c) => c.text === '坏时间')).toBe(false);

    // 第 3 集 vid=29393813；2740s → 10 个窗口，起点 5 + 300k
    const danmuUrls = mockedRequest.mock.calls.filter((call) => String(call[0]).includes('/danmu/list'));
    expect(danmuUrls).toHaveLength(10);
    expect(danmuUrls.map((call) => new URL(String(call[0])).searchParams.get('start'))).toEqual([
      '5', '305', '605', '905', '1205', '1505', '1805', '2105', '2405', '2705',
    ]);
    expect(new URL(String(danmuUrls[0]?.[0])).searchParams.get('vid')).toBe('29393813');
    expect(new URL(String(danmuUrls[0]?.[0])).searchParams.get('amount')).toBe('2000');
  });

  it('搜索请求带片名与 Referer（乐视无 Referer 会跳反爬页）', async () => {
    route(SEARCH_HTML, playPage(), () => danmu([{ txt: '弹幕', start: 1 }]));
    await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 1 });

    const [url, options] = mockedRequest.mock.calls[0] ?? [];
    expect(url).toContain('wd=%E7%99%BD%E9%B9%BF%E5%8E%9F');
    expect(options?.responseType).toBe('text');
    expect(options?.headers?.Referer).toBe('https://www.le.com/');
  });

  it('衍生条目不采用（前缀同名的解读版/纪录片不算命中）', async () => {
    route(SEARCH_HTML, playPage('极速看懂白鹿原'), () => danmu([{ txt: '弹幕', start: 1 }]));

    const result = await leshiProvider.match({ title: '极速看懂白鹿原', year: 2017, episode: 1 });

    // 命中的是「极速看懂白鹿原」本名条目，而非白鹿原
    expect(result).not.toBeNull();
    expect(new URL(String(mockedRequest.mock.calls[1]?.[0])).pathname).toContain('vplay/28879327.html');

    mockedRequest.mockReset();
    mockedRequest.mockResolvedValueOnce(NOISE_BLOCK);
    const none = await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 1 });
    expect(none).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('超长内容按 40 窗口截断', async () => {
    route(MOVIE_HTML, playPage('捉妖记', '04:00:00'), () => danmu([{ txt: '弹幕', start: 1 }]));

    const result = await leshiProvider.match({ title: '捉妖记', year: 2015, episode: 1 });

    expect(result).not.toBeNull();
    const starts = mockedRequest.mock.calls
      .filter((call) => String(call[0]).includes('/danmu/list'))
      .map((call) => Number(new URL(String(call[0])).searchParams.get('start')));
    expect(starts).toHaveLength(40);
    expect(starts[39]).toBe(11705);
  });

  it('年份对不上时不串季', async () => {
    mockedRequest.mockResolvedValueOnce(SEARCH_HTML);

    const result = await leshiProvider.match({ title: '白鹿原', year: 2012, episode: 1 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('集号越界返回 null（不做顺序位回退）', async () => {
    route(SEARCH_HTML, playPage(), () => danmu([{ txt: '弹幕', start: 1 }]));

    const result = await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 99 });

    expect(result).toBeNull();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('电影无分集表时回落到播放链接 vid', async () => {
    route(MOVIE_HTML, playPage('捉妖记', '01:58:23'), () => danmu([{ txt: '弹幕', start: 1 }]));

    const result = await leshiProvider.match({ title: '捉妖记', year: 2015, episode: 1 });

    expect(result).not.toBeNull();
    expect(new URL(String(mockedRequest.mock.calls[1]?.[0])).pathname).toContain('vplay/20012799.html');
    // 7103s → 24 个 300s 窗口（未触及 40 窗口上限）
    expect(mockedRequest.mock.calls.filter((call) => String(call[0]).includes('/danmu/list'))).toHaveLength(24);
  });

  it('播放页非正片或时长过短时放弃', async () => {
    route(SEARCH_HTML, playPage('白鹿原', '01:29'), () => danmu([{ txt: '弹幕', start: 1 }]));
    expect(await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 3 })).toBeNull();

    mockedRequest.mockReset();
    route(SEARCH_HTML, playPage('白鹿原', '45:40', '预告'), () => danmu([{ txt: '弹幕', start: 1 }]));
    expect(await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 3 })).toBeNull();
  });

  it('播放页专辑名与查询片名不符时放弃（防搜索块与播放页串片）', async () => {
    route(SEARCH_HTML, playPage('琅琊榜'), () => danmu([{ txt: '弹幕', start: 1 }]));

    const result = await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 3 });

    expect(result).toBeNull();
    expect(mockedRequest.mock.calls.filter((call) => String(call[0]).includes('/danmu/list'))).toHaveLength(0);
  });

  it('单窗口失败不影响整集（返回已成功的部分）', async () => {
    route(SEARCH_HTML, playPage(), (start) => {
      if (start === 5) return Promise.reject(new Error('danmu window down'));
      return Promise.resolve(danmu([{ txt: `幸存@${start}`, start: 1 }]));
    });

    const result = await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 3 });

    expect(result).not.toBeNull();
    expect(result!.comments).toHaveLength(9);
    expect(result!.comments[0]?.text).toBe('幸存@305');
  });

  it('窗口全部返回错误码时返回 null', async () => {
    route(SEARCH_HTML, playPage(), () => ({ code: 500, data: null }));

    expect(await leshiProvider.match({ title: '白鹿原', year: 2017, episode: 3 })).toBeNull();
  });
});
