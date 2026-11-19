import { describe, expect, it } from 'vitest';

import { titlePoster } from '@/shared/posterFallback';

/**
 * 标题兜底海报（P2-7）
 *
 * 断言三件事：可离线渲染（data URI）、同一标题恒定、不带演示片单的身份字样。
 * `demoPoster` 里的 `DEMO` / `PUBLIC DOMAIN SAMPLE` 是给内置演示片标身份的，
 * 真实影片套用等于谎称公有领域样片，所以这里显式钉住不能出现。
 */

function svgOf(title: string): string {
  const uri = titlePoster(title);
  expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
  return decodeURIComponent(uri.slice('data:image/svg+xml;charset=utf-8,'.length));
}

describe('titlePoster', () => {
  it('同一标题恒定同一张图（色相不随渲染次数跳）', () => {
    expect(titlePoster('绝命毒师')).toBe(titlePoster('绝命毒师'));
    expect(titlePoster('绝命毒师 第二季')).not.toBe(titlePoster('绝命毒师'));
  });

  it('片名写进图里，且不带演示片单的身份字样', () => {
    const svg = svgOf('庆余年');
    expect(svg).toContain('庆余年');
    expect(svg).not.toContain('DEMO');
    expect(svg).not.toContain('PUBLIC DOMAIN');
  });

  it('2:3 比例、比例值与卡片容器一致', () => {
    const svg = svgOf('某片');
    expect(svg).toContain('width="300" height="450"');
  });

  it('XML 特殊字符转义，不产生畸形 SVG', () => {
    const svg = svgOf('A&B <c> "d"');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&lt;');
    expect(svg).toContain('&gt;');
    expect(svg).toContain('&quot;');
    // 只剩结构自身的标签，片名里的尖括号不会被当元素解析
    expect(svg).not.toMatch(/<c>/);
    expect([...svg.matchAll(/<text/g)].length).toBe([...svg.matchAll(/<\/text>/g)].length);
  });

  it('超长片名折行不超过 3 行，末行以省略号收尾', () => {
    const long = '这部影片的名字非常之长以至于单行完全放不下必须折成好几行来看还得省略号收尾才行';
    // 39 字：最小字号（20）按 3 行也只能铺开 36 字，必须走省略号分支
    expect([...long].length).toBe(39);
    const lines = [...svgOf(long).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines.at(-1)).toMatch(/…$/);
    expect(lines.join('')).toContain('这部影片的名字非常之长');
  });

  it('空标题落到占位文案，不产出无字图', () => {
    expect(svgOf('   ')).toContain('未命名');
  });
});
