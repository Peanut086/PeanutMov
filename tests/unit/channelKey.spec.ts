import { describe, expect, it } from 'vitest';

import {
  channelKeyOf,
  epgNameCandidates,
  normalizeChannelName,
  normalizeTvgId,
  programmeKeyOf,
  splitChannelKey,
} from '@/shared/channelKey';
import { EMPTY_EXTRAS, extrasOf, parseLiveExtras, urlOfTvgId } from '@/sources/live/liveExtras';

/**
 * EXT-06 / FR-67：频道身份与四级匹配的「身份侧」口径（AC-157 / AC-158 纯函数部分）
 * EXT-06 / FR-68：m3u 旁路属性（tvg-id / catchup-*）解析
 */

describe('normalizeChannelName（FR-67 频道名归一化）', () => {
  it('把同一频道的常见写法归一为同一结果', () => {
    const variants = ['CCTV-1 综合', 'CCTV1', 'cctv 1 高清', '  CCTV1 ', 'CCTV_1', 'ＣＣＴＶ１'];
    for (const variant of variants) {
      expect(normalizeChannelName(variant)).toBe('cctv1');
    }
  });

  it('反复剥离画质后缀（"高清"+"4K"）', () => {
    expect(normalizeChannelName('湖南卫视高清4K')).toBe('湖南卫视');
    expect(normalizeChannelName('CCTV5+体育HD')).toBe('cctv5体育');
  });

  it('剥离"综合/频道"词尾但不会剥空', () => {
    expect(normalizeChannelName('新闻频道')).toBe('新闻');
    expect(normalizeChannelName('综合')).toBe('综合');
    expect(normalizeChannelName('频道')).toBe('频道');
  });

  it('空值与空白安全返回空串（异常数据不抛错）', () => {
    expect(normalizeChannelName('')).toBe('');
    expect(normalizeChannelName('   ')).toBe('');
    expect(normalizeChannelName(null as unknown as string)).toBe('');
    expect(normalizeChannelName(undefined as unknown as string)).toBe('');
  });

  it('保留标点差异以外的语义差异（不同频道不会误判相等）', () => {
    expect(normalizeChannelName('CCTV1')).not.toBe(normalizeChannelName('CCTV2'));
    expect(normalizeChannelName('湖南卫视')).not.toBe(normalizeChannelName('湖南经视'));
  });
});

describe('normalizeTvgId（L1 匹配口径）', () => {
  it('只去空白并小写，保留 - . 等业务语义', () => {
    expect(normalizeTvgId('  CCTV1.HD ')).toBe('cctv1.hd');
    expect(normalizeTvgId(null)).toBe('');
    expect(normalizeTvgId(undefined)).toBe('');
  });
});

describe('channelKeyOf（全项目统一身份键）', () => {
  it('有 tvg-id 用 id: 前缀，否则用归一化名', () => {
    expect(channelKeyOf({ name: 'CCTV-1 综合', tvgId: 'CCTV1.HD' })).toBe('id:cctv1.hd');
    expect(channelKeyOf({ name: 'CCTV-1 综合' })).toBe('nm:cctv1');
    expect(channelKeyOf({ name: 'CCTV-1 综合', tvgId: '   ' })).toBe('nm:cctv1');
  });

  it('同一频道的不同写法得到同一键（分组/排序/提醒共用）', () => {
    const a = channelKeyOf({ name: '湖南卫视高清' });
    const b = channelKeyOf({ name: '湖南卫视' });
    expect(a).toBe(b);
  });

  it('splitChannelKey 可逆', () => {
    expect(splitChannelKey('id:cctv1.hd')).toEqual({ kind: 'id', value: 'cctv1.hd' });
    expect(splitChannelKey('nm:cctv1')).toEqual({ kind: 'nm', value: 'cctv1' });
    // 非法前缀兜底为名称键（异常数据不抛错）
    expect(splitChannelKey('cctv1')).toEqual({ kind: 'nm', value: 'cctv1' });
  });
});

describe('epgNameCandidates（L3 候选）', () => {
  it('去重去空，同时给出 name 与 tvg-name 的归一化结果', () => {
    expect(epgNameCandidates({ name: 'CCTV1', tvgName: 'CCTV-1 高清' })).toEqual(['cctv1']);
    expect(epgNameCandidates({ name: 'CCTV1', tvgName: 'CCTV1 综合' })).toEqual(['cctv1']);
    expect(epgNameCandidates({ name: '', tvgName: '' })).toEqual([]);
    expect(epgNameCandidates({ name: 'CCTV1', tvgName: 'CCTV2' })).toEqual(['cctv1', 'cctv2']);
  });
});

describe('programmeKeyOf（提醒/缓存去重键）', () => {
  it('同一节目得到同一键，不同标题/时间得到不同键', () => {
    expect(programmeKeyOf(1000, '新闻联播')).toBe('1000:新闻联播');
    expect(programmeKeyOf(1000, '新闻联播')).toBe(programmeKeyOf(1000, '新闻联播'));
    expect(programmeKeyOf(1000, '新闻联播')).not.toBe(programmeKeyOf(1001, '新闻联播'));
    expect(programmeKeyOf(1000, '新闻联播')).not.toBe(programmeKeyOf(1000, '焦点访谈'));
  });
});

describe('parseLiveExtras（FR-68：不改 parseM3u 的旁路属性）', () => {
  const M3U = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="cctv1.hd" tvg-name="CCTV-1 综合" tvg-logo="x.png" group-title="央视",CCTV-1 综合',
    'http://a.example.com/live/cctv1.m3u8',
    '#EXTINF:-1 tvg-id="hunan" group-title="卫视" catchup-source="http://a.example.com/timeshift/{channel}/{date}/play.m3u8" catchup-days="3",湖南卫视',
    'http://a.example.com/live/hunan.m3u8',
    '#EXTINF:-1 group-title="卫视",浙江卫视',
    'http://a.example.com/live/zhejiang.m3u8',
  ].join('\n');

  it('以频道 URL 为键产出属性（含 catchup-*）', () => {
    const map = parseLiveExtras(M3U);
    expect(map['http://a.example.com/live/cctv1.m3u8']).toMatchObject({
      tvgId: 'cctv1.hd',
      tvgName: 'CCTV-1 综合',
      catchupTemplate: null,
      catchupDays: null,
    });
    expect(map['http://a.example.com/live/hunan.m3u8']).toMatchObject({
      tvgId: 'hunan',
      catchupDays: 3,
    });
    expect(map['http://a.example.com/live/hunan.m3u8']?.catchupTemplate).toContain('{date}');
    // 无属性的频道也必须有一条记录（否则上层判空分支会漏）
    expect(map['http://a.example.com/live/zhejiang.m3u8']).toMatchObject({
      tvgId: null,
      tvgName: null,
    });
  });

  it('extrasOf 无命中返回共享空对象，urlOfTvgId 可反查', () => {
    const map = parseLiveExtras(M3U);
    expect(extrasOf(map, 'http://a.example.com/live/none.m3u8')).toBe(EMPTY_EXTRAS);
    expect(extrasOf(null, 'x')).toBe(EMPTY_EXTRAS);
    expect(urlOfTvgId(map, 'CCTV1.HD')).toBe('http://a.example.com/live/cctv1.m3u8');
    expect(urlOfTvgId(map, 'unknown')).toBeNull();
  });

  it('非 m3u 文本返回空对象（txt 列表不受影响）', () => {
    expect(parseLiveExtras('央视,#genre#\nCCTV1,http://a/c1.m3u8')).toEqual({});
    expect(parseLiveExtras('')).toEqual({});
    expect(parseLiveExtras(null)).toEqual({});
  });

  it('属性行后紧跟注释行时不吞掉地址（容错）', () => {
    const text = [
      '#EXTINF:-1 tvg-id="x",X',
      '#EXTVLCOPT:http-user-agent=foo',
      'http://a.example.com/x.m3u8',
    ].join('\n');
    expect(parseLiveExtras(text)['http://a.example.com/x.m3u8']?.tvgId).toBe('x');
  });
});
