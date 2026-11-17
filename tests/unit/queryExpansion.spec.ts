/**
 * 查询扩展纯函数单测（SO-ALIAS 基础层）
 *
 * 重点口径：去重是**字面等价**判定——季号写法互转（第八季↔S8）正是要产出的目标，
 * 不能被 normalizeTitleKey 的同形结论误杀；续集号（流浪地球2）没有季号语义，绝不互转。
 */
import { describe, expect, it } from 'vitest';

import {
  canonicalizeQuery,
  expansionCandidates,
  parseRomanNumber,
  parseSeasonOf,
  seasonFormVariants,
} from '@/services/queryExpansion';

describe('canonicalizeQuery', () => {
  it('全半角、包裹标点与多余空白统一', () => {
    expect(canonicalizeQuery('《庆余年　第八季》')).toBe('庆余年 第八季');
    expect(canonicalizeQuery('Ｓ８')).toBe('S8');
  });
});

describe('parseRomanNumber', () => {
  it('罗马与阿拉伯均可解析', () => {
    expect(parseRomanNumber('VIII')).toBe(8);
    expect(parseRomanNumber('xiv')).toBe(14);
    expect(parseRomanNumber('12')).toBe(12);
    expect(parseRomanNumber('')).toBeNull();
    expect(parseRomanNumber('abc')).toBeNull();
    expect(parseRomanNumber('iiix')).toBe(11); // 减记折算：i+i+(x-i)
  });
});

describe('seasonFormVariants / parseSeasonOf', () => {
  it('中文季号 → S/阿拉伯形态（字面不同即产出）', () => {
    const variants = seasonFormVariants('庆余年 第八季');
    expect(variants).toContain('庆余年S8');
    // 「第8季」与「第八季」字面不同（8≠八），对源站就是另一个查询——同样是有效扩展
    expect(variants).toContain('庆余年第8季');
    expect(parseSeasonOf('庆余年 第八季')).toBe(8);
  });

  it('S/Season 形态 → 中文季号', () => {
    expect(seasonFormVariants('权游S8')).toContain('权游第8季');
    expect(seasonFormVariants('权力的游戏 Season IX')).toContain('权力的游戏第9季');
    expect(parseSeasonOf('权游S8')).toBe(8);
  });

  it('裸数字是续集号不是季号：不猜、不互转', () => {
    expect(seasonFormVariants('流浪地球2')).toEqual([]);
    expect(parseSeasonOf('流浪地球2')).toBeNull();
    expect(seasonFormVariants('三体')).toEqual([]);
  });

  it('片名根太短（单字）不产出', () => {
    expect(seasonFormVariants('S8')).toEqual([]);
  });
});

describe('expansionCandidates', () => {
  it('别名在前、季号互转在后，且与字面等价的原词剔除', () => {
    const out = expansionCandidates('庆余年 第八季', ['庆余年 第二季', '庆余年 第八季']);
    expect(out[0]).toBe('庆余年 第二季');
    expect(out).not.toContain('庆余年 第八季');
    // 默认 limit=2：第二条给季号互转，S8 形态要第三席才轮到
    expect(out[1]).toBe('庆余年第8季');
    expect(expansionCandidates('庆余年 第八季', ['庆余年 第二季'], 3)).toContain('庆余年S8');
  });

  it('别名不带季号而原词带季号时，把季号贴回去', () => {
    expect(expansionCandidates('权游S8', ['权力的游戏'])).toEqual(['权力的游戏第8季', '权游第8季']);
  });

  it('limit 生效且彼此去重', () => {
    const out = expansionCandidates('庆余年 第八季', ['庆余年 第二季', '庆余年 第三季', '庆余年 第四季'], 2);
    expect(out).toHaveLength(2);
    expect(new Set(out).size).toBe(2);
  });

  it('全空输入不炸', () => {
    expect(expansionCandidates('', [])).toEqual([]);
    expect(expansionCandidates('《》', [])).toEqual([]);
  });
});
