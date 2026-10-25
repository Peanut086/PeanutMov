/**
 * EPG 解析单测（v1.7 / CHG-23，AC-127 部分）
 */
import { describe, expect, it } from 'vitest';

import { epgService, parseEpgResponse, type EpgProgramme } from '@/services/epgService';

describe('parseEpgResponse', () => {
  it('diyp JSON 数组 → 秒偏移 + 排序', () => {
    const programmes = parseEpgResponse(
      JSON.stringify([
        { start: '2026-10-25 20:00:00', end: '2026-10-25 20:30:00', title: '新闻联播' },
        { start: '2026-10-25 08:00:00', end: '2026-10-25 09:00:00', title: '朝闻天下' },
      ]),
    );
    expect(programmes.length).toBe(2);
    expect(programmes[0]!.title).toBe('朝闻天下');
    expect(programmes[0]!.start).toBe('08:00');
    expect(programmes[0]!.startSec).toBe(8 * 3600);
    expect(programmes[1]!.startSec).toBe(20 * 3600);
  });

  it('XMLTV 文本 → 解析 start/stop/title', () => {
    const xml = [
      '<tv>',
      '<programme start="20261025200000 +0800" stop="20261025203000 +0800" channel="CCTV1">',
      '<title lang="zh">新闻联播</title><desc lang="zh">时事报道</desc>',
      '</programme>',
      '<programme start="20261025180000 +0800" stop="20261025190000 +0800" channel="CCTV1">',
      '<title lang="zh">动画城</title>',
      '</programme>',
      '</tv>',
    ].join('');
    const programmes = parseEpgResponse(xml);
    expect(programmes.length).toBe(2);
    expect(programmes[0]!.title).toBe('动画城');
    expect(programmes[1]!.title).toBe('新闻联播');
    expect(programmes[1]!.desc).toBe('时事报道');
  });

  it('非法输入返回空', () => {
    expect(parseEpgResponse('not epg')).toEqual([]);
    expect(parseEpgResponse('')).toEqual([]);
  });
});

describe('nowPlaying / upNext', () => {
  const programmes: EpgProgramme[] = [
    { start: '08:00', end: '09:00', title: '早间', desc: null, startSec: 8 * 3600, endSec: 9 * 3600 },
    { start: '20:00', end: '20:30', title: '新闻联播', desc: null, startSec: 20 * 3600, endSec: 20 * 3600 + 1800 },
    { start: '20:30', end: '21:00', title: '天气预报', desc: null, startSec: 20 * 3600 + 1800, endSec: 21 * 3600 },
  ];
  const at2010 = new Date(2026, 9, 25, 20, 10, 0);

  it('命中当前节目', () => {
    expect(epgService.nowPlaying(programmes, at2010)?.title).toBe('新闻联播');
  });

  it('无命中（时段之外）返回 null', () => {
    expect(epgService.nowPlaying(programmes, new Date(2026, 9, 25, 3, 0, 0))).toBeNull();
  });

  it('upNext 给出后续节目', () => {
    const next = epgService.upNext(programmes, at2010);
    expect(next.map((p) => p.title)).toEqual(['天气预报']);
  });
});
