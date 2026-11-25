/**
 * 原生播放引擎（ExoPlayer surface 模式桥接，v1.8/CHG-25）
 *
 * - 实现 `PlayableEngine`：把 Java 侧 `ExoPlayerPlugin`（Media3 硬解，
 *   WebView 之上叠原生 surface）适配进 PlayerController 的引擎选择
 * - 进度靠 500ms 轮询 `progress()`（无逐帧事件桥），buffered 以 position 近似
 * - rect 对齐：ResizeObserver + 窗口 resize/orientationchange 后逐帧追到几何稳定
 * - 清晰度为空数组（面板天然隐藏）；PoC 边界见 `契约变更-v1.7.md` §2.4
 */
import type { AppErrorShape, ErrorCode, PlaybackSource, ResizeMode } from '@/types';
import { AppError, ERROR_MESSAGES, httpStatusToErrorCode } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { PluginListenerHandle } from '@capacitor/core';

import type { EngineCapabilities, PlayableEngine } from '@/player/types';
import { assertSourceSupported } from '@/player/sourceGuard';
import { ExoPlayer, exoHeadersOf, type ExoQuality, type ExoRect } from '@/native/exoPlayerPlugin';
import { nativeFrameLumaSource } from '@/player/frameLuma';

const PROGRESS_POLL_MS = 1000;
const RECT_SETTLE_MS = 2000;
let nativeSessionSequence = 0;

function createNativeSessionId(): string {
  nativeSessionSequence += 1;
  return `${Date.now().toString(36)}-${nativeSessionSequence.toString(36)}`;
}

/**
 * 把 Capacitor localhost URL 转成原生 file:// URI（ExoPlayer 需要）。
 * `https://localhost/_capacitor_file_/data/user/0/...` → `file:///data/user/0/...`
 * 非本地 URL 原样返回。
 */
function toNativeFileUri(url: string): string {
  const prefix = 'https://localhost/_capacitor_file_';
  if (url.startsWith(prefix)) {
    const path = url.slice(prefix.length);
    return `file://${path.startsWith('/') ? '' : '/'}${path}`;
  }
  return url;
}

export interface NativeEngineEvents {
  onLoadedMetadata: (duration: number, hasVideoTrack?: boolean) => void;
  onTimeUpdate: (currentTime: number, duration: number, buffered: number) => void;
  onWaiting: () => void;
  onEnded: () => void;
  onError: (error: AppErrorShape) => void;
  /** v1.8 优化：清晰度列表更新 */
  onQualitiesChange?: (qualities: string[]) => void;
  /** EXT-07：内嵌字幕/音轨列表与选中项更新 */
  onEmbeddedTracksChange?: (state: EmbeddedTrackState) => void;
  /** P1-a：seek 后画面真正渲染出第一帧（Java onRenderedFirstFrame 上报） */
  onSeekSettled?: (info: { targetMs: number; latencyMs: number; positionMs: number }) => void;
  /** 原生 surface 真实渲染出首帧；与 READY 分开，READY 不等于已有画面。 */
  onFirstFrame?: (positionSec: number) => void;
  /**
   * B1：原生侧播放意图变化（通知栏/锁屏/线控/音频焦点被抢都会触发）。
   *
   * 不接这条回调就会出现「画面在播、按钮显示暂停」的双状态源。
   */
  onPlayingChange?: (playing: boolean) => void;
  /** B1：通知栏/锁屏的上下集与关闭指令（真正的切集逻辑在 JS 侧） */
  onRemoteCommand?: (command: RemoteCommand) => void;
}

/** 媒体会话远端指令 */
export type RemoteCommand = 'previous' | 'next' | 'stop';

/** B1：锁屏/通知栏元数据（随 prepare 下发，见 ExoPrepareOptions 注释） */
export interface NativeMediaInfo {
  title: string;
  subtitle: string;
  artworkUrl: string | null;
}

/** P2-1：原生 Surface 现场快照；字段缺席表示旧插件无法提供该项。 */
export interface NativeSurfaceDiagnostic {
  reason?: string;
  visible?: boolean;
  audioOnly?: boolean;
  playerAttached?: boolean;
  hasVideoTrack?: boolean;
  videoTrackCount?: number;
  videoWidth?: number;
  videoHeight?: number;
  firstFrameRendered?: boolean;
  rect?: ExoRect;
  surfaceValid?: boolean;
  surfaceShown?: boolean;
  surfaceWidth?: number;
  surfaceHeight?: number;
  webViewBackgroundTransparent?: boolean;
}

/* ---------- EXT-07：内嵌字幕 / 音轨 ---------- */

/**
 * 内嵌字幕轨（来自 ExoPlayer TrackGroup）。
 *
 * 与 `playback.subtitles`（外挂 SRT/VTT，由 SubtitleManager 渲染到 DOM）是**两条独立通道**：
 * 本菜单只切换码流内嵌轨，外挂字幕仍走原「字幕」面板。
 */
export interface EmbeddedTextTrack {
  /** Java 侧顺序 id，切换时原样回传 */
  id: number;
  label: string;
  /** ISO 语言码（如 `zh` / `eng`）；未知为 null */
  language: string | null;
  mimeType: string | null;
}

/** 内嵌音轨 */
export interface EmbeddedAudioTrack {
  id: number;
  label: string;
  language: string | null;
  mimeType: string | null;
  /** 声道数；未知为 null */
  channels: number | null;
}

/** 内嵌字幕/音轨面板数据（空数据 = loaded:false + 空数组） */
export interface EmbeddedTrackState {
  /** Java onTracksChanged 已回报过一次（false = 仍在探测） */
  loaded: boolean;
  text: EmbeddedTextTrack[];
  audio: EmbeddedAudioTrack[];
  /** 当前字幕轨 id；null = 字幕关闭 */
  activeTextId: number | null;
  /** 当前音轨 id；null = 未知（播放器自选） */
  activeAudioId: number | null;
}

/** 空状态（首次加载 / 切集重置用） */
export function emptyEmbeddedTracks(): EmbeddedTrackState {
  return { loaded: false, text: [], audio: [], activeTextId: null, activeAudioId: null };
}

/** Java 侧 `exostate` 的原始轨道载荷（音轨/选中态是 EXT-07 新增字段） */
interface RawEmbeddedTrack {
  id: number;
  label?: string | null;
  language?: string | null;
  mimeType?: string | null;
  channels?: number | null;
}

type ExoStateData = {
  state: string;
  message?: string;
  duration?: number;
  command?: string;
  qualities?: ExoQuality[];
  textTracks?: RawEmbeddedTrack[];
  audioTracks?: RawEmbeddedTrack[];
  activeTextId?: number;
  activeAudioId?: number;
  targetMs?: number;
  latencyMs?: number;
  /** FIX-PLAY-C1：原生侧补的结构化错误字段（旧插件缺席时回退 message 正则） */
  errorCodeName?: string;
  causeChain?: string;
  positionMs?: number;
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
  sessionId?: string;
  requestGeneration?: number;
  generation?: number;
  valid?: boolean;
};

/**
 * EXT-07 新增桥接方法。
 *
 * `src/native/exoPlayerPlugin.ts` 不在本次文件范围内（插件契约由架构师维护），
 * 因此新增能力用局部结构类型描述：运行期走 Capacitor 代理的
 * 「未声明方法 → Promise reject」路径，调用方逐个兜底；既有字段一个不动。
 */
interface ExoPlayerExtBridge {
  getAudioTracks(): Promise<{ audioTracks?: RawEmbeddedTrack[]; activeAudioId?: number }>;
  setAudioTrack(options: { id: number }): Promise<void>;
  getTextTracks(): Promise<{ textTracks?: RawEmbeddedTrack[]; activeTextId?: number }>;
  isPipSupported(): Promise<{ supported: boolean }>;
  isPipActive(): Promise<{ active: boolean }>;
}

export class NativeEngine implements PlayableEngine {
  readonly capabilities: EngineCapabilities = { kind: 'hls', supportsHeaders: true };

  private host: HTMLElement | null = null;
  private detachState: PluginListenerHandle | null = null;
  private detachPromise: Promise<void> | null = null;
  private releasePromise: Promise<void> | null = null;
  private releaseSessionKey = '';
  private destroyPromise: Promise<void> | null = null;
  private nativeSessionStarted = false;
  private sessionId = '';
  private requestGeneration = 0;
  private lastRect: ExoRect | null = null;
  private surfaceDiagnostic: NativeSurfaceDiagnostic | null = null;
  private lastSurfaceLogKey = '';
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private observer: ResizeObserver | null = null;
  private onWindowResize: (() => void) | null = null;
  private onScroll: (() => void) | null = null;
  private scrollRaf: number | null = null;

  /** load() 的结算句柄：READY/错误事件到达前由 exostate 负责 resolve/reject */
  private pending: { resolve: () => void; reject: (e: unknown) => void } | null = null;

  private positionSec = 0;
  private durationSec = 0;
  private droppedFrames = 0;
  private ready = false;
  private firstFrameRendered = false;
  private readonly frameLuma = nativeFrameLumaSource();
  private hasVideoTrack: boolean | null = null;
  private videoWidth = 0;
  private videoHeight = 0;
  private audioOnly = false;
  /** v1.8 优化：当前清晰度列表 */
  private qualities: ExoQuality[] = [];
  /** EXT-07：内嵌字幕/音轨状态（Java 推送 + 本地乐观更新） */
  private tracks: EmbeddedTrackState = emptyEmbeddedTracks();
  /** B1：锁屏/通知栏元数据，由 PlayerController 在 load 前注入 */
  private mediaInfo: NativeMediaInfo | null = null;

  constructor(private readonly events: NativeEngineEvents) {}

  attach(container: HTMLElement): void {
    this.host = container;
  }

  async load(source: PlaybackSource): Promise<void> {
    assertSourceSupported(source.url);
    const host = this.host;
    if (!host) throw new AppError('E_INVALID_STATE', '播放器容器未挂载');

    this.stopPolling();
    this.teardownRectWatch();
    this.ready = false;
    this.firstFrameRendered = false;
    this.hasVideoTrack = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.positionSec = 0;
    this.durationSec = 0;
    this.pending?.reject(new AppError('E_ABORTED', '播放器已切换，本次加载作废'));
    this.pending = null;
    this.surfaceDiagnostic = null;
    this.lastSurfaceLogKey = '';
    // EXT-07：切集/换线重置轨道面板，避免上一集字幕/音轨残留在菜单里
    this.patchTracks(emptyEmbeddedTracks());

    const previousSessionId = this.sessionId;
    const previousGeneration = this.requestGeneration;
    const sessionId = createNativeSessionId();
    const requestGeneration = ++this.requestGeneration;
    this.sessionId = sessionId;
    this.requestGeneration = requestGeneration;

    await this.detachStateListener();
    if (!this.isCurrentSession(sessionId, requestGeneration)) {
      throw new AppError('E_ABORTED', '播放器已切换，本次加载作废');
    }
    const releasePrevious = this.nativeSessionStarted || this.releasePromise !== null;
    this.nativeSessionStarted = false;
    if (releasePrevious) {
      await this.releaseNative(previousSessionId, previousGeneration);
    }
    if (!this.isCurrentSession(sessionId, requestGeneration)) {
      throw new AppError('E_ABORTED', '播放器已切换，本次加载作废');
    }

    try {
      const handle = await ExoPlayer.addListener('exostate', (data: ExoStateData) => {
        if (this.isCurrentSession(sessionId, requestGeneration)) this.onState(data);
      });
      if (!this.isCurrentSession(sessionId, requestGeneration)) {
        try {
          await handle.remove();
        } catch (e) {
          logger.debug('ExoPlayer 过期状态监听解绑失败', e);
        }
        throw new AppError('E_ABORTED', '播放器已切换，本次加载作废');
      }
      this.detachState = handle;
    } catch (e) {
      if (e instanceof AppError && e.code === 'E_ABORTED') throw e;
      throw toLoadError(e);
    }

    const loadPromise = new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    try {
      // 本地文件用 file:// URI（ExoPlayer 无法访问 Capacitor https://localhost 桥）
      const nativeUrl = source.isLocal ? toNativeFileUri(source.url) : source.url;
      const rect = rectOf(host);
      this.lastRect = rect;
      // OPT-26（P0-②-2）：用 info 而不是 debug——release 包把 debug 全滤掉了，于是
      // 「ExoPlayer 到底收到什么地址、按什么 mime 嗅的」在真机日志里查不到，
      // 而 UnrecognizedInputFormatException 一类的根因恰恰只有这一行能证实。
      // 地址由 logger 统一脱敏（`redactUrl`），签名参数不会进日志。
      logger.info('NativeEngine.prepare', {
        url: nativeUrl,
        isLocal: source.isLocal,
        format: source.format,
        mime: source.format === 'hls' ? 'application/x-mpegURL' : null,
        startPositionMs: source.startPositionMs ?? 0,
        sessionId,
        requestGeneration,
      });
      this.nativeSessionStarted = true;
      await ExoPlayer.prepare({
        url: nativeUrl,
        headers: exoHeadersOf(source.headers ?? {}),
        // format 由 URL 路径推不出来的（中转/代理地址）必须显式带过去，否则 ExoPlayer
        // 按 progressive 嗅探 m3u8 → UnrecognizedInputFormatException（真机实证）
        mime: source.format === 'hls' ? 'application/x-mpegURL' : undefined,
        rect,
        // P0-7: 续播位置随 prepare 下发
        startPositionMs: source.startPositionMs ?? 0,
        sessionId,
        requestGeneration,
        // B1：会话元数据只能随 MediaItem 下发，事后补设会动播放进度
        title: this.mediaInfo?.title,
        subtitle: this.mediaInfo?.subtitle,
        artworkUrl: this.mediaInfo?.artworkUrl ?? undefined,
      });
      if (!this.isCurrentSession(sessionId, requestGeneration)) {
        throw new AppError('E_ABORTED', '播放器已切换，本次加载作废');
      }
    } catch (e) {
      if (this.isCurrentSession(sessionId, requestGeneration)) this.pending = null;
      if (e instanceof AppError && e.code === 'E_ABORTED') throw e;
      throw toLoadError(e);
    }

    this.watchRect(host, sessionId, requestGeneration);
    this.startPolling(sessionId, requestGeneration);
    // ready / error 由 exostate 事件结算；外层（PlayerController）再套元数据超时
    return loadPromise;
  }

  async play(): Promise<void> {
    await ExoPlayer.play();
  }

  pause(): void {
    void ExoPlayer.pause().catch((e: unknown) => logger.debug('ExoPlayer pause 失败', e));
  }

  seek(sec: number): void {
    void ExoPlayer.seek({ positionMs: Math.round(Math.max(0, sec) * 1000) }).catch(
      (e: unknown) => logger.debug('ExoPlayer seek 失败', e),
    );
  }

  setRate(rate: number): void {
    void ExoPlayer.setRate({ rate }).catch((e: unknown) => logger.debug('ExoPlayer setRate 失败', e));
  }

  setVolume(volume: number): void {
    void ExoPlayer.setVolume({ volume: Math.round(volume) }).catch(
      (e: unknown) => logger.debug('ExoPlayer setVolume 失败', e),
    );
  }

  getCurrentTime(): number {
    return this.positionSec;
  }

  getDuration(): number {
    return this.durationSec;
  }

  /** 近似值：原生侧无缓冲水位事件，用当前进度代替（进度条视觉一致） */
  getBuffered(): number {
    return this.positionSec;
  }

  getFrameStats(): { videoWidth: number; videoHeight: number; totalFrames: number } | null {
    if (this.audioOnly || this.hasVideoTrack !== true) return null;
    return {
      videoWidth: this.videoWidth,
      videoHeight: this.videoHeight,
      totalFrames: this.firstFrameRendered ? 1 : 0,
    };
  }

  sampleFrameLuma() {
    return this.frameLuma(1, 1, 'fill');
  }

  getSurfaceDiagnostic(): NativeSurfaceDiagnostic | null {
    if (!this.surfaceDiagnostic) return null;
    return {
      ...this.surfaceDiagnostic,
      rect: this.surfaceDiagnostic.rect ? { ...this.surfaceDiagnostic.rect } : undefined,
    };
  }

  canObserveFirstFrame(): boolean {
    return true;
  }

  getQualities(): string[] {
    return this.qualities.map((q) => q.label);
  }

  setQuality(quality: string): void {
    const track = this.qualities.find((q) => q.label === quality);
    if (track) {
      void ExoPlayer.setQuality({ id: track.id }).catch((e: unknown) =>
        logger.debug('ExoPlayer setQuality 失败', e),
      );
    }
  }

  /* ---------- EXT-07：内嵌字幕 / 音轨 ---------- */

  /** 当前内嵌字幕/音轨状态（含选中项），返回副本避免调用方改到内部状态 */
  getEmbeddedTracks(): EmbeddedTrackState {
    return {
      ...this.tracks,
      text: [...this.tracks.text],
      audio: [...this.tracks.audio],
    };
  }

  /** 切换内嵌字幕轨；`null` = 关闭字幕（Java 侧 -1） */
  async setEmbeddedSubtitle(id: number | null): Promise<void> {
    await ExoPlayer.setTextTrack({ id: id ?? -1 });
    this.patchTracks({ activeTextId: id });
  }

  /** 切换内嵌音轨（契约代理尚未声明该方法，经局部结构类型调用） */
  async setAudioTrack(id: number): Promise<void> {
    const ext = this.extBridge();
    if (!ext.setAudioTrack) throw new AppError('E_NOT_IMPLEMENTED', '当前安装包不支持音轨切换');
    await ext.setAudioTrack({ id });
    this.patchTracks({ activeAudioId: id });
  }

  /** 主动重拉一次轨道列表（菜单「重试」用；常态由 Java 推送驱动） */
  async refreshEmbeddedTracks(): Promise<void> {
    const ext = this.extBridge();
    try {
      const [text, audio] = await Promise.all([
        ext.getTextTracks ? ext.getTextTracks() : Promise.resolve(undefined),
        ext.getAudioTracks ? ext.getAudioTracks() : Promise.resolve(undefined),
      ]);
      const textList = text?.textTracks?.map(toTextTrack) ?? null;
      const audioList = audio?.audioTracks?.map(toAudioTrack) ?? null;
      if (!textList && !audioList) return;
      this.patchTracks({
        loaded: true,
        text: textList ?? this.tracks.text,
        audio: audioList ?? this.tracks.audio,
        activeTextId: normalizeTrackId(text?.activeTextId) ?? this.tracks.activeTextId,
        activeAudioId: normalizeTrackId(audio?.activeAudioId) ?? this.tracks.activeAudioId,
      });
    } catch (e) {
      // 旧安装包没有这些方法：保持推送状态，不当作播放错误
      logger.debug('ExoPlayer 轨道列表拉取失败', e);
    }
  }

  /* ---------- EXT-07：画中画（Android 8.0+） ---------- */

  /** 设备/系统是否支持 PiP（原生插件 + 系统特性双判定） */
  async isPipSupported(): Promise<boolean> {
    try {
      const ext = this.extBridge();
      if (!ext.isPipSupported) return false;
      const result = await ext.isPipSupported();
      return result?.supported === true;
    } catch (e) {
      logger.debug('ExoPlayer isPipSupported 不可用', e);
      return false;
    }
  }

  /** 进入 PiP（宽高比由 Java 侧按视频尺寸推导并限幅 16:9 / 4:3） */
  async enterPip(): Promise<void> {
    await ExoPlayer.enterPip();
  }

  /** 当前 Activity 是否处于 PiP（Android 无主动退出 API，靠轮询感知退出） */
  async isPipActive(): Promise<boolean> {
    try {
      const ext = this.extBridge();
      if (!ext.isPipActive) return false;
      const result = await ext.isPipActive();
      return result?.active === true;
    } catch (e) {
      logger.debug('ExoPlayer isPipActive 不可用', e);
      return false;
    }
  }

  setResizeMode(mode: ResizeMode): void {
    void ExoPlayer.setResizeMode({ mode }).catch((e: unknown) =>
      logger.debug('ExoPlayer setResizeMode 失败', e),
    );
  }

  /* ---------- B1/B2：媒体会话元数据 / 后台播放 / 纯音频 ---------- */

  /** 必须在 load() 之前调用：元数据随 prepare 一起下发（见 ExoPrepareOptions） */
  setMediaInfo(info: NativeMediaInfo): void {
    this.mediaInfo = info;
  }

  /** B2：后台继续播放。旧安装包没有该方法时静默降级为「切后台即暂停」 */
  setBackgroundPlayback(enabled: boolean): void {
    this.callOptional('setBackgroundPlayback', { enabled });
  }

  /** B2：纯音频模式（禁视频轨 + 收起 surface，画面位置交还 WebView） */
  setAudioOnly(enabled: boolean): void {
    if (this.audioOnly !== enabled) this.firstFrameRendered = false;
    this.audioOnly = enabled;
    this.callOptional('setAudioOnly', { enabled });
  }

  /**
   * 新增桥接方法的可选调用。
   *
   * 旧安装包上 `ExoPlayer.xxx` 根本不存在，直接调用会**同步**抛 TypeError，
   * `.catch()` 接不住——而这两个方法在 attachEngine 里是同步调的，
   * 抛出去会让整个 load 失败。所以必须先探测再调。
   */
  private callOptional(
    method: 'setBackgroundPlayback' | 'setAudioOnly',
    payload: { enabled: boolean },
  ): void {
    const fn = ExoPlayer[method];
    if (typeof fn !== 'function') {
      logger.debug(`ExoPlayer.${method} 不可用（旧安装包），已跳过`);
      return;
    }
    try {
      void fn.call(ExoPlayer, payload).catch((e: unknown) =>
        logger.debug(`ExoPlayer ${method} 失败`, e),
      );
    } catch (e) {
      logger.debug(`ExoPlayer ${method} 抛错`, e);
    }
  }

  /** 本次会话累计丢帧（AC-125 帧率采样用） */
  getDroppedFrames(): number {
    return this.droppedFrames;
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = this.performDestroy();
    return this.destroyPromise;
  }

  private async performDestroy(): Promise<void> {
    logger.info('NativeEngine.destroy: release 播放器');
    const sessionId = this.sessionId;
    const requestGeneration = this.requestGeneration;
    this.sessionId = '';
    this.requestGeneration += 1;
    try {
      this.stopPolling();
      this.teardownRectWatch();
    } catch (e) {
      logger.warn('NativeEngine.destroy: teardown 异常', (e as Error)?.message ?? String(e));
    }
    await this.detachStateListener();
    if (this.nativeSessionStarted || this.releasePromise) {
      await this.releaseNative(sessionId, requestGeneration);
    }
    this.nativeSessionStarted = false;
    this.pending?.reject(new AppError('E_ABORTED', '播放器已销毁，本次加载作废'));
    this.pending = null;
    this.ready = false;
    this.firstFrameRendered = false;
    this.hasVideoTrack = null;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.surfaceDiagnostic = null;
    this.tracks = emptyEmbeddedTracks();
    logger.info('NativeEngine.destroy: release 完成');
  }

  /* ---------- 内部 ---------- */

  private onState(data: ExoStateData): void {
    if (!this.acceptsState(data)) return;
    switch (data.state) {
      case 'ready': {
        if (typeof data.duration === 'number' && data.duration > 0) {
          this.durationSec = data.duration / 1000;
        }
        if (typeof data.positionMs === 'number' && data.positionMs >= 0) {
          this.positionSec = data.positionMs / 1000;
        }
        this.ready = true;
        if (typeof data.hasVideoTrack === 'boolean') this.hasVideoTrack = data.hasVideoTrack;
        if (typeof data.videoWidth === 'number') this.videoWidth = data.videoWidth;
        if (typeof data.videoHeight === 'number') this.videoHeight = data.videoHeight;
        this.patchSurfaceDiagnostic({
          hasVideoTrack: this.hasVideoTrack ?? undefined,
          videoWidth: this.videoWidth,
          videoHeight: this.videoHeight,
        });
        logger.info('NativeEngine.ready', {
          durationMs: this.durationSec > 0 ? Math.round(this.durationSec * 1000) : null,
          positionMs: Math.round(this.positionSec * 1000),
          hasVideoTrack: this.hasVideoTrack,
          videoWidth: this.videoWidth,
          videoHeight: this.videoHeight,
          sessionId: this.sessionId,
          requestGeneration: this.requestGeneration,
        });
        this.events.onLoadedMetadata(this.durationSec, this.hasVideoTrack ?? undefined);
        this.pending?.resolve();
        this.pending = null;
        // EXT-07：READY 后补拉一次轨道（兜住「Java 上报早于 JS 监听」的窗口）
        void this.refreshEmbeddedTracks();
        break;
      }
      case 'firstframe': {
        if (typeof data.positionMs === 'number') this.positionSec = data.positionMs / 1000;
        this.firstFrameRendered = true;
        this.patchSurfaceDiagnostic({ firstFrameRendered: true });
        this.events.onFirstFrame?.(this.positionSec);
        break;
      }
      case 'surface': {
        this.updateSurfaceDiagnostic(data);
        break;
      }
      case 'buffering':
        if (this.ready) this.events.onWaiting();
        break;
      case 'seeksettled':
        // P1-a：seek 后画面真的落地（Java 侧首帧渲染/重新 READY 上报）
        this.events.onSeekSettled?.({
          targetMs: data.targetMs ?? 0,
          latencyMs: data.latencyMs ?? 0,
          positionMs: data.positionMs ?? 0,
        });
        logger.info('NativeEngine.seekSettled', {
          targetMs: data.targetMs,
          latencyMs: data.latencyMs,
          positionMs: data.positionMs,
        });
        break;
      case 'ended':
        this.ready = false;
        this.events.onEnded();
        break;
      case 'playing':
      case 'paused':
        // B1：原生侧改了播放意图（通知栏/线控/音频焦点），JS 状态必须跟上
        this.events.onPlayingChange?.(data.state === 'playing');
        break;
      case 'remote': {
        const command = data.command;
        if (command === 'previous' || command === 'next' || command === 'stop') {
          this.events.onRemoteCommand?.(command);
        }
        break;
      }
      case 'qualities': {
        // v1.8 优化：清晰度列表更新
        if (data.qualities) {
          this.qualities = data.qualities;
          this.events.onQualitiesChange?.(this.qualities.map((q) => q.label));
        }
        break;
      }
      case 'textTracks': {
        // 兼容旧载荷（仅字幕列表）：音轨/选中态由 `embeddedTracks` 负责
        if (data.textTracks) {
          this.patchTracks({ loaded: true, text: data.textTracks.map(toTextTrack) });
        }
        break;
      }
      case 'embeddedTracks': {
        // EXT-07：字幕轨 + 音轨 + 双方选中项一次到位
        this.patchTracks({
          loaded: true,
          text: (data.textTracks ?? []).map(toTextTrack),
          audio: (data.audioTracks ?? []).map(toAudioTrack),
          activeTextId: normalizeTrackId(data.activeTextId),
          activeAudioId: normalizeTrackId(data.activeAudioId),
        });
        break;
      }
      case 'error': {
        const error = toPlayError(data);
        logger.warn('NativeEngine.error', {
          errorCodeName: data.errorCodeName,
          causeChain: data.causeChain,
          positionMs: data.positionMs,
          code: error.code,
          sessionId: this.sessionId,
          requestGeneration: this.requestGeneration,
          surface: this.getSurfaceDiagnostic(),
        });
        if (this.pending) {
          this.pending.reject(error);
          this.pending = null;
        } else {
          this.events.onError(error);
        }
        break;
      }
      default:
        break;
    }
  }

  private isCurrentSession(sessionId: string, requestGeneration: number): boolean {
    return this.sessionId === sessionId && this.requestGeneration === requestGeneration;
  }

  private acceptsState(data: ExoStateData): boolean {
    if (data.sessionId === undefined && data.requestGeneration === undefined) return true;
    return data.sessionId === this.sessionId && data.requestGeneration === this.requestGeneration;
  }

  private patchSurfaceDiagnostic(patch: NativeSurfaceDiagnostic): void {
    this.surfaceDiagnostic = {
      ...(this.surfaceDiagnostic ?? {}),
      ...patch,
      rect: patch.rect ?? this.surfaceDiagnostic?.rect ?? this.lastRect ?? undefined,
    };
  }

  private updateSurfaceDiagnostic(data: ExoStateData): void {
    if (typeof data.audioOnly === 'boolean') this.audioOnly = data.audioOnly;
    if (typeof data.hasVideoTrack === 'boolean') this.hasVideoTrack = data.hasVideoTrack;
    if (typeof data.videoWidth === 'number') this.videoWidth = data.videoWidth;
    if (typeof data.videoHeight === 'number') this.videoHeight = data.videoHeight;
    if (typeof data.firstFrameRendered === 'boolean') this.firstFrameRendered = data.firstFrameRendered;
    if (data.rect) this.lastRect = data.rect;
    const diagnostic: NativeSurfaceDiagnostic = {
      ...(this.surfaceDiagnostic ?? {}),
      reason: data.reason ?? this.surfaceDiagnostic?.reason,
      visible: data.visible ?? this.surfaceDiagnostic?.visible,
      audioOnly: data.audioOnly ?? this.audioOnly,
      playerAttached: data.playerAttached ?? this.surfaceDiagnostic?.playerAttached,
      hasVideoTrack: data.hasVideoTrack ?? this.hasVideoTrack ?? undefined,
      videoTrackCount: data.videoTrackCount ?? this.surfaceDiagnostic?.videoTrackCount,
      videoWidth: data.videoWidth ?? this.videoWidth,
      videoHeight: data.videoHeight ?? this.videoHeight,
      firstFrameRendered: data.firstFrameRendered ?? this.firstFrameRendered,
      rect: data.rect ?? this.lastRect ?? undefined,
      surfaceValid: data.surfaceValid ?? data.valid ?? this.surfaceDiagnostic?.surfaceValid,
      surfaceShown: data.surfaceShown ?? this.surfaceDiagnostic?.surfaceShown,
      surfaceWidth: data.surfaceWidth ?? this.surfaceDiagnostic?.surfaceWidth,
      surfaceHeight: data.surfaceHeight ?? this.surfaceDiagnostic?.surfaceHeight,
      webViewBackgroundTransparent: data.webViewBackgroundTransparent
        ?? this.surfaceDiagnostic?.webViewBackgroundTransparent,
    };
    this.surfaceDiagnostic = diagnostic;
    const key = JSON.stringify({ ...diagnostic, reason: undefined });
    if (key === this.lastSurfaceLogKey) return;
    this.lastSurfaceLogKey = key;
    logger.info('NativeEngine.surface', {
      ...diagnostic,
      sessionId: this.sessionId,
      requestGeneration: this.requestGeneration,
    });
  }

  private async detachStateListener(): Promise<void> {
    if (this.detachPromise) return this.detachPromise;
    const handle = this.detachState;
    this.detachState = null;
    if (!handle) return;
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(handle.remove()).catch((e: unknown) => {
        logger.debug('ExoPlayer 状态监听解绑失败', e);
      });
    } catch (e) {
      logger.debug('ExoPlayer 状态监听解绑失败', e);
      return;
    }
    this.detachPromise = pending;
    try {
      await pending;
    } finally {
      if (this.detachPromise === pending) this.detachPromise = null;
    }
  }

  private async releaseNative(sessionId: string, requestGeneration: number): Promise<void> {
    const key = `${sessionId}:${requestGeneration}`;
    if (this.releasePromise && this.releaseSessionKey === key) return this.releasePromise;
    if (this.isCurrentSession(sessionId, requestGeneration)) this.nativeSessionStarted = false;
    const pending = (this.releasePromise ?? Promise.resolve())
      .then(() => ExoPlayer.release({ sessionId, requestGeneration }))
      .catch((e: unknown) => {
        logger.debug('ExoPlayer release 失败', e);
      });
    this.releasePromise = pending;
    this.releaseSessionKey = key;
    try {
      await pending;
    } finally {
      if (this.releasePromise === pending) {
        this.releasePromise = null;
        this.releaseSessionKey = '';
      }
    }
  }

  /** 合并轨道状态并通知订阅者（UI 只认这一个出口，避免多处各拼一份） */
  private patchTracks(patch: Partial<EmbeddedTrackState>): void {
    this.tracks = { ...this.tracks, ...patch };
    this.events.onEmbeddedTracksChange?.(this.getEmbeddedTracks());
  }

  /** EXT-07 新增桥接方法视图（见 `ExoPlayerExtBridge` 注释） */
  private extBridge(): Partial<ExoPlayerExtBridge> {
    return ExoPlayer as unknown as Partial<ExoPlayerExtBridge>;
  }

  private startPolling(sessionId: string, requestGeneration: number): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (!this.ready || !this.isCurrentSession(sessionId, requestGeneration)) return;
      void ExoPlayer.progress()
        .then((p) => {
          if (!this.isCurrentSession(sessionId, requestGeneration)) return;
          if (p.positionMs >= 0) this.positionSec = p.positionMs / 1000;
          if (p.durationMs > 0) this.durationSec = p.durationMs / 1000;
          if (typeof p.droppedFrames === 'number') this.droppedFrames = p.droppedFrames;
          this.events.onTimeUpdate(this.positionSec, this.durationSec, this.positionSec);
        })
        .catch(() => undefined);
    }, PROGRESS_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** 全屏/旋屏/窗口变化 → 短窗口内逐帧对齐；页面滚动 → 逐帧对齐（直播页整页滚动） */
  private watchRect(host: HTMLElement, sessionId: string, requestGeneration: number): void {
    this.teardownRectWatch();
    let lastKey = '';
    let settleUntil = 0;
    const pump = (): void => {
      if (this.scrollRaf !== null) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = null;
        if (!this.isCurrentSession(sessionId, requestGeneration)) return;
        const rect = rectOf(host);
        this.lastRect = rect;
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        if (key !== lastKey) {
          lastKey = key;
          void ExoPlayer.setRect(rect).catch(() => undefined);
        }
        if (performance.now() < settleUntil) pump();
      });
    };
    // 旋屏/全屏时视口是分几步落定的，单次防抖会停在中间态（真机实测画面错位持续数秒），
    // 所以变化后开一个窗口逐帧比对，直到几何不再变化才自然收工
    const scheduleSync = (): void => {
      settleUntil = performance.now() + RECT_SETTLE_MS;
      pump();
    };
    this.onWindowResize = scheduleSync;
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('orientationchange', scheduleSync);
    document.addEventListener('fullscreenchange', scheduleSync);
    window.visualViewport?.addEventListener('resize', scheduleSync);
    this.onScroll = pump;
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(scheduleSync);
      this.observer.observe(host);
    }
  }

  private teardownRectWatch(): void {
    if (this.scrollRaf !== null) {
      cancelAnimationFrame(this.scrollRaf);
      this.scrollRaf = null;
    }
    if (this.onScroll) {
      window.removeEventListener('scroll', this.onScroll, { capture: true });
      this.onScroll = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.onWindowResize) {
      window.removeEventListener('resize', this.onWindowResize);
      window.removeEventListener('orientationchange', this.onWindowResize);
      document.removeEventListener('fullscreenchange', this.onWindowResize);
      window.visualViewport?.removeEventListener('resize', this.onWindowResize);
      this.onWindowResize = null;
    }
  }
}

/* ---------- EXT-07：轨道载荷归一化（异常数据兜底） ---------- */

function normalizeTrackId(id: number | undefined | null): number | null {
  return typeof id === 'number' && Number.isFinite(id) && id >= 0 ? id : null;
}

/** Java 侧 label 可能为空（无 language 也无 NAME）：给可读占位，超长交给 CSS 省略 */
function toTextTrack(raw: RawEmbeddedTrack): EmbeddedTextTrack {
  return {
    id: raw.id,
    label: normalizeLabel(raw.label, `字幕 ${raw.id + 1}`),
    language: raw.language ?? null,
    mimeType: raw.mimeType ?? null,
  };
}

function toAudioTrack(raw: RawEmbeddedTrack): EmbeddedAudioTrack {
  return {
    id: raw.id,
    label: normalizeLabel(raw.label, `音轨 ${raw.id + 1}`),
    language: raw.language ?? null,
    mimeType: raw.mimeType ?? null,
    channels: typeof raw.channels === 'number' && raw.channels > 0 ? raw.channels : null,
  };
}

function normalizeLabel(label: string | null | undefined, fallback: string): string {
  const text = (label ?? '').trim();
  return text.length > 0 ? text : fallback;
}

/**
 * host 元素的 CSS px rect（Java 侧 ×density 换算物理像素）。
 * x/y 不做 0 截断：直播页整页滚动时播放器会移出视口上沿，截断会让画面钉在顶部、
 * 与页面上挖出的透明带错位；负坐标交给原生父容器裁剪即可。
 */
function rectOf(host: HTMLElement): { x: number; y: number; width: number; height: number } {
  const r = host.getBoundingClientRect();
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  };
}

function httpStatusFromText(text: string): number | null {
  const match = /Response code:\s*(\d{3})|\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i.exec(text);
  const status = Number(match?.[1] ?? match?.[2]);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function httpPlayError(status: number, detail: string | null): AppErrorShape {
  const mapped = httpStatusToErrorCode(status);
  const code: ErrorCode = status === 402 || mapped === 'E_UNKNOWN' ? 'E_SOURCE_UNAVAILABLE' : mapped;
  return {
    code,
    message: status === 402 ? '播放地址已失效或访问受限，请重新获取' : ERROR_MESSAGES[code],
    detail,
    retryable: code === 'E_SOURCE_UNAVAILABLE' || code === 'E_HTTP_429' || code === 'E_HTTP_5XX',
    httpStatus: status,
  };
}

function toLoadError(e: unknown): AppError {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const detail = raw.length > 0 ? raw.slice(0, 200) : null;
  if (/safe mode active|native player disabled/i.test(raw)) {
    return new AppError('E_INVALID_STATE', '安全模式已关闭原生播放器', {
      cause: e,
      detail,
      retryable: false,
    });
  }
  const status = httpStatusFromText(raw);
  if (status !== null) {
    const shape = httpPlayError(status, detail);
    return new AppError(shape.code, shape.message, {
      cause: e,
      detail: shape.detail,
      retryable: shape.retryable,
      httpStatus: status,
    });
  }
  return new AppError('E_DECODE', '原生引擎加载失败', {
    cause: e,
    detail,
  });
}

/** 播放中错误分类：先保留真实 HTTP 状态，再按 IO/超时/解码归类。 */
export function toPlayError(data: ExoStateData): AppErrorShape {
  const text = data.message ?? '';
  const codeName = data.errorCodeName ?? '';
  const extras = [
    codeName ? `code=${codeName}` : '',
    data.causeChain ? `cause=${data.causeChain}` : '',
    typeof data.positionMs === 'number' ? `pos=${(data.positionMs / 1000).toFixed(1)}s` : '',
  ].filter(Boolean).join(' | ');
  const detail = [text, extras].filter(Boolean).join('\n') || null;
  const status = httpStatusFromText([text, data.causeChain ?? ''].filter(Boolean).join('\n'));
  if (status !== null) return httpPlayError(status, detail);

  let isNetwork: boolean;
  if (codeName) {
    isNetwork = codeName.startsWith('ERROR_CODE_IO_')
      || codeName === 'ERROR_CODE_NETWORK_ERROR'
      || codeName === 'ERROR_CODE_TIMEOUT'
      || codeName === 'ERROR_CODE_BEHIND_LIVE_WINDOW';
  } else {
    isNetwork = /http|network|connect|timeout|source/i.test(text);
  }
  return {
    code: isNetwork ? 'E_NETWORK' : 'E_DECODE',
    message: isNetwork ? '视频加载失败，请检查网络' : '视频播放失败，请尝试切换线路',
    detail,
    retryable: true,
    httpStatus: null,
  };
}
