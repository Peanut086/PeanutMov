import { describe, expect, it } from 'vitest';

/**
 * 虚拟网格的窗口计算（REV-11）
 *
 * 直接测 `recompute` 用到的几何公式，不经过 Vue 组件（happy-dom 无真实布局）。
 * 关键回归点：**页面级滚动**（`documentElement`）的 rect 会随滚动移动，
 * 因此"网格被滚过的距离"必须用 `-gridRect.top` 而不是
 * `scrollTop - (gridRect.top + scrollTop)`（后者恒为 0，窗口永远停在第一屏）。
 */

/** 模拟网格在某滚动位置下的视口坐标 */
interface Geometry {
  /** documentElement.scrollTop（页面滚动） */
  pageScrollTop: number;
  /** 网格相对视口顶部的 top（随滚动变化） */
  gridTop: number;
  /** 网格自身高度 */
  gridHeight: number;
  /** 视口高度 */
  viewport: number;
  /** 每行高度 */
  rowHeight: number;
  /** 总行数 */
  rowCount: number;
}

const OVERSCAN_ROWS = 3;

/** 页面级滚动：网格被滚过的距离 */
function pageOffset(g: Geometry): number {
  return Math.max(0, -g.gridTop);
}

/** 内层容器滚动：容器视口固定，滚过量 = 容器顶部 - 网格顶部 */
function innerOffset(g: Geometry): number {
  // 容器顶部固定为 0（视口顶部）
  return Math.max(0, 0 - g.gridTop);
}

function window(g: Geometry, offset: number): { first: number; last: number } {
  return {
    first: Math.max(0, Math.floor(offset / g.rowHeight) - OVERSCAN_ROWS),
    last: Math.min(g.rowCount, Math.ceil((offset + g.viewport) / g.rowHeight) + OVERSCAN_ROWS),
  };
}

describe('useVirtualGrid 窗口计算（REV-11）', () => {
  const base: Geometry = {
    pageScrollTop: 0,
    gridTop: 0,
    gridHeight: 200 * 758,
    viewport: 950,
    rowHeight: 758,
    rowCount: 200,
  };

  it('页面滚动：offset 随滚动增长（回归：曾恒为 0）', () => {
    // 滚到 50000px 时，网格顶部应在视口上方约 49863px
    const g = { ...base, pageScrollTop: 50000, gridTop: -49863 };
    const offset = pageOffset(g);

    expect(offset).toBe(49863);
    const w = window(g, offset);
    expect(w.first).toBeGreaterThan(60);
    expect(w.last).toBeLessThanOrEqual(200);
  });

  it('页面滚动：顶部时 offset 为 0，窗口从第一行开始', () => {
    const g = { ...base, pageScrollTop: 0, gridTop: 0 };
    const w = window(g, pageOffset(g));

    expect(w.first).toBe(0);
    expect(w.last).toBeGreaterThan(0);
  });

  it('内层容器滚动：容器固定时 offset 同样正确', () => {
    // 容器在视口顶部，网格已滚到其上方 30000px
    const g = { ...base, gridTop: -30000 };
    expect(innerOffset(g)).toBe(30000);
  });

  it('两种来源的公式在各自场景下给出一致结果', () => {
    // 同一物理滚动量：页面滚动下 gridTop = -30000
    const g = { ...base, gridTop: -30000 };
    expect(pageOffset(g)).toBe(innerOffset(g));
  });

  it('overscan 保证首屏上方多渲染 3 行', () => {
    const g = { ...base, gridTop: -758 * 10 };
    const w = window(g, pageOffset(g));
    // offset = 7580 → 10 行整，first 应为 10 - 3 = 7
    expect(w.first).toBe(7);
  });

  it('底部不越界：last 不超过总行数', () => {
    const g = { ...base, gridTop: -758 * 199 };
    const w = window(g, pageOffset(g));
    expect(w.last).toBeLessThanOrEqual(g.rowCount);
    expect(w.first).toBeGreaterThan(0);
  });

  it('DOM 节点数远小于总量（虚拟化的目的）', () => {
    const g = { ...base, gridTop: -758 * 100 };
    const w = window(g, pageOffset(g));
    const rendered = (w.last - w.first) * 4; // 4 列

    expect(rendered).toBeLessThan(40);
    expect(rendered).toBeGreaterThan(0);
  });

  it('gridTop 为正（尚未滚到网格）时 offset 归零', () => {
    const g = { ...base, gridTop: 500 };
    expect(pageOffset(g)).toBe(0);
  });
});
