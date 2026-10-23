import { describe, expect, it } from 'vitest';

import { isTitleMatch, normalizeTitleForMatch, pickPlayCandidate, stripTitleNoise } from '@/sources/douban/playMatch';
import type { MediaItem, Source } from '@/types';

/**
 * 跨源播放匹配（「发现源」借 CMS）规则测试
 *
 * 核心是防串片：片名必须归一化后相等、年份必须一致，
 * 否则宁可返回 null 让上层报「没找到可播放的源」。
 */
function item(title: string, year: number | null, sourceId = 'cms'): MediaItem {
  return {
    id: `${sourceId}::${title}`,
    sourceId,
    sourceItemId: title,
    title,
    originalTitle: null,
    type: 'movie',
    year,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: title.toLowerCase(),
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

function makeSource(type: Source['type'] = 'site', extra: Partial<Source> = {}): Source {
  return {
    id: 'cms',
    key: 'cms',
    name: 'CMS 站',
    type,
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://cms.example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'ok',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

describe('跨源播放匹配', () => {
  it('片名归一化：去空白、全角转半角、去标点', () => {
    expect(normalizeTitleForMatch('流浪地球2')).toBe('流浪地球2');
    expect(normalizeTitleForMatch('流浪地球 第2季')).toBe('流浪地球第2季');
    expect(normalizeTitleForMatch('Ａｖａｔａｒ')).toBe('avatar');
    expect(normalizeTitleForMatch('希望×一战成名')).toBe('希望一战成名');
  });

  it('stripTitleNoise 剥掉年份/季/预告/画质等噪声', () => {
    expect(stripTitleNoise('流浪地球2(2019)')).toBe(stripTitleNoise('流浪地球2'));
    expect(stripTitleNoise('庆余年 第2季')).toBe(stripTitleNoise('庆余年'));
    expect(stripTitleNoise('杯雪·一战成名2026')).toBe(stripTitleNoise('杯雪·一战成名'));
    expect(stripTitleNoise('希望（预告片）')).toBe(stripTitleNoise('希望'));
  });

  it('片名相等且年份一致 → 匹配', () => {
    expect(isTitleMatch('流浪地球', 2019, item('流浪地球', 2019))).toBe(true);
    expect(isTitleMatch('流浪地球2(2019)', 2019, item('流浪地球2', 2019))).toBe(true);
    expect(isTitleMatch('庆余年 第2季', null, item('庆余年第二季', null))).toBe(true);
  });

  it('年份冲突 → 拒绝（防串片）', () => {
    expect(isTitleMatch('流浪地球', 2019, item('流浪地球', 2020))).toBe(false);
    expect(isTitleMatch('流浪地球', 2020, item('流浪地球', 2019))).toBe(false);
  });

  it('一方缺年份 → 其它条件满足仍匹配', () => {
    expect(isTitleMatch('流浪地球', null, item('流浪地球', 2019))).toBe(true);
    expect(isTitleMatch('流浪地球', 2019, item('流浪地球', null))).toBe(true);
  });

  it('片名不同 → 拒绝', () => {
    expect(isTitleMatch('希望', null, item('希望2', null))).toBe(false);
    expect(isTitleMatch('流浪地球', null, item('流浪地球特别篇', null))).toBe(false);
  });

  it('pickPlayCandidate 只从 site/spider 源借，跳过其它发现源', () => {
    const cms = makeSource('site');
    const douban = makeSource('douban');
    expect(douban.id).toBe(cms.id); // 同 id，用 map 区分 type
    const byId = new Map([[cms.id, cms]]);
    const results = [item('流浪地球', 2019)];
    expect(pickPlayCandidate('流浪地球', 2019, results, byId)?.source.type).toBe('site');

    const doubanOnly = new Map([[douban.id, douban]]);
    expect(pickPlayCandidate('流浪地球', 2019, results, doubanOnly)).toBe(null);
  });

  it('pickPlayCandidate 跳过禁用的源', () => {
    const disabled = makeSource('site', { enabled: false });
    const byId = new Map([[disabled.id, disabled]]);
    expect(pickPlayCandidate('流浪地球', 2019, [item('流浪地球', 2019)], byId)).toBe(null);
  });
});
