import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVirtualGrid } from '@/components/media/useVirtualGrid';
import type { VirtualGridState } from '@/components/media/useVirtualGrid';

/**
 * 长列表虚拟化（P2-13）+ 虚拟网格滚动重算节流（P2-14）
 *
 * 覆盖三个「不真实挂载就看不见」的点：
 * - `rowStride`：直播频道这类单行文本列表，行高与海报比例无关，必须用调用方
 *   量出来的步长，而不是 `列宽 × 3/2 + 标题区`。
 * - `scrollToIndex`：窗口化以后目标行压根不在 DOM 里，先把窗口挪过去才有节点可滚。
 * - 滚动重算合并到每帧一次；但**手工派发**（`isTrusted === false`）必须同帧算完，
 *   否则 LibraryView 恢复滚动位置后的首帧只有占位空白。
 *
 * happy-dom 没有布局，rect 与 `getComputedStyle` 全部桩掉。
 */

const COLS = 2;
const ITEM_COUNT = 200;
const ROW_COUNT = ITEM_COUNT / COLS;
/** 文本行步长：行高 44 + row-gap 8 */
const STRIDE = 52;
const VIEWPORT = 800;
const OVERSCAN = 3;
/** 未滚（offset = 0）时算出的窗口行数；`scrollToIndex` 只平移，跨度不变 */
const WINDOW_ROWS = Math.ceil(VIEWPORT / STRIDE) + OVERSCAN;

interface Row {
  id: string;
}

const items: Row[] = Array.from({ length: ITEM_COUNT }, (_, i) => ({ id: `r${i}` }));

describe('useVirtualGrid 文本行 / 定位 / 滚动节流（P2-13 + P2-14）', () => {
  let grid: HTMLElement;
  let rectCalls = 0;
  let frames: Array<() => void> = [];
  // 上一用例留存的实例仍绑着 document 的 scroll 监听，不回收的话事件会被它们接走
  let wrappers: Array<{ unmount: () => void }> = [];

  /** 页面级滚动下 `rect.top === -scrollTop`；顺便统计 rect 被读了多少次（= 重算次数） */
  function setScrolled(px: number): void {
    grid.getBoundingClientRect = () => {
      rectCalls += 1;
      return {
        top: -px,
        bottom: -px,
        left: 0,
        right: 360,
        width: 360,
        height: 0,
        x: 0,
        y: -px,
        toJSON: () => ({}),
      };
    };
  }

  beforeEach(() => {
    frames = [];
    rectCalls = 0;
    wrappers = [];
    grid = document.createElement('div');
    Object.defineProperty(grid, 'clientWidth', { value: 360, configurable: true });
    document.body.appendChild(grid);
    setScrolled(0);

    const doc = document.documentElement;
    Object.defineProperty(doc, 'scrollHeight', { value: 200_000, configurable: true });
    Object.defineProperty(doc, 'clientHeight', { value: VIEWPORT, configurable: true });
    Object.defineProperty(doc, 'scrollTop', { value: 0, writable: true, configurable: true });

    vi.stubGlobal('getComputedStyle', () => ({
      // 直播频道的 ul 上没有 --layout-grid-columns，走 options.columns() 回退
      getPropertyValue: () => '',
      rowGap: '8px',
      overflowY: 'visible',
    }));
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = [];
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    // 先卸载（走 unbind → cancelAnimationFrame），再撤桩，否则 cancel 会打到真机上
    wrappers.forEach((wrapper) => wrapper.unmount());
    wrappers = [];
    vi.unstubAllGlobals();
    grid.remove();
  });

  /** 真实挂载一个组件，让 onMounted 里的 bind() + recompute() 跑起来 */
  function mountGrid(rowStride: boolean, scrolled = 0): VirtualGridState<Row> {
    setScrolled(scrolled);
    let captured!: VirtualGridState<Row>;
    const Probe = defineComponent({
      setup() {
        captured = useVirtualGrid(() => grid, {
          items: () => items,
          columns: () => COLS,
          paddingX: () => 0,
          showMeta: () => false,
          ...(rowStride ? { rowStride: () => STRIDE } : {}),
        });
        return () => h('div');
      },
    });
    const wrapper = mount(Probe, { attachTo: document.body });
    wrappers.push(wrapper);
    return captured;
  }

  /** 派发一个「手指滑动」产生的 scroll（isTrusted = true） */
  function dispatchTrustedScroll(): void {
    const event = new Event('scroll');
    Object.defineProperty(event, 'isTrusted', { value: true });
    document.dispatchEvent(event);
  }

  it('rowStride 生效：占位按文本行步长累加', () => {
    const state = mountGrid(true, STRIDE * 20);

    expect(state.active.value).toBe(true);
    // offset = 1040 → 第 20 行 → 上探 3 行 overscan
    expect(state.padTop.value).toBe((20 - OVERSCAN) * STRIDE);
    expect(state.startIndex.value).toBe((20 - OVERSCAN) * COLS);
  });

  it('不给 rowStride 时仍按海报公式算步长（既有海报墙不受影响）', () => {
    // 步长 = 列宽 174 × 1.5 + 裸卡标题区 22 + row-gap 8 = 291
    const posterStride = ((360 - 12 * (COLS - 1)) / COLS) * 1.5 + 22 + 8;
    const state = mountGrid(false, STRIDE * 20);

    // 同样滚 1040px：文本步长已到第 20 行，291px 的海报步长才第 3 行 → 减 overscan 归 0
    expect(posterStride).not.toBe(STRIDE);
    expect(state.padTop.value).toBe(0);
    expect(state.padBottom.value).toBe((ROW_COUNT - 10) * posterStride);
  });

  it('scrollToIndex 把目标条目挪进窗口，且上下都还留占位', async () => {
    const state = mountGrid(true);

    expect(state.startIndex.value).toBe(0);
    expect(state.visibleItems.value.some((row) => row.id === 'r100')).toBe(false);

    await state.scrollToIndex(100);

    const first = state.startIndex.value;
    expect(first).toBeLessThanOrEqual(100);
    expect(first + state.visibleItems.value.length).toBeGreaterThan(100);
    // 接着的 scrollIntoView 要有的可滚，窗口不能被顶到任一尽头
    expect(state.padTop.value).toBeGreaterThan(0);
    expect(state.padBottom.value).toBeGreaterThan(0);
  });

  it('scrollToIndex 定位到底部时不越界', async () => {
    const state = mountGrid(true);
    await state.scrollToIndex(ITEM_COUNT - 1);

    expect(state.startIndex.value + state.visibleItems.value.length).toBeLessThanOrEqual(ITEM_COUNT);
    expect(state.visibleItems.value.some((row) => row.id === `r${ITEM_COUNT - 1}`)).toBe(true);
    expect(state.padBottom.value).toBe(0);
  });

  it('scrollToIndex 只平移窗口，不放大渲染量', async () => {
    const state = mountGrid(true);
    const before = state.visibleItems.value.length;
    await state.scrollToIndex(120);

    expect(before).toBe(WINDOW_ROWS * COLS);
    expect(state.visibleItems.value.length).toBe(before);
  });

  it('真实滚动：一帧内的多次 scroll 只重算一次', () => {
    const state = mountGrid(true);
    const afterMount = rectCalls;
    expect(state.active.value).toBe(true);

    for (let i = 0; i < 6; i += 1) dispatchTrustedScroll();

    expect(frames).toHaveLength(1);
    expect(rectCalls).toBe(afterMount);

    frames[0]?.();
    expect(rectCalls).toBeGreaterThan(afterMount);
  });

  it('手工派发的 scroll（isTrusted = false）同帧算完，不进 rAF', () => {
    mountGrid(true);
    const afterMount = rectCalls;

    document.dispatchEvent(new Event('scroll'));

    expect(frames).toHaveLength(0);
    expect(rectCalls).toBeGreaterThan(afterMount);
  });

  it('合并到帧里的那次重算读的是最新滚动位置', () => {
    const state = mountGrid(true);
    expect(state.padTop.value).toBe(0);

    setScrolled(STRIDE * 30);
    for (let i = 0; i < 4; i += 1) dispatchTrustedScroll();
    frames[0]?.();

    expect(state.padTop.value).toBe((30 - OVERSCAN) * STRIDE);
  });

  it('网格节点挂载后才出现（加载态）时补绑滚动源并启用窗口', async () => {
    // 直播页的 <ul> 在 v-else 链后面：channelsLoading 期间压根没有这个节点
    const elRef = ref<HTMLElement | null>(null);
    let captured!: VirtualGridState<Row>;
    const Probe = defineComponent({
      setup() {
        captured = useVirtualGrid(() => elRef.value, {
          items: () => items,
          columns: () => COLS,
          paddingX: () => 0,
          showMeta: () => false,
          rowStride: () => STRIDE,
        });
        return () => h('div');
      },
    });
    const wrapper = mount(Probe, { attachTo: document.body });
    wrappers.push(wrapper);

    expect(captured.active.value).toBe(false);

    elRef.value = grid;
    await nextTick();

    expect(captured.active.value).toBe(true);
    expect(captured.visibleItems.value.length).toBe(WINDOW_ROWS * COLS);

    // 补绑之后真实滚动才有人接：否则窗口永远停在第一屏
    frames = [];
    const before = rectCalls;
    dispatchTrustedScroll();
    expect(frames).toHaveLength(1);
    frames[0]?.();
    expect(rectCalls).toBeGreaterThan(before);
  });
});
