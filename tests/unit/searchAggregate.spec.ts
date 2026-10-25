/**
 * 聚合检索单测（v1.7 / CHG-20，AC-120 / AC-121）
 */
import { describe, expect, it } from 'vitest';

import { groupSearchResults, scoreRelevance, sortByRelevance } from '@/services/searchAggregate';
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
    // 分词 AND：两个词都在标题里、但不是连续子串 → 2
    expect(scoreRelevance('流浪地球之庆余年传', '庆余年 流浪')).toBe(2);
    expect(scoreRelevance('流浪地球', '庆余年 流浪')).toBe(0);
    expect(scoreRelevance('三体', '庆余年')).toBe(0);
    expect(scoreRelevance('三体', '')).toBe(0);
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
});
