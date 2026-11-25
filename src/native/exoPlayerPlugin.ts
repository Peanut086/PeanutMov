/**
 * ExoPlayer 原生引擎插件代理（v1.7 / CHG-21 PoC，Spike）
 *
 * Android 端 `ExoPlayerPlugin.java`（Media3 1.3.1，surface 模式）：
 * 在 WebView 之上叠加 `PlayerView`，JS 侧用 `setRect` 对齐占位元素。
 *
 * **默认不启用**：设置 `experimentalNativePlayer` 开关（SettingsView，默认关）
 * 为真时 PlayerView 才路由到本引擎；未启用时本文件零调用、WebView 链路不变。
 * 退出标准（MuMu 4K 不掉帧）与移除方式见 `契约变更-v1.7.md` §2.4。
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

import { logger } from '@/shared/logger';

export interface ExoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExoPrepareOptions {
  url: string;
  /** 头数组形态（Java 侧 `call.getArray("headers")` 逐项还原；用 exoHeadersOf 转换） */
  headers?: Array<{ key: string; value: string }>;
  /** 显式内容类型：中转/代理地址的 .m3u8 不在 URI 路径上，Java 侧推断不出来 */
  mime?: string;
  rect?: ExoRect;
  autoPlay?: boolean;
  /** P0-7: 续播起始位置（毫秒），0 或 undefined 表示从头播放 */
  startPositionMs?: number;
  /** P2-2：一次 load 的会话标识；Java 用它丢弃旧 player 实例的事件 */
  sessionId?: string;
  /** P2-2：同一 NativeEngine 内递增的加载代次，与 sessionId 联合过滤事件 */
  requestGeneration?: number;
  /**
   * B1：锁屏/通知栏/蓝牙元数据。
   *
   * 必须随 prepare 下发：media3 1.3.1 的 MediaSession 没有 setMediaMetadata，
   * 会话元数据只取自播放器当前 MediaItem，事后补设需要 replaceMediaItem（会动进度）。
   */
  title?: string;
  subtitle?: string;
  artworkUrl?: string;
}

export interface ExoQuality {
  id: number;
  label: string;
  width: number;
  height: number;
  bitrate: number;
}

export interface ExoTextTrack {
  id: number;
  label: string;
  mimeType: string;
}

export interface ExoAudioTrack {
  id: number;
  label: string;
  language: string | null;
  mimeType: string | null;
  channels: number | null;
}

/**
 * 弹幕智能配色的取帧结果（11-17）。
 *
 * `cells` 只覆盖 **视频内容区**（surface 本身），信箱黑边由 JS 侧铺 0；
 * 每格是 0~255 的 sRGB 相对亮度，不是 gamma 域的 RGB 均值。
 */
export interface ExoFrameLuma {
  /** 这条路永久不通（不是 SurfaceView 渲染 / 系统调用异常）：调用方应关掉功能 */
  unsupported?: boolean;
  /** 这一轮有没有拿到帧（未起播、surface 未就绪 = false，下一轮再问） */
  available?: boolean;
  /**
   * P1-4：这一代 surface 根本截不到（纯音频收起画面、离开播放页、尺寸还没量出来）。
   * 与 `available:false` 的区别是"别再问了"——调用方应停轮询，等 `surface` 事件说恢复了再采。
   */
  surfaceInvalid?: boolean;
  /** 取样目标的代次：抓帧是异步的，回执带的是**发起时**那一代，对不上就该丢掉这张图 */
  generation?: number;
  cells?: number[];
  /** 内容区在原生播放器容器里的归一化矩形（cover/fill 时就是整块） */
  box?: { left: number; top: number; width: number; height: number };
}

export type ExoPlayerUnavailableReason = 'plugin_missing' | 'safe_mode' | 'unsupported';

export interface ExoPlayerStatus {
  available: boolean;
  supported: boolean;
  safeMode: boolean;
  reason: ExoPlayerUnavailableReason | null;
}

export interface ExoPlayerPlugin {
  isSupported(): Promise<{ supported: boolean; safeMode?: boolean }>;
  prepare(options: ExoPrepareOptions): Promise<void>;
  setRect(options: ExoRect): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { positionMs: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  /** v1.8/CHG-25：音量 0~100（Java 侧映射 0~1） */
  setVolume(options: { volume: number }): Promise<void>;
  /** v1.8/CHG-25：droppedFrames 为本次会话累计丢帧（AC-125 帧率采样） */
  progress(): Promise<{ positionMs: number; durationMs: number; droppedFrames?: number }>;
  /** P2-2：可等待释放；带会话参数时，旧 session 的迟到 release 不会关掉新 player */
  release(options?: { sessionId?: string; requestGeneration?: number }): Promise<void>;
  /** v1.8 优化：获取视频轨列表（清晰度） */
  getQualities(): Promise<{ qualities: ExoQuality[] }>;
  /** v1.8 优化：切换视频轨（清晰度） */
  setQuality(options: { id: number }): Promise<void>;
  /** v1.8 优化：获取字幕轨列表 */
  getTextTracks(): Promise<{ textTracks: ExoTextTrack[]; activeTextId: number }>;
  /** v1.8 优化：切换字幕轨（-1 表示关闭） */
  setTextTrack(options: { id: number }): Promise<void>;
  /** EXT-07：获取音轨列表 */
  getAudioTracks(): Promise<{ audioTracks: ExoAudioTrack[]; activeAudioId: number }>;
  /** EXT-07：切换音轨 */
  setAudioTrack(options: { id: number }): Promise<void>;
  /** EXT-07：画中画能力探测 */
  isPipSupported(): Promise<{ supported: boolean }>;
  /** EXT-07：当前是否处于画中画 */
  isPipActive(): Promise<{ active: boolean }>;
  /**
   * 11-17 弹幕智能配色：抓当前视频帧，回 `cols×rows` 的相对亮度网格。
   *
   * 原生侧用 `PixelCopy` 截 PlayerView 的 SurfaceView，JS 侧按 contain 的算法把它铺到
   * 整块弹幕画布上。拿不到帧的两种口径见 `ExoFrameLuma`。
   */
  sampleFrameLuma(options: { cols: number; rows: number }): Promise<ExoFrameLuma>;
  /** v1.8 优化：获取播放质量指标 */
  getPlaybackStats(): Promise<{
    bufferEvents: number;
    bufferDurationMs: number;
    currentBitrate: number;
    decoderName: string;
    droppedFrames: number;
    currentPosition: number;
    duration: number;
    playbackSpeed: number;
  }>;
  /** v1.8 优化：进入画中画模式 */
  enterPip(): Promise<void>;
  /** v1.8 优化：退出画中画模式 */
  exitPip(): Promise<void>;
  /** P1 画面比例：contain/cover/fill → Media3 resize_mode */
  setResizeMode(options: { mode: string }): Promise<void>;
  /** B2：后台继续播放（关时原生看门狗仍会在 JS 心跳丢失后自动暂停） */
  setBackgroundPlayback(options: { enabled: boolean }): Promise<void>;
  /** B2：纯音频模式（禁用视频轨 + 收起原生 surface） */
  setAudioOnly(options: { enabled: boolean }): Promise<void>;
  /**
   * 状态监听（ready / buffering / ended / error / qualities / textTracks /
   * audioTracks / playing / paused / remote / surface / firstframe / seeksettled）；返回解绑 handle。
   *
   * `remote` 是通知栏/锁屏/线控发来的指令，`command` 为 previous / next / stop；
   * `playing` / `paused` 是原生侧播放意图变化（含音频焦点被抢），JS 必须跟着同步。
   * `surface` 是 P1-4 的取样目标代次变化（建/毁、纯音频收起画面、离开播放页），
   * 带 `generation` 与 `valid`，亮度取样据此停轮询与恢复。
   * `seeksettled` 带请求目标、真实落点和首帧耗时，不能用目标值冒充真实位置。
   */
  addListener(
    eventName: 'exostate',
    cb: (data: {
      state: string;
      message?: string;
      duration?: number;
      positionMs?: number;
      targetMs?: number;
      latencyMs?: number;
      errorCodeName?: string;
      causeChain?: string;
      hasVideoTrack?: boolean;
      videoTrackCount?: number;
      videoWidth?: number;
      videoHeight?: number;
      firstFrameRendered?: boolean;
      audioOnly?: boolean;
      visible?: boolean;
      playerAttached?: boolean;
      surfaceValid?: boolean;
      surfaceShown?: boolean;
      surfaceWidth?: number;
      surfaceHeight?: number;
      webViewBackgroundTransparent?: boolean;
      rect?: ExoRect;
      reason?: string;
      command?: string;
      qualities?: ExoQuality[];
      textTracks?: ExoTextTrack[];
      audioTracks?: ExoAudioTrack[];
      sessionId?: string;
      requestGeneration?: number;
      /** SurfaceView 取样目标代次，与 P2-2 的 requestGeneration 不是同一个概念 */
      generation?: number;
      valid?: boolean;
    }) => void,
  ): Promise<PluginListenerHandle>;
}

export const ExoPlayer = registerPlugin<ExoPlayerPlugin>('ExoPlayer');

export async function getExoPlayerStatus(): Promise<ExoPlayerStatus> {
  try {
    const result = await ExoPlayer.isSupported();
    const supported = result.supported === true;
    const safeMode = result.safeMode === true;
    if (!supported) {
      return { available: false, supported: false, safeMode, reason: 'unsupported' };
    }
    if (safeMode) {
      return { available: false, supported: true, safeMode: true, reason: 'safe_mode' };
    }
    return { available: true, supported: true, safeMode: false, reason: null };
  } catch (e) {
    logger.debug('ExoPlayer 插件不可用（回退 WebView 引擎）', e);
    return { available: false, supported: false, safeMode: false, reason: 'plugin_missing' };
  }
}

export async function isExoPlayerAvailable(): Promise<boolean> {
  return (await getExoPlayerStatus()).available;
}

/** headers 对象 → 插件数组格式（Java 侧逐项还原） */
export function exoHeadersOf(headers: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}
