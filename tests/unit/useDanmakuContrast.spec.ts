/**
 * 弹幕智能配色驱动层的取样生命周期（P1-4）
 *
 * 要证明的是「无效 surface 时真的停表」「恢复后真的再采」「过期帧不贴到新画面上」，
 * 所以定时器换成可观测注册表：`periods` 就是当前在跑的频率（333=取样，1000=恢复探测），
 * `timers.size` 就是表在不在；桥回执由 `bridge` 手工摆布，代次事件直接喂给监听器。
 *
 * happy-dom 没有真画布：WebView 那条路的 `getContext('2d')` 换成假上下文，
 * `reads` 就是像素回读次数（探测阶段必须为 0）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick, ref, shallowRef, type Ref } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';

import { useDanmakuContrast, type DanmakuContrastBlockReason } from '@/composables/useDanmakuContrast';
import { LUMA_CELLS, LUMA_COLS, LUMA_ROWS, type LumaField } from '@/player/danmakuContrast';
import type { DanmakuOverlay } from '@/player/DanmakuOverlay';
import { logger } from '@/shared/logger';
import type { ResizeMode } from '@/types';

const SAMPLE_PERIOD = 333;
const PROBE_PERIOD = 1000;
const FULL_BOX = { left: 0, top: 0, width: 1, height: 1 };

function cells(value = 120): number[] {
  return new Array<number>(LUMA_CELLS).fill(value);
}

/** 原生桥的可控替身：回执、异常、挂住、代次事件监听器都在这里 */
const bridge = vi.hoisted(() => ({
  result: {} as Record<string, unknown>,
  error: null as Error | null,
  hang: false,
  resolve: null as null | ((result: unknown) => void),
  calls: 0,
  lastOpts: null as null | { cols: number; rows: number },
  listeners: [] as Array<(data: Record<string, unknown>) => void>,
}));

vi.mock('@/native/exoPlayerPlugin', () => ({
  ExoPlayer: {
    sampleFrameLuma: vi.fn(async (opts: { cols: number; rows: number }) => {
      bridge.calls += 1;
      bridge.lastOpts = opts;
      if (bridge.error) throw bridge.error;
      if (bridge.hang) return new Promise((resolve) => (bridge.resolve = resolve));
      return bridge.result;
    }),
    addListener: vi.fn(async (_name: string, cb: (data: Record<string, unknown>) => void) => {
      bridge.listeners.push(cb);
      return {
        remove: async () => {
          const i = bridge.listeners.indexOf(cb);
          if (i >= 0) bridge.listeners.splice(i, 1);
        },
      };
    }),
  },
}));

/** 推给渲染层的亮度场序列：null = 交还原色 */
let pushed: Array<LumaField | null> = [];
let reads = 0;
let tainted = false;

class FakeCtx {
  drawImage = vi.fn(() => {
    if (tainted) throw new DOMException('The operation is insecure.', 'SecurityError');
  });
  getImageData = vi.fn(() => {
    reads += 1;
    const data = new Uint8ClampedArray(LUMA_COLS * LUMA_ROWS * 4);
    data.fill(180);
    return { data };
  });
  setTransform = vi.fn();
  clearRect = vi.fn();
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

function fireTimers(): void {
  for (const fn of [...timers.values()]) fn();
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    fireTimers();
    await flush();
  }
}

function emitSurface(generation: number, valid: boolean): void {
  for (const cb of [...bridge.listeners]) cb({ state: 'surface', generation, valid });
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  document.dispatchEvent(new Event('visibilitychange'));
}

interface Harness {
  api: { blocked: Ref<DanmakuContrastBlockReason | null> };
  enabled: Ref<boolean>;
  native: Ref<boolean>;
  wrapper: VueWrapper;
  setVideoPresent: (present: boolean) => void;
  setVideoReady: (ready: boolean) => void;
}

let mounted: VueWrapper | null = null;

function boot(options: { native?: boolean; enabled?: boolean; video?: boolean } = {}): Harness {
  const stage = ref<HTMLElement | null>(null);
  const overlay = shallowRef<DanmakuOverlay | null>({
    canvasSize: { width: 640, height: 360 },
    setLumaField: (field: LumaField | null) => pushed.push(field),
  } as unknown as DanmakuOverlay);
  const enabled = ref(options.enabled ?? true);
  const native = ref(options.native ?? true);
  const resizeMode = ref<ResizeMode>('contain');
  const playing = ref(true);
  const videoPresent = ref(options.video ?? false);
  let api!: Harness['api'];

  const wrapper = mount(
    defineComponent({
      setup() {
        api = useDanmakuContrast({
          overlay,
          stage,
          enabled,
          native,
          resizeMode,
          isPlaying: () => playing.value,
        });
        return () => h('div', [h('div', { ref: stage }, videoPresent.value ? [h('video')] : [])]);
      },
    }),
    { attachTo: document.body },
  );
  mounted = wrapper;

  return {
    api,
    enabled,
    native,
    wrapper,
    setVideoPresent: (present) => {
      videoPresent.value = present;
    },
    setVideoReady: (ready) => {
      const el = wrapper.find('video').element;
      Object.defineProperty(el, 'videoWidth', { configurable: true, value: ready ? 1280 : 0 });
      Object.defineProperty(el, 'videoHeight', { configurable: true, value: ready ? 720 : 0 });
      Object.defineProperty(el, 'readyState', { configurable: true, value: ready ? 4 : 0 });
    },
  };
}

function fieldCount(): number {
  return pushed.filter((f) => f !== null).length;
}

beforeEach(() => {
  setVisibility('visible');
  timers.clear();
  periods.clear();
  timerId = 0;
  pushed = [];
  reads = 0;
  tainted = false;
  bridge.result = { available: true, generation: 1, cells: cells(), box: FULL_BOX };
  bridge.error = null;
  bridge.hang = false;
  bridge.resolve = null;
  bridge.calls = 0;
  bridge.lastOpts = null;
  bridge.listeners = [];

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
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

  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, writable: true, value: 8 });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
});

describe('useDanmakuContrast 取样与停表（P1-4）', () => {
  it('原生引擎按 3Hz 取样，亮度场按 32×18 推给渲染层', async () => {
    const h1 = boot({ native: true });
    expect([...periods.values()]).toEqual([SAMPLE_PERIOD]);

    await tick(1);
    expect(bridge.calls).toBe(1);
    expect(bridge.lastOpts).toEqual({ cols: LUMA_COLS, rows: LUMA_ROWS });
    expect(fieldCount()).toBe(1);
    expect(pushed[0]?.cells).toHaveLength(LUMA_CELLS);
    expect(h1.api.blocked.value).toBeNull();
  });

  it('surface 无效：停掉取样轮询并交还原色，但不判死（只留 1Hz 恢复探测）', async () => {
    const h1 = boot({ native: true });
    await tick(1);
    expect(fieldCount()).toBe(1);

    bridge.result = { available: false, surfaceInvalid: true, generation: 2 };
    await tick(1);

    expect([...periods.values()]).toEqual([PROBE_PERIOD]);
    expect(pushed[pushed.length - 1]).toBeNull();
    expect(h1.api.blocked.value).toBeNull();

    const calls = bridge.calls;
    await tick(2);
    // 探测只问状态：频率降到 1Hz，且不再有任何亮度场推出去
    expect(bridge.calls).toBe(calls + 2);
    expect(fieldCount()).toBe(1);
  });

  it('原生 surface 事件说恢复了：立刻重新起取样时钟并继续推场', async () => {
    boot({ native: true });
    await tick(1);
    bridge.result = { available: false, surfaceInvalid: true, generation: 2 };
    await tick(1);
    expect([...periods.values()]).toEqual([PROBE_PERIOD]);

    bridge.result = { available: true, generation: 3, cells: cells(90), box: FULL_BOX };
    emitSurface(3, true);
    expect([...periods.values()]).toEqual([SAMPLE_PERIOD]);

    await tick(1);
    expect(fieldCount()).toBe(2);
  });

  it('页面不可见：停表且不再过桥；回前台自动恢复取样', async () => {
    boot({ native: true });
    await tick(1);
    const calls = bridge.calls;

    setVisibility('hidden');
    expect(timers.size).toBe(0);
    expect(pushed[pushed.length - 1]).toBeNull();
    await tick(5);
    expect(bridge.calls).toBe(calls);

    setVisibility('visible');
    expect([...periods.values()]).toEqual([SAMPLE_PERIOD]);
    await tick(1);
    expect(bridge.calls).toBe(calls + 1);
    expect(fieldCount()).toBe(2);
  });

  it('抓帧期间 surface 换代：属于上一代的亮度场不推给渲染层', async () => {
    boot({ native: true });
    await tick(1);
    expect(fieldCount()).toBe(1);

    // 让这一轮抓帧挂在桥上，期间原生报"换了一代 surface"
    bridge.hang = true;
    fireTimers();
    await flush();
    expect(bridge.resolve).not.toBeNull();
    emitSurface(5, true);

    const resolve = bridge.resolve;
    bridge.hang = false;
    bridge.resolve = null;
    resolve?.({ available: true, generation: 1, cells: cells(200), box: FULL_BOX });
    await flush();

    expect(fieldCount()).toBe(1);
  });

  it('桥异常（老安装包没有该方法）：判为永久不通并撤表', async () => {
    bridge.error = new Error('ExoPlayer.sampleFrameLuma is not implemented');
    const h1 = boot({ native: true });

    await tick(1);
    expect(h1.api.blocked.value).toBe('unsupported');
    expect(timers.size).toBe(0);
  });

  it('卸载：撤表并解绑 surface 监听，不留悬挂订阅', async () => {
    const h1 = boot({ native: true });
    await tick(1);
    expect(bridge.listeners).toHaveLength(1);

    h1.wrapper.unmount();
    mounted = null;
    expect(timers.size).toBe(0);
    expect(bridge.listeners).toHaveLength(0);
  });
});

describe('useDanmakuContrast WebView 取样路（P1-4）', () => {
  it('换集重建途中找不到 video：挂起而不是判死，元素回来就恢复', async () => {
    const h1 = boot({ native: false, video: false });
    await tick(20);

    expect(h1.api.blocked.value).toBeNull();
    expect([...periods.values()]).toEqual([PROBE_PERIOD]);
    expect(reads).toBe(0);

    h1.setVideoPresent(true);
    await nextTick();
    h1.setVideoReady(true);
    await tick(1); // 探测发现元素回来了
    expect([...periods.values()]).toEqual([SAMPLE_PERIOD]);

    await tick(1);
    expect(reads).toBe(1);
    expect(fieldCount()).toBe(1);
  });

  it('画布被跨域视频污染：这才是永久不通，报 tainted 并撤表', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    tainted = true;
    const h1 = boot({ native: false, video: true });
    h1.setVideoReady(true);

    await tick(1);
    expect(h1.api.blocked.value).toBe('tainted');
    expect(timers.size).toBe(0);
    // 永久不通是唯一会落到日志页的取样结论（每实例只一次），取证靠它补 stopReason
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][1]).toMatchObject({ reason: 'tainted' });
    warn.mockRestore();
  });
});