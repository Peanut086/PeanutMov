/**
 * 标题归一化单测（FIX-05）
 *
 * 覆盖四类行为：
 * 1. 字形归一：全角 → 半角、大小写；
 * 2. 后缀剥离：季/部/篇、集/话、Season N、末尾年份、画质与版本修饰词；
 * 3. 数字解析：中文数字、季号、集号、年份；
 * 4. 相似度判定：编辑距离、包含加成、季号/续集号冲突必须判为不同作品（防串片）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TITLE_THRESHOLD,
  editDistance,
  normalizeTitleKey,
  parseChineseNumber,
  parseEpisodeIndex,
  parseSeasonNumber,
  parseYear,
  seasonConflicts,
  stripTitleSuffixes,
  titleKeysOf,
  titleMatches,
  titleMatchScore,
  titleSimilarity,
  toHalfWidth,
} from '@/sources/mapping/TitleNormalizer';

describe('TitleNormalizer / 字形归一', () => {
  it('全角字母数字与全角空格转半角', () => {
    expect(toHalfWidth('ＡＢＣ１２３')).toBe('ABC123');
    expect(toHalfWidth('庆余年　第二季')).toBe('庆余年 第二季');
    expect(toHalfWidth('（２０２４）')).toBe('(2024)');
  });

  it('大小写不敏感', () => {
    expect(normalizeTitleKey('THE OFFICE')).toBe(normalizeTitleKey('the office'));
  });
});

describe('TitleNormalizer / 后缀剥离', () => {
  it('剥掉「第二季」得到片名根', () => {
    expect(normalizeTitleKey('庆余年第二季')).toBe('庆余年');
    expect(normalizeTitleKey('庆余年 第二部')).toBe('庆余年');
    expect(normalizeTitleKey('庆余年第三篇')).toBe('庆余年');
  });

  it('剥掉阿拉伯数字季号与英文 Season/Part/S 写法', () => {
    expect(normalizeTitleKey('庆余年 第2季')).toBe('庆余年');
    expect(normalizeTitleKey('The Office Season 2')).toBe('theoffice');
    expect(normalizeTitleKey('The Office Part 3')).toBe('theoffice');
    expect(normalizeTitleKey('The Office S03')).toBe('theoffice');
  });

  it('剥掉集/话/期/回后缀（有些源把单集当独立条目）', () => {
    expect(normalizeTitleKey('繁花 第5集')).toBe('繁花');
    expect(normalizeTitleKey('进击的巨人 第五话')).toBe('进击的巨人');
  });

  it('剥掉画质/版本/语言修饰词', () => {
    expect(normalizeTitleKey('庆余年 高清 完整版')).toBe('庆余年');
    expect(normalizeTitleKey('流浪地球2 HD 1080P')).toBe('流浪地球2');
    expect(normalizeTitleKey('让子弹飞 未删减 粤语 中字')).toBe('让子弹飞');
  });

  it('括号内容整体剔除（年份、清晰度、语言标注）', () => {
    expect(normalizeTitleKey('庆余年（2024）')).toBe('庆余年');
    expect(normalizeTitleKey('庆余年[高清]')).toBe('庆余年');
    expect(normalizeTitleKey('庆余年【特别篇】')).toBe('庆余年');
  });

  it('只剥末尾年份，保住片名里的年份', () => {
    expect(normalizeTitleKey('繁花 2023 版')).toBe('繁花');
    // 「2001太空漫游」的年份在片名里，不是后缀
    expect(normalizeTitleKey('2001太空漫游')).toBe('2001太空漫游');
  });

  it('剥掉标点与空白', () => {
    expect(normalizeTitleKey(' 三体· 黑暗森林 ')).toBe('三体黑暗森林');
  });

  it('stripTitleSuffixes 与 normalizeTitleKey 口径一致', () => {
    expect(stripTitleSuffixes('庆余年 第二季 高清')).toBe(normalizeTitleKey('庆余年 第二季 高清'));
  });

  it('空值与非法输入返回空串（供调用方判空）', () => {
    expect(normalizeTitleKey('')).toBe('');
    expect(normalizeTitleKey(null)).toBe('');
    expect(normalizeTitleKey(undefined)).toBe('');
  });
});

describe('TitleNormalizer / 数字解析', () => {
  it('中文数字', () => {
    expect(parseChineseNumber('2')).toBe(2);
    expect(parseChineseNumber('十')).toBe(10);
    expect(parseChineseNumber('十二')).toBe(12);
    expect(parseChineseNumber('二十')).toBe(20);
    expect(parseChineseNumber('一百零一')).toBe(101);
    expect(parseChineseNumber('两')).toBe(2);
    expect(parseChineseNumber('')).toBeNull();
    expect(parseChineseNumber('abc')).toBeNull();
  });

  it('季号：中英写法都认', () => {
    expect(parseSeasonNumber('庆余年第二季')).toBe(2);
    expect(parseSeasonNumber('庆余年 第2部')).toBe(2);
    expect(parseSeasonNumber('The Office Season 3')).toBe(3);
    expect(parseSeasonNumber('The Office Ｓｅａｓｏｎ 2')).toBe(2);
    expect(parseSeasonNumber('The Office S04')).toBe(4);
    expect(parseSeasonNumber('庆余年')).toBeNull();
  });

  it('集号：中文、EP、S01E05、纯数字', () => {
    expect(parseEpisodeIndex('第5集')).toBe(5);
    expect(parseEpisodeIndex('第五话')).toBe(5);
    expect(parseEpisodeIndex('EP05')).toBe(5);
    expect(parseEpisodeIndex('E07')).toBe(7);
    expect(parseEpisodeIndex('S01E05')).toBe(5);
    expect(parseEpisodeIndex('05')).toBe(5);
    expect(parseEpisodeIndex('正片')).toBeNull();
    // 4 位数字当成码率/年份，不当集号
    expect(parseEpisodeIndex('2024')).toBeNull();
  });

  it('年份：取第一个 19xx/20xx', () => {
    expect(parseYear('2024')).toBe(2024);
    expect(parseYear('2001太空漫游')).toBe(2001);
    expect(parseYear('某剧')).toBeNull();
  });

  it('titleKeysOf 同时给出根与季号', () => {
    expect(titleKeysOf('庆余年 第二季')).toEqual({ key: '庆余年', season: 2 });
    expect(titleKeysOf('庆余年')).toEqual({ key: '庆余年', season: null });
  });
});

describe('TitleNormalizer / 相似度', () => {
  it('编辑距离', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('同一部', '同一部')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });

  it('完全相同（含修饰词差异）相似度为 1', () => {
    expect(titleSimilarity('庆余年', '庆余年')).toBe(1);
    expect(titleSimilarity('庆余年 高清', '庆余年')).toBe(1);
    expect(titleSimilarity('庆余年', '')).toBe(0);
  });

  it('一字之差落在阈值以下（宁可不播，不可串片）', () => {
    const score = titleSimilarity('庆余年', '余庆年');
    expect(score).toBeLessThan(DEFAULT_TITLE_THRESHOLD);
  });

  it('短名被长名包含时抬高相似度', () => {
    expect(titleMatchScore('漫长的季节', '漫长的季节特别篇')).toBeCloseTo(0.9, 5);
    expect(titleMatchScore('漫长的季节', '漫长的季节')).toBe(1);
  });

  it('季号冲突 → 0（第二季不能拿第一季的地址）', () => {
    expect(titleMatchScore('庆余年第二季', '庆余年第一季')).toBe(0);
    expect(titleMatchScore('The Office Season 2', 'The Office Season 1')).toBe(0);
  });

  it('单侧有季号时可消解（庆余年第二季 / 庆余年2）', () => {
    expect(titleMatchScore('庆余年第二季', '庆余年')).toBe(1);
    expect(titleMatchScore('庆余年第二季', '庆余年2')).toBe(1);
  });

  it('续集号冲突 → 0（流浪地球 / 流浪地球2 是两部片）', () => {
    expect(titleMatchScore('流浪地球', '流浪地球2')).toBe(0);
    expect(titleMatches('流浪地球', '流浪地球2')).toBe(false);
  });

  it('titleMatches 按阈值判定', () => {
    expect(titleMatches('庆余年', '庆余年第二季')).toBe(true);
    expect(titleMatches('庆余年', '庆余年第二季', 1)).toBe(true);
    expect(titleMatches('庆余年', '余庆年')).toBe(false);
  });

  it('seasonConflicts 只判「两侧都有季号且不同」', () => {
    expect(seasonConflicts('庆余年第二季', '庆余年第一季')).toBe(true);
    expect(seasonConflicts('庆余年第二季', '庆余年')).toBe(false);
    expect(seasonConflicts('庆余年', '庆余年')).toBe(false);
  });

  it('空片名不匹配任何东西', () => {
    expect(titleMatchScore('', '')).toBe(0);
    expect(titleMatchScore(null, '庆余年')).toBe(0);
    expect(titleMatches('', '庆余年')).toBe(false);
  });
});
