import { createPinia } from 'pinia';
import { config, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaItem } from '@/types';
import PosterCard from '@/components/media/PosterCard.vue';

/**
 * PosterCard 测试（设计规范 8.4 / AC-17 / AC-19）
 *
 * - 2:3 海报容器与懒加载属性
 * - 标题 2 行截断、元信息格式
 * - 角标：集数 / 演示 / 已下载
 * - 进度条 aria 属性
 * - 点击 emit select；长按 emit longpress（500ms）
 */
function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'mock:demo-001~a1',
    sourceId: 'mock',
    sourceItemId: 'demo-001',
    title: 'Big Buck Bunny',
    originalTitle: null,
    type: 'movie',
    year: 2008,
    area: '美国',
    genres: ['动画', '喜剧'],
    tags: ['mock'],
    rating: null,
    posterUrl: 'https://example.test/poster.jpg',
    backdropUrl: null,
    description: '公开版权样片',
    durationSec: 596,
    episodeCount: null,
    titleLower: 'big buck bunny',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('PosterCard', () => {
  // PosterCard → useHaptic → settingsStore，组件挂载时必须有 activePinia。
  // 测试基建补位（每个用例独立实例，避免状态串味）。
  beforeEach(() => {
    config.global.plugins = [createPinia()];
  });
  afterEach(() => {
    config.global.plugins = [];
  });

  it('渲染 2:3 海报、懒加载属性与无障碍标签', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem() } });
    const img = wrapper.find('img');
    expect(img.exists()).toBe(true);
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('decoding')).toBe('async');
    expect(img.attributes('alt')).toBe('Big Buck Bunny');

    const button = wrapper.find('button.poster-card');
    expect(button.attributes('aria-label')).toBe('Big Buck Bunny，2008');
  });

  it('标题使用 2 行截断，元信息为「年份 · 类型」', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem({ type: 'series', year: 2021 }) } });
    expect(wrapper.find('.poster-card__title').classes()).toContain('clamp-2');
    expect(wrapper.find('.poster-card__meta').text()).toBe('2021 · 剧集');
  });

  it('集数角标：多集时显示「全 N 集」，演示时显示演示角标', () => {
    const withEpisodes = mount(PosterCard, {
      props: { item: makeItem({ type: 'series', episodeCount: 24 }) },
    });
    expect(withEpisodes.text()).toContain('全 24 集');

    const demo = mount(PosterCard, { props: { item: makeItem({ isDemo: true }) } });
    expect(demo.text()).toContain('演示');
    expect(demo.find('.poster-card__badge--demo').exists()).toBe(true);
  });

  it('已下载角标使用 SVG 图标而非文本字符', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem(), downloaded: true } });
    const badge = wrapper.find('.poster-card__badge--done');
    expect(badge.exists()).toBe(true);
    expect(badge.attributes('aria-label')).toBe('已下载');
    // 图标必须是内联 SVG（不随字体渲染漂移），且装饰性内容对读屏隐藏
    const svg = badge.find('svg');
    expect(svg.exists()).toBe(true);
    expect(svg.attributes('aria-hidden')).toBe('true');
    expect(badge.text()).toBe('');
  });

  it('演示角标优先于已下载角标（避免两个右上角角标重叠）', () => {
    const wrapper = mount(PosterCard, {
      props: { item: makeItem({ isDemo: true }), downloaded: true },
    });
    expect(wrapper.find('.poster-card__badge--demo').exists()).toBe(true);
    expect(wrapper.find('.poster-card__badge--done').exists()).toBe(false);
  });

  it('进度条按 0~1 换算为百分比并写入 aria', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem(), progress: 0.456 } });
    const bar = wrapper.find('[role="progressbar"]');
    expect(bar.exists()).toBe(true);
    expect(bar.attributes('aria-valuenow')).toBe('46');
    expect(bar.attributes('aria-valuemax')).toBe('100');
  });

  it('无进度时不渲染进度条', () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem() } });
    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false);
  });

  it('点击卡片 emit select，携带完整 item', async () => {
    const item = makeItem();
    const wrapper = mount(PosterCard, { props: { item } });
    await wrapper.find('button.poster-card').trigger('click');
    const emitted = wrapper.emitted('select');
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0]?.[0]).toMatchObject({ id: item.id, title: item.title });
  });

  // P2-3：卡片把片名交给 PosterImage 做兜底，所以首次加载失败先换成生成图，
  // 连生成图都渲染不出来才落到「无封面」占位（逐档行为在 PosterImageFallback.spec 覆盖）。
  it('图片加载失败先用片名生成兜底海报，兜底也失败才显示占位', async () => {
    const wrapper = mount(PosterCard, { props: { item: makeItem() } });
    const firstSrc = wrapper.find('img').attributes('src');

    await wrapper.find('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(true);
    expect(wrapper.find('img').attributes('src')).not.toBe(firstSrc);
    expect(wrapper.text()).not.toContain('无封面');

    await wrapper.find('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.text()).toContain('无封面');
  });

  it('长按 500ms 触发 longpress', async () => {
    const item = makeItem();
    const wrapper = mount(PosterCard, { props: { item }, attachTo: document.body });
    const btn = wrapper.find('button.poster-card');

    await btn.trigger('pointerdown');
    await new Promise((resolve) => setTimeout(resolve, 520));
    await btn.trigger('pointerup');

    expect(wrapper.emitted('longpress')).toHaveLength(1);
    // 长按后松手不应同时触发点击导航
    await btn.trigger('click');
    expect(wrapper.emitted('select')).toBeUndefined();
    wrapper.unmount();
  });
});

/**
 * C-08 · 海报卡 3D 倾斜与光泽
 *
 * 四条验收都落在"什么时候动、什么时候必须不动"：
 * - 鼠标：跟指针倾斜 + 高光；离开清空内联样式，把 transform 交回 CSS。
 * - 触屏 / 低端机 / 减动效：倾斜这条关掉，长按菜单的功能一条不许少。
 * - 高频路径：同帧多次 move 只算一次；滚动、松手、卸载都要复位。
 *
 * happy-dom 没有布局，卡片矩形必须显式 stub，否则宽高为 0 时被守卫直接跳过。
 */
describe('PosterCard 倾斜与抬升（C-08）', () => {
  const RECT = { x: 0, y: 0, top: 0, left: 0, right: 120, bottom: 180, width: 120, height: 180 };
  const cores = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');

  beforeEach(() => {
    config.global.plugins = [createPinia()];
    // 档位是本机事实，测试里锁成高档；只有"低端机关闭倾斜"那条显式改成 4
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 8 });
  });
  afterEach(() => {
    config.global.plugins = [];
    if (cores) Object.defineProperty(navigator, 'hardwareConcurrency', cores);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function mountCard() {
    const wrapper = mount(PosterCard, { props: { item: makeItem() }, attachTo: document.body });
    const card = wrapper.find('button.poster-card').element as HTMLElement;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ ...RECT, toJSON: () => RECT } as DOMRect);
    const sheen = card.querySelector('.poster-card__sheen') as HTMLElement;
    return { wrapper, card, sheen };
  }

  function fire(el: Element, type: string, init: Record<string, unknown> = {}): void {
    const ev = new Event(type);
    Object.assign(ev, { pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 0 }, init);
    el.dispatchEvent(ev);
  }

  /** 手动跑帧：让"一帧只算一次"变成可断言的事实，而不是碰运气 */
  function manualFrames(): { pump: () => void; executed: () => number } {
    let queue: FrameRequestCallback[] = [];
    let done = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queue.push(cb);
      return queue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      queue = [];
    });
    return {
      pump: () => {
        const pending = queue;
        queue = [];
        pending.forEach((cb) => {
          done += 1;
          cb(0);
        });
      },
      executed: () => done,
    };
  }

  it('鼠标划过：倾斜与高光实时跟随，will-change 只在交互期间挂着', () => {
    const frames = manualFrames();
    const { wrapper, card, sheen } = mountCard();

    fire(card, 'pointerenter', { pointerType: 'mouse' });
    fire(card, 'pointermove', { clientX: 108, clientY: 36 });
    frames.pump();

    // 指针在右上区（90% / 20%）：上沿后仰 7.2°、右沿外翻 9.6°
    expect(card.style.transform).toMatch(/rotateX\(7\.200deg\)/);
    expect(card.style.transform).toMatch(/rotateY\(9\.600deg\)/);
    expect(sheen.style.opacity).toBe('1');
    expect(sheen.style.getPropertyValue('--sheen-x')).toBe('90.0%');
    expect(sheen.style.getPropertyValue('--sheen-y')).toBe('20.0%');
    expect(card.style.willChange).toBe('transform');
    expect(card.classList.contains('is-tilting')).toBe(true);
    wrapper.unmount();
  });

  it('同一帧内连续多次 move 只重算一次，且用最后一个坐标', () => {
    const frames = manualFrames();
    const { wrapper, card, sheen } = mountCard();
    const measured = vi.mocked(card.getBoundingClientRect);

    fire(card, 'pointerenter', { pointerType: 'mouse' });
    fire(card, 'pointermove', { clientX: 10, clientY: 10 });
    fire(card, 'pointermove', { clientX: 60, clientY: 90 });
    expect(frames.executed()).toBe(0);
    frames.pump();

    expect(frames.executed()).toBe(1);
    expect(measured).toHaveBeenCalledTimes(1);
    expect(sheen.style.getPropertyValue('--sheen-x')).toBe('50.0%');
    expect(sheen.style.getPropertyValue('--sheen-y')).toBe('50.0%');
    wrapper.unmount();
  });

  it('指针离开：内联样式全部交回 CSS，:active 按压反馈恢复', () => {
    const frames = manualFrames();
    const { wrapper, card } = mountCard();

    fire(card, 'pointerenter', { pointerType: 'mouse' });
    fire(card, 'pointermove', { clientX: 100, clientY: 40 });
    frames.pump();
    fire(card, 'pointerleave');

    expect(card.style.transform).toBe('');
    expect(card.style.boxShadow).toBe('');
    expect(card.style.willChange).toBe('');
    expect(card.style.transition).toBe('');
    expect(card.classList.contains('is-tilting')).toBe(false);
    wrapper.unmount();
  });

  it('触屏不做倾斜（没有 hover，主反馈交给长按抬升）', () => {
    const frames = manualFrames();
    const { wrapper, card } = mountCard();

    fire(card, 'pointerenter', { pointerType: 'touch' });
    fire(card, 'pointermove', { pointerType: 'touch', clientX: 100, clientY: 40 });
    frames.pump();

    expect(card.style.transform).toBe('');
    expect(card.classList.contains('is-tilting')).toBe(false);
    wrapper.unmount();
  });

  it('低端机（≤4 核）关闭倾斜，但长按抬升与菜单照常', async () => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 4 });
    const frames = manualFrames();
    const { wrapper, card } = mountCard();

    fire(card, 'pointerenter', { pointerType: 'mouse' });
    fire(card, 'pointermove', { clientX: 100, clientY: 40 });
    frames.pump();
    expect(card.style.transform).toBe('');

    fire(card, 'pointerdown', { pointerType: 'touch' });
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(wrapper.emitted('longpress')).toHaveLength(1);
    expect(card.style.transform).toContain('translateZ(34px)');
    expect(card.classList.contains('is-lifted')).toBe(true);
    wrapper.unmount();
  });

  it('系统减动效：倾斜与抬升都不动，长按菜单功能不受影响', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduced-motion'), media: query } as MediaQueryList),
    );
    const frames = manualFrames();
    const { wrapper, card } = mountCard();

    fire(card, 'pointerenter', { pointerType: 'mouse' });
    fire(card, 'pointermove', { clientX: 100, clientY: 40 });
    frames.pump();
    expect(card.style.transform).toBe('');

    fire(card, 'pointerdown', { pointerType: 'touch' });
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(wrapper.emitted('longpress')).toHaveLength(1);
    expect(card.style.transform).toBe('');
    wrapper.unmount();
  });

  it('长按松手立即复位', async () => {
    const { wrapper, card } = mountCard();
    fire(card, 'pointerdown', { pointerType: 'touch' });
    await new Promise((resolve) => setTimeout(resolve, 520));
    expect(card.style.transform).toContain('translateZ');
    fire(card, 'pointerup', { pointerType: 'touch' });
    expect(card.style.transform).toBe('');
    expect(card.classList.contains('is-lifted')).toBe(false);
    wrapper.unmount();
  });

  it('滚动一下整墙立刻复位（虚拟网格换数据时不留歪卡片）', () => {
    const frames = manualFrames();
    const { wrapper, card } = mountCard();

    fire(card, 'pointerenter', { pointerType: 'mouse' });
    fire(card, 'pointermove', { clientX: 100, clientY: 40 });
    frames.pump();
    expect(card.style.transform).toContain('rotateY');

    window.dispatchEvent(new Event('scroll'));
    expect(card.style.transform).toBe('');

    // 复位后不该继续挂着 window 上的滚动监听
    frames.pump();
    fire(card, 'pointermove', { clientX: 20, clientY: 20 });
    frames.pump();
    expect(card.style.transform).toBe('');
    wrapper.unmount();
  });

  it('卸载时复位：切走页面不留内联 transform', () => {
    const frames = manualFrames();
    const { wrapper, card } = mountCard();

    fire(card, 'pointerenter', { pointerType: 'mouse' });
    fire(card, 'pointermove', { clientX: 100, clientY: 40 });
    frames.pump();
    expect(card.style.transform).toContain('rotateX');

    wrapper.unmount();
    expect(card.style.transform).toBe('');
    expect(card.style.willChange).toBe('');
  });
});
