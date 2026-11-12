import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVirtualGrid } from '@/components/media/useVirtualGrid';
import type { MediaItem } from '@/types';

/**
 * 行步长必须包含 row-gap（A3 回归）
 *
 * 既有 virtualGridWindow.spec 只验算窗口公式、把 rowHeight 当已知量传入，
 * 因此漏掉了 `computeRowHeight` 少算行间距的缺陷：占位高度按行步长累加，
 * 每行少 16~20px，超过 40 行后累积成数百 px 的滚动漂移。
 * 这里直接驱动真实 composable，断言 padTop/padBottom 的绝对像素值。
 */

const COLUMNS = 2;
const COLUMN_GAP = 12;
const ROW_GAP = 16;
const GRID_WIDTH = 360;
const META_EXTRA = 46;
const VIEWPORT = 800;
const ITEM_COUNT = 200;

/** 列宽 = (净宽 - 列间距) / 列数；行步长 = 列宽 * 1.5 + 标题区 + 行间距 */
const COLUMN_WIDTH = (GRID_WIDTH - COLUMN_GAP * (COLUMNS - 1)) / COLUMNS;
const ROW_STEP = COLUMN_WIDTH * 1.5 + META_EXTRA + ROW_GAP;
const ROW_COUNT = ITEM_COUNT / COLUMNS;

function makeItems(count: number): MediaItem[] {
  return Array.from({ length: count }, (_, i) => ({ id: `m${i}` }) as MediaItem);
}

describe('useVirtualGrid 行步长含 row-gap（A3）', () => {
  let grid: HTMLElement;
  let items: MediaItem[];

  beforeEach(() => {
    items = makeItems(ITEM_COUNT);
    grid = document.createElement('div');
    document.body.appendChild(grid);

    Object.defineProperty(grid, 'clientWidth', { value: GRID_WIDTH, configurable: true });
    grid.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: GRID_WIDTH, height: 0, x: 0, y: 0, toJSON: () => ({}) });

    const doc = document.documentElement;
    Object.defineProperty(doc, 'scrollHeight', { value: 200_000, configurable: true });
    Object.defineProperty(doc, 'clientHeight', { value: VIEWPORT, configurable: true });
    Object.defineProperty(doc, 'scrollTop', { value: 0, writable: true, configurable: true });

    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => {
        if (name === '--layout-grid-columns') return String(COLUMNS);
        if (name === '--layout-grid-gap') return `${COLUMN_GAP}px`;
        return '';
      },
      rowGap: `${ROW_GAP}px`,
      overflowY: 'visible',
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    grid.remove();
  });

  function setup(scrollTop = 0) {
    document.documentElement.scrollTop = scrollTop;
    grid.getBoundingClientRect = () => ({ top: -scrollTop, bottom: 0, left: 0, right: 0, width: GRID_WIDTH, height: 0, x: 0, y: -scrollTop, toJSON: () => ({}) });
    const state = useVirtualGrid(() => grid, {
      items: () => items,
      columns: () => COLUMNS,
      paddingX: () => 0,
      showMeta: () => true,
    });
    state.refresh();
    return state;
  }

  it('顶部未滚动时 padBottom 按含 gap 的行步长累加', () => {
    const state = setup(0);
    const last = Math.min(ROW_COUNT, Math.ceil(VIEWPORT / ROW_STEP) + 3);

    expect(state.active.value).toBe(true);
    expect(state.padTop.value).toBe(0);
    expect(state.padBottom.value).toBe((ROW_COUNT - last) * ROW_STEP);
  });

  it('滚动 10 行后 padTop 精确等于 10-3 行步长（漏 gap 会偏小）', () => {
    const state = setup(ROW_STEP * 10);

    expect(state.padTop.value).toBe(7 * ROW_STEP);
    // 漏算 gap 的旧实现会得到 7 * (ROW_STEP - ROW_GAP)
    expect(state.padTop.value).not.toBe(7 * (ROW_STEP - ROW_GAP));
  });

  it('占位总高 + 窗口内容高 = N 行内容 + (N-1) 个行间距', () => {
    const state = setup(ROW_STEP * 20);
    const renderedRows = state.visibleItems.value.length / COLUMNS;
    const contentHeight = COLUMN_WIDTH * 1.5 + META_EXTRA;
    const total =
      state.padTop.value +
      (renderedRows * contentHeight + (renderedRows - 1) * ROW_GAP) +
      state.padBottom.value;

    expect(total).toBe(ROW_COUNT * contentHeight + (ROW_COUNT - 1) * ROW_GAP);
  });

  it('rowGap 为 normal（无行间距）时不引入 NaN', () => {
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => {
        if (name === '--layout-grid-columns') return String(COLUMNS);
        if (name === '--layout-grid-gap') return `${COLUMN_GAP}px`;
        return '';
      },
      rowGap: 'normal',
      overflowY: 'visible',
    }));
    const state = setup(0);

    expect(Number.isFinite(state.padBottom.value)).toBe(true);
    expect(state.padBottom.value).toBeGreaterThan(0);
  });
});