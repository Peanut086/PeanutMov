import { describe, expect, it } from 'vitest';

import { deriveVars, paletteForPoster, rgbToHsl, type PaletteSeed } from '@/services/paletteService';

/**
 * 动态取色的对比度护栏（设计规范 §9 / AC-87 同一口径）：
 * 海报销出什么主色都可以，但落到文字级用途时必须满足 WCAG AA，
 * 否则详情页/播放页的染色会把可读性换成了好看。
 */

type Rgb = [number, number, number];

const DARK_BG: Rgb = [0, 0, 0];
const LIGHT_BG: Rgb = [237, 239, 243];

function hexToRgb(hex: string): Rgb {
  const body = hex.replace('#', '');
  return [
    parseInt(body.slice(0, 2), 16),
    parseInt(body.slice(2, 4), 16),
    parseInt(body.slice(4, 6), 16),
  ];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = (c: [number, number, number]): number =>
    0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  const ch = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const SEEDS: PaletteSeed[] = [
  { h: 4, s: 0.72, l: 0.42 }, // 红
  { h: 42, s: 0.9, l: 0.62 }, // 亮黄
  { h: 130, s: 0.45, l: 0.3 }, // 绿
  { h: 205, s: 0.85, l: 0.5 }, // 蓝
  { h: 280, s: 0.6, l: 0.36 }, // 紫
  { h: 320, s: 0.2, l: 0.7 }, // 低饱和粉（会被保底拉饱和）
];

describe('paletteService · 角色色派生', () => {
  it('文字级品牌色在深色底上满足 AA（≥4.5:1）', () => {
    for (const seed of SEEDS) {
      const vars = deriveVars(seed, DARK_BG);
      const text = hexToRgb(vars['--color-brand-text']!);
      expect(contrast(text, DARK_BG), `h=${seed.h} ${vars['--color-brand-text']}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('文字级品牌色在浅色底上满足 AA（≥4.5:1）', () => {
    for (const seed of SEEDS) {
      const vars = deriveVars(seed, LIGHT_BG);
      const text = hexToRgb(vars['--color-brand-text']!);
      expect(contrast(text, LIGHT_BG), `h=${seed.h} ${vars['--color-brand-text']}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('填充色上的反色文字取对比度更高的方向', () => {
    for (const seed of SEEDS) {
      for (const bg of [DARK_BG, LIGHT_BG]) {
        const vars = deriveVars(seed, bg);
        const fill = hexToRgb(vars['--color-brand']!);
        const ink = hexToRgb(vars['--color-brand-ink']!);
        const best = Math.max(contrast([255, 255, 255], fill), contrast([23, 15, 0], fill));
        expect(contrast(ink, fill), `h=${seed.h} ink=${vars['--color-brand-ink']}`).toBeGreaterThanOrEqual(best - 0.01);
      }
    }
  });

  it('只覆盖品牌族变量，中性色不动', () => {
    const vars = deriveVars(SEEDS[3]!, DARK_BG);
    expect(Object.keys(vars).every((key) => key.includes('brand') || key === '--shadow-focus')).toBe(true);
    expect(vars['--color-bg-base']).toBeUndefined();
    expect(vars['--color-text-primary']).toBeUndefined();
  });

  it('派生出的颜色格式可被 CSS 直接消费', () => {
    const vars = deriveVars(SEEDS[1]!, LIGHT_BG);
    for (const key of ['--color-brand', '--color-brand-strong', '--color-brand-press', '--color-brand-text']) {
      expect(vars[key]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(vars['--color-brand-soft']).toMatch(/^rgba\(/);
    expect(vars['--gradient-brand']).toContain('linear-gradient(135deg');
  });

  it('rgbToHsl 用标准 HSL 饱和度（笔误会让暗调海报被主色门槛整批滤掉）', () => {
    expect(rgbToHsl(0, 255, 0)).toMatchObject({ h: 120, s: 1, l: 0.5 });
    expect(rgbToHsl(255, 255, 255)).toMatchObject({ h: 0, s: 0, l: 1 });
    expect(rgbToHsl(128, 128, 128).s).toBe(0);
    const forest = rgbToHsl(51, 127, 51);
    expect(forest.h).toBeCloseTo(120, 0);
    expect(forest.l).toBeCloseTo(0.349, 3);
    expect(forest.s).toBeCloseTo(0.427, 3);
  });

  it('灰调与非法 URL 不染色', async () => {
    await expect(paletteForPoster(null)).resolves.toBeNull();
    await expect(paletteForPoster('')).resolves.toBeNull();
    await expect(paletteForPoster('magnet:?xt=urn:btih:abc')).resolves.toBeNull();
    await expect(paletteForPoster('ftp://example.com/a.jpg')).resolves.toBeNull();
  });
});
