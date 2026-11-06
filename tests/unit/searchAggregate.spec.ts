/**
 * 聚合检索单测（v1.7 / CHG-20，AC-120 / AC-121）
 */
import { describe, expect, it } from 'vitest';

import { groupSearchResults, scoreRelevance, sortByRelevance, titleDedupKey } from '@/services/searchAggregate';
import type { MediaItem } from '@/types';

function makeItem(overrides: Partial<MediaItem> & { sourceId: string; title: string }): MediaItem {
  const now = Date.now();
  return {
    id: `${overrides.sourceId}:${overrides.title}`,
    sourceItemId: overrides.title,
    originalTitle: null,
    type: 'movie',
    year: null,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: overrides.title.toLowerCase(),
    isDemo: false,
    cachedAt: now,
    updatedAt: now,
    ...overrides,
  } as MediaItem;
}

describe('groupSearchResults（AC-120）', () => {
  it('3 个源的同片同年归并为 1 组且来源数 = 3', () => {
    const items = [
      makeItem({ sourceId: 'a', title: '庆余年', year: 2019 }),
      makeItem({ sourceId: 'b', title: '庆余年 HD', year: 2019 }),
      makeItem({ sourceId: 'c', title: '庆余年 4K', year: 2019 }),
    ];
    const groups = groupSearchResults(items, '庆余年');
    expect(groups.length).toBe(1);
    expect(groups[0]!.items.length).toBe(3);
    expect(groups[0]!.title).toBe('庆余年');
  });

  it('同年不同名 / 同名不同年不并组', () => {
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'a', title: '庆余年', year: 2019 }),
        makeItem({ sourceId: 'b', title: '庆余年2', year: 2019 }),
        makeItem({ sourceId: 'c', title: '庆余年', year: 2024 }),
      ],
      '庆余年',
    );
    expect(groups.length).toBe(3);
  });

  it('组内按健康档位排序：fast 在 good 前、bad 最后', () => {
    const health: Record<string, string> = { a: 'ok', b: 'ok', c: 'timeout' };
    const latency: Record<string, number | null> = { a: 100, b: 500, c: null };
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'c', title: '庆余年', year: 2019 }),
        makeItem({ sourceId: 'b', title: '庆余年', year: 2019 }),
        makeItem({ sourceId: 'a', title: '庆余年', year: 2019 }),
      ],
      '庆余年',
      (id) => health[id] as never,
      (id) => latency[id] ?? null,
    );
    expect(groups[0]!.items.map((i) => i.sourceId)).toEqual(['a', 'b', 'c']);
  });

  it('组间排序：健康档位优的组在前', () => {
    const health: Record<string, string> = { a: 'ok', b: 'timeout' };
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'b', title: '片B', year: 2020 }),
        makeItem({ sourceId: 'a', title: '片A', year: 2020 }),
      ],
      '片',
      (id) => health[id] as never,
      () => 100,
    );
    expect(groups[0]!.title).toBe('片A');
  });
});

describe('scoreRelevance（AC-121）', () => {
  it('包含 > 前缀 > 分词 > 无关，分值严格递减', () => {
    expect(scoreRelevance(' 庆余年第二季 ', '庆余年')).toBeGreaterThan(scoreRelevance('庆', '庆余年'));
    expect(scoreRelevance('庆余年', '庆余年')).toBe(4);
    expect(scoreRelevance('庆余年第二季', '庆余年')).toBeGreaterThan(0);
    // 分词 AND：两个词都在标题里、但不是连续子串 → 1
    expect(scoreRelevance('流浪地球之庆余年传', '庆余年 流浪')).toBe(1);
    expect(scoreRelevance('流浪地球', '庆余年 流浪')).toBe(0);
    expect(scoreRelevance('三体', '庆余年')).toBe(0);
    expect(scoreRelevance('三体', '')).toBe(0);
  });

  it('精确匹配 4 分、前缀匹配 3 分，二者不再同分（OPT-08）', () => {
    expect(scoreRelevance('庆余年', '庆余年')).toBe(4);
    expect(scoreRelevance('庆余年第二季', '庆余年')).toBe(3);
    expect(scoreRelevance('庆余年', '庆余年')).toBeGreaterThan(scoreRelevance('庆余年第二季', '庆余年'));
  });

  it('包含匹配 2 分：关键词在标题中段（非前缀）', () => {
    expect(scoreRelevance('新庆余年', '庆余年')).toBe(2);
    expect(scoreRelevance('新庆余年', '庆余年')).toBeLessThan(scoreRelevance('庆余年第二季', '庆余年'));
    expect(scoreRelevance('新庆余年', '庆余年')).toBeGreaterThan(scoreRelevance('流浪地球之庆余年传', '庆余年 流浪'));
  });

  it('四档严格递减 4 > 3 > 2 > 1 > 0（OPT-08 边界）', () => {
    const exact = scoreRelevance('庆余年', '庆余年');
    const prefix = scoreRelevance('庆余年第二季', '庆余年');
    const contains = scoreRelevance('新庆余年', '庆余年');
    const tokens = scoreRelevance('流浪地球之庆余年传', '庆余年 流浪');
    const none = scoreRelevance('三体', '庆余年');
    expect([exact, prefix, contains, tokens, none]).toEqual([4, 3, 2, 1, 0]);
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(contains);
    expect(contains).toBeGreaterThan(tokens);
    expect(tokens).toBeGreaterThan(none);
  });
});

describe('sortByRelevance', () => {
  it('相关度高的在前，同分保持到达顺序', () => {
    const items = [
      makeItem({ sourceId: 'a', title: '别的片子' }),
      makeItem({ sourceId: 'b', title: '庆余年' }),
      makeItem({ sourceId: 'c', title: '庆余年第二季' }),
    ];
    const sorted = sortByRelevance(items, '庆余年');
    expect(sorted[0]!.title).toBe('庆余年');
    expect(sorted[1]!.title).toBe('庆余年第二季');
  });

  it('四档排序：精确 → 前缀 → 包含 → 分词 → 无关（OPT-08 排序回归）', () => {
    const items = [
      makeItem({ sourceId: 'n', title: '三体' }),
      makeItem({ sourceId: 't', title: '流浪的地球' }),
      makeItem({ sourceId: 'c', title: '新流浪地球' }),
      makeItem({ sourceId: 'p', title: '流浪地球2' }),
      makeItem({ sourceId: 'e', title: '流浪地球' }),
    ];
    // 关键词「流浪 地球」归一化后为「流浪地球」：精确 4 / 前缀 3 / 中段包含 2 / 分词 1 / 无关 0
    const sorted = sortByRelevance(items, '流浪 地球');
    expect(sorted.map((i) => i.sourceId)).toEqual(['e', 'p', 'c', 't', 'n']);
    expect(sorted.map((i) => scoreRelevance(i.title, '流浪 地球'))).toEqual([4, 3, 2, 1, 0]);
  });
});

describe('groupSearchResults 组间排序（v1.8 修订：相关度第一优先级）', () => {
  it('精确匹配组压过健康垃圾源组（AC-121 口径修订回归）', () => {
    // 真机案例：采集站对任意关键词返回「找新影视片 001~N」（源健康 ok + 低延迟），
    // 唯一精确匹配的组来自未体检源（unknown tier）——相关度必须先于健康档位
    const items = [
      makeItem({ sourceId: 'junk', title: '找新影视片 001', year: 2024 }),
      makeItem({ sourceId: 'exact', title: '坏线路验证片', year: 2026 }),
      makeItem({ sourceId: 'junk2', title: '找新影视片 002', year: 2024 }),
    ];
    const groups = groupSearchResults(
      items,
      '坏线路验证片',
      (id) => (id.startsWith('junk') ? 'ok' : 'unknown'),
      (id) => (id.startsWith('junk') ? 30 : null),
    );
    expect(groups[0]!.title).toBe('坏线路验证片');
    expect(groups.slice(1).every((g) => g.title.startsWith('找新影视片'))).toBe(true);
  });

  it('同等相关度时健康档位仍生效：fast 源组在 unknown 源组前', () => {
    const items = [
      makeItem({ sourceId: 'unknown-src', title: '庆余年', year: 2019 }),
      makeItem({ sourceId: 'fast-src', title: '庆余年', year: 2020 }),
    ];
    const groups = groupSearchResults(items, '找不到的片', () => 'unknown', () => null);
    // 关键词都不命中（同 0 分）→ 不并组（年份不同）→ 健康与延迟决定顺序
    expect(groups.map((g) => g.year)).toEqual([2019, 2020]);
  });
});

describe('titleDedupKey（CHG-28：平铺去重含年份）', () => {
  it('同名同年 → 同键；同名不同年 → 不同键（同名异年版不再互相挤掉）', () => {
    expect(titleDedupKey('三体', 2023)).toBe(titleDedupKey(' 三体 ', 2023));
    expect(titleDedupKey('三体', 2023)).not.toBe(titleDedupKey('三体', 2008));
  });

  it('大小写与空白归一；年份缺失落到 unknown 桶', () => {
    expect(titleDedupKey('Big Buck', 2020)).toBe(titleDedupKey('bigbuck', 2020));
    expect(titleDedupKey('未知片', null)).toBe(titleDedupKey('未知片', null));
    expect(titleDedupKey('未知片', null)).not.toBe(titleDedupKey('未知片', 2020));
  });
});
