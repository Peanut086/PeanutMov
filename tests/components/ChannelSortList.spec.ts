/**
 * 频道排序列表（ChannelSortList）单测 —— EXT-06 P1 复审整改
 *
 * - REV-24：长按阈值 500ms（380ms 不激活）；超限提示文案固定为
 *   「当前分组频道过多（n），请先按分组筛选」
 * - REV-25：拖拽期只维护 dragKey + targetIndex，靠 transform 位移；
 *   指针移动不再重建整表，松手只 emit 一次 reorder
 * - REV-34：`reorder` 第二参携带来源（`drag` / `button`），供调用方决定是否合并提示
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ChannelSortList from '@/components/live/ChannelSortList.vue';
import { CHANNEL_ORDER_MAX } from '@/shared/constants';

const ROW_STEP = 48;

function makeItems(count: number): Array<{ key: string; name: string }> {
  return Array.from({ length: count }, (_, index) => ({
    key: `k${index}`,
    name: `频道 ${index + 1}`,
  }));
}

const wrappers: VueWrapper[] = [];

function mountList(count = 3): VueWrapper {
  const wrapper = mount(ChannelSortList, { props: { items: makeItems(count) } });
  wrappers.push(wrapper);
  return wrapper;
}

/** 给每行铺一个确定的行高（happy-dom 无布局，getBoundingClientRect 恒为 0） */
function stubRowGeometry(wrapper: VueWrapper): void {
  const rows = wrapper.findAll('[data-row]');
  rows.forEach((row, index) => {
    const top = index * ROW_STEP;
    row.element.getBoundingClientRect = () =>
      ({
        top,
        bottom: top + ROW_STEP - 4,
        height: ROW_STEP - 4,
        left: 0,
        right: 320,
        width: 320,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

function pointerDown(row: Element, clientY = 0): void {
  row.dispatchEvent(
    new PointerEvent('pointerdown', { clientY, bubbles: true, cancelable: true, button: 0 }),
  );
}

function pointerMove(clientY: number): void {
  window.dispatchEvent(new PointerEvent('pointermove', { clientY, bubbles: true }));
}

function pointerUp(): void {
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  // rAF 立即执行，等价于「下一帧只算一次位移」
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('REV-24：长按阈值与超限提示', () => {
  it('380ms 只按下不激活；500ms 才进入拖拽态', async () => {
    const wrapper = mountList(3);
    stubRowGeometry(wrapper);
    const firstRow = wrapper.findAll('[data-row]')[0]!;

    pointerDown(firstRow.element);
    vi.advanceTimersByTime(380);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.sort-list__row--active')).toHaveLength(0);

    vi.advanceTimersByTime(120);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.sort-list__row--active')).toHaveLength(1);

    pointerUp();
    await wrapper.vm.$nextTick();
  });

  it('超过 CHANNEL_ORDER_MAX 时提示「当前分组频道过多（n），请先按分组筛选」', () => {
    const count = CHANNEL_ORDER_MAX + 1;
    const wrapper = mountList(count);
    const warn = wrapper.find('.sort-list__warn');
    expect(warn.exists()).toBe(true);
    expect(warn.text()).toBe(`当前分组频道过多（${count}），请先按分组筛选`);
    expect(wrapper.find('.sort-list__hint').exists()).toBe(false);
  });
});

describe('REV-25：拖拽只改 transform，松手只提交一次', () => {
  it('指针移动不重建列表；被拖行与相邻行只改 transform，reorder 只发一次', async () => {
    const wrapper = mountList(3);
    stubRowGeometry(wrapper);
    const rows = wrapper.findAll('[data-row]');

    pointerDown(rows[0]!.element);
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('.sort-list__row--active')).toHaveLength(1);

    // 往下拖到第 3 行（clientY 落在 index 2 的区间内）
    pointerMove(ROW_STEP * 2 + 5);
    await wrapper.vm.$nextTick();

    // 拖拽中数组顺序不变（DOM 文本仍是原序）
    expect(wrapper.findAll('.sort-list__name').map((node) => node.text())).toEqual([
      '频道 1',
      '频道 2',
      '频道 3',
    ]);
    // 只改 transform：被拖行下移两格，中间两行上移一格
    expect(wrapper.findAll('[data-row]')[0]!.attributes('style')).toContain(
      `translateY(${2 * ROW_STEP}px)`,
    );
    expect(wrapper.findAll('[data-row]')[1]!.attributes('style')).toContain(
      `translateY(${-ROW_STEP}px)`,
    );
    // 移动过程中不发 reorder
    expect(wrapper.emitted('reorder')).toBeUndefined();

    pointerUp();
    await wrapper.vm.$nextTick();

    const emitted = wrapper.emitted('reorder');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![0]).toEqual(['k1', 'k2', 'k0']);
    // 松手后位移清空
    expect(wrapper.findAll('[data-row]')[0]!.attributes('style') ?? '').not.toContain(
      'translateY',
    );
  });

  it('松手时落点未变 → 不发 reorder', async () => {
    const wrapper = mountList(3);
    stubRowGeometry(wrapper);
    pointerDown(wrapper.findAll('[data-row]')[0]!.element);
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    pointerUp();
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('reorder')).toBeUndefined();
  });
});

describe('REV-34：reorder 携带来源', () => {
  it('拖拽松手 → origin = drag', async () => {
    const wrapper = mountList(3);
    stubRowGeometry(wrapper);

    pointerDown(wrapper.findAll('[data-row]')[0]!.element);
    vi.advanceTimersByTime(500);
    await wrapper.vm.$nextTick();
    pointerMove(ROW_STEP * 2 + 5);
    await wrapper.vm.$nextTick();
    pointerUp();
    await wrapper.vm.$nextTick();

    const emitted = wrapper.emitted('reorder');
    expect(emitted).toHaveLength(1);
    expect(emitted![0]![1]).toBe('drag');
  });

  it('↑ / ↓ 按钮 → origin = button（每次点击各自发一次，由调用方合并）', async () => {
    const wrapper = mountList(3);
    const downButtons = wrapper.findAll('.sort-list__btn').filter((btn) => btn.text() === '↓');

    await downButtons[0]!.trigger('click');
    await downButtons[0]!.trigger('click');

    const emitted = wrapper.emitted('reorder');
    expect(emitted).toHaveLength(2);
    expect(emitted![0]![1]).toBe('button');
    expect(emitted![1]![1]).toBe('button');
    expect(emitted![0]![0]).toEqual(['k1', 'k0', 'k2']);
  });
});
