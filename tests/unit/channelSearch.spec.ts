/**
 * 直播频道搜索（C2）
 *
 * 直播源命名千奇百怪，搜索必须走和身份键同一套归一化：
 * 「cctv 1」「CCTV-1 高清」「cctv1综合」都得命中同一路。
 * 同时不能因为归一化剥后缀就把「高清」「综合」这两个词搜没了。
 */
import { describe, expect, it } from 'vitest';

import { filterChannelsByQuery } from '@/shared/channelSearch';

const channels = [
  { name: 'CCTV-1 综合', group: '央视' },
  { name: 'CCTV-5 体育', group: '央视' },
  { name: 'CCTV-13 新闻', group: '央视' },
  { name: '湖南卫视 高清', group: '卫视' },
  { name: '浙江卫视', group: '卫视' },
  { name: 'CCTV-1 备用', group: '备用线路' },
];

const names = (query: string) => filterChannelsByQuery(channels, query).map((c) => c.name);

describe('filterChannelsByQuery', () => {
  it('空查询原样返回，不动源顺序', () => {
    expect(filterChannelsByQuery(channels, '')).toEqual(channels);
    expect(filterChannelsByQuery(channels, '   ')).toEqual(channels);
  });

  it('纯分隔符查询不会把整份列表判成命中', () => {
    expect(filterChannelsByQuery(channels, '---')).toEqual(channels);
  });

  it('归一化命中：空格 / 连字符 / 大小写 / 画质后缀都不影响', () => {
    for (const query of ['cctv1', 'CCTV 1', 'cctv-1', 'CCTV1高清']) {
      const hits = names(query);
      expect(hits).toContain('CCTV-1 综合');
      // 精确命中排最前；cctv13 这类前缀相同的台按「包含」档排在后面
      expect(hits[0]).toBe('CCTV-1 综合');
      expect(hits).not.toContain('湖南卫视 高清');
    }
  });

  it('被归一化剥掉的后缀词仍可搜到（走宽松名）', () => {
    expect(names('高清')).toEqual(['湖南卫视 高清']);
    expect(names('综合')).toEqual(['CCTV-1 综合']);
  });

  it('相关性分档：全等 > 前缀 > 包含 > 仅分组命中', () => {
    const list = [
      { name: '湖南卫视', group: '卫视' },
      { name: '卫视精选', group: '其他' },
      { name: '浙江卫视', group: '卫视' },
      { name: 'CCTV-1', group: '卫视' },
      { name: '卫视', group: '其他' },
    ];
    expect(filterChannelsByQuery(list, '卫视').map((c) => c.name)).toEqual([
      '卫视',
      '卫视精选',
      '湖南卫视',
      '浙江卫视',
      'CCTV-1',
    ]);
  });

  it('同档内保持源顺序（稳定排序）', () => {
    expect(names('cctv')).toEqual(['CCTV-1 综合', 'CCTV-5 体育', 'CCTV-13 新闻', 'CCTV-1 备用']);
  });

  it('分组名也能搜：搜「央视」拿到整组', () => {
    expect(names('央视')).toEqual(['CCTV-1 综合', 'CCTV-5 体育', 'CCTV-13 新闻']);
  });

  it('搜不到返回空数组，不抛错', () => {
    expect(filterChannelsByQuery(channels, '不存在的台')).toEqual([]);
    expect(filterChannelsByQuery([], 'cctv')).toEqual([]);
  });

  it('全角输入按 NFKC 归一化后命中', () => {
    expect(names('ＣＣＴＶ１')).toContain('CCTV-1 综合');
  });

  it('不改动入参数组', () => {
    const snapshot = channels.map((c) => c.name);
    filterChannelsByQuery(channels, '卫视');
    expect(channels.map((c) => c.name)).toEqual(snapshot);
  });
});