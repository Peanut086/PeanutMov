/**
 * 画面氛围光驱动（C-09 / P1-4 取样生命周期）
 *
 * 只做三件事：按固定频率取样、把四边颜色画到光晕画布上、拿不到像素时干净退出。
 *
 * 取样频率是模块常量而不是设置项（8Hz / 低端 4Hz），因为验收红线是"色调变化
 * 150ms 内跟上且帧率下降 <3fps"——把 Hz 暴露成滑条只会让人把它推到 30Hz。
 * 强度是设置项（0~100），只影响渐变峰值不透明度，不增加任何成本。
 *
 * P1-4：取样时钟跟着页面生命周期与视频元素代次走：
 * - 页面不可见 → 停表并擦掉光晕（没人看的时候逐帧画渐变纯属白烧），回前台再起；
 * - 换了视频元素（换集/换线重建）→ 代次变了，旧色调作废、失败计数归零；
 * - WebView 引擎连续找不到视频元素 → 挂起 + 1Hz 存在性探测，元素回来就恢复，
 *   不再把"重建途中"误判成永久不通；
 * - 原生引擎 DOM 里永远不会有视频元素 → 这才是真的永久不通，照旧报 no-video。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

import {
  AMBILIGHT_SAMPLE_H,
  AMBILIGHT_SAMPLE_W,
  glowCanvasSize,
  paintAmbilight,
  sampleEdges,
  type AmbilightEdges,
} from '@/player/AmbilightSampler';
import { prefersReducedMotion } from '@/composables/useSpring';
import { isLowEndDevice } from '@/shared/deviceTier';

const HIGH_HZ = 8;
const LOW_HZ = 4;
/** ≈1.5s 内始终没有视频元素：原生引擎判死，WebView 引擎挂起等重建 */
const MISSING_LIMIT = 12;
/** 挂起后的存在性探测：只查元素，不读像素 */
const PROBE_PERIOD_MS = 1000;

/**
 * 氛围光为什么用不了——提示文案要能对上原因，而不是笼统一句"不支持"。
 * - `no-video`：原生引擎，DOM 里根本没有视频元素
 * - `no-pixels`：拿不到 2D 上下文，或画布被跨域视频污染
 * - `reduced-motion`：系统「减少动态效果」
 */
export type AmbilightBlockReason = 'no-video' | 'no-pixels' | 'reduced-motion';

export interface AmbilightOptions {
  /** 视频容器：氛围光只认这里存在的 `<video>`，原生引擎下它始终是空的 */
  host: Readonly<Ref<HTMLElement | null>>;
  canvas: Readonly<Ref<HTMLCanvasElement | null>>;
  enabled: Readonly<Ref<boolean>>;
  /** 0~100 */
  intensity: Readonly<Ref<number>>;
  /** 当前是否原生引擎：决定"没有视频元素"是永久不通还是重建途中 */
  native: Readonly<Ref<boolean>>;
}

export interface AmbilightApi {
  /** null = 正常在跑；非空 = 已自动关闭，调用方据此撤开关并提示 */
  blocked: Ref<AmbilightBlockReason | null>;
  /** 最近一次采样结果，供强度变化时立刻重画，也便于测试观测 */
  edges: Ref<AmbilightEdges | null>;
}

export function useAmbilight(options: AmbilightOptions): AmbilightApi {
  const { host, canvas, enabled, intensity, native } = options;
  const blocked = ref<AmbilightBlockReason | null>(null);
  const edges = ref<AmbilightEdges | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;
  let missing = 0;
  let visible = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
  /** 挂起 = 视频元素暂时不在（重建途中），路本身是通的 */
  let suspended = false;
  /** 上一次取样用的视频元素：换了元素就是换了一代，旧色调不能留着 */
  let lastVideo: HTMLVideoElement | null = null;
  let disposed = false;

  function periodMs(): number {
    return 1000 / (isLowEndDevice() ? LOW_HZ : HIGH_HZ);
  }

  function ensureScratch(): CanvasRenderingContext2D | null {
    if (scratchCtx) return scratchCtx;
    if (typeof document === 'undefined') return null;
    const el = document.createElement('canvas');
    el.width = AMBILIGHT_SAMPLE_W;
    el.height = AMBILIGHT_SAMPLE_H;
    // 每帧都要读回像素，明确告诉浏览器别按 GPU 纹理优化
    scratchCtx = el.getContext('2d', { willReadFrequently: true });
    return scratchCtx;
  }

  function clearTimer(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function clearProbe(): void {
    if (probeTimer === null) return;
    clearInterval(probeTimer);
    probeTimer = null;
  }

  function clearLayer(): void {
    const el = canvas.value;
    el?.getContext('2d')?.clearRect(0, 0, el.width, el.height);
  }

  /** 拿不到帧：撤掉定时器与光晕层内容，但绝不影响播放本身 */
  function giveUp(reason: AmbilightBlockReason): void {
    blocked.value = reason;
    edges.value = null;
    suspended = false;
    clearProbe();
    clearTimer();
    clearLayer();
  }

  function paint(source: AmbilightEdges): void {
    const el = canvas.value;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, isLowEndDevice() ? 1 : 1.5);
    const size = glowCanvasSize(el.clientWidth, el.clientHeight, dpr);
    if (el.width !== size.w || el.height !== size.h) {
      el.width = size.w;
      el.height = size.h;
    }
    const ctx = el.getContext('2d');
    if (ctx) paintAmbilight(ctx, source, size.w, size.h, intensity.value);
  }

  /** 取样时钟的唯一开关：开着 + 没被判死 + 页面可见 + 不在挂起中，才建定时器 */
  function sync(): void {
    if (disposed) return;
    const live = enabled.value && blocked.value === null && visible && !prefersReducedMotion();
    if (live && !suspended) {
      clearProbe();
      if (timer === null) timer = setInterval(tick, periodMs());
      return;
    }
    if (timer !== null) {
      clearTimer();
      edges.value = null;
      clearLayer();
    }
    if (live && suspended) {
      if (probeTimer === null) probeTimer = setInterval(probe, PROBE_PERIOD_MS);
    } else {
      clearProbe();
    }
  }

  /** 挂起期间只查元素在不在，不做任何像素回读 */
  function probe(): void {
    const video = host.value?.querySelector('video');
    if (!video || video.videoWidth <= 0 || video.readyState < 2) return;
    suspended = false;
    missing = 0;
    sync();
  }

  function tick(): void {
    const video = host.value?.querySelector('video') ?? null;
    if (!video) {
      // 原生 ExoPlayer 的 surface 在 WebView 之下，DOM 里永远不会有视频元素
      if (native.value) {
        missing += 1;
        if (missing >= MISSING_LIMIT) giveUp('no-video');
        return;
      }
      // WebView 引擎：换集/换线会把 video 拆了重建，这不是永久不通
      missing += 1;
      if (missing >= MISSING_LIMIT) {
        suspended = true;
        missing = 0;
        sync();
      }
      return;
    }
    if (lastVideo !== null && video !== lastVideo) {
      // 换了一代画面：上一代的色调与失败计数都作废（首次取样不算换代，层本来就是空的）
      edges.value = null;
      clearLayer();
    }
    lastVideo = video;
    missing = 0;
    // 首帧未到 / 正在缓冲不算失败，等下一个周期
    if (video.videoWidth <= 0 || video.readyState < 2) return;
    const ctx = ensureScratch();
    if (!ctx) {
      giveUp('no-pixels');
      return;
    }
    const sampled = sampleEdges(video, ctx);
    if (!sampled) {
      // 像素读不回来（跨域未开 CORS 会污染画布）：一次抖动都不会有，直接收摊
      giveUp('no-pixels');
      return;
    }
    edges.value = sampled;
    paint(sampled);
  }

  function onVisibility(): void {
    visible = document.visibilityState !== 'hidden';
    sync();
  }

  watch(
    enabled,
    (on) => {
      if (!on) {
        suspended = false;
        clearProbe();
        clearTimer();
        clearLayer();
        return;
      }
      // 系统减少动效：氛围光是持续变化的效果，归零而不是"变慢一点"
      if (prefersReducedMotion()) {
        blocked.value = 'reduced-motion';
        return;
      }
      blocked.value = null;
      suspended = false;
      missing = 0;
      lastVideo = null;
      sync();
    },
    { immediate: true },
  );

  // 强度改动立刻重画一次：不必等下一个采样周期
  watch(intensity, () => {
    if (timer !== null && edges.value) paint(edges.value);
  });

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  onBeforeUnmount(() => {
    disposed = true;
    clearTimer();
    clearProbe();
    scratchCtx = null;
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  });

  return { blocked, edges };
}