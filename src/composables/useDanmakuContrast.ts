/**
 * 弹幕智能配色的驱动层（11-17 / P1-4 取样生命周期）
 *
 * 只做三件事：按固定频率取样、把亮度场推给渲染层、这条路永远取不到帧时干净退出。
 *
 * 频率是模块常量而不是设置项：配色跟的是剧情亮度，秒级变化就够用，而原生那条路每次
 * 取样都要过一遍桥 + 抓一帧 surface，把它推到 10Hz 只是给播放加负担。低端机减半。
 *
 * 引擎决定取样路：WebView 引擎画 DOM 里的 `<video>`（跨域污染则永久不通），原生引擎
 * 走 `ExoPlayer.sampleFrameLuma`。两条路都失败时只关功能，弹幕本身照旧显示。
 *
 * P1-4：取样时钟跟着 **surface 代次**与**页面生命周期**走，而不是一直空转：
 * - 页面不可见（后台播放 / 纯音频 / 小窗）→ 停表，回前台再起；
 * - 原生回执 `surfaceInvalid` 或 `surface` 事件说这一代截不到 → 停表并交还原色，
 *   由事件或 1Hz 探测唤醒（探测只问状态，不读像素）；
 * - WebView 引擎连续找不到视频元素（换集/换线重建途中）→ 同样挂起而不是判死，
 *   元素回来就恢复；
 * - 抓帧期间代次变了 → 丢掉这张属于上一代画面的亮度场。
 * 只有"这条路永远不通"（画布污染、非 SurfaceView、桥反复异常）才记 blocked。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { PluginListenerHandle } from '@capacitor/core';

import {
  FrameLumaUnavailableError,
  nativeFrameLumaSource,
  videoFrameLumaSource,
  type FrameLumaBlockReason,
  type FrameLumaSource,
  type SurfaceSampleState,
} from '@/player/frameLuma';
import { ExoPlayer } from '@/native/exoPlayerPlugin';
import type { DanmakuOverlay } from '@/player/DanmakuOverlay';
import type { LumaField } from '@/player/danmakuContrast';
import { isLowEndDevice } from '@/shared/deviceTier';
import { logger } from '@/shared/logger';
import type { ResizeMode } from '@/types';

const SAMPLE_HZ = 3;
const SAMPLE_HZ_LOW_END = 2;
/** ≈7s 内桥一直异常，就认为这条路不通 */
const MISSING_LIMIT = 20;
/** 挂起后的恢复探测：1Hz，只问状态/查元素，不做像素回读 */
const PROBE_PERIOD_MS = 1000;

export type DanmakuContrastBlockReason = FrameLumaBlockReason;

export interface DanmakuContrastOptions {
  /** 渲染层实例（弹幕关闭 / 未就绪时为 null，取样空转等它挂上） */
  overlay: Readonly<Ref<DanmakuOverlay | null>>;
  /** 播放器舞台：WebView 引擎的 `<video>` 在它里面 */
  stage: Readonly<Ref<HTMLElement | null>>;
  enabled: Readonly<Ref<boolean>>;
  /** 当前是否原生引擎（引擎切换要换取样路） */
  native: Readonly<Ref<boolean>>;
  resizeMode: Readonly<Ref<ResizeMode>>;
  /** 暂停时不必取样：画面不会自己变 */
  isPlaying: () => boolean;
  /**
   * 每取到一帧亮度场回调一次（只给非空帧，代次过期/已挂起的帧不会到这里）。
   *
   * 节奏带（G-C05）搭这条路取数，而不是自己再开一条：原生取样每次要过桥抓一帧 surface，
   * 多一路就是给播放加负担，而它要的"相邻两帧差多少"这一路本来就已经拿到了。
   */
  onField?: (field: LumaField) => void;
}

export interface DanmakuContrastApi {
  /** null = 正常在跑；非空 = 已自动关闭，面板据此给出原因 */
  blocked: Ref<DanmakuContrastBlockReason | null>;
}

export function useDanmakuContrast(options: DanmakuContrastOptions): DanmakuContrastApi {
  const { overlay, stage, enabled, native, resizeMode, isPlaying } = options;
  const blocked = ref<DanmakuContrastBlockReason | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let source: FrameLumaSource | null = null;
  let missing = 0;
  /** 取样是异步的（原生过桥），一轮没回来就跳过这一轮 */
  let inFlight = false;
  /** 页面可见性：后台/小窗时画面没人看，取样纯属白烧 */
  let visible = typeof document === 'undefined' ? true : document.visibilityState !== 'hidden';
  /** 挂起 = 这一代暂时取不到，但路是通的（区别于 blocked 的永久不通） */
  let suspended = false;
  /** 原生回执/事件到达前先当作可取样：第一轮就会告知真实状态 */
  let surfaceValid = true;
  /** 最近一次已知的 surface 代次；null = 还不知道（首轮不做新旧比对） */
  let generation: number | null = null;
  let detachSurface: PluginListenerHandle | null = null;
  let disposed = false;

  function periodMs(): number {
    return Math.round(1000 / (isLowEndDevice() ? SAMPLE_HZ_LOW_END : SAMPLE_HZ));
  }

  function rebuildSource(): void {
    source = native.value ? nativeFrameLumaSource(applySurface) : videoFrameLumaSource(() => stage.value);
    missing = 0;
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function clearProbe(): void {
    if (probeTimer !== null) {
      clearInterval(probeTimer);
      probeTimer = null;
    }
  }

  /** 永久取不到帧：撤定时器、把已接管的配色交还原色，并留下原因给面板 */
  function giveUp(reason: DanmakuContrastBlockReason): void {
    logger.warn('亮度取样判定永久不通', { reason, generation, surfaceValid });
    blocked.value = reason;
    suspended = false;
    clearProbe();
    clearTimer();
    overlay.value?.setLumaField(null);
  }

  /**
   * 取样时钟的唯一开关：开着 + 没被判死 + 页面可见 + 这一代 surface 能截，才建定时器。
   * 停表时把亮度场交还（旧画面的配色不该贴在新画面上），挂起期间留一条低频恢复探测。
   */
  function sync(): void {
    if (disposed) return;
    const live = enabled.value && blocked.value === null && visible;
    if (live && !suspended && surfaceValid) {
      clearProbe();
      if (timer === null) {
        rebuildSource();
        timer = setInterval(() => void tick(), periodMs());
      }
      return;
    }
    if (timer !== null) {
      clearTimer();
      overlay.value?.setLumaField(null);
    }
    if (live && suspended) {
      if (probeTimer === null) probeTimer = setInterval(() => void probe(), PROBE_PERIOD_MS);
    } else {
      clearProbe();
    }
  }

  /** 原生回执/事件里的取样目标状态 */
  function applySurface(state: SurfaceSampleState): void {
    // 代次只前进不回退：抓帧期间 surface 换了一代，旧回执带的是旧代次，
    // 让它覆盖回去就等于把"这张图过期了"这条证据抹掉。
    if (generation !== null && state.generation < generation) return;
    generation = state.generation;
    const wasValid = surfaceValid;
    surfaceValid = state.valid;
    if (!state.valid) {
      suspended = true;
      sync();
      return;
    }
    if (!wasValid || suspended) {
      // surface 回来了：重新起表（旧亮度场已在停表时交还）
      suspended = false;
      missing = 0;
      sync();
    }
  }

  /** 恢复探测：原生问一次状态（无效时原生直接回执，不抓帧），WebView 查元素回没回来 */
  async function probe(): Promise<void> {
    if (inFlight || disposed) return;
    if (!native.value) {
      const video = stage.value?.querySelector('video');
      if (!video || video.videoWidth <= 0 || video.readyState < 2) return;
      suspended = false;
      missing = 0;
      sync();
      return;
    }
    if (source === null) rebuildSource();
    const sample = source;
    if (sample === null) return;
    inFlight = true;
    try {
      // 只要状态：applySurface 会在回执里决定要不要恢复取样
      await sample(0, 0, resizeMode.value);
    } catch (e) {
      if (e instanceof FrameLumaUnavailableError && e.reason !== 'no-video') giveUp(e.reason);
    } finally {
      inFlight = false;
    }
  }

  async function tick(): Promise<void> {
    if (inFlight) return;
    const target = overlay.value;
    if (!target) {
      // 弹幕层还没挂上（本集没弹幕/刚 seek）：这条路本身是通的，不计失败
      return;
    }
    const { width, height } = target.canvasSize;
    if (width <= 0 || height <= 0 || !isPlaying()) return;
    if (source === null) rebuildSource();
    const sample = source;
    if (sample === null) return;
    const startedGeneration = generation;
    inFlight = true;
    try {
      const field = await sample(width, height, resizeMode.value);
      // 抓帧期间换了代：这张图属于上一代 surface，贴上去就是错色
      if (startedGeneration !== null && generation !== startedGeneration) return;
      // 回执自己把时钟停了（surface 无效）：别再推场
      if (suspended || !surfaceValid) return;
      missing = 0;
      target.setLumaField(field);
      if (field) options.onField?.(field);
    } catch (e) {
      if (e instanceof FrameLumaUnavailableError) {
        // DOM 里没有视频元素是换集/换线重建途中的常态，不是永久不通
        if (e.reason === 'no-video') {
          suspended = true;
          missing = 0;
          sync();
          return;
        }
        giveUp(e.reason);
        return;
      }
      // 桥抖动、原生临时取不到帧：与"这条路不通"区分开，只累计次数
      missing += 1;
      if (missing >= MISSING_LIMIT) giveUp('unsupported');
    } finally {
      inFlight = false;
    }
  }

  function onVisibility(): void {
    visible = document.visibilityState !== 'hidden';
    sync();
  }

  /** 原生 surface 代次事件：停表后靠它立刻恢复，不必等探测 */
  async function watchSurface(): Promise<void> {
    if (!native.value || detachSurface !== null || disposed) return;
    try {
      const handle = await ExoPlayer.addListener('exostate', (data) => {
        if (data.state !== 'surface') return;
        applySurface({ generation: data.generation ?? 0, valid: data.valid === true });
      });
      if (disposed) {
        void handle.remove().catch(() => undefined);
        return;
      }
      detachSurface = handle;
    } catch (e) {
      logger.debug('订阅原生 surface 事件失败（取样仍按每轮回执自判）', e);
    }
  }

  function unwatchSurface(): void {
    const handle = detachSurface;
    detachSurface = null;
    if (handle) void handle.remove().catch(() => undefined);
  }

  watch(
    [enabled, native],
    ([on, isNative]) => {
      // 重新打开 / 换引擎：换了一条取样路就该重新试过，否则 tainted 会永久卡死原生那条通的路
      blocked.value = null;
      suspended = false;
      surfaceValid = true;
      generation = null;
      const wasRunning = timer !== null;
      clearTimer();
      clearProbe();
      // 打断的是正在跑的取样才交还原色；首次挂载时渲染层本来就没有场，不必多推一次 null
      if (wasRunning) overlay.value?.setLumaField(null);
      if (!on) {
        unwatchSurface();
        return;
      }
      if (isNative) void watchSurface();
      else unwatchSurface();
      sync();
    },
    { immediate: true },
  );

  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  onBeforeUnmount(() => {
    disposed = true;
    clearTimer();
    clearProbe();
    unwatchSurface();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
  });

  return { blocked };
}
