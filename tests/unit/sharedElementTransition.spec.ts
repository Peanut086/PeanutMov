import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginSharedCover,
  cancelSharedCover,
  finishSharedCover,
  finishSharedCoverRewind,
  rewindSharedCover,
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

  it('详情路由回顶后再采样目标，避免封面飞向旧滚动位置', async () => {
    const { host, img } = mountCover();
    beginSharedCover(host);
    const overlay = img.parentElement?.nextElementSibling as HTMLElement;
    const clone = overlay.querySelector('img') as HTMLImageElement;
    const calls = spyAnimate(clone);
    const stage = document.createElement('div');
    let targetTop = -1647;
    stage.getBoundingClientRect = () => rectBox(targetTop, 0, 430, 242)();
    document.body.appendChild(stage);

    const done = finishSharedCover(stage);
    requestAnimationFrame(() => {
      targetTop = 64;
    });
    await done;

    expect(calls).toHaveLength(1);
    expect(translationOf(calls[0])).toEqual({ x: -24, y: -56 });
    expect(document.body.contains(overlay)).toBe(false);
    expect(img.style.visibility).toBe('');
  });

  it('目标页不出帧时稳定采样也会撤层', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    const { host, img } = mountCover();
    beginSharedCover(host);
    const overlay = img.parentElement?.nextElementSibling as HTMLElement;
    const stage = document.createElement('div');
    stage.getBoundingClientRect = rectBox(64, 0, 430, 242);
    document.body.appendChild(stage);

    const done = finishSharedCover(stage);
    await vi.advanceTimersByTimeAsync(900);
    await expect(done).resolves.toBeUndefined();

    expect(document.body.contains(overlay)).toBe(false);
    expect(img.style.visibility).toBe('');
    expect(sharedCoverActive.value).toBe(false);
    vi.useRealTimers();
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
    document.body.appendChild(stage);

    const done = finishSharedCover(stage);
    await vi.advanceTimersByTimeAsync(900);
    await expect(done).resolves.toBeUndefined();

    expect(document.body.contains(overlay)).toBe(false);
    expect(img.style.visibility).toBe('');
    expect(sharedCoverActive.value).toBe(false);
    vi.useRealTimers();
  });
});

/* ---------- 返程：舞台 → 原卡片 ---------- */

function rectBox(top: number, left: number, width: number, height: number): () => DOMRect {
  return () =>
    ({
      top,
      left,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

/** 入口卡片：带 data-cover-key，返程时靠它重新定位（不持有元素引用） */
function mountCard(key: string, top = 300, loaded = true): { host: HTMLElement; img: HTMLImageElement } {
  const host = document.createElement('div');
  host.className = 'poster-image';
  host.setAttribute('data-cover-key', key);
  host.style.borderRadius = '14px';
  const img = document.createElement('img');
  img.src = 'https://cdn.example.com/poster.jpg';
  Object.defineProperty(img, 'complete', { value: loaded, configurable: true });
  Object.defineProperty(img, 'naturalWidth', { value: loaded ? 300 : 0, configurable: true });
  img.getBoundingClientRect = rectBox(top, 24, 96, 144);
  host.appendChild(img);
  document.body.appendChild(host);
  return { host, img };
}

function mountStage(): HTMLDivElement {
  const stage = document.createElement('div');
  stage.getBoundingClientRect = rectBox(60, 0, 360, 202);
  document.body.appendChild(stage);
  return stage;
}

function lastOverlay(): { overlay: HTMLElement; clone: HTMLImageElement } {
  const overlay = document.body.lastElementChild as HTMLElement;
  return { overlay, clone: overlay.querySelector('img') as HTMLImageElement };
}

/** 记录 animate 收到的关键帧，替代 happy-dom 缺失的 WAAPI */
function spyAnimate(el: HTMLElement): (Keyframe[] | undefined)[] {
  const calls: (Keyframe[] | undefined)[] = [];
  el.animate = ((frames: Keyframe[]) => {
    calls.push(frames);
    return { finished: Promise.resolve() } as unknown as Animation;
  }) as HTMLElement['animate'];
  return calls;
}

function translationOf(frames: Keyframe[] | undefined): { x: number; y: number } {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(String(frames?.[1]?.transform ?? ''));
  return { x: Number(match?.[1]), y: Number(match?.[2]) };
}

describe('useSharedElement · 返回反向共享元素', () => {
  beforeEach(() => {
    // 横向可见性判定要用到 clientWidth，happy-dom 同样恒为 0
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 360, configurable: true });
  });

  it('返回前立浮层，进场后收回卡片当前位置并交回真图', async () => {
    const card = mountCard('src1:item1', 300);
    const stage = mountStage();

    rewindSharedCover(stage, 'src1:item1', 'https://cdn.example.com/poster.jpg');
    expect(sharedCoverActive.value).toBe(true);
    expect(overlayCount()).toBe(1);

    const { overlay, clone } = lastOverlay();
    const calls = spyAnimate(clone);
    await finishSharedCoverRewind();

    expect(calls).toHaveLength(1);
    const frames = calls[0]!;
    expect(clone.style.top).toBe('60px');
    expect(clone.style.width).toBe('360px');
    expect(frames[0]).toMatchObject({ transform: 'translate(0px, 0px) scale(1)' });
    expect(frames[1]).not.toHaveProperty('top');
    expect(translationOf(frames)).toEqual({ x: 24, y: 240 });
    expect(document.body.contains(overlay)).toBe(false);
    expect(sharedCoverActive.value).toBe(false);
    // 卡片图只是临时隐身，收尾必须原样还回去
    expect(card.img.style.visibility).toBe('');
  });

  it('卡片随列表滚动换位时，落点是当前位置而不是原始位置', async () => {
    const card = mountCard('m1', 620);
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');

    const { clone } = lastOverlay();
    const calls = spyAnimate(clone);
    card.img.getBoundingClientRect = rectBox(620, 24, 96, 144);
    await finishSharedCoverRewind();

    expect(translationOf(calls[0])).toEqual({ x: 24, y: 560 });
  });

  it('动画已启动后卡片再换位，返程落点必须跟着最新位置', async () => {
    const card = mountCard('m1', 300);
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');

    const { clone } = lastOverlay();
    const calls: (Keyframe[] | undefined)[] = [];
    let releaseFirst: (() => void) | undefined;
    clone.animate = ((frames: Keyframe[]) => {
      calls.push(frames);
      if (calls.length === 1) {
        card.img.getBoundingClientRect = rectBox(620, 24, 96, 144);
        window.dispatchEvent(new Event('scroll'));
        return {
          finished: new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
          cancel: vi.fn(),
        } as unknown as Animation;
      }
      return { finished: Promise.resolve(), cancel: vi.fn() } as unknown as Animation;
    }) as HTMLElement['animate'];

    const done = finishSharedCoverRewind();
    await new Promise((resolve) => setTimeout(resolve, 350));
    releaseFirst?.();
    await done;

    expect(calls.length).toBeGreaterThan(1);
    expect(translationOf(calls.at(-1))).toEqual({ x: 24, y: 560 });
  });

  it('返程动画被新导航取消时恢复卡片可见性', async () => {
    const card = mountCard('m1', 300);
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');
    const { overlay, clone } = lastOverlay();
    let started!: () => void;
    const animationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    clone.animate = (() => {
      started();
      let reject!: (reason?: unknown) => void;
      const finished = new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
      return { finished, cancel: () => reject() } as unknown as Animation;
    }) as HTMLElement['animate'];

    const done = finishSharedCoverRewind();
    await animationStarted;
    expect(card.img.style.visibility).toBe('hidden');
    beginSharedCover(document.createElement('div'));
    await done;

    expect(card.img.style.visibility).toBe('');
    expect(document.body.contains(overlay)).toBe(false);
    expect(sharedCoverActive.value).toBe(false);
  });

  it('目标页没有出现时原地撤层，不飞错位图', async () => {
    const stage = mountStage();
    rewindSharedCover(stage, 'gone', 'https://cdn.example.com/poster.jpg');
    const { overlay, clone } = lastOverlay();
    const calls = spyAnimate(clone);

    await finishSharedCoverRewind();

    expect(calls).toHaveLength(0);
    expect(document.body.contains(overlay)).toBe(false);
    expect(sharedCoverActive.value).toBe(false);
  });

  it('卡片被虚拟列表回收（无 data-cover-key）时同样只撤层', async () => {
    mountCard('other', 300);
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');

    const { clone } = lastOverlay();
    const calls = spyAnimate(clone);
    await finishSharedCoverRewind();

    expect(calls).toHaveLength(0);
    expect(sharedCoverActive.value).toBe(false);
  });

  it('卡片已滚出视口时不飞过去', async () => {
    // 视口 800px：top=5200 在屏幕下方，飞行目标无意义
    mountCard('m1', 5200);
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');

    const { overlay, clone } = lastOverlay();
    const calls = spyAnimate(clone);
    await finishSharedCoverRewind();

    expect(calls).toHaveLength(0);
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('详情页刚重建、海报还没解码完时等到就绪再飞', async () => {
    const card = mountCard('m1', 300, false);
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');
    const { clone } = lastOverlay();
    const calls = spyAnimate(clone);

    setTimeout(() => {
      Object.defineProperty(card.img, 'complete', { value: true, configurable: true });
      Object.defineProperty(card.img, 'naturalWidth', { value: 300, configurable: true });
    }, 60);

    await finishSharedCoverRewind();

    expect(calls).toHaveLength(1);
    expect(translationOf(calls[0])).toEqual({ x: 24, y: 240 });
    expect(card.img.style.visibility).toBe('');
  });

  it('没有海报或没有封面 id 时不建浮层（返回行为与现状一致）', () => {
    const stage = mountStage();
    rewindSharedCover(stage, null, 'https://cdn.example.com/poster.jpg');
    rewindSharedCover(stage, 'm1', null);
    expect(overlayCount()).toBe(0);
    expect(sharedCoverActive.value).toBe(false);
  });

  it('系统关闭动效时返程整体静默', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: query.includes('reduced-motion'), media: query } as MediaQueryList),
    );
    mountCard('m1');
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');

    expect(overlayCount()).toBe(0);
    expect(sharedCoverActive.value).toBe(false);
  });

  it('目标页永不出现时看门狗清场', async () => {
    vi.useFakeTimers();
    const stage = mountStage();
    rewindSharedCover(stage, 'never', 'https://cdn.example.com/poster.jpg');
    expect(overlayCount()).toBe(1);

    vi.advanceTimersByTime(2600);

    expect(overlayCount()).toBe(0);
    expect(sharedCoverActive.value).toBe(false);
    vi.useRealTimers();
  });

  it('返程浮层未散时再次进入，先撤旧层不允许两张封面叠加', () => {
    const from = mountCard('m1', 300);
    const stage = mountStage();
    rewindSharedCover(stage, 'm1', 'https://cdn.example.com/poster.jpg');
    expect(overlayCount()).toBe(1);

    beginSharedCover(from.host);

    // 去程浮层接管，返程浮层已被撤掉：仍然只有一层
    expect(overlayCount()).toBe(1);
    expect(sharedCoverActive.value).toBe(true);
  });
});
