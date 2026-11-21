import { describe, expect, it } from 'vitest';

import { isTitleMatch, normalizeTitleForMatch, pickPlayCandidate, pickSourceCandidates, seasonOfTitle, stripTitleNoise } from '@/sources/douban/playMatch';
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

describe('stripTitleNoise 集数/更新后缀', () => {
  it('剥掉「更新至N集」「更新到N集」「更新N集」', () => {
    expect(stripTitleNoise('嫁金钗 更新至12集')).toBe(stripTitleNoise('嫁金钗'));
    expect(stripTitleNoise('嫁金钗 更新到12集')).toBe(stripTitleNoise('嫁金钗'));
    expect(stripTitleNoise('嫁金钗 更新12集')).toBe(stripTitleNoise('嫁金钗'));
  });

  it('剥掉「全N集」「共N集」「N集全」「N集完结」', () => {
    expect(stripTitleNoise('嫁金钗 全40集')).toBe(stripTitleNoise('嫁金钗'));
    expect(stripTitleNoise('嫁金钗 共40集')).toBe(stripTitleNoise('嫁金钗'));
    expect(stripTitleNoise('嫁金钗40集全')).toBe(stripTitleNoise('嫁金钗'));
    expect(stripTitleNoise('嫁金钗40集完结')).toBe(stripTitleNoise('嫁金钗'));
  });

  it('剥掉「第N集」「第N话」「第N期」', () => {
    expect(stripTitleNoise('嫁金钗 第12集')).toBe(stripTitleNoise('嫁金钗'));
    expect(stripTitleNoise('嫁金钗 第12话')).toBe(stripTitleNoise('嫁金钗'));
    expect(stripTitleNoise('嫁金钗 第12期')).toBe(stripTitleNoise('嫁金钗'));
  });

  it('不误剥纯数字结尾（流浪地球2）', () => {
    expect(stripTitleNoise('流浪地球2')).toBe('流浪地球2');
    expect(stripTitleNoise('流浪地球2(2019)')).toBe('流浪地球2');
  });

  it('不误剥非集数后缀（第十二秒）', () => {
    expect(stripTitleNoise('第十二秒')).toBe('第十二秒');
  });
});

describe('pickSourceCandidates', () => {
  it('每个源只保留一条候选', () => {
    const source1 = makeSource('site', { id: 's1', name: '源1' });
    const source2 = makeSource('site', { id: 's2', name: '源2' });
    const byId = new Map([
      [source1.id, source1],
      [source2.id, source2],
    ]);
    const results = [
      item('嫁金钗', 2025, 's1'),
      item('嫁金钗 更新至12集', 2025, 's1'),
      item('嫁金钗', 2025, 's2'),
    ];
    const candidates = pickSourceCandidates('嫁金钗', 2025, results, byId);
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => c.source.id).sort()).toEqual(['s1', 's2']);
  });

  it('优先保留年份精确匹配的条目', () => {
    const source = makeSource('site', { id: 's1' });
    const byId = new Map([[source.id, source]]);
    const results = [
      item('嫁金钗', 2024, 's1'),
      item('嫁金钗', 2025, 's1'),
    ];
    const candidates = pickSourceCandidates('嫁金钗', 2025, results, byId);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.item.year).toBe(2025);
  });

  it('排除 douban 源（只有元数据）', () => {
    const douban = makeSource('douban', { id: 'd1' });
    const byId = new Map([[douban.id, douban]]);
    const results = [item('嫁金钗', 2025, 'd1')];
    expect(pickSourceCandidates('嫁金钗', 2025, results, byId).length).toBe(0);
  });

  it('排除禁用的源', () => {
    const disabled = makeSource('site', { id: 's1', enabled: false });
    const byId = new Map([[disabled.id, disabled]]);
    const results = [item('嫁金钗', 2025, 's1')];
    expect(pickSourceCandidates('嫁金钗', 2025, results, byId).length).toBe(0);
  });

  it('排除当前源和当前条目', () => {
    const source1 = makeSource('site', { id: 's1' });
    const source2 = makeSource('site', { id: 's2' });
    const byId = new Map([
      [source1.id, source1],
      [source2.id, source2],
    ]);
    const results = [
      item('嫁金钗', 2025, 's1'),
      item('嫁金钗', 2025, 's2'),
    ];
    expect(pickSourceCandidates('嫁金钗', 2025, results, byId, { excludeSourceId: 's1' }).length).toBe(1);
    expect(pickSourceCandidates('嫁金钗', 2025, results, byId, { excludeMediaId: 's1::嫁金钗' }).length).toBe(1);
  });

  it('允许 alist/webdav/jellyfin 等本地媒体库源', () => {
    const alist = makeSource('alist', { id: 'a1' });
    const webdav = makeSource('webdav', { id: 'w1' });
    const jellyfin = makeSource('jellyfin', { id: 'j1' });
    const byId = new Map([
      [alist.id, alist],
      [webdav.id, webdav],
      [jellyfin.id, jellyfin],
    ]);
    const results = [
      item('嫁金钗', 2025, 'a1'),
      item('嫁金钗', 2025, 'w1'),
      item('嫁金钗', 2025, 'j1'),
    ];
    const candidates = pickSourceCandidates('嫁金钗', 2025, results, byId);
    expect(candidates.length).toBe(3);
  });
});
