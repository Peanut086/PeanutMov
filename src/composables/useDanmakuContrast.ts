/**
 * 弹幕智能配色的驱动层（11-17）
 *
 * 只做三件事：按固定频率取样、把亮度场推给渲染层、这条路永远取不到帧时干净退出。
 *
 * 频率是模块常量而不是设置项：配色跟的是剧情亮度，秒级变化就够用，而原生那条路每次
 * 取样都要过一遍桥 + 抓一帧 surface，把它推到 10Hz 只是给播放加负担。低端机减半。
 *
 * 引擎决定取样路：WebView 引擎画 DOM 里的 `<video>`（跨域污染则永久不通），原生引擎
 * 走 `ExoPlayer.sampleFrameLuma`。两条路都失败时只关功能，弹幕本身照旧显示。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

import {
  FrameLumaUnavailableError,
  nativeFrameLumaSource,
  videoFrameLumaSource,
  type FrameLumaBlockReason,
  type FrameLumaSource,
} from '@/player/frameLuma';
import type { DanmakuOverlay } from '@/player/DanmakuOverlay';
import { isLowEndDevice } from '@/shared/deviceTier';
import type { ResizeMode } from '@/types';

const SAMPLE_HZ = 3;
const SAMPLE_HZ_LOW_END = 2;
/** ≈7s 内始终等不到弹幕层或视频元素，就认为这条路不通 */
const MISSING_LIMIT = 20;

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
}

export interface DanmakuContrastApi {
  /** null = 正常在跑；非空 = 已自动关闭，面板据此给出原因 */
  blocked: Ref<DanmakuContrastBlockReason | null>;
}

export function useDanmakuContrast(options: DanmakuContrastOptions): DanmakuContrastApi {
  const { overlay, stage, enabled, native, resizeMode, isPlaying } = options;
  const blocked = ref<DanmakuContrastBlockReason | null>(null);

  let timer: ReturnType<typeof setInterval> | null = null;
  let source: FrameLumaSource | null = null;
  let missing = 0;
  /** 取样是异步的（原生过桥），一轮没回来就跳过这一轮 */
  let inFlight = false;

  function periodMs(): number {
    return Math.round(1000 / (isLowEndDevice() ? SAMPLE_HZ_LOW_END : SAMPLE_HZ));
  }

  function rebuildSource(): void {
    source = native.value ? nativeFrameLumaSource() : videoFrameLumaSource(() => stage.value);
    missing = 0;
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    overlay.value?.setLumaField(null);
  }

  /** 永久取不到帧：撤定时器、把已接管的配色交还原色，并留下原因给面板 */
  function giveUp(reason: DanmakuContrastBlockReason): void {
    blocked.value = reason;
    stop();
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
    inFlight = true;
    try {
      const field = await sample(width, height, resizeMode.value);
      missing = 0;
      target.setLumaField(field);
    } catch (e) {
      if (e instanceof FrameLumaUnavailableError) {
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

  function start(): void {
    if (timer !== null) return;
    rebuildSource();
    timer = setInterval(() => void tick(), periodMs());
  }

  watch(
    [enabled, native],
    ([on]) => {
      if (!on) {
        // 用户关掉：停轮询 + 交还原色，但不记失败（面板上的开关状态就是反馈）
        blocked.value = null;
        stop();
        return;
      }
      // 重新打开 / 换引擎：换了一条取样路就该重新试过，否则 tainted 会永久卡死原生那条通的路
      blocked.value = null;
      stop();
      start();
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  });

  return { blocked };
}
