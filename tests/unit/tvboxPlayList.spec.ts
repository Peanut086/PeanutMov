import { describe, expect, it } from 'vitest';

import { buildLinesWithRaw } from '@/sources/site/tvboxNormalize';
import type { Source } from '@/types';

/**
 * 非标准 `vod_play_list` 兼容（网盘/盘搜类源）
 *
 * 样本取自真机日志：线路带 `parse_urls` 时 `urls[].url` 是 token，
 * 需拼到解析接口前缀后；不带 `parse_urls` 时 `urls[].url` 就是直链。
 */
function makeSource(): Source {
  return {
    id: 'src-pan',
    key: 'src-pan',
    name: '网盘源',
    type: 'spider',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://pan.example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

const PARSE_PREFIX = 'https://api.nbyjson.top:7788/api/?key=k&url=';

describe('buildLinesWithRaw：vod_play_list 回退', () => {
  it('仅有 vod_play_list：线路名取 title，token 拼上 parse_urls 前缀', () => {
    const { lines, episodes, rawEpisodes } = buildLinesWithRaw(
      makeSource(),
      {
        vod_id: 1,
        vod_name: '尖峰时刻',
        vod_play_list: [
          {
            flag: 'nby',
            title: '线路二 (点击换线)',
            parse_urls: [PARSE_PREFIX],
            urls: [
              { name: '1', url: 'NBY-TOKEN-A|md5' },
              { name: '2', url: 'NBY-TOKEN-B|md5' },
            ],
          },
        ],
      },
      'media-1',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.name).toBe('线路二 (点击换线)');
    expect(episodes).toHaveLength(2);
    expect(rawEpisodes[0]?.map((entry) => entry.url)).toEqual([
      `${PARSE_PREFIX}NBY-TOKEN-A|md5`,
      `${PARSE_PREFIX}NBY-TOKEN-B|md5`,
    ]);
  });

  it('parse_urls 为空：urls[].url 原样作为直链，空线路丢弃', () => {
    const { lines, episodes } = buildLinesWithRaw(
      makeSource(),
      {
        vod_id: 2,
        vod_name: '尖峰时刻3',
        vod_play_list: [
          {
            title: '线路三 (勿信广告)',
            parse_urls: [],
            urls: [
              { name: '1', url: 'https://v.lf.example.com/a/index.m3u8' },
              { name: '2', url: 'https://v.lf.example.com/b/index.m3u8' },
            ],
          },
          { title: '空线路', urls: [] },
        ],
      },
      'media-2',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.name).toBe('线路三 (勿信广告)');
    expect(lines[0]?.format).toBe('hls');
    expect(episodes.map((episode) => episode.rawUrl)).toEqual([
      'https://v.lf.example.com/a/index.m3u8',
      'https://v.lf.example.com/b/index.m3u8',
    ]);
  });

  it('标准 vod_play_url 有剧集时优先，忽略 vod_play_list', () => {
    const { lines, episodes } = buildLinesWithRaw(
      makeSource(),
      {
        vod_id: 3,
        vod_name: '标准源',
        vod_play_from: '线路1',
        vod_play_url: '第1集$https://cdn.example.com/1.m3u8',
        vod_play_list: [
          { title: '网盘线路', urls: [{ name: '1', url: 'https://pan.example.com/a.m3u8' }] },
        ],
      },
      'media-3',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]?.name).toBe('线路1');
    expect(episodes.map((episode) => episode.rawUrl)).toEqual(['https://cdn.example.com/1.m3u8']);
  });
});
