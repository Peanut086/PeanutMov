/**
 * 弹幕层几何跟随（背板尺寸 vs 容器 CSS 盒子）
 *
 * 真机现象：第一次播放弹幕字号不对，关掉再打开就好了。原因是 canvas 的
 * `width:100%;height:100%` 会自己跟容器，背板像素只在 `attach()` 量过一次；
 * 竖屏 16:9 画面带 → 沉浸态铺满 这跳尺寸差就把整块贴图拉伸，字跟着变形。
 * 关掉重开之所以能治好，是因为那条路会重建 overlay 并重测。
 *
 * 这里断言的是「重测」本身：
 * 1. 挂载按当下容器尺寸建背板（像素比上限 2）；
 * 2. 容器变大后备板跟上新尺寸（`canvasSize` 同步——智能配色按它铺亮度场）；
 * 3. 尺寸没变不空跑：给 width/height 赋值会清空画布，逐帧追几何时不能每帧都付这个代价；
 * 4. 落定窗口跑完就收手，新一次几何事件才重新开窗；
 * 5. `detach()` 把观察器与窗口事件全部摘掉，残留事件不再重测；
 * 6. 重挂（含同尺寸重挂）必须重建背板：缓存的几何键要作废，否则新 canvas 停在默认 300×150。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DanmakuOverlay } from '@/player/DanmakuOverlay';
import type { DanmakuSettings } from '@/types';

/** 竖屏画面带（16:9） */
const PORTRAIT = { width: 720, height: 405 };
/** 沉浸态铺满 */
const IMMERSIVE = { width: 1280, height: 720 };
const DPR = 2;
/** 一帧 16ms，130 帧 = 2080ms：刚好越过 2000ms 的落定窗口，用它验证「追到稳定就收手」 */
const SETTLE_FRAMES = 130;

const SETTINGS: DanmakuSettings = {
  enabled: true,
  fontSize: 16,
  opacity: 0.8,
  speed: 1,
  areaPercent: 50,
  merge: true,
  safeBottomPercent: 15,
  bold: false,
  strokeStyle: 'shadow',
  density: 'normal',
  filterTop: false,
  filterBottom: false,
  interactive: true,
  autoContrast: true,
};

const ctx = { transforms: 0 };
let clockMs = 0;
let stageRect = { ...PORTRAIT };
/** rAF 桩按 id 存取：cancel 全清会把漏网的逐帧轮询一起抹掉，测不出泄漏 */
const pendingFrames = new Map<number, (t: number) => void>();
let rafSeq = 0;
/** ResizeObserver 桩：留住回调与目标，测试自己触发，并按 disconnect 计数判泄漏 */
let observerCb: (() => void) | null = null;
let observed: Element[] = [];
let disconnected = 0;
/** 每条用例挂上的 overlay：afterEach 统一 detach，中途失败的用例不能把监听漏给后面 */
const live = new Set<DanmakuOverlay>();

class ResizeObserverStub {
  constructor(cb: () => void) {
    observerCb = cb;
  }
  observe(el: Element): void {
    observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    disconnected += 1;
  }
}

function rectOf(): DOMRect {
  return {
    left: 0,
    top: 0,
    right: stageRect.width,
    bottom: stageRect.height,
    width: stageRect.width,
    height: stageRect.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 手动喂帧：推进 16ms 假时钟并跑掉当前排队的帧 */
function pump(frames = 1): void {
  for (let i = 0; i < frames; i++) {
    clockMs += 16;
    const due = [...pendingFrames.values()];
    pendingFrames.clear();
    due.forEach((cb) => cb(clockMs));
  }
}

/** 容器换成新尺寸，并按真机顺序走一遍：几何事件 → 逐帧追到落定 */
function resizeTo(next: { width: number; height: number }): void {
  stageRect = { ...next };
  observerCb?.();
  pump(SETTLE_FRAMES);
}

function mount(): DanmakuOverlay {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const overlay = new DanmakuOverlay({
    settings: SETTINGS,
    getTime: () => 0,
    // 暂停态：绘制时间就是 getTime()，几何可精确断言
    isPlaying: () => false,
    getRate: () => 1,
  });
  live.add(overlay);
  overlay.attach(container);
  return overlay;
}

function canvas(): HTMLCanvasElement {
  const el = document.querySelector('canvas.danmaku-overlay');
  if (el === null) throw new Error('弹幕 canvas 不在文档里');
  return el as HTMLCanvasElement;
}

function canvasOrNull(): HTMLCanvasElement | null {
  return document.querySelector('canvas.danmaku-overlay');
}

/** 换一个新容器重挂（真机上容器都在文档里，脱离文档就查不到 canvas） */
function reattach(overlay: DanmakuOverlay): HTMLCanvasElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  overlay.attach(container);
  return canvas();
}

beforeEach(() => {
  ctx.transforms = 0;
  clockMs = 0;
  stageRect = { ...PORTRAIT };
  pendingFrames.clear();
  rafSeq = 0;
  observerCb = null;
  observed = [];
  disconnected = 0;
  live.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafSeq += 1;
    pendingFrames.set(rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    pendingFrames.delete(id);
  });
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('devicePixelRatio', DPR);
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rectOf);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  // 本文件不 load 弹幕，位图那条路不走：setTransform 只有 resize() 会调，用它数重测次数
  Object.assign(ctx, {
    setTransform: () => {
      ctx.transforms += 1;
    },
    clearRect: () => {},
    measureText: (text: string) => ({ width: text.length * 8 }),
    drawImage: () => {},
    fillText: () => {},
    strokeText: () => {},
  });
});

afterEach(() => {
  // 先 detach 再撤桩：中途失败的用例不该把窗口监听漏给后面
  for (const overlay of [...live].reverse()) overlay.detach();
  live.clear();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DanmakuOverlay 几何跟随', () => {
  it('挂载即按当下容器尺寸与像素比建背板', () => {
    mount();
    expect(canvas().width).toBe(PORTRAIT.width * DPR);
    expect(canvas().height).toBe(PORTRAIT.height * DPR);
  });

  it('观察器盯的是弹幕 canvas 本身（它的盒子就等于画面带）', () => {
    mount();
    expect(observed).toEqual([canvas()]);
  });

  it('竖屏画面带 → 沉浸态铺满：背板跟上新尺寸，字号不再被拉伸', () => {
    const overlay = mount();
    expect(ctx.transforms).toBe(1);

    resizeTo(IMMERSIVE);

    expect(canvas().width).toBe(IMMERSIVE.width * DPR);
    expect(canvas().height).toBe(IMMERSIVE.height * DPR);
    // 智能配色按 canvasSize 铺亮度场，它必须跟着变成新尺寸，否则色带同样错位
    expect(overlay.canvasSize).toEqual({ width: IMMERSIVE.width, height: IMMERSIVE.height });
    expect(ctx.transforms).toBe(2);
  });

  it('尺寸没变不空跑：逐帧追几何不重复清画布', () => {
    mount();
    const before = ctx.transforms;

    observerCb?.();
    pump(SETTLE_FRAMES);
    window.dispatchEvent(new Event('resize'));
    pump(SETTLE_FRAMES);

    expect(ctx.transforms).toBe(before);
  });

  it('落定窗口跑完就收手：窗口过后静默改尺寸不空转，新事件才重新开窗', () => {
    mount();
    resizeTo(IMMERSIVE);
    expect(canvas().width).toBe(IMMERSIVE.width * DPR);

    const after = ctx.transforms;
    stageRect = { width: 900, height: 506 };
    pump(SETTLE_FRAMES);
    expect(ctx.transforms).toBe(after);

    observerCb?.();
    pump(2);
    expect(canvas().width).toBe(900 * DPR);
  });

  it('窗口事件驱动的同样跟得上（旋屏只报 orientationchange / 全屏只报 fullscreenchange）', () => {
    mount();
    stageRect = { ...IMMERSIVE };
    window.dispatchEvent(new Event('orientationchange'));
    pump(SETTLE_FRAMES);
    expect(canvas().height).toBe(IMMERSIVE.height * DPR);

    stageRect = { width: 900, height: 506 };
    document.dispatchEvent(new Event('fullscreenchange'));
    pump(SETTLE_FRAMES);
    expect(canvas().width).toBe(900 * DPR);
  });

  it('像素比变化也重测（CSS 尺寸不变时背板仍要跟着换）', () => {
    const overlay = mount();
    vi.stubGlobal('devicePixelRatio', 1);

    observerCb?.();
    pump(SETTLE_FRAMES);

    expect(canvas().width).toBe(PORTRAIT.width);
    expect(overlay.canvasSize.width).toBe(PORTRAIT.width);
  });

  it('detach 摘干净：观察器断开、画布出文档，残留事件不再重测', () => {
    const overlay = mount();
    const before = ctx.transforms;
    overlay.detach();

    expect(disconnected).toBe(1);
    expect(canvasOrNull()).toBeNull();

    stageRect = { ...IMMERSIVE };
    observerCb?.();
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('orientationchange'));
    document.dispatchEvent(new Event('fullscreenchange'));
    pump(SETTLE_FRAMES);

    expect(ctx.transforms).toBe(before);
  });

  it('同尺寸重挂也重建背板：缓存的几何键必须作废', () => {
    const overlay = mount();
    // 新 canvas 的 width/height 是默认的 300×150：键没作废就停在这儿，整块贴图被拉满屏
    expect(reattach(overlay).width).toBe(PORTRAIT.width * DPR);
  });

  it('换容器重挂遇到新尺寸：按新尺寸重建', () => {
    const overlay = mount();
    overlay.detach();
    stageRect = { ...IMMERSIVE };

    const canvasAfter = reattach(overlay);

    expect(canvasAfter.width).toBe(IMMERSIVE.width * DPR);
    expect(overlay.canvasSize.height).toBe(IMMERSIVE.height);
  });

  it('重挂只留一份观察器：多次 attach 不叠监听', () => {
    const overlay = mount();
    reattach(overlay);

    expect(disconnected).toBe(1);
    expect(observed.length).toBe(2);
    const before = ctx.transforms;
    resizeTo(PORTRAIT);
    // 只有最新那份观察器在工作：一次事件不该被多份回调重复触发
    expect(ctx.transforms).toBeLessThanOrEqual(before + 1);
  });
});
