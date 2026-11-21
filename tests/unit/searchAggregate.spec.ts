/**
 * 聚合检索单测（v1.7 / CHG-20，AC-120 / AC-121）
 */
import { describe, expect, it } from 'vitest';

import {
  buildTailSuggestions,
  countDirectGroupMatches,
  countDirectItemMatches,
  countDirectMatches,
  groupRelevanceScore,
  groupSearchResults,
  isKeywordIgnored,
  isNonFeatureContent,
  matchesActor,
  normalizeSearchKeyword,
  relevanceScoreOf,
  scoreRelevance,
  sortByRelevance,
  titleDedupKey,
} from '@/services/searchAggregate';
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

describe('countDirectMatches（P2-8：直接命中计数口径）', () => {
  it('精确/前缀/包含算直接命中，分词档与无关都不算', () => {
    const titles = ['庆余年', '庆余年第二季', '新庆余年', '三体'];
    // 前三条分别是 4/3/2 分，最后一条无关
    expect(countDirectMatches(titles, '庆余年')).toBe(3);
    // 只有分词档（1 分）：两个词都出现，但不是连续子串——只是沾边
    expect(countDirectMatches(['流浪的庆余年传'], '庆余年 流浪')).toBe(0);
  });

  it('整屏只是沾边时计数为 0（结果区据此改口径并给改写建议）', () => {
    expect(countDirectMatches(['某综艺第 3 期', '某纪录片', '另一部剧'], '庆余年')).toBe(0);
    expect(countDirectMatches([], '庆余年')).toBe(0);
  });

  it('关键词归一化后为空时不把所有标题判成命中', () => {
    expect(countDirectMatches(['庆余年', '三体'], '！！！')).toBe(0);
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

  it('四档都命中时组顺序即徽章顺序：精确 → 前缀 → 包含 → 分词（C-12）', () => {
    const keyword = '太阳雨 上海';
    // 到达顺序故意从最差档开始，证明是排序而不是输入顺序
    const items = [
      makeItem({ sourceId: 'd', title: '上海的太阳雨', year: 2022 }),
      makeItem({ sourceId: 'c', title: '纪录片太阳雨上海滩', year: 2023 }),
      makeItem({ sourceId: 'b', title: '太阳雨上海滩', year: 2024 }),
      makeItem({ sourceId: 'a', title: '太阳雨 上海', year: 2025 }),
    ];
    const groups = groupSearchResults(items, keyword);
    expect(groups.map((g) => scoreRelevance(g.title, keyword))).toEqual([4, 3, 2, 1]);
  });
});

describe('isNonFeatureContent（F6：非正片形态降权）', () => {
  it('真机两轮实测到的非正片形态全部命中', () => {
    const titles = [
      // 第一轮：关键词「绝命毒师」
      '【第1次补档】绝命毒师【非AI真人语音解说】',
      '【黑屏·弹幕版】一口气24小时看完绝命毒师',
      '【yuwapeach ASMR】绝命毒师乐高收藏',
      '跟经典美剧《绝命毒师》学英语-001',
      '王橹杰最新微博视频re：绝命毒师',
      '绝命毒师的搜索有80条',
      // 第二轮：关键词「庆余年」
      '有声书《庆余年》完整版全集',
      '【庆余年｜李沁&张若昀】混剪合集',
      '庆余年 片尾曲《借过一下》完整版剧情MV！',
      '【余年】古筝（纯筝）庆余年主题曲',
      '绝命毒师第四季幕后纪实',
      '庆余年 定档预告',
    ];
    for (const title of titles) {
      expect(isNonFeatureContent(title), title).toBe(true);
    }
  });

  it('刻意不收的词不误杀真实片名', () => {
    // 纪录片 / 合集 / 全集 / 特别篇 / 特别版 / 剪辑 / 钢琴 均不在词表内
    const titles = [
      '庆余年 第一季特别篇',
      '庆余年 第一季特别版',
      '银翼杀手 导演剪辑版',
      '海上钢琴师',
      '太阳雨 纪实录',
      '绝命毒师 1-5季全集 电影',
      '庆余年 S01-S05 4K 高码率 未删减',
    ];
    for (const title of titles) {
      expect(isNonFeatureContent(title), title).toBe(false);
    }
  });

  it('用户主动搜该形态时不再降权', () => {
    expect(isNonFeatureContent('【第1次补档】绝命毒师【非AI真人语音解说】', '绝命毒师 解说')).toBe(false);
    expect(isNonFeatureContent('庆余年混剪', '混剪')).toBe(false);
    expect(isNonFeatureContent('庆余年混剪', '庆余年')).toBe(true);
  });

  it('同分时正片组排在非正片组前（rankOf 第二键）', () => {
    const items = [
      makeItem({ sourceId: 'bilibili', title: '庆余年 有声剧全集', year: 2021 }),
      makeItem({ sourceId: 'vod', title: '庆余年 第一季', year: 2019 }),
    ];
    // 两者同为「前缀」档（3 分），组顺序只能由非正片判定决定
    expect(scoreRelevance(items[0]!.title, '庆余年')).toBe(scoreRelevance(items[1]!.title, '庆余年'));
    const groups = groupSearchResults(items, '庆余年');
    expect(groups.map((g) => g.title)).toEqual(['庆余年 第一季', '庆余年 有声剧全集']);
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

describe('isKeywordIgnored（P0-1：源忽略关键词检测）', () => {
  it('返回数量 < minCount 时不判定为忽略', () => {
    const items = [
      makeItem({ sourceId: 'a', title: '完全不相关的标题' }),
      makeItem({ sourceId: 'a', title: '另一个无关标题' }),
    ];
    expect(isKeywordIgnored(items, '太阳雨', 15)).toBe(false);
  });

  it('数量足够但有任何相关项时不判定为忽略', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ sourceId: 'a', title: i === 0 ? '今天是太阳雨' : `无关标题${i}` }),
    );
    expect(isKeywordIgnored(items, '太阳雨', 15)).toBe(false);
  });

  it('数量足够且全部无关时判定为忽略', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ sourceId: 'a', title: `找新影视片 ${String(i).padStart(3, '0')}` }),
    );
    expect(isKeywordIgnored(items, '太阳雨', 15)).toBe(true);
  });
});

describe('主演命中（演员搜索）', () => {
  it('双向包含都认：整词与分词形态都比', () => {
    expect(matchesActor(['沈腾', '尹正'], '沈腾')).toBe(true);
    expect(matchesActor(['沈腾'], '飞驰人生 沈腾')).toBe(true);
    expect(matchesActor(['凯莉·库恩'], '凯莉库恩')).toBe(true);
    expect(matchesActor(['沈腾'], '三体')).toBe(false);
  });

  it('单字查询不比演员：门槛按归一化后的长度', () => {
    expect(matchesActor(['沈腾'], '腾')).toBe(false);
    expect(matchesActor(['王'], '王刚')).toBe(false);
  });

  it('季号/年份标注词不参与演员比对', () => {
    expect(matchesActor(['庆余年'], '庆余年 第三季')).toBe(true);
    expect(matchesActor(['十月'], '2024 十月')).toBe(true);
  });

  it('存量缓存没有 actors 字段时不报错', () => {
    expect(matchesActor(undefined, '沈腾')).toBe(false);
    expect(matchesActor([], '沈腾')).toBe(false);
  });

  it('标题档优先，标题完全不沾时主演命中算包含档', () => {
    const byTitle = makeItem({ sourceId: 'a', title: '沈腾传', actors: ['张三'] });
    expect(relevanceScoreOf(byTitle, '沈腾')).toBe(3);
    const byActor = makeItem({ sourceId: 'a', title: '飞驰人生', actors: ['沈腾'] });
    expect(relevanceScoreOf(byActor, '沈腾')).toBe(2);
    expect(relevanceScoreOf(makeItem({ sourceId: 'a', title: '三体', actors: ['王佳怡'] }), '沈腾')).toBe(0);
  });

  it('主演命中计入直接命中，不再误报「没有直接匹配」', () => {
    const shen = makeItem({ sourceId: 'a', title: '飞驰人生', actors: ['沈腾'] });
    const jia = makeItem({ sourceId: 'b', title: '热辣滚烫', actors: ['贾玲'] });
    const three = makeItem({ sourceId: 'c', title: '三体' });
    expect(countDirectItemMatches([shen, jia, three], '沈腾')).toBe(1);
    const groups = [
      { key: 'k1', title: '飞驰人生', year: null, items: [shen] },
      { key: 'k3', title: '三体', year: null, items: [three] },
    ];
    expect(countDirectGroupMatches(groups, '沈腾')).toBe(1);
    expect(groupRelevanceScore(groups[0]!, '沈腾')).toBe(2);
    expect(groupRelevanceScore(groups[1]!, '沈腾')).toBe(0);
  });

  it('P0-1：源按演员返回结果时不再整批判成「源忽略关键词」', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({
        sourceId: 'a',
        title: `影片${String(i).padStart(2, '0')}`,
        actors: i === 0 ? ['沈腾'] : ['其他人'],
      }),
    );
    expect(isKeywordIgnored(items, '沈腾', 15)).toBe(false);
  });

  it('P0-1：目录页冒充结果（演员也不含关键词）仍判忽略，噪声没被放回来', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeItem({ sourceId: 'a', title: `找新影视片 ${String(i).padStart(3, '0')}`, actors: ['张三', '李四'] }),
    );
    expect(isKeywordIgnored(items, '太阳雨', 15)).toBe(true);
  });

  it('演员命中的条目不沉到最后（0 分之前）', () => {
    const sorted = sortByRelevance(
      [
        makeItem({ sourceId: 'a', title: '三体' }),
        makeItem({ sourceId: 'b', title: '飞驰人生', actors: ['沈腾'] }),
        makeItem({ sourceId: 'c', title: '沈腾的节目' }),
      ],
      '沈腾',
    );
    expect(sorted.map((item) => relevanceScoreOf(item, '沈腾'))).toEqual([3, 2, 0]);
  });
});

describe('normalizeSearchKeyword（P0-2：关键词规范化）', () => {
  it('去除书名号', () => {
    expect(normalizeSearchKeyword('《今天是太阳雨》')).toBe('今天是太阳雨');
  });

  it('去除各种括号和引号', () => {
    expect(normalizeSearchKeyword('【庆余年】')).toBe('庆余年');
    expect(normalizeSearchKeyword('[三体]')).toBe('三体');
    expect(normalizeSearchKeyword('（流浪地球）')).toBe('流浪地球');
    expect(normalizeSearchKeyword('(变形金刚)')).toBe('变形金刚');
  });

  it('保留核心文本并 trim', () => {
    expect(normalizeSearchKeyword('  《坏线路验证片》  ')).toBe('坏线路验证片');
  });

  it('空字符串返回空', () => {
    expect(normalizeSearchKeyword('')).toBe('');
    expect(normalizeSearchKeyword('《》')).toBe('');
  });
});

describe('buildTailSuggestions（C-12：尾词建议芯片）', () => {
  it('去掉尾字排第一，其余缩短建议补足，最多 3 个', () => {
    expect(buildTailSuggestions('今天是太阳雨')).toEqual(['今天是太阳', '今天', '太阳雨']);
  });

  it('先按关键词规范化再切词，书名号不会带进建议', () => {
    expect(buildTailSuggestions('《庆余年》')).toEqual(['庆余']);
  });

  it('2 字及以下没有可缩短的空间，返回空而不是硬凑', () => {
    expect(buildTailSuggestions('三体')).toEqual([]);
    expect(buildTailSuggestions('')).toEqual([]);
    expect(buildTailSuggestions('《》')).toEqual([]);
  });

  it('4 字能凑满 3 个且不重复', () => {
    const result = buildTailSuggestions('流浪地球');
    expect(result).toHaveLength(3);
    expect(new Set(result).size).toBe(3);
    expect(result).not.toContain('流浪地球');
  });

  it('建议里每个词都短于原词，绝不会把原词再推一遍', () => {
    for (const kw of ['庆余年', '流浪地球', '今天是太阳雨', '  《漫长的季节》  ']) {
      const base = normalizeSearchKeyword(kw);
      for (const tail of buildTailSuggestions(kw)) {
        expect(tail.length).toBeLessThan(base.length);
      }
    }
  });
});
