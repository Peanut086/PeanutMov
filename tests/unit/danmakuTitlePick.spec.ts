/**
 * 弹幕选片判据：片名精度分层 + 年份只在同分池内生效
 *
 * 起因是《士兵突击》整集串到 2013 年那档同名纪实节目上：资源站把 2006 年的电视剧
 * 标成 vod_year=2013，而各源原先「年份命中优先于完全同名」，于是低精度候选被顶上来。
 */
import { describe, expect, it } from 'vitest';

import { pickCandidate, titleMatchScore, type Scored } from '@/services/danmaku/titlePick';
import { seasonOfTitle } from '@/sources/douban/playMatch';

describe('titleMatchScore', () => {
  it('归一化相等记 2 分，剥掉季号/年份/集数后相等记 1 分', () => {
    expect(titleMatchScore('<em>庆余年</em>', '庆余年')).toBe(0); // 标签由调用方先清洗，这里按字面判
    expect(titleMatchScore('庆余年', '庆余年')).toBe(2);
    expect(titleMatchScore('庆余年 第一季', '庆余年')).toBe(1);
    expect(titleMatchScore('士兵突击 第2季', '士兵突击')).toBe(1);
    expect(titleMatchScore('庆余年', '庆余年第二季')).toBe(1);
    expect(titleMatchScore('狂飙 2023', '狂飙')).toBe(1);
  });

  it('主体不同与空串都不算候选', () => {
    expect(titleMatchScore('伪装者2', '伪装者')).toBe(0);
    expect(titleMatchScore('', '伪装者')).toBe(0);
    expect(titleMatchScore('伪装者', '')).toBe(0);
  });
});

describe('pickCandidate', () => {
  function cand(item: string, score: number, year: number | null): Scored & { item: string } {
    return { item, score, year };
  }

  it('年份命中优先于池内顺序', () => {
    const pool = [cand('a', 2, 2019), cand('b', 2, 2024)];
    expect(pickCandidate(pool, 2024)?.item).toBe('b');
  });

  it('年份指向低分候选时不越级采用（本次修复的核心）', () => {
    const pool = [cand('士兵突击 第2季', 1, 2013), cand('士兵突击', 2, 2006)];
    expect(pickCandidate(pool, 2013)).toBeNull();
  });

  it('最高分池内没有年份可校验时按顺序取首条', () => {
    const pool = [cand('甲', 2, null), cand('乙', 2, 2013)];
    expect(pickCandidate(pool, 2013)?.item).toBe('乙');
    expect(pickCandidate([cand('甲', 2, null), cand('丙', 2, null)], 2013)?.item).toBe('甲');
  });

  it('无候选达到精度门槛时返回 null', () => {
    expect(pickCandidate([cand('无关', 0, 2013)], 2013)).toBeNull();
    expect(pickCandidate([], 2013)).toBeNull();
    expect(pickCandidate([cand('甲', 1, null)], null)?.item).toBe('甲');
  });
});

describe('seasonOfTitle', () => {
  it('读季号：阿拉伯数字、中文数字与 Season/Part 写法', () => {
    expect(seasonOfTitle('士兵突击 第2季')).toBe(2);
    expect(seasonOfTitle('庆余年第二季')).toBe(2);
    expect(seasonOfTitle('庆余年 第十一季')).toBe(11);
    expect(seasonOfTitle('流浪地球第二部')).toBe(2);
    expect(seasonOfTitle('西部世界 Season 3')).toBe(3);
  });

  it('不带季号返回 null（单季剧与不带季号同义）', () => {
    expect(seasonOfTitle('士兵突击')).toBeNull();
    expect(seasonOfTitle('士兵突击 2013')).toBeNull();
    expect(seasonOfTitle('士兵突击 第2集')).toBeNull();
  });
});
