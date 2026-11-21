/**
 * 捏合切画幅的编排层（G-A09）。
 *
 * 几何归几何（`pinchResizeRecognizer.spec.ts` 已压死），这里只盯住四条不变量：
 * - 只有真正换档才碰一次画面，同档连续采样一枪不发；
 * - 抬手才落盘，未越阈值与中途打断一律还原且不留痕迹；
 * - 还原是「撤销」，HUD 立刻收起；吸附才走弹簧 + 停留；
 * - reduced-motion 下不做弹簧动画，但结果位必须一样到位。
 *
 * 弹簧按仓库既有做法整体 mock 成「直接到位」，计时器用 fake timers 走停留时间。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, ref, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

import type { ResizeMode } from '@/types';
import { animateSpring, type SpringAnimation } from '@/composables/useSpring';
import { usePinchResize, type PinchResizeOptions } from '@/composables/usePinchResize';

let reducedMotion = false;
vi.mock('@/composables/useSpring', () => ({
  prefersReducedMotion: () => reducedMotion,
  animateSpring: vi.fn((anim: SpringAnimation) => {
    anim.onFrame(anim.target);
    anim.onSettle();
    return () => undefined;
  }),
}));

const springMock = vi.mocked(animateSpring);

interface Harness {
  current: Ref<ResizeMode>;
  apply: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  onShift: ReturnType<typeof vi.fn>;
  wrapper: VueWrapper;
}

function setup(start: ResizeMode = 'cover'): Harness {
  const current = ref<ResizeMode>(start);
  const apply = vi.fn();
  const commit = vi.fn();
  const onShift = vi.fn();

  const Host = defineComponent({
    setup() {
      const options: PinchResizeOptions = {
        currentMode: () => current.value,
        apply: (mode) => {
          apply(mode);
          current.value = mode;
        },
        commit,
        onShift,
      };
      return { pinch: usePinchResize(options), current };
    },
    // 只是需要一个组件实例让 onBeforeUnmount 有归属；呈现层另有 spec
    render: () => h('div'),
  });

  const wrapper = mount(Host);
  return { current, apply, commit, onShift, wrapper };
}

/** 取回 setup 返回值：`pinch` 是 ComputedRef/refs 的容器，直接读原始对象最省事 */
function pinchOf(harness: Harness) {
  return (harness.wrapper.vm as unknown as { pinch: ReturnType<typeof usePinchResize> }).pinch;
}

beforeEach(() => {
  reducedMotion = false;
  vi.useFakeTimers();
  springMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('采样阶段', () => {
  it('第一次采样只亮起尺子，不碰画面', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.5, 'cover');

    expect(pinch.visible.value).toBe(true);
    expect(pinch.mode.value).toBe('cover');
    expect(harness.apply).not.toHaveBeenCalled();
  });

  it('同档内连续滑动一枪不发，跨档才发一次', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.5, 'cover');
    pinch.onSample(0.62, 'cover');
    expect(harness.apply).not.toHaveBeenCalled();

    pinch.onSample(0.8, 'fill');
    expect(harness.apply).toHaveBeenCalledTimes(1);
    expect(harness.apply).toHaveBeenLastCalledWith('fill');
    expect(harness.onShift).toHaveBeenCalledTimes(1);
    expect(pinch.pos.value).toBe(0.8);
  });

  it('捏回起始档后不再算作「已改动」', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.8, 'fill');
    pinch.onSample(0.5, 'cover');
    expect(harness.apply.mock.calls).toEqual([['fill'], ['cover']]);

    pinch.onEnd('cover', 0.5, 'up');
    // 已经回到原位，抬手时不该再补一次画幅切换
    expect(harness.apply).toHaveBeenCalledTimes(2);
    expect(harness.commit).toHaveBeenCalledWith('cover');
  });
});

describe('抬手与打断', () => {
  it('抬手吸附：写存储 + 弹簧到位 + 停留后收起', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.86, 'fill');
    pinch.onEnd('fill', 0.86, 'up');

    expect(harness.commit).toHaveBeenCalledWith('fill');
    expect(pinch.pos.value).toBe(1);
    expect(pinch.mode.value).toBe('fill');
    expect(pinch.visible.value).toBe(true);

    vi.advanceTimersByTime(319);
    expect(pinch.visible.value).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pinch.visible.value).toBe(false);
  });

  it('未越过阈值的抬手：不还原也不落盘，尺子立刻收起', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.5, 'cover');
    pinch.onEnd(null, 0.5, 'up');

    expect(harness.apply).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
    expect(pinch.visible.value).toBe(false);
    expect(springMock).not.toHaveBeenCalled();
  });

  it('系统打断：撤销已生效的档位且不落盘', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.86, 'fill');
    pinch.onEnd(null, 0.86, 'cancel');

    expect(harness.apply.mock.calls).toEqual([['fill'], ['cover']]);
    expect(harness.current.value).toBe('cover');
    expect(harness.commit).not.toHaveBeenCalled();
    expect(pinch.visible.value).toBe(false);
  });

  it('会话中途 abort：等价于被打断', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.86, 'fill');
    pinch.abort();

    expect(harness.apply).toHaveBeenLastCalledWith('cover');
    expect(harness.commit).not.toHaveBeenCalled();
    expect(pinch.visible.value).toBe(false);
  });

  it('没有会话时的一切调用都是空操作', () => {
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onEnd('fill', 1, 'up');
    pinch.abort();

    expect(harness.apply).not.toHaveBeenCalled();
    expect(harness.commit).not.toHaveBeenCalled();
    expect(pinch.visible.value).toBe(false);
  });

  it('连续两次会话各自从最新档位起算', () => {
    const harness = setup('contain');
    const pinch = pinchOf(harness);

    pinch.onSample(0.5, 'cover');
    pinch.onEnd('cover', 0.5, 'up');
    expect(harness.apply).toHaveBeenCalledWith('cover');

    pinch.onSample(0.8, 'fill');
    // 第二次的还原基准是「cover」而不是最初的 contain
    pinch.onEnd(null, 0.8, 'cancel');
    expect(harness.apply.mock.calls.map((call) => call[0])).toEqual(['cover', 'fill', 'cover']);
    expect(harness.commit).toHaveBeenCalledTimes(1);
  });
});

describe('减弱动效', () => {
  it('不做弹簧，但结果位照样到位', () => {
    reducedMotion = true;
    const harness = setup('cover');
    const pinch = pinchOf(harness);

    pinch.onSample(0.86, 'fill');
    pinch.onEnd('fill', 0.86, 'up');

    expect(springMock).not.toHaveBeenCalled();
    expect(pinch.pos.value).toBe(1);
    vi.advanceTimersByTime(320);
    expect(pinch.visible.value).toBe(false);
  });
});
