/**
 * 边缘滑动返回的接线（B-07）
 *
 * 阈值判定在 `edgeSwipeRecognizer.spec.ts` 里压过了，这里只管四件事：
 * - 跟手只动 surface 的内联 transform，判定不成立时一点都不碰；
 * - 满足提交时**先清内联位移再交回统一出口**，否则 CSS 的 slide-right 会叠在手势位移上；
 * - 不满足提交走弹簧回弹，不是硬贴回去；
 * - 起点在横向滚动容器里 / 页面被关掉（播放器、全屏）时整段手势不接管。
 *
 * 监听挂在 document 上，所以组件必须 attachTo body，否则事件冒泡不到。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';

import { pressBackButton } from '@/native/appLifecycle';
import { animateSpring, type SpringAnimation } from '@/composables/useSpring';
import { useEdgeBackSwipe } from '@/composables/useEdgeBackSwipe';

vi.mock('@/native/appLifecycle', () => ({ pressBackButton: vi.fn(() => true) }));
vi.mock('@/composables/useSpring', () => ({
  prefersReducedMotion: () => false,
  animateSpring: vi.fn((anim: SpringAnimation) => {
    anim.onFrame(anim.from);
    anim.onSettle();
    return () => undefined;
  }),
}));

const pressMock = vi.mocked(pressBackButton);
const springMock = vi.mocked(animateSpring);

/** happy-dom 不做布局，屏宽直接钉成 400：40% 提交线就是 160px */
const VIEWPORT_W = 400;

interface Harness {
  surface: HTMLElement;
  scroller: HTMLElement;
  enabled: Ref<boolean>;
  fire: (type: string, x: number, y: number, target?: HTMLElement) => void;
  unmount: () => void;
}

function setup(options: { enabled?: boolean; scrollable?: boolean } = {}): Harness {
  const surface = ref<HTMLElement | null>(null);
  const scroller = ref<HTMLElement | null>(null);
  const enabled = ref(options.enabled ?? true);

  const wrapper = mount(
    defineComponent({
      setup() {
        useEdgeBackSwipe({ surface, enabled });
        return () =>
          h('div', { class: 'shell' }, [
            h('div', { ref: surface, class: 'surface' }, [
              h('div', { class: 'plain' }, '正文'),
              h('div', { ref: scroller, class: 'scroller', style: { overflowX: 'auto' } }, '横向列表'),
            ]),
          ]);
      },
    }),
    { attachTo: document.body },
  );

  const surfaceEl = surface.value as HTMLElement;
  const scrollerEl = scroller.value as HTMLElement;
  // 能不能横滚要看 scrollWidth - clientWidth，happy-dom 一律给 0，这里按需伪造
  const scrollable = options.scrollable !== false;
  Object.defineProperty(scrollerEl, 'clientWidth', { configurable: true, value: 300 });
  Object.defineProperty(scrollerEl, 'scrollWidth', { configurable: true, value: scrollable ? 900 : 300 });

  return {
    surface: surfaceEl,
    scroller: scrollerEl,
    enabled,
    fire(type, x, y, target) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, pointerType: 'touch' });
      (target ?? surfaceEl).dispatchEvent(ev);
    },
    unmount: () => wrapper.unmount(),
  };
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', VIEWPORT_W);
  pressMock.mockClear();
  springMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useEdgeBackSwipe', () => {
  it('拖过 40% 屏宽：先清掉内联位移，再走统一返回出口', () => {
    const env = setup();
    let transformAtPress = 'unset';
    pressMock.mockImplementationOnce(() => {
      transformAtPress = env.surface.style.transform;
      return true;
    });

    env.fire('pointerdown', 6, 500);
    env.fire('pointermove', 60, 501);
    env.fire('pointermove', 200, 502);
    expect(env.surface.style.transform).toBe('translate3d(194px, 0, 0)');
    expect(env.surface.classList.contains('edge-drag')).toBe(true);

    env.fire('pointerup', 200, 502);
    expect(pressMock).toHaveBeenCalledTimes(1);
    expect(transformAtPress).toBe('');
    expect(env.surface.style.transform).toBe('');
    expect(env.surface.classList.contains('edge-drag')).toBe(false);
    expect(springMock).not.toHaveBeenCalled();
    env.unmount();
  });

  it('没拖够：不回退路由，改用弹簧收回去', () => {
    const env = setup();
    env.fire('pointerdown', 6, 500);
    env.fire('pointermove', 60, 501);
    env.fire('pointerup', 60, 501);

    expect(pressMock).not.toHaveBeenCalled();
    expect(springMock).toHaveBeenCalledTimes(1);
    const anim = springMock.mock.calls[0][0];
    expect(anim.from).toBe(54);
    expect(anim.target).toBe(0);
    expect(anim.clamp?.(-30)).toBe(0);
    expect(env.surface.style.transform).toBe('');
    env.unmount();
  });

  it('起点在横向滚动列表里：整段手势不接管，列表照常滚', () => {
    const env = setup();
    env.fire('pointerdown', 6, 500, env.scroller);
    env.fire('pointermove', 200, 501, env.scroller);
    env.fire('pointerup', 200, 501, env.scroller);

    expect(env.surface.style.transform).toBe('');
    expect(pressMock).not.toHaveBeenCalled();
    expect(springMock).not.toHaveBeenCalled();
    env.unmount();
  });

  it('横滚容器已滚到底（没有可滚距离）时不算横滚，照常接管', () => {
    const env = setup({ scrollable: false });
    env.fire('pointerdown', 6, 500, env.scroller);
    env.fire('pointermove', 200, 501, env.scroller);
    expect(env.surface.style.transform).toBe('translate3d(194px, 0, 0)');
    env.fire('pointerup', 200, 501, env.scroller);
    expect(pressMock).toHaveBeenCalledTimes(1);
    env.unmount();
  });

  it('关掉开关（播放器 / 全屏）后完全静默', () => {
    const env = setup({ enabled: false });
    env.fire('pointerdown', 6, 500);
    env.fire('pointermove', 200, 501);
    env.fire('pointerup', 200, 501);
    expect(env.surface.style.transform).toBe('');
    expect(pressMock).not.toHaveBeenCalled();
    env.unmount();
  });

  it('起点不在左边缘带内、或竖着划，都不跟手', () => {
    const env = setup();
    env.fire('pointerdown', 200, 500);
    env.fire('pointermove', 380, 501);
    env.fire('pointerup', 380, 501);
    expect(env.surface.style.transform).toBe('');

    env.fire('pointerdown', 6, 600);
    env.fire('pointermove', 10, 400);
    env.fire('pointermove', 12, 200);
    env.fire('pointerup', 12, 200);
    expect(env.surface.style.transform).toBe('');
    expect(pressMock).not.toHaveBeenCalled();
    env.unmount();
  });

  it('拖动中挂 will-change，松手后连同位移一起清干净', async () => {
    const env = setup();
    env.fire('pointerdown', 6, 500);
    env.fire('pointermove', 100, 501);
    expect(env.surface.style.willChange).toBe('transform');
    env.fire('pointerup', 100, 501);
    await nextTick();
    expect(env.surface.style.willChange).toBe('');
    expect(env.surface.getAttribute('style') ?? '').not.toContain('translate3d');
    env.unmount();
  });

  it('卸载后监听器全部摘掉，再划页面不动', () => {
    const env = setup();
    const el = env.surface;
    env.unmount();
    env.fire('pointerdown', 6, 500);
    env.fire('pointermove', 200, 501);
    expect(el.style.transform).toBe('');
    expect(pressMock).not.toHaveBeenCalled();
  });
});
