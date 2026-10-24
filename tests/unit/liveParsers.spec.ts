import { describe, expect, it } from 'vitest';

import {
  detectLiveFormat,
  extractTvboxLives,
  groupChannels,
  parseLiveList,
  parseLiveTxt,
  parseM3u,
} from '@/sources/live/liveParsers';

/** 直播播放列表解析（CHG-13） */
const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV1" tvg-logo="https://img/1.png" group-title="央视",CCTV-1 综合',
  'http://live.example.com/cctv1.m3u8',
  '#EXTINF:-1 group-title="卫视" tvg-logo="https://img/2.png",湖南卫视',
  'http://live.example.com/hntv.m3u8',
  '',
  '#EXTINF:-1,坏行没有地址',
  '#EXTINF:-1,rtmp 频道',
  'rtmp://live.example.com/rtv',
].join('\n');

const TXT = [
  '央视,#genre#',
  'CCTV-1,http://live.example.com/cctv1.m3u8',
  'CCTV-2,http://live.example.com/cctv2.m3u8#需要验证$备注',
  '卫视,#genre#',
  '湖南卫视,http://live.example.com/hntv.m3u8',
  '这不是链接的一行',
].join('\n');

describe('parseM3u', () => {
  it('EXTINF 属性、分组、URL 全部就位', () => {
    const channels = parseM3u(M3U);
    expect(channels).toHaveLength(3);
    expect(channels[0]).toEqual({
      name: 'CCTV-1 综合',
      url: 'http://live.example.com/cctv1.m3u8',
      group: '央视',
      logo: 'https://img/1.png',
    });
    expect(channels[1]?.group).toBe('卫视');
    // rtmp 标记为可播候选（能否真播由播放器决定）
    expect(channels[2]?.url).toBe('rtmp://live.example.com/rtv');
  });

  it('缺 tvg-name 时 EXTINF 逗号后为名；无 group-title 落「未分组」', () => {
    const channels = parseM3u(['#EXTM3U', '#EXTINF:-1,测试频道', 'http://a.example.com/1.m3u8'].join('\n'));
    expect(channels[0]?.name).toBe('测试频道');
    expect(channels[0]?.group).toBe('未分组');
  });
});

describe('parseLiveTxt', () => {
  it('#genre# 分组 + 频道行，$/# 后缀剥离', () => {
    const channels = parseLiveTxt(TXT);
    expect(channels).toHaveLength(3);
    expect(channels[0]).toEqual({
      name: 'CCTV-1',
      url: 'http://live.example.com/cctv1.m3u8',
      group: '央视',
      logo: null,
    });
    expect(channels[1]?.url).toBe('http://live.example.com/cctv2.m3u8');
    expect(channels[2]?.group).toBe('卫视');
  });
});

describe('detectLiveFormat / parseLiveList', () => {
  it('自动识别两种格式；识别不了返回空', () => {
    expect(detectLiveFormat(M3U)).toBe('m3u');
    expect(detectLiveFormat(TXT)).toBe('txt');
    expect(detectLiveFormat('random text')).toBeNull();
    expect(parseLiveList('random text')).toEqual([]);
    expect(parseLiveList(TXT)).toHaveLength(3);
  });
});

describe('groupChannels', () => {
  it('按分组聚合且保持出现顺序', () => {
    const groups = groupChannels(parseLiveTxt(TXT));
    expect(groups.map((g) => g.name)).toEqual(['央视', '卫视']);
    expect(groups[0]?.channels).toHaveLength(2);
  });
});

describe('extractTvboxLives', () => {
  it('提取 type 0 的 url 型直播源；过滤非法与不支持类型', () => {
    const config = JSON.stringify({
      lives: [
        { name: '聚合直播', type: 0, url: 'https://live.example.com/tv.txt' },
        { name: '组播', type: 1, url: 'rtp://239.1.1.1:5000' },
        { name: '无地址', type: 0 },
        { name: ' ', url: 'https://live.example.com/blank.txt' },
      ],
    });
    expect(extractTvboxLives(config)).toEqual([
      { name: '聚合直播', url: 'https://live.example.com/tv.txt' },
      // 空白名称但 URL 有效：给默认名保留
      { name: '直播源', url: 'https://live.example.com/blank.txt' },
    ]);
  });

  it('非法 JSON / 缺 lives 返回空', () => {
    expect(extractTvboxLives('not json')).toEqual([]);
    expect(extractTvboxLives(JSON.stringify({ sites: [] }))).toEqual([]);
  });
});
