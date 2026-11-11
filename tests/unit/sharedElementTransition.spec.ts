import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginSharedCover,
  cancelSharedCover,
  finishSharedCover,
  sharedCoverActive,
} from '@/composables/useSharedElement';

/**
 * 封面共享元素转场的守卫条件：
 * 任何一条不满足都必须静默跳过，让导航退回普通页面过渡（不能留下悬挂的浮层）。
 */

function mountCover(): { host: HTMLElement; img: HTMLImageElement } {
  const host = document.createElement('div');
  host.className = 'poster-image';
  const img = document.createElement('img');
  img.src = 'https://cdn.example.com/poster.jpg';
  Object.defineProperty(img, 'complete', { value: true, configurable: true });
  Object.defineProperty(img, 'naturalWidth', { value: 300, configurable: true });
  img.getBoundingClientRect = () =>
    ({ top: 120, left: 24, width: 96, height: 144, right: 120, bottom: 264, x: 24, y: 120, toJSON: () => ({}) }) as DOMRect;
  host.appendChild(img);
  document.body.appendChild(host);
  return { host, img };
}

function overlayCount(): number {
  return [...document.body.children].filter((el) => (el as HTMLElement).style?.zIndex).length;
}

afterEach(() => {
  cancelSharedCover();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

beforeEach(() => {
  // jsdom 不做布局，视口高度恒为 0；按常见手机竖屏视口打桩，否则越界判定会误杀
  Object.defineProperty(document.documentElement, 'clientHeight', { value: 800, configurable: true });
});

describe('useSharedElement · 封面共享元素转场', () => {
  it('封面已就位时建浮层并隐去原图', () => {
    const { img } = mountCover();
    beginSharedCover(img.parentElement);

    expect(img.style.visibility).toBe('hidden');
    expect(sharedCoverActive.value).toBe(true);
    expect(overlayCount()).toBe(1);
  });

  it('未加载完成的封面不接管（避免浮层闪白）', () => {
    const { img } = mountCover();
    Object.defineProperty(img, 'complete', { value: false, configurable: true });

    beginSharedCover(img.parentElement);

    expect(img.style.visibility).toBe('');
    expect(sharedCoverActive.value).toBe(false);
    expect(overlayCount()).toBe(0);
  });

  it('已滚出视口的封面不接管', () => {
    const { host, img } = mountCover();
    img.getBoundingClientRect = () =>
      ({ top: -400, left: 0, width: 96, height: 144, bottom: -256, right: 96, x: 0, y: -400, toJSON: () => ({}) }) as DOMRect;

    beginSharedCover(host);

    expect(sharedCoverActive.value).toBe(false);
    expect(overlayCount()).toBe(0);
  });

  it('系统关闭动效时整条链路静默', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduced-motion'), media: query } as MediaQueryList),
    );
    const { img } = mountCover();

    beginSharedCover(img.parentElement);
    expect(sharedCoverActive.value).toBe(false);

    const stage = document.createElement('div');
    stage.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 360, height: 202, bottom: 202, right: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    await expect(finishSharedCover(stage)).resolves.toBeUndefined();
  });

  it('取消转场立即归位', () => {
    const { img } = mountCover();
    beginSharedCover(img.parentElement);
    cancelSharedCover();

    expect(img.style.visibility).toBe('');
    expect(sharedCoverActive.value).toBe(false);
    expect(overlayCount()).toBe(0);
  });

  it('没有进行中的转场时 finish 不做任何事', async () => {
    const stage = document.createElement('div');
    await expect(finishSharedCover(stage)).resolves.toBeUndefined();
    expect(sharedCoverActive.value).toBe(false);
  });

  it('动画卡住（页面不出帧）时看门狗仍会收尾', async () => {
    vi.useFakeTimers();
    const { host, img } = mountCover();
    beginSharedCover(host);

    const overlay = img.parentElement?.nextElementSibling as HTMLElement;
    const clone = overlay.querySelector('img') as HTMLImageElement;
    // 后台/节流标签页不出帧：Animation.finished 永不 resolve
    clone.animate = () => ({ finished: new Promise(() => {}) }) as unknown as Animation;

    const stage = document.createElement('div');
    stage.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 360, height: 202, bottom: 202, right: 360, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    const done = finishSharedCover(stage);
    await vi.advanceTimersByTimeAsync(900);
    await expect(done).resolves.toBeUndefined();

    expect(document.body.contains(overlay)).toBe(false);
    expect(img.style.visibility).toBe('');
    expect(sharedCoverActive.value).toBe(false);
    vi.useRealTimers();
  });
});
