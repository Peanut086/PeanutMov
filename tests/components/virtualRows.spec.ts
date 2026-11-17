import { describe, expect, it } from 'vitest';

import { computeWindow } from '../../src/components/media/useVirtualRows';

describe('computeWindow（固定行高虚拟滚动窗口）', () => {
  it('空列表返回空窗口', () => {
    expect(computeWindow(0, 600, 0, 24, 10)).toEqual({ start: 0, end: 0 });
  });

  it('非法参数返回空窗口', () => {
    expect(computeWindow(0, 0, 100, 24, 10)).toEqual({ start: 0, end: 0 });
    expect(computeWindow(0, 600, 100, 0, 10)).toEqual({ start: 0, end: 0 });
  });

  it('顶部：窗口从 0 开始，含向下 overscan', () => {
    const w = computeWindow(0, 600, 1000, 24, 10);
    expect(w.start).toBe(0);
    expect(w.end).toBe(Math.ceil(600 / 24) + 10);
  });

  it('中部：窗口按 scrollTop 平移并带两侧 overscan', () => {
    // scrollTop=2400 → 首可见行 100
    const w = computeWindow(2400, 480, 1000, 24, 10);
    expect(w.start).toBe(90);
    expect(w.end).toBe(130);
  });

  it('底部：end 封顶到 count，不越界', () => {
    const w = computeWindow(999999, 600, 50, 24, 10);
    expect(w.start).toBe(0);
    expect(w.end).toBe(50);
  });

  it('行数少于视口：全量渲染', () => {
    const w = computeWindow(0, 600, 5, 24, 10);
    expect(w.start).toBe(0);
    expect(w.end).toBe(5);
  });
});
