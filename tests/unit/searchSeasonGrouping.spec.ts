import { describe, expect, it } from 'vitest';

import { groupSearchResults, scoreRelevance } from '@/services/searchAggregate';
import type { MediaItem } from '@/types';

/**
 * P1-7 跨季合并与首位命中（真机 2026-11-18 实测口径）
 *
 * 实测样本（关键词「绝命毒师」）：
 * - group[1] 聚合 171 条、含 26 个不同标题，代表项是「绝命毒师 **第三季**」；
 * - 「第五季」在第 6 位与第 17 位各成一组；
 * - 2023 年同名动画排在 2008 剧版之上。
 *
 * 本文件固定修法：季号只做「同作品不同季」的二级归并（写法互认、跨季不合并）、
 * 组名取最贴查询词的标题、查询词点名的年份/季号参与组间排序、来源数在健康档位之前。
 */

function makeItem(overrides: Partial<MediaItem> & { sourceId: string; title: string }): MediaItem {
  const now = Date.now();
  return {
    id: `${overrides.sourceId}:${overrides.title}`,
    sourceItemId: overrides.title,
    originalTitle: null,
    type: 'series',
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

describe('季号二级归并（P1-7）', () => {
  it('同一季的不同写法归为一组，主条目不再被并进去', () => {
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'a', title: '绝命毒师', year: 2008 }),
        makeItem({ sourceId: 'b', title: '绝命毒师 第三季', year: 2010 }),
        makeItem({ sourceId: 'c', title: '绝命毒师第3季', year: 2010 }),
        makeItem({ sourceId: 'd', title: '绝命毒师 Season 3', year: null }),
        makeItem({ sourceId: 'e', title: '绝命毒师 S03', year: null }),
      ],
      '绝命毒师',
    );
    expect(groups.length).toBe(2);
    const third = groups.find((g) => g.items.length === 4);
    expect(third?.items.map((i) => i.sourceId)).toEqual(['b', 'c', 'd', 'e']);
    // 主条目那一组只剩它自己：某季不再冒充整部剧
    expect(groups.find((g) => g.items.length === 1)?.title).toBe('绝命毒师');
  });

  it('缺年份的季条目并入同季里条目最多的那一年，不再另开一组（第五季两组 → 一组）', () => {
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'a', title: '绝命毒师第五季', year: 2012 }),
        makeItem({ sourceId: 'b', title: '绝命毒师 第5季', year: null }),
        makeItem({ sourceId: 'c', title: '绝命毒师 Season 5', year: null }),
      ],
      '绝命毒师',
    );
    expect(groups.length).toBe(1);
    expect(groups[0]?.year).toBe(2012);
    expect(groups[0]?.items.length).toBe(3);
  });

  it('跨季打包条目不挤进第一季，也不与单季条目同组', () => {
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'a', title: '绝命毒师 第一季', year: 2009 }),
        makeItem({ sourceId: 'b', title: '绝命毒师 1-5季全集 电影', year: null }),
        makeItem({ sourceId: 'c', title: '绝命毒师 S01-S05 4K 高码率 未删减', year: null }),
      ],
      '绝命毒师',
    );
    const first = groups.find((g) => g.title === '绝命毒师 第一季');
    expect(first?.items.map((i) => i.sourceId)).toEqual(['a']);
    expect(groups.length).toBe(3);
  });

  it('组名取最贴查询词的标题，不再随机落在带后缀的那份（实测代表项是「绝命毒师 第三季」）', () => {
    const groups = groupSearchResults(
      [
        // 到达顺序故意让带后缀的写法在最前
        makeItem({ sourceId: 'a', title: '绝命毒师 第三季 HD', year: 2010 }),
        makeItem({ sourceId: 'b', title: '绝命毒师 第三季 未删减', year: 2010 }),
        makeItem({ sourceId: 'c', title: '绝命毒师第三季', year: null }),
      ],
      '绝命毒师 第三季',
    );
    expect(groups.length).toBe(1);
    expect(groups[0]?.title).toBe('绝命毒师第三季');
  });
});

describe('首位命中与年份/季号一致性（P1-7）', () => {
  it('同名不同年：来源数多的正片组排在只有一两个来源的同名动画之前', () => {
    const drama = [1, 2, 3].map((n) => makeItem({ sourceId: `drama${n}`, title: '绝命毒师', year: 2008 }));
    const anime = makeItem({ sourceId: 'anime', title: '绝命毒师', year: 2023 });
    // 动画那组来自"健康且快"的源，旧口径的档位/延迟键会让它压过剧版
    const groups = groupSearchResults(
      [anime, ...drama],
      '绝命毒师',
      (id) => (id === 'anime' ? 'ok' : 'unknown'),
      (id) => (id === 'anime' ? 30 : null),
    );
    expect(groups.length).toBe(2);
    expect(groups[0]?.year).toBe(2008);
    expect(groups[1]?.year).toBe(2023);
  });

  it('查询点名年份：一致的组压过来源更多的冲突组', () => {
    const conflict = [1, 2, 3].map((n) => makeItem({ sourceId: `x${n}`, title: '绝命毒师', year: 2023 }));
    const match = makeItem({ sourceId: 'z', title: '绝命毒师', year: 2008 });
    const groups = groupSearchResults([...conflict, match], '绝命毒师 2008');
    expect(groups.map((g) => g.year)).toEqual([2008, 2023]);
  });

  it('查询点名季号：该季在前、主条目居中、其它季沉底，且主条目不再被判成无关', () => {
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'base', title: '绝命毒师', year: 2008 }),
        makeItem({ sourceId: 's5', title: '绝命毒师 第五季', year: 2012 }),
        makeItem({ sourceId: 's3', title: '绝命毒师 第三季', year: 2010 }),
      ],
      '绝命毒师 第三季',
    );
    expect(groups.map((g) => g.title)).toEqual(['绝命毒师 第三季', '绝命毒师', '绝命毒师 第五季']);
    // 「其它匹配」折叠按相关度 > 0 判定：主条目必须留在有效结果里
    expect(scoreRelevance('绝命毒师', '绝命毒师 第三季')).toBe(1);
    expect(scoreRelevance('绝命毒师 第三季', '绝命毒师 第三季')).toBe(4);
  });

  it('查询没点名片号时不猜：季号之间只由来源数与到达顺序决定', () => {
    const groups = groupSearchResults(
      [
        makeItem({ sourceId: 'a1', title: '绝命毒师 第一季', year: 2008 }),
        makeItem({ sourceId: 'a2', title: '绝命毒师 第一季', year: 2008 }),
        makeItem({ sourceId: 'b1', title: '绝命毒师 第二季', year: 2009 }),
      ],
      '绝命毒师',
    );
    expect(groups.map((g) => g.title)).toEqual(['绝命毒师 第一季', '绝命毒师 第二季']);
  });

  it('相关度四档不因季号改动而变形（OPT-08 口径守住）', () => {
    expect(scoreRelevance('庆余年', '庆余年')).toBe(4);
    expect(scoreRelevance('庆余年第二季', '庆余年')).toBe(3);
    expect(scoreRelevance('新庆余年', '庆余年')).toBe(2);
    expect(scoreRelevance('流浪地球之庆余年传', '庆余年 流浪')).toBe(1);
    expect(scoreRelevance('三体', '庆余年')).toBe(0);
    // 年份/季号标注词不构成命中：只有片名根也不得分
    expect(scoreRelevance('三体', '庆余年 第二季')).toBe(0);
  });
});
