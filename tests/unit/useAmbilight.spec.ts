/**
 * 画面氛围光的驱动（C-09 · 取样定时器层）
 *
 * 要证明的是「关得干净」和「拿不到帧时不装死」，所以定时器不用假时钟，直接换成
 * 可观测的注册表：`timers.size` 就是取样定时器在不在，`periods` 就是频率。
 *
 * happy-dom 没有真画布，所有 `getContext('2d')` 都换成假上下文：
 * - 像素回读次数（`reads`）就是"取样到底发生了几次"；
 * - 光晕元素自己的 `fills / clears` 证明画面层画了、撤了。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

import { prefersReducedMotion } from '@/composables/useSpring';
import { useAmbilight, type AmbilightApi } from '@/composables/useAmbilight';
import type { AmbilightEdges } from '@/player/AmbilightSampler';

vi.mock('@/composables/useSpring', () => ({
  prefersReducedMotion: vi.fn(() => false),
}));

const reducedMock = vi.mocked(prefersReducedMotion);

const SAMPLE_W = 32;
const SAMPLE_H = 18;
/** 高端机 8Hz；低端机（≤4 核）4Hz */
const HIGH_PERIOD = 125;

/** 当前喂给取样画布的像素——换色调的用例直接改它 */
let frame = solidFrame(220, 40, 40);
/** 全局像素回读次数：只有取样画布会读像素 */
let reads = 0;
/** 模拟「这条路根本拿不到像素」的两种失败 */
let tainted = false;
let undrawable = false;

function solidFrame(r: number, g: number, b: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return px;
}

class FakeCtx {
  clears = 0;
  fills = 0;
  fillStyle: unknown = null;
  drawImage = vi.fn(() => {
    if (undrawable) throw new Error('source not drawable');
  });
  getImageData = vi.fn(() => {
    if (tainted) throw new DOMException('The operation is insecure.', 'SecurityError');
    reads += 1;
    return { data: frame };
  });
  createLinearGradient = vi.fn(() => ({ addColorStop: vi.fn() }));
  clearRect = vi.fn(() => {
    this.clears += 1;
  });
  fillRect = vi.fn(() => {
    this.fills += 1;
  });
  save = vi.fn();
  restore = vi.fn();
}

const ctxByCanvas = new WeakMap<object, FakeCtx>();

function ctxFor(el: object): FakeCtx {
  let c = ctxByCanvas.get(el);
  if (!c) {
    c = new FakeCtx();
    ctxByCanvas.set(el, c);
  }
  return c;
}

// ---- 可观测的 setInterval ----
const timers = new Map<number, () => void>();
const periods = new Map<number, number>();
let timerId = 0;

function tick(times: number): void {
  for (let i = 0; i < times; i += 1) {
    for (const fn of [...timers.values()]) fn();
  }
}

/** 挂起后的恢复探测周期（只查元素，不读像素） */
const PROBE_PERIOD = 1000;

/** P1-4：页面生命周期用真的 visibilitychange 事件驱动，不伪造内部状态 */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

interface Harness {
  api: AmbilightApi;
  enabled: { value: boolean };
  intensity: { value: number };
  native: { value: boolean };
  glow: FakeCtx;
  setVideoReady: (ready: boolean) => void;
  /** 换集/换线会把 video 拆了重建：用它模拟元素消失与回来 */
  setVideoPresent: (present: boolean) => void;
}

function setup(options: { video?: boolean; enabled?: boolean; native?: boolean } = {}): {
  harness: Harness;
  wrapper: VueWrapper;
} {
  const host = ref<HTMLElement | null>(null);
  const canvas = ref<HTMLCanvasElement | null>(null);
  const enabled = ref(options.enabled ?? true);
  const intensity = ref(85);
  const native = ref(options.native ?? false);
  const withVideo = options.video !== false;
  const videoPresent = ref(withVideo);
  let api!: AmbilightApi;

  const wrapper = mount(
    defineComponent({
      setup() {
        api = useAmbilight({ host, canvas, enabled, intensity, native });
        return () =>
          h('div', [
            h('div', { ref: host }, videoPresent.value ? [h('video')] : []),
            enabled.value ? h('canvas', { ref: canvas }) : null,
          ]);
      },
    }),
    { attachTo: document.body },
  );

  return {
    wrapper,
    harness: {
      api,
      enabled,
      intensity,
      native,
      glow: ctxFor(wrapper.find('canvas').element),
      setVideoPresent: (present) => {
        videoPresent.value = present;
      },
      setVideoReady: (ready) => {
        const el = wrapper.find('video').element;
        Object.defineProperty(el, 'videoWidth', { configurable: true, value: ready ? 1280 : 0 });
        Object.defineProperty(el, 'readyState', { configurable: true, value: ready ? 4 : 0 });
      },
    },
  };
}

let mounted: VueWrapper | null = null;

function boot(options: { video?: boolean; enabled?: boolean; native?: boolean } = {}): Harness {
  const { harness, wrapper } = setup(options);
  mounted = wrapper;
  return harness;
}

beforeEach(() => {
  setVisibility('visible');
  timers.clear();
  periods.clear();
  timerId = 0;
  reads = 0;
  tainted = false;
  undrawable = false;
  frame = solidFrame(220, 40, 40);
  reducedMock.mockReturnValue(false);

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return ctxFor(this) as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
    timerId += 1;
    timers.set(timerId, fn);
    periods.set(timerId, ms ?? 0);
    return timerId as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id?: number) => {
    if (typeof id === 'number') {
      timers.delete(id);
      periods.delete(id);
    }
  }) as unknown as typeof clearInterval);

  Object.defineProperty(navigator, 'hardwareConcurrency', {
    configurable: true,
    writable: true,
    value: 8,
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
});

describe('useAmbilight 取样与关档', () => {
  it('挂载即按 8Hz 建定时器，一个周期内完成一次取样并画四条光带', () => {
    const h1 = boot();
    h1.setVideoReady(true);

    expect([...periods.values()]).toEqual([HIGH_PERIOD]);
    tick(1);
    expect(reads).toBe(1);
    expect(h1.api.edges.value).not.toBeNull();
    expect(h1.glow.fills).toBe(4);
  });

  it('色调变化在一个周期后跟上：重新清空并重画', () => {
    const h1 = boot();
    h1.setVideoReady(true);
    tick(1);
    expect((h1.api.edges.value as AmbilightEdges).top).toEqual([220, 40, 40]);

    frame = solidFrame(40, 90, 210);
    const fills = h1.glow.fills;
    const clears = h1.glow.clears;
    tick(1);

    expect((h1.api.edges.value as AmbilightEdges).top).toEqual([40, 90, 210]);
    expect(h1.glow.fills).toBe(fills + 4);
    expect(h1.glow.clears).toBeGreaterThan(clears);
  });

  it('原生引擎（DOM 里没有 video）：连续取不到帧后自动关闭并报 no-video', () => {
    const h1 = boot({ video: false, native: true });

    tick(11);
    expect(h1.api.blocked.value).toBeNull();
    expect(timers.size).toBe(1);

    tick(1);
    expect(h1.api.blocked.value).toBe('no-video');
    expect(timers.size).toBe(0);
    expect(h1.api.edges.value).toBeNull();
    // 关掉时光晕层要擦干净，不能留一坨旧色压在播放画面上
    const clears = h1.glow.clears;
    expect(clears).toBeGreaterThan(0);

    tick(30);
    expect(h1.glow.clears).toBe(clears);
  });

  it('画布被跨域视频污染：报 no-pixels 而不是抛错', () => {
    const h1 = boot();
    h1.setVideoReady(true);
    tick(1);

    tainted = true;
    expect(() => tick(1)).not.toThrow();
    expect(h1.api.blocked.value).toBe('no-pixels');
    expect(timers.size).toBe(0);
  });

  it('drawImage 直接失败（原生 surface）：同样报 no-pixels', () => {
    const h1 = boot();
    h1.setVideoReady(true);
    undrawable = true;

    tick(1);
    expect(h1.api.blocked.value).toBe('no-pixels');
    expect(reads).toBe(0);
  });

  it('首帧未到不算失败：等 3 秒也不自动关，且不做无谓的像素回读', () => {
    const h1 = boot();
    h1.setVideoReady(false);

    tick(24);
    expect(h1.api.blocked.value).toBeNull();
    expect(timers.size).toBe(1);
    expect(reads).toBe(0);

    h1.setVideoReady(true);
    tick(1);
    expect(h1.api.edges.value).not.toBeNull();
  });

  it('关掉开关：定时器立刻撤掉，光晕层清空，取样不再发生', async () => {
    const h1 = boot();
    h1.setVideoReady(true);
    tick(1);

    h1.enabled.value = false;
    await nextTick();

    expect(timers.size).toBe(0);
    // 一次来自绘制、一次来自关档擦除
    expect(h1.glow.clears).toBe(2);
    tick(5);
    expect(reads).toBe(1);
  });

  it('系统减少动态效果：不建定时器，直接报 blocked', () => {
    reducedMock.mockReturnValue(true);
    const h1 = boot();
    h1.setVideoReady(true);

    expect(h1.api.blocked.value).toBe('reduced-motion');
    expect(timers.size).toBe(0);
    tick(30);
    expect(reads).toBe(0);
  });

  it('低端机降频到 4Hz：功能不变，只是更省', () => {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      configurable: true,
      writable: true,
      value: 4,
    });
    const h1 = boot();
    h1.setVideoReady(true);

    expect([...periods.values()]).toEqual([250]);
    tick(1);
    expect(h1.glow.fills).toBe(4);
  });

  it('调强度当帧重画：不必等下一个取样周期', async () => {
    const h1 = boot();
    h1.setVideoReady(true);
    tick(1);
    const fills = h1.glow.fills;

    h1.intensity.value = 30;
    await nextTick();

    expect(h1.glow.fills).toBe(fills + 4);
    expect(reads).toBe(1);
  });

  it('自动关闭后重新打开：清掉 blocked 并重新起定时器', async () => {
    const h1 = boot({ video: false, native: true });
    tick(12);
    expect(h1.api.blocked.value).toBe('no-video');

    h1.enabled.value = false;
    await nextTick();
    h1.enabled.value = true;
    await nextTick();

    expect(h1.api.blocked.value).toBeNull();
    expect(timers.size).toBe(1);
  });
});

/**
 * P1-4：取样跟着页面生命周期与视频元素代次走。
 *
 * 旧实现只有"一直 8Hz 画"和"数满 12 次永久关档"两态：切后台仍在逐帧画渐变，
 * 换集把 video 拆了重建超过 1.5s 就把氛围光判死，回到前台/元素回来也不再恢复。
 */
describe('useAmbilight 取样生命周期（P1-4）', () => {
  it('页面不可见：停表并擦掉光晕，不再读像素；回前台自动恢复', () => {
    const h1 = boot();
    h1.setVideoReady(true);
    tick(1);
    expect(reads).toBe(1);
    const clears = h1.glow.clears;

    setVisibility('hidden');
    expect(timers.size).toBe(0);
    expect(h1.glow.clears).toBe(clears + 1);
    expect(h1.api.edges.value).toBeNull();
    // 停表不是判死：面板不该弹"氛围光不可用"
    expect(h1.api.blocked.value).toBeNull();
    tick(5);
    expect(reads).toBe(1);

    setVisibility('visible');
    expect(timers.size).toBe(1);
    expect([...periods.values()]).toEqual([HIGH_PERIOD]);
    tick(1);
    expect(reads).toBe(2);
    expect(h1.api.edges.value).not.toBeNull();
  });

  it('WebView 引擎换集重建：找不到 video 是挂起而不是判死，元素回来就恢复取样', async () => {
    const h1 = boot();
    h1.setVideoReady(true);
    tick(1);
    expect(reads).toBe(1);

    h1.setVideoPresent(false);
    await nextTick();
    tick(12);
    expect(h1.api.blocked.value).toBeNull();
    // 取样定时器撤掉，只留 1Hz 存在性探测
    expect(timers.size).toBe(1);
    expect([...periods.values()]).toEqual([PROBE_PERIOD]);
    const readsBefore = reads;
    tick(3);
    expect(reads).toBe(readsBefore);

    h1.setVideoPresent(true);
    await nextTick();
    h1.setVideoReady(true);
    tick(1); // 这一轮是探测：发现元素回来了，重新起取样时钟
    expect([...periods.values()]).toEqual([HIGH_PERIOD]);
    tick(1);
    expect(reads).toBe(readsBefore + 1);
    expect(h1.api.edges.value).not.toBeNull();
  });

  it('换了视频元素就是换了一代：旧光晕先擦掉，再按新画面重画', async () => {
    const h1 = boot();
    h1.setVideoReady(true);
    tick(1);
    const clears = h1.glow.clears;

    frame = solidFrame(40, 90, 210);
    h1.setVideoPresent(false);
    await nextTick();
    h1.setVideoPresent(true);
    await nextTick();
    h1.setVideoReady(true);
    tick(1);

    // 一次来自换代作废，一次来自本轮重画前的清空
    expect(h1.glow.clears).toBeGreaterThanOrEqual(clears + 2);
    expect((h1.api.edges.value as AmbilightEdges).top).toEqual([40, 90, 210]);
  });
});
