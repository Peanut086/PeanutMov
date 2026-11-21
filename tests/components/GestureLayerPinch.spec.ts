/**
 * G-A09 · 捏合与单指手势的互斥接线（GestureLayer 侧）
 *
 * 这一层是"不破坏现有功能"的关键：`pinch` 关掉时事件分发必须和升级前一模一样；
 * 打开时也只能在第二指落下后才接管，并把在飞的单指手势（含长按倍速）撤销干净。
 *
 * 断言只看派发出来的 intent / pinch 事件——几何细节由 recognizer 自己的用例负责。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import GestureLayer from '@/components/player/GestureLayer.vue';
import { usePlayerStore } from '@/stores/playerStore';

function mountLayer(pinch: boolean): VueWrapper {
  const wrapper = mount(GestureLayer, { props: { pinch } });
  wrappers.push(wrapper);
  return wrapper;
}

const wrappers: VueWrapper[] = [];

type Phase = 'down' | 'move' | 'up' | 'cancel';

function fire(wrapper: VueWrapper, phase: Phase, id: number, x: number, y: number): void {
  const map = { down: 'pointerdown', move: 'pointermove', up: 'pointerup', cancel: 'pointercancel' };
  void wrapper.get('.gesture-layer').trigger(map[phase], { pointerId: id, clientX: x, clientY: y });
}

/** 单指横向拖：升级前就是快进手势，必须照常派发 */
function dragRight(wrapper: VueWrapper): void {
  fire(wrapper, 'down', 1, 10, 10);
  fire(wrapper, 'move', 1, 120, 12);
  fire(wrapper, 'move', 1, 240, 14);
  fire(wrapper, 'up', 1, 240, 14);
}

function intents(wrapper: VueWrapper): string[] {
  return wrapper.emitted('intent')?.map((args) => (args[0] as { type: string }).type) ?? [];
}

function samples(wrapper: VueWrapper): Array<[number, string]> {
  return (wrapper.emitted('pinch-sample') ?? []) as Array<[number, string]>;
}

beforeEach(() => {
  setActivePinia(createPinia());
  usePlayerStore().patch({ currentTime: 100, duration: 1000 });
});

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
  vi.useRealTimers();
});

describe('pinch 关掉时行为不变', () => {
  it('单指拖动照常派发快进预览与提交', () => {
    const wrapper = mountLayer(false);
    dragRight(wrapper);
    expect(intents(wrapper)).toEqual(['seek-preview', 'seek-preview', 'seek-commit']);
    expect(wrapper.emitted('pinch-sample')).toBeUndefined();
    expect(wrapper.emitted('pinch-end')).toBeUndefined();
  });

  it('两指落下也不会产生任何捏合事件（识别器照旧忽略第二指）', () => {
    const wrapper = mountLayer(false);
    fire(wrapper, 'down', 1, 0, 0);
    fire(wrapper, 'down', 2, 100, 0);
    fire(wrapper, 'move', 2, 200, 0);
    fire(wrapper, 'up', 2, 200, 0);
    expect(wrapper.emitted('pinch-sample')).toBeUndefined();
    expect(wrapper.emitted('pinch-end')).toBeUndefined();
  });
});

describe('pinch 打开时的分工', () => {
  it('单指拖动仍然是快进，不被捏合抢走', () => {
    const wrapper = mountLayer(true);
    dragRight(wrapper);
    expect(intents(wrapper)).toEqual(['seek-preview', 'seek-preview', 'seek-commit']);
    expect(samples(wrapper)).toHaveLength(0);
  });

  it('第二指落下后才接管，并把单指手势静默掉', () => {
    const wrapper = mountLayer(true);
    fire(wrapper, 'down', 1, 0, 0);
    fire(wrapper, 'down', 2, 100, 0);
    fire(wrapper, 'move', 2, 135, 0);
    fire(wrapper, 'move', 2, 180, 0);
    fire(wrapper, 'up', 2, 180, 0);

    expect(samples(wrapper).map((pair) => pair[1])).toEqual(['cover', 'fill']);
    expect(wrapper.emitted('pinch-end')?.[0]).toEqual(['fill', 1, 'up']);
    // 第一指只是落住就被撤销，不该补出快进提交，也不该在抬手时变成一次单击
    expect(intents(wrapper)).toEqual([]);
  });

  it('在飞的长按倍速必须随着捏合开始而收尾', () => {
    vi.useFakeTimers();
    const wrapper = mountLayer(true);
    fire(wrapper, 'down', 1, 0, 0);
    vi.advanceTimersByTime(500);
    expect(intents(wrapper)).toEqual(['long-press-start']);

    fire(wrapper, 'down', 2, 100, 0);
    expect(intents(wrapper)).toEqual(['long-press-start', 'long-press-end']);
    // 撤销过后，两指抬起不能再补一次单击或快进
    fire(wrapper, 'up', 2, 100, 0);
    fire(wrapper, 'up', 1, 0, 0);
    expect(intents(wrapper)).toEqual(['long-press-start', 'long-press-end']);
  });

  it('pointercancel 也要交回一次取消，让上层还原画面', () => {
    const wrapper = mountLayer(true);
    fire(wrapper, 'down', 1, 0, 0);
    fire(wrapper, 'down', 2, 100, 0);
    fire(wrapper, 'move', 2, 135, 0);
    fire(wrapper, 'cancel', 1, 0, 0);
    expect(wrapper.emitted('pinch-end')?.[0]).toEqual([null, expect.any(Number), 'cancel']);
  });

  it('未越过触发阈值的两指落按不打扰画面，只交回 null', () => {
    const wrapper = mountLayer(true);
    fire(wrapper, 'down', 1, 0, 0);
    fire(wrapper, 'down', 2, 100, 0);
    fire(wrapper, 'move', 2, 102, 0);
    fire(wrapper, 'up', 2, 102, 0);
    expect(samples(wrapper)).toHaveLength(0);
    expect(wrapper.emitted('pinch-end')?.[0]?.[0]).toBeNull();
  });
});
