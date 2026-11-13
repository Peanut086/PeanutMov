import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import BottomSheet from '@/components/common/BottomSheet.vue';
import { pressBackButton, setBackFallback } from '@/native/appLifecycle';

/**
 * 底部弹层拖拽释放（A 批次·A-02）
 *
 * - 未达阈值：位移交给弹簧逐帧积分，**不是**立刻归零，也不再挂固定时长的 CSS 过渡
 * - 阈值判定不变：位移 > 96px 或 释放速度 > 0.5px/ms 走关闭
 * - 重新按下要掐掉进行中的弹簧，不让两条曲线抢同一个位移
 */

let queue: Array<(now: number) => void> = [];
let clock = 0;
/** 每个用例挂上的弹层：afterEach 统一卸载，避免残留组件继续占住返回键总线 */
const mounted = new Set<{ unmount: () => void }>();

/** 手动推进 rAF；真实时长由 fake timers 管，这里只喂帧 */
function pump(frames: number): void {
  for (let i = 0; i < frames; i++) {
    clock += 16;
    const pending = queue;
    queue = [];
    pending.forEach((cb) => cb(clock));
  }
}

function offsetOf(wrapper: VueWrapper): { transform: string; style: string } {
  const style = wrapper.get('.sheet').element.getAttribute('style') ?? '';
  const matched = /translateY\(([-\d.]+)px\)/.exec(style);
  return { transform: matched?.[1] ?? '', style };
}

async function mountAndOpen(): Promise<VueWrapper> {
  const wrapper = mount(BottomSheet, {
    props: { modelValue: true, title: '选集' },
    global: { stubs: { Teleport: true } },
  });
  mounted.add(wrapper);
  await wrapper.vm.$nextTick();
  return wrapper;
}

function handleOf(wrapper: VueWrapper): Element {
  return wrapper.get('.sheet__handle-area').element;
}

function pointer(el: Element, type: string, clientY: number): void {
  el.dispatchEvent(new PointerEvent(type, { clientY, bubbles: true, cancelable: true, pointerId: 1 }));
}

/** 从 100px 处按住，拖到 `toY`，停留 `holdMs` 后松手 */
async function dragAndRelease(wrapper: VueWrapper, toY: number, holdMs: number): Promise<void> {
  const handle = handleOf(wrapper);
  pointer(handle, 'pointerdown', 100);
  pointer(handle, 'pointermove', toY);
  vi.advanceTimersByTime(holdMs);
  pointer(handle, 'pointerup', toY);
  await wrapper.vm.$nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  queue = [];
  clock = 0;
  // toFake 里不放 requestAnimationFrame：帧由 pump 手动喂，否则会被 sinon 接管
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });
});

afterEach(() => {
  // 先卸载再撤桩：unmount 会走 cancelAnimationFrame 掐弹簧
  for (const wrapper of [...mounted].reverse()) wrapper.unmount();
  mounted.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BottomSheet 拖拽释放', () => {
  it('未达阈值松手：位移逐帧回到停靠位，而不是瞬间归零', async () => {
    const wrapper = await mountAndOpen();
    await dragAndRelease(wrapper, 140, 200);

    // 松手第一帧仍带着位移（弹簧在跑），且没停在原地
    const released = offsetOf(wrapper);
    expect(Number(released.transform)).toBeGreaterThan(0);

    pump(1);
    await wrapper.vm.$nextTick();
    const one = Number(offsetOf(wrapper).transform);
    expect(one).toBeLessThan(Number(released.transform));

    pump(80);
    await wrapper.vm.$nextTick();
    expect(offsetOf(wrapper).transform).toBe('');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('回弹期间不挂 CSS transition，避免和积分器抢同一条曲线', async () => {
    const wrapper = await mountAndOpen();
    await dragAndRelease(wrapper, 140, 200);
    expect(offsetOf(wrapper).style).toContain('transition: none');
  });

  it('快甩（位移未到 96px 但速度过阈值）仍然关闭，阈值判定未变', async () => {
    const wrapper = await mountAndOpen();
    await dragAndRelease(wrapper, 130, 20);

    vi.advanceTimersByTime(220);
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('拖过 96px 关闭', async () => {
    const wrapper = await mountAndOpen();
    await dragAndRelease(wrapper, 240, 400);

    vi.advanceTimersByTime(220);
    await wrapper.vm.$nextTick();
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('再次按下打断进行中的弹簧：位移只跟手指', async () => {
    const wrapper = await mountAndOpen();
    await dragAndRelease(wrapper, 160, 200);
    pump(2);

    const handle = handleOf(wrapper);
    pointer(handle, 'pointerdown', 200);
    pointer(handle, 'pointermove', 224);
    await wrapper.vm.$nextTick();
    const grabbed = offsetOf(wrapper);
    expect(grabbed.transform).toBe('24');

    pump(20);
    await wrapper.vm.$nextTick();
    expect(offsetOf(wrapper).style).toBe(grabbed.style);
  });
});

/**
 * 硬件返回键（P3-17）
 *
 * 弹层过去只认 Esc 与遮罩：Android 的物理返回键直接落到路由上，用户离开页面，
 * 而弹层还挂在 body 上等下一次响应。这里验的是「挂上总线 / 关闭即摘 / 叠层只退一层」。
 *
 * 注册在 `watch(() => props.modelValue)` 里（非 immediate），所以必须**先挂闭再翻成开**，
 * 直接用上面 `mountAndOpen` 那样以 open 状态挂载是走不到注册的。
 */
async function mountByOpening(): Promise<VueWrapper> {
  const wrapper = mount(BottomSheet, {
    props: { modelValue: false, title: '选集' },
    global: { stubs: { Teleport: true } },
  });
  mounted.add(wrapper);
  await wrapper.setProps({ modelValue: true });
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe('BottomSheet 返回键总线', () => {
  afterEach(() => {
    setBackFallback(null);
  });

  it('打开时返回键关闭弹层并消费本次返回', async () => {
    const wrapper = await mountByOpening();

    expect(pressBackButton()).toBe(true);
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([false]);
  });

  it('关闭后摘掉监听，返回键交回路由兜底', async () => {
    const wrapper = await mountByOpening();
    pressBackButton();
    await wrapper.setProps({ modelValue: false });

    const fallback = vi.fn(() => true);
    setBackFallback(fallback);
    expect(pressBackButton()).toBe(true);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('叠两层只关最上面那层，不会一次穿回页面本体', async () => {
    const under = await mountByOpening();
    const over = await mountByOpening();

    expect(pressBackButton()).toBe(true);
    expect(over.emitted('update:modelValue')?.[0]).toEqual([false]);
    expect(under.emitted('update:modelValue')).toBeUndefined();
  });

  it('卸载即摘：残留组件不能继续吞掉返回键', async () => {
    const wrapper = await mountByOpening();
    // 从登记表里摘掉再卸载：这里要验的就是「这一次卸载」本身
    mounted.delete(wrapper);
    wrapper.unmount();

    setBackFallback(() => false);
    expect(pressBackButton()).toBe(false);
  });
});
