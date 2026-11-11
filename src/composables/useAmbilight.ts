/**
 * 画面氛围光驱动（C-09）
 *
 * 只做三件事：按固定频率取样、把四边颜色画到光晕画布上、拿不到像素时干净退出。
 *
 * 取样频率是模块常量而不是设置项（8Hz / 低端 4Hz），因为验收红线是"色调变化
 * 150ms 内跟上且帧率下降 <3fps"——把 Hz 暴露成滑条只会让人把它推到 30Hz。
 * 强度是设置项（0~100），只影响渐变峰值不透明度，不增加任何成本。
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
/** ≈1.5s 内始终没有视频元素就认定这条路拿不到帧 */
const MISSING_LIMIT = 12;

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
}

export interface AmbilightApi {
  /** null = 正常在跑；非空 = 已自动关闭，调用方据此撤开关并提示 */
  blocked: Ref<AmbilightBlockReason | null>;
  /** 最近一次采样结果，供强度变化时立刻重画，也便于测试观测 */
  edges: Ref<AmbilightEdges | null>;
}

export function useAmbilight(options: AmbilightOptions): AmbilightApi {
  const { host, canvas, enabled, intensity } = options;
  const blocked = ref<AmbilightBlockReason | null>(null);
  const edges = ref<AmbilightEdges | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let scratchCtx: CanvasRenderingContext2D | null = null;
  let missing = 0;

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

  function stop(): void {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  }

  function clearLayer(): void {
    const el = canvas.value;
    el?.getContext('2d')?.clearRect(0, 0, el.width, el.height);
  }

  /** 拿不到帧：撤掉定时器与光晕层内容，但绝不影响播放本身 */
  function giveUp(reason: AmbilightBlockReason): void {
    blocked.value = reason;
    edges.value = null;
    stop();
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

  function tick(): void {
    const video = host.value?.querySelector('video');
    if (!video) {
      // 原生 ExoPlayer 的 surface 在 WebView 之下，DOM 里永远不会有视频元素
      missing += 1;
      if (missing >= MISSING_LIMIT) giveUp('no-video');
      return;
    }
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

  function start(): void {
    if (timer !== null || blocked.value) return;
    timer = setInterval(tick, periodMs());
  }

  watch(
    enabled,
    (on) => {
      if (!on) {
        stop();
        clearLayer();
        return;
      }
      // 系统减少动效：氛围光是持续变化的效果，归零而不是"变慢一点"
      if (prefersReducedMotion()) {
        blocked.value = 'reduced-motion';
        return;
      }
      blocked.value = null;
      missing = 0;
      start();
    },
    { immediate: true },
  );

  // 强度改动立刻重画一次：不必等下一个采样周期
  watch(intensity, () => {
    if (timer !== null && edges.value) paint(edges.value);
  });

  onBeforeUnmount(() => {
    stop();
    scratchCtx = null;
  });

  return { blocked, edges };
}
