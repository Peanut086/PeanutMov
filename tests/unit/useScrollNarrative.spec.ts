/**
 * 详情页滚动叙事（C-10 · 驱动层）
 *
 * 钉四件事：
 * 1. 进度只写成 CSS 变量与 data 属性，模糊必须离散到 5 档；
 * 2. 一帧内多次 scroll 只算一次（rAF 节流），监听必须 passive；
 * 3. 段落切换要把 `data-narrative-active` 交出去，旧段落必须摘掉；
 * 4. reduced-motion 下背景静止、顶栏标题二值切换。
 *
 * happy-dom 不做布局，所有矩形 / scrollTop / clientHeight 都用属性桩。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

import { prefersReducedMotion } from '@/composables/useSpring';
import { useScrollNarrative, type ScrollNarrativeApi } from '@/composables/useScrollNarrative';

vi.mock('@/composables/useSpring', () => ({
  prefersReducedMotion: vi.fn(() => false),
}));

const reducedMock = vi.mocked(prefersReducedMotion);

/** 滚动容器视口：顶边 100px、高 600px → 段落判定线 = 600 * 0.34 ≈ 204 */
const SCROLLER_TOP = 100;
const SCROLLER_H = 600;
const HERO_H = 200;

let rafQueue: FrameRequestCallback[] = [];
let scrollListeners: Array<{ fn: EventListener; opts: AddEventListenerOptions | boolean }> = [];
let scrollOffset = 0;

function rect(left: number, top: number, height = 40): DOMRect {
  return {
    left,
    top,
    right: left + 200,
    bottom: top + height,
    x: left,
    y: top,
    width: 200,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

let wrapper: VueWrapper | null = null;
let api!: ScrollNarrativeApi;
let rootEl!: HTMLElement;
let scrollerEl!: HTMLElement;
let heroEl!: HTMLElement;

function flushFrame(): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const fn of queue) fn(0);
}

function scroll(to: number): void {
  scrollOffset = to;
  scrollerEl.dispatchEvent(new Event('scroll'));
  flushFrame();
}

function mountPage(): void {
  const root = ref<HTMLElement | null>(null);
  const scroller = ref<HTMLElement | null>(null);
  const hero = ref<HTMLElement | null>(null);

  wrapper = mount(
    defineComponent({
      setup() {
        api = useScrollNarrative({ root, scroller, hero });
        return () =>
          h('main', { ref: root, class: 'detail' }, [
            h('p', { 'data-narrative-nav-title': '' }, '顶栏标题'),
            h('section', { ref: hero, class: 'detail-hero' }, [
              h('h1', { 'data-narrative-title': '' }, '雪线之下'),
            ]),
            h(
              'div',
              { ref: scroller, class: 'detail__scroll' },
              [0, 1, 2].map((i) => h('section', { 'data-narrative': '', 'data-i': String(i) }, `第 ${i} 段`)),
            ),
          ]);
      },
    }),
    { attachTo: document.body },
  );

  rootEl = wrapper.element as HTMLElement;
  scrollerEl = wrapper.find('.detail__scroll').element as HTMLElement;
  heroEl = wrapper.find('.detail-hero').element as HTMLElement;

  Object.defineProperty(scrollerEl, 'clientHeight', { configurable: true, get: () => SCROLLER_H });
  Object.defineProperty(scrollerEl, 'scrollTop', { configurable: true, get: () => scrollOffset });
  Object.defineProperty(heroEl, 'offsetHeight', { configurable: true, get: () => HERO_H });

  scrollerEl.getBoundingClientRect = () => rect(0, SCROLLER_TOP, 400);
  heroEl.querySelector('h1')!.getBoundingClientRect = () => rect(128, 120, 28);
  rootEl.querySelector('[data-narrative-nav-title]')!.getBoundingClientRect = () => rect(56, 100, 28);
  // 三段顶边（视口坐标，容器顶在 100）：相对容器 200 / 360 / 600，判定线 204
  const tops = [300, 460, 700];
  wrapper.findAll('[data-narrative]').forEach((node, i) => {
    (node.element as HTMLElement).getBoundingClientRect = () => rect(16, tops[i] ?? 460, 120);
  });
}

beforeEach(() => {
  rafQueue = [];
  scrollListeners = [];
  scrollOffset = 0;
  reducedMock.mockReturnValue(false);

  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((fn) => {
    rafQueue.push(fn);
    return rafQueue.length;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => undefined);

  // 记录 passive 标记，但仍然真接挂上去：滚动事件要能真的派发到监听器
  const add = HTMLElement.prototype.addEventListener;
  const remove = HTMLElement.prototype.removeEventListener;
  vi.spyOn(HTMLElement.prototype, 'addEventListener').mockImplementation(function (
    this: HTMLElement,
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: AddEventListenerOptions | boolean,
  ) {
    if (type === 'scroll' && this.classList?.contains('detail__scroll')) {
      scrollListeners.push({ fn: fn as EventListener, opts: opts ?? false });
    }
    add.call(this, type, fn, opts);
  });
  vi.spyOn(HTMLElement.prototype, 'removeEventListener').mockImplementation(function (
    this: HTMLElement,
    type: string,
    fn: EventListenerOrEventListenerObject,
    opts?: EventListenerOptions | boolean,
  ) {
    if (type === 'scroll') {
      const at = scrollListeners.findIndex((l) => l.fn === fn);
      if (at >= 0) scrollListeners.splice(at, 1);
    }
    remove.call(this, type, fn, opts);
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const v = (name: string): string => rootEl.style.getPropertyValue(name);

describe('useScrollNarrative 滚动驱动', () => {
  it('挂载即测一次：顶栏标题与大标题同一条竖线（72px 偏移）', async () => {
    mountPage();
    await nextTick();
    expect(v('--dn-nav-x')).toBe('72px');
  });

  it('多次 measure 不累加偏移：refresh 后仍是对齐值', async () => {
    mountPage();
    await nextTick();
    api.refresh();
    api.refresh();
    expect(v('--dn-nav-x')).toBe('72px');
  });

  it('滚到一半：视差位移 / 进度 / 顶栏与标题互补淡入淡出', async () => {
    mountPage();
    await nextTick();

    scroll(150);
    expect(v('--dn-p')).toBe('0.500');
    expect(v('--dn-shift')).toBe('60.0px');
    expect(v('--dn-nav')).toBe('0.267');
    expect(v('--dn-hero')).toBe('0.375');
  });

  it('模糊分 5 档离散切换，不是逐帧插值', async () => {
    mountPage();
    await nextTick();

    const seen = new Set<string>();
    for (const y of [0, 60, 120, 180, 240, 300, 420]) {
      scroll(y);
      seen.add(rootEl.dataset.blur ?? '');
    }
    expect([...seen].sort()).toEqual(['0', '1', '2', '3', '4']);
    // 进度封顶后不再往上涨：背景不会无限下滑
    scroll(4000);
    expect(v('--dn-shift')).toBe('120.0px');
  });

  it('同一帧内多次 scroll 只算一次，且监听是 passive', async () => {
    mountPage();
    await nextTick();

    expect(scrollListeners).toHaveLength(1);
    expect(scrollListeners[0]?.opts).toEqual({ passive: true });

    scrollOffset = 200;
    scrollerEl.dispatchEvent(new Event('scroll'));
    scrollerEl.dispatchEvent(new Event('scroll'));
    scrollerEl.dispatchEvent(new Event('scroll'));
    expect(rafQueue).toHaveLength(1);
    flushFrame();
    expect(v('--dn-p')).toBe('0.667');
  });

  it('will-change 只在滚动进行中挂，停下后立刻撤', async () => {
    mountPage();
    await nextTick();

    const idleQueue: Array<() => void> = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      idleQueue.push(fn);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);

    scroll(100);
    expect(rootEl.hasAttribute('data-narrative-live')).toBe(true);
    idleQueue[0]?.();
    expect(rootEl.hasAttribute('data-narrative-live')).toBe(false);
  });

  it('段落切换：activeSection 递增，且 data-narrative-active 只留在当前段', async () => {
    mountPage();
    await nextTick();
    const nodes = wrapper!.findAll('[data-narrative]').map((n) => n.element as HTMLElement);
    // 判定线 204：只有第一段（相对顶边 200）过了线
    expect(api.activeSection.value).toBe(0);
    expect(nodes[0]?.hasAttribute('data-narrative-active')).toBe(true);

    // 把后两段挪到过线位置，模拟继续下滚
    (nodes[1] as HTMLElement).getBoundingClientRect = () => rect(16, 200, 120);
    scroll(60);
    expect(api.activeSection.value).toBe(1);
    expect(nodes[0]?.hasAttribute('data-narrative-active')).toBe(false);
    expect(nodes[1]?.hasAttribute('data-narrative-active')).toBe(true);

    (nodes[2] as HTMLElement).getBoundingClientRect = () => rect(16, 150, 120);
    scroll(80);
    expect(api.activeSection.value).toBe(2);
    expect(nodes[2]?.hasAttribute('data-narrative-active')).toBe(true);
  });

  it('reduced-motion：背景静止在静态档位，标题直接切换', async () => {
    reducedMock.mockReturnValue(true);
    mountPage();
    await nextTick();

    scroll(150);
    expect(v('--dn-shift')).toBe('0px');
    expect(v('--dn-p')).toBe('0.5');
    expect(rootEl.dataset.blur).toBe('2');
    // 进度刚过 0.42 的阈值：不给中间态，直接落到 1 / 0
    scroll(127);
    expect(v('--dn-nav')).toBe('1');
    expect(v('--dn-hero')).toBe('0');
    scroll(20);
    expect(v('--dn-nav')).toBe('0');
    expect(v('--dn-hero')).toBe('1');
  });

  it('卸载后摘掉监听', async () => {
    mountPage();
    await nextTick();
    expect(scrollListeners).toHaveLength(1);
    wrapper?.unmount();
    wrapper = null;
    expect(scrollListeners).toHaveLength(0);
  });
});
