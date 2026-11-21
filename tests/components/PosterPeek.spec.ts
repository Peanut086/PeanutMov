import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaItem } from '@/types';
import PosterPeek from '@/components/media/PosterPeek.vue';
import type { PeekClip, PeekPreview } from '@/services/peekPreviewService';

/**
 * 原位放映台（G-B02）
 *
 * 断言分三块：形变「演的是卡片矩形 → 终态」、画面来源「有帧放帧、没帧诚实说」、
 * 手势「上滑播、下滑藏、松手回菜单、其它一律只是关掉」。
 *
 * happy-dom 没有布局也没有 WAAPI：视口尺寸与 `animate` 都要显式打桩，
 * 而 `animate` 必须打在 `HTMLElement.prototype` 上——放映台是 Teleport 到 body 的，
 * 挂载瞬间就要能用，拿到元素再补已经错过第一段动画了。
 */

const h = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('@/services/peekPreviewService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/peekPreviewService')>();
  return { ...actual, resolvePeekPreview: h.resolve };
});

const ANCHOR = { top: 120, left: 24, width: 120, height: 180 };
/** 视口 400×800 时放映台的目标矩形（与组件里同一套算式，改动时这里会一起红） */
const TARGET = { top: 257, left: 20, width: 360, height: 203 };

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'mock:m1~a',
    sourceId: 'mock',
    sourceItemId: 'm1',
    title: '影片一',
    originalTitle: null,
    type: 'series',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: 'https://example.test/p.jpg',
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: 3,
    titleLower: '影片一',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeClip(frames: string[]): PeekClip {
  return { episodeId: 'e2', lineId: 'line-a', episodeLabel: '第 2 集', durationSec: 600, frames };
}

function clipPreview(frames: string[]): PeekPreview {
  return { clip: makeClip(frames), fallback: null };
}

let animateDescriptor: PropertyDescriptor | undefined;
let animateCalls: { frames: Keyframe[]; options: KeyframeAnimationOptions }[] = [];

function stubAnimate(): void {
  animateCalls = [];
  animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'animate');
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: (frames: Keyframe[], options: KeyframeAnimationOptions) => {
      animateCalls.push({ frames, options });
      return { finished: Promise.resolve() } as unknown as Animation;
    },
  });
}

function fire(target: EventTarget, type: string, init: Record<string, unknown> = {}): void {
  const ev = new Event(type);
  Object.assign(ev, { clientX: 200, clientY: 500, isPrimary: true }, init);
  target.dispatchEvent(ev);
}

function mountPeek(props: Record<string, unknown> = {}) {
  const wrapper = mount(PosterPeek, {
    props: { item: makeItem(), anchor: ANCHOR, origin: { x: 200, y: 500 }, ...props },
    // 放映台是 Teleport 到 body 的；stub 掉才能在 wrapper 里查到，否则每次都要摸 document
    global: { stubs: { teleport: true } },
  });
  const stage = wrapper.find('.poster-peek__stage').element as HTMLElement;
  return { wrapper, stage };
}

beforeEach(() => {
  h.resolve.mockReset().mockResolvedValue(clipPreview(['F0', 'F1', 'F2']));
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 400 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 800 });
  stubAnimate();
});

afterEach(() => {
  if (animateDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'animate', animateDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');
  }
  animateCalls = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PosterPeek · 形变', () => {
  it('挂载即把终态写进内联样式，并从卡片矩形演过去', async () => {
    const { stage } = mountPeek();
    await flushPromises();

    expect(stage.style.top).toBe(`${TARGET.top}px`);
    expect(stage.style.left).toBe(`${TARGET.left}px`);
    expect(stage.style.width).toBe(`${TARGET.width}px`);
    expect(stage.style.height).toBe(`${TARGET.height}px`);

    expect(animateCalls).toHaveLength(1);
    expect(animateCalls[0]?.frames[0]).toEqual({
      top: '120px',
      left: '24px',
      width: '120px',
      height: '180px',
    });
    expect(animateCalls[0]?.frames[1]).toEqual({
      top: '257px',
      left: '20px',
      width: '360px',
      height: '203px',
    });
    expect(animateCalls[0]?.options.duration).toBe(300);
  });

  it('减弱动效：一段都不演，但基础样式就是展开后的终态', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduced-motion'), media: query } as MediaQueryList),
    );

    const { stage } = mountPeek();
    await flushPromises();

    expect(animateCalls).toHaveLength(0);
    expect(stage.style.width).toBe(`${TARGET.width}px`);
    expect(stage.style.height).toBe(`${TARGET.height}px`);
  });

  it('没有 WAAPI 的 WebView 不崩：终态照样就位，收起时直接消失', async () => {
    Reflect.deleteProperty(HTMLElement.prototype, 'animate');

    const { wrapper, stage } = mountPeek();
    await flushPromises();
    expect(stage.style.width).toBe(`${TARGET.width}px`);

    fire(document, 'keydown', { key: 'Escape' });
    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('key');
  });

  it('收起是从当前终态演回卡片矩形，不是凭空消失', async () => {
    const { wrapper } = mountPeek();

    fire(document, 'pointermove', { clientY: 500 - 20 });
    await nextTick();
    fire(document, 'pointerup');
    await flushPromises();

    expect(animateCalls).toHaveLength(2);
    expect(animateCalls[1]?.frames[0]).toEqual({
      top: '257px',
      left: '20px',
      width: '360px',
      height: '203px',
    });
    expect(animateCalls[1]?.frames[1]).toEqual({
      top: '120px',
      left: '24px',
      width: '120px',
      height: '180px',
    });
    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('release');
  });
});

describe('PosterPeek · 画面来源与诚实降级', () => {
  it('取到帧：逐帧轮播、齿孔带出现、说明写清放的是哪一集', async () => {
    h.resolve.mockResolvedValue(clipPreview(['data:image/jpeg;base64,F0', 'data:image/jpeg;base64,F1', 'data:image/jpeg;base64,F2']));
    const { wrapper } = mountPeek();
    await flushPromises();

    const frame = wrapper.find('.poster-peek__frame');
    expect(frame.exists()).toBe(true);
    expect(frame.attributes('src')).toBe('data:image/jpeg;base64,F0');
    expect(wrapper.findAll('.poster-peek__perf')).toHaveLength(2);
    expect(wrapper.find('.poster-peek__note').text()).toBe('本地 · 第 2 集');
    expect(wrapper.find('.poster-peek__still').exists()).toBe(false);
  });

  it('每 700ms 换一格，进度条跟着帧序走', async () => {
    h.resolve.mockResolvedValue(clipPreview(['A', 'B', 'C']));
    vi.useFakeTimers();
    const { wrapper } = mountPeek();
    await vi.advanceTimersByTimeAsync(0);
    await flushPromises();

    expect(wrapper.find('.poster-peek__frame').attributes('src')).toBe('A');
    await vi.advanceTimersByTimeAsync(700);
    expect(wrapper.find('.poster-peek__frame').attributes('src')).toBe('B');
    expect(wrapper.find('.poster-peek__bar-fill').attributes('style')).toContain('width: 67%');
    await vi.advanceTimersByTimeAsync(1400);
    expect(wrapper.find('.poster-peek__frame').attributes('src')).toBe('A');
  });

  it('没下载过就说「在线源」，而且不挂空转的定时器', async () => {
    h.resolve.mockResolvedValue({ clip: null, fallback: 'no-download' });
    const ticker = vi.spyOn(globalThis, 'setInterval');
    const { wrapper } = mountPeek();
    await flushPromises();

    expect(wrapper.find('.poster-peek__still').exists()).toBe(true);
    expect(wrapper.find('.poster-peek__frame').exists()).toBe(false);
    expect(wrapper.findAll('.poster-peek__perf')).toHaveLength(0);
    expect(wrapper.find('.poster-peek__note').text()).toBe('在线源 · 仅海报预览');
    expect(ticker).not.toHaveBeenCalled();
  });

  it('海报沿用卡片那份尺寸协商地址：同一个 URL 不再走一次网络', async () => {
    h.resolve.mockResolvedValue({ clip: null, fallback: 'no-download' });
    const { wrapper } = mountPeek({ item: makeItem({ posterUrl: 'https://pic.oss-cn-beijing.aliyuncs.com/a.jpg' }) });
    await flushPromises();

    expect(wrapper.find('.poster-peek__still').attributes('src')).toContain(
      'x-oss-process=image/resize,w_540',
    );
  });

  it('没海报也没帧时用片名占位，不留一块黑', async () => {
    h.resolve.mockResolvedValue({ clip: null, fallback: 'no-frames' });
    const { wrapper } = mountPeek({ item: makeItem({ posterUrl: null }) });
    await flushPromises();

    expect(wrapper.find('.poster-peek__noimage').text()).toBe('影片一');
    expect(wrapper.find('.poster-peek__note').text()).toBe('这一集抽不出画面 · 仅海报预览');
  });

  it('取帧服务整体抛错也归到「抽不出画面」，不是永远停在「正在取帧」', async () => {
    h.resolve.mockRejectedValue(new Error('db exploded'));
    const { wrapper } = mountPeek();
    await flushPromises();

    expect(wrapper.find('.poster-peek__note').text()).toBe('这一集抽不出画面 · 仅海报预览');
  });

  it('收起之后才到达的取帧结果不再改画面', async () => {
    let release!: (value: PeekPreview) => void;
    h.resolve.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const { wrapper } = mountPeek();

    wrapper.find('.poster-peek__scrim').element.dispatchEvent(new Event('pointerdown'));
    await flushPromises();
    release(clipPreview(['X']));
    await flushPromises();

    expect(wrapper.find('.poster-peek__frame').exists()).toBe(false);
    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('scrim');
  });
});

describe('PosterPeek · 手势', () => {
  it('上滑超过阈值松手 = 播放，并带上取到的那一集', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();

    fire(document, 'pointermove', { clientY: 500 - 60 });
    await nextTick();
    expect(wrapper.find('.poster-peek__cue--play').text()).toBe('松手播放');

    fire(document, 'pointerup');
    await flushPromises();

    const play = wrapper.emitted('play');
    expect(play?.[0]?.[0]).toMatchObject({ episodeId: 'e2', lineId: 'line-a' });
    expect(wrapper.emitted('favorite')).toBeUndefined();
    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('swipe');
  });

  it('下滑超过阈值松手 = 收藏', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();

    fire(document, 'pointermove', { clientY: 500 + 60 });
    await nextTick();
    expect(wrapper.find('.poster-peek__cue--fav').text()).toBe('松手收藏');

    fire(document, 'pointerup');
    await flushPromises();

    expect(wrapper.emitted('favorite')).toHaveLength(1);
    expect(wrapper.emitted('play')).toBeUndefined();
    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('swipe');
  });

  it('没滑动够就松手：只是收起，把原菜单交还给页面', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();

    fire(document, 'pointermove', { clientY: 500 - 20 });
    fire(document, 'pointerup');
    await flushPromises();

    expect(wrapper.emitted('play')).toBeUndefined();
    expect(wrapper.emitted('favorite')).toBeUndefined();
    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('release');
  });

  it('第二根手指不抢手势', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();

    fire(document, 'pointermove', { clientY: 400, isPrimary: false });
    fire(document, 'pointerup');
    await flushPromises();

    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('release');
    expect(wrapper.emitted('play')).toBeUndefined();
  });

  it('滑动会把画面跟着手指带过去，但最多 120px', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();

    fire(document, 'pointermove', { clientY: 500 - 1000 });
    await nextTick();
    const transform = (wrapper.find('.poster-peek__stage').element as HTMLElement).style.transform;
    expect(transform).toContain('translate3d(0, -120px');
  });

  it('键盘起幕（没有触点）不吃滑动，只用 Esc 关', async () => {
    const { wrapper } = mountPeek({ origin: null });
    await flushPromises();

    fire(document, 'pointermove', { clientY: 400 });
    expect(wrapper.find('.poster-peek__cue--play').exists()).toBe(false);

    fire(document, 'keydown', { key: 'Escape' });
    await flushPromises();
    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('key');
    expect(wrapper.text()).toContain('Esc 关闭');
  });

  it('滚动会让放映台直接收掉：起点矩形已经不成立了', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();

    window.dispatchEvent(new Event('scroll'));
    await flushPromises();

    expect(wrapper.emitted('dismiss')?.[0]?.[0]).toBe('scroll');
  });

  it('按过的动作不会被第二次松手重复触发', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();

    fire(document, 'pointermove', { clientY: 400 });
    fire(document, 'pointerup');
    await flushPromises();
    fire(document, 'pointerup');

    expect(wrapper.emitted('play')).toHaveLength(1);
    expect(wrapper.emitted('dismiss')).toHaveLength(1);
  });

  it('卸载后监听全部摘掉：残留事件不再往屏幕上撒动作', async () => {
    const { wrapper } = mountPeek();
    await flushPromises();
    wrapper.unmount();

    fire(document, 'pointermove', { clientY: 400 });
    fire(document, 'pointerup');
    fire(document, 'keydown', { key: 'Escape' });
    window.dispatchEvent(new Event('scroll'));
    await flushPromises();

    expect(wrapper.emitted('play')).toBeUndefined();
    expect(wrapper.emitted('dismiss')).toBeUndefined();
  });
});
