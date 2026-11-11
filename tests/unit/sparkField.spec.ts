import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { attachSparkCanvas, burstSparks, SPARK_COUNT, __resetSparkField, __sparkCount, sparkCount } from '@/services/sparkField';
import { prefersReducedMotion } from '@/composables/useSpring';
import { isLowEndDevice } from '@/shared/deviceTier';

vi.mock('@/composables/useSpring', () => ({
  prefersReducedMotion: vi.fn(() => false),
}));
vi.mock('@/shared/deviceTier', () => ({
  isLowEndDevice: vi.fn(() => false),
  budgetAt: vi.fn((n: number) => n),
}));

/**
 * C-11 火花层（全页共享的单张 canvas）
 *
 * 这里管的是"别把页面拖垮"：降级时一个粒子都不该有，跑完必须自己停循环，
 * 卸载必须把 rAF 与 resize 监听一起还回去。
 */
const reducedMock = vi.mocked(prefersReducedMotion);
const lowEndMock = vi.mocked(isLowEndDevice);

interface FakeCtx {
  setTransform: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  arc: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  globalAlpha: number;
  fillStyle: string;
}

let ctx: FakeCtx;
let rafQueue: Map<number, FrameRequestCallback>;
let cancelled: number[];
let nextRafId = 1;
let getContextSpy: ReturnType<typeof vi.fn>;
let adds = 0;
let removes = 0;

function flushRaf(time: number): void {
  const pending = [...rafQueue.entries()];
  rafQueue.clear();
  for (const [id, fn] of pending) {
    if (cancelled.includes(id)) continue;
    fn(time);
  }
}

function makeCanvas(): HTMLCanvasElement {
  const el = document.createElement('canvas');
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 800 });
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 400, bottom: 800, x: 0, y: 0, width: 400, height: 800, toJSON: () => ({}) }) as DOMRect;
  return el;
}

beforeEach(() => {
  ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    globalAlpha: 1,
    fillStyle: '',
  };
  getContextSpy = vi.fn(() => ctx);
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = getContextSpy;

  rafQueue = new Map();
  cancelled = [];
  nextRafId = 1;
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((fn) => {
    const id = nextRafId++;
    rafQueue.set(id, fn);
    return id;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    cancelled.push(id);
    rafQueue.delete(id);
  });

  adds = 0;
  removes = 0;
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, ...rest: unknown[]) => {
    if (type === 'resize') adds += 1;
    (add as (t: string, ...r: unknown[]) => void)(type, ...rest);
  }) as typeof window.addEventListener);
  vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, ...rest: unknown[]) => {
    if (type === 'resize') removes += 1;
    (remove as (t: string, ...r: unknown[]) => void)(type, ...rest);
  }) as typeof window.removeEventListener);

  reducedMock.mockReturnValue(false);
  lowEndMock.mockReturnValue(false);
  __resetSparkField();
});

afterEach(() => {
  __resetSparkField();
  vi.restoreAllMocks();
});

describe('sparkField · 降级闸门', () => {
  it('正常档位放满额粒子；减少动效与低端机一个都不放', () => {
    expect(sparkCount()).toBe(SPARK_COUNT);
    reducedMock.mockReturnValue(true);
    expect(sparkCount()).toBe(0);
    reducedMock.mockReturnValue(false);
    lowEndMock.mockReturnValue(true);
    expect(sparkCount()).toBe(0);
  });

  it('画布没挂载时 burst 直接返回 0，不建循环', () => {
    expect(burstSparks(10, 20)).toBe(0);
    expect(__sparkCount()).toBe(0);
    expect(rafQueue.size).toBe(0);
  });

  it('降级机型即使挂了画布也不撒粒子', () => {
    attachSparkCanvas(makeCanvas());
    lowEndMock.mockReturnValue(true);
    expect(burstSparks(10, 20)).toBe(0);
    expect(__sparkCount()).toBe(0);
  });
});

describe('sparkField · 生命周期', () => {
  it('一次 burst = 一簇粒子 + 一个 rAF 循环', () => {
    attachSparkCanvas(makeCanvas());
    expect(burstSparks(100, 200)).toBe(SPARK_COUNT);
    expect(__sparkCount()).toBe(SPARK_COUNT);
    expect(rafQueue.size).toBe(1);
    expect(ctx.setTransform).toHaveBeenCalled();
  });

  it('两次 burst 共用同一个循环（全页始终只有一张画布在跑）', () => {
    attachSparkCanvas(makeCanvas());
    burstSparks(10, 10);
    flushRaf(16);
    burstSparks(20, 20);
    expect(__sparkCount()).toBe(SPARK_COUNT * 2);
    expect(rafQueue.size).toBeLessThanOrEqual(1);
  });

  it('粒子在 800ms 收尾预算内散尽，之后循环不再空转', () => {
    attachSparkCanvas(makeCanvas());
    burstSparks(10, 10);
    let t = 0;
    while (__sparkCount() > 0 && t < 1600) {
      t += 16;
      flushRaf(t);
    }
    expect(t).toBeLessThanOrEqual(800);
    expect(__sparkCount()).toBe(0);
    expect(rafQueue.size).toBe(0);
    expect(ctx.clearRect).toHaveBeenCalled();
  });

  it('卸载交还画布：撤销循环并摘掉 resize 监听', () => {
    attachSparkCanvas(makeCanvas());
    expect(adds).toBe(1);
    burstSparks(10, 10);
    expect(__sparkCount()).toBe(SPARK_COUNT);

    attachSparkCanvas(null);
    expect(__sparkCount()).toBe(0);
    expect(removes).toBe(1);
    expect(cancelled).toContain(1);
  });
});
