/**
 * 播放器控制器（API-15）
 *
 * 职责：
 * - 状态机 idle → loading → ready → playing/paused → ended / error
 * - 引擎选择：hls + 原生支持 → VideoEngine；hls 且 hls.js 可用 → HlsEngine；其它 → VideoEngine
 * - 事件订阅与一次性解绑
 * - 进度上报（ProgressReporter）、字幕（SubtitleManager）、全屏（FullscreenController）
 *
 * 明确边界：**不调用任何 Service**。播放源由 Store 解析后传入；
 * 切集通过 `resolveEpisode` 回调由 View 提供新参数。
 */
import type { AppErrorShape, PlaybackRate, PlaybackSource, ResizeMode, SubtitleTrack } from '@/types';
import { AppError, toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { guessFormatFromUrl } from '@/shared/url';

import type {
  EpisodeRef,
  PlayableEngine,
  PlayerEventMap,
  PlayerEventName,
  PlayerListener,
  PlayerLoadOptions,
  PlayerState,
} from '@/player/types';
import {
  CONTROLS_HIDE_DELAY_MS,
  HLS_METADATA_TIMEOUT_MS,
  LOAD_METADATA_TIMEOUT_MS,
  NATIVE_METADATA_TIMEOUT_MS,
  NETWORK_RETRY_DELAY_MS,
  NETWORK_RETRY_TIMES,
  NO_VIDEO_CHECK_DELAY_MS,
  QUALITY_AUTO,
  RESUME_MAX_RATIO,
  RESUME_MIN_RATIO,
  SEEK_SETTLE_TIMEOUT_MS,
  SEEK_SETTLE_TOLERANCE_SEC,
  STALL_CHECK_INTERVAL_MS,
  STALL_MIN_ADVANCE_SEC,
  STALL_STUCK_MS,
} from '@/player/constants';
import { clampBrightness } from '@/player/brightness';
import { canPlayNativeHls, VideoEngine } from '@/player/VideoEngine';
import { HlsEngine, isHlsSupported } from '@/player/HlsEngine';
import {
  NativeEngine,
  emptyEmbeddedTracks,
  type EmbeddedAudioTrack,
  type EmbeddedTextTrack,
  type EmbeddedTrackState,
  type NativeMediaInfo,
} from '@/player/NativeEngine';
import { isExoPlayerAvailable } from '@/native/exoPlayerPlugin';
import { SubtitleManager } from '@/player/SubtitleManager';
import { GestureRecognizer, type GestureIntent } from '@/player/GestureRecognizer';
import { ProgressReporter, type ProgressSnapshot } from '@/player/ProgressReporter';
import { FullscreenController } from '@/player/FullscreenController';
import { OrientationController } from '@/player/OrientationController';
import { assertSourceSupported, isWebPlayPageUrl, scanManifestForDrm } from '@/player/sourceGuard';

/**
 * EXT-07：内嵌字幕/音轨面板类型与空状态。
 *
 * 转导出而非让 View 直接依赖 NativeEngine——面板展示的是控制器状态，
 * 引擎替换（后续可能加入别的原生实现）时 View 无需改动。
 */
export { emptyEmbeddedTracks };
export type { EmbeddedAudioTrack, EmbeddedTextTrack, EmbeddedTrackState };

/** 帧统计（`getFrameStats` 的返回；原生 surface 引擎为 null） */
export interface FrameStats {
  videoWidth: number;
  videoHeight: number;
  totalFrames: number;
}

/**
 * 黑屏判定（纯函数，便于单测）：
 * 有视频元数据、时间在走（>1s）、却一帧都没解出来 → 只有声音没有画面。
 * `totalFrames < 0` 表示环境不支持统计（原生引擎），一律不判黑屏。
 */
export function isNoVideo(stats: FrameStats | null, elapsedSec: number): boolean {
  if (!stats) return false;
  if (stats.totalFrames < 0) return false;
  if (stats.totalFrames > 0) return false;
  if (stats.videoWidth === 0) return false;
  return elapsedSec >= 1;
}

export interface PlayerControllerDeps {
  /** 进度写回调（由 View 注入 historyStore.save） */
  onProgress: (snapshot: ProgressSnapshot, opts: PlayerLoadOptions) => void | Promise<void>;
  /**
   * 全屏时状态栏显隐（AC-52）。
   *
   * 由 View 注入 `deviceService.setStatusBarVisible`——播放器层**不直接调用 Service**
   * （本文件分层约束），Web 下 Service 自身为 no-op，异常也被 FullscreenController 吞掉。
   */
  setStatusBarVisible?: (visible: boolean) => void | Promise<void>;
  /**
   * 全屏沉浸模式（edge-to-edge）：横屏时让内容铺满整块屏幕，
   * 避免刘海安全边内缩后在左侧露出窗口背景。
   *
   * 由 View 注入原生插件代理；Web/测试环境不传即为 no-op。
   */
  setImmersive?: (on: boolean) => void | Promise<void>;
}

/**
 * P0-2 停滞判定（纯函数，便于单测）：
 * 相对锚点没有实质推进（< {@link STALL_MIN_ADVANCE_SEC}）且已经持续
 * {@link STALL_STUCK_MS} 以上 → 判定卡住。
 */
export function isPlaybackStalled(anchorSec: number, positionSec: number, elapsedMs: number): boolean {
  if (positionSec - anchorSec >= STALL_MIN_ADVANCE_SEC) return false;
  return elapsedMs >= STALL_STUCK_MS;
}

export class PlayerController {
  private container: HTMLElement | null = null;
  private engine: PlayableEngine | null = null;
  /** v1.8/CHG-25：当前引擎类型（native/hls/video），供 View 做能力互斥（弹幕/字幕） */
  private engineKind: 'native' | 'hls' | 'video' | null = null;
  private videoHost: HTMLDivElement | null = null;

  private listeners = new Map<PlayerEventName, Set<(payload: never) => void>>();
  private state: PlayerState = 'idle';
  private options: PlayerLoadOptions | null = null;
  /** B2：跨引擎重建保持的后台播放 / 纯音频开关 */
  private backgroundPlayback = false;
  private audioOnly = false;

  private rate: PlaybackRate = 1;
  private volume = 100;
  /** 画面亮度 0~100（100 = 无遮罩，0 = 遮罩最暗）；遮罩渲染由 PlayerSurface 负责 */
  private brightness = 100;
  private quality: string = QUALITY_AUTO;
  private resizeMode: ResizeMode = 'contain';

  /* ---------- EXT-07：内嵌字幕/音轨 ---------- */

  /** 最近一次引擎上报的轨道状态（切集重置为空状态） */
  private embeddedTracks: EmbeddedTrackState = emptyEmbeddedTracks();
  /**
   * 轨道订阅者。
   *
   * 不复用 `PlayerEventMap`：`src/player/types.ts` 的公开事件契约不在本次改动范围内，
   * 这里用独立订阅 API（`onEmbeddedTracksChange`）承载新增能力。
   */
  private trackListeners = new Set<(state: EmbeddedTrackState) => void>();

  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** 网络错误自动重试定时器（REV-06）：必须可取消，避免页面销毁/切集后仍触发 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private networkRetries = 0;

  /**
   * P1-a：待落地的 seek 目标（秒）。
   *
   * `null` = 没有等待落地的定位。落地的判定取三者最早：原生 `seeksettled` 事件、
   * 引擎回报已接近目标的时间、或 `SEEK_SETTLE_TIMEOUT_MS` 超时兜底。
   */
  private seekSettleTarget: number | null = null;
  private seekSettleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * P0-2：本地播放停滞自愈状态。
   *
   * 只在 `playback.isLocal` 且状态为 playing 时运行：坏转封装产物的典型形态是
   * READY + 首帧已出、位置却永远不动，引擎自身不会报错，必须靠位置推进来判断。
   */
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private stallAnchorSec = 0;
  private stallAnchorAt = 0;
  /** 本轮加载是否已经用过"复位重备"这一次机会（每次 load 重置） */
  private stallRecovered = false;

  /** m3u8 DRM 预检的取消句柄（AC-40）：切集/重试/销毁时中止上一轮预检 */
  private preflightAbort: AbortController | null = null;
  /** 预检代次：新一次加载/卸载时递增，旧预检返回后据此放弃，避免旧结果污染新播放 */
  private preflightEpoch = 0;

  /** 加载代次：load() 入口递增，await 后校验，过期则中止（防止卸载后僵尸播放） */
  private loadSeq = 0;

  private readonly subtitles: SubtitleManager;
  private readonly progress: ProgressReporter;
  /** 缓存最近一次字幕文本，跳过同一 cue 内的重复 emit */
  private lastSubtitleText = '';
  readonly fullscreen: FullscreenController;
  readonly orientation: OrientationController;
  private recognizer: GestureRecognizer | null = null;

  private destroyed = false;

  constructor(private readonly deps: PlayerControllerDeps) {
    this.subtitles = new SubtitleManager();
    this.progress = new ProgressReporter({
      save: (snapshot) => {
        const opts = this.options;
        if (!opts) return;
        return this.deps.onProgress(snapshot, opts);
      },
    });
    this.fullscreen = new FullscreenController({
      onChange: (fs) => this.emit('fullscreenchange', { fullscreen: fs }),
      // AC-52：全屏隐藏状态栏并切沉浸式，退出恢复。异常不得阻断全屏（FullscreenController 已兜底）
      onEnter: async () => {
        await this.deps.setStatusBarVisible?.(false);
        await this.deps.setImmersive?.(true);
      },
      onExit: async () => {
        await this.deps.setImmersive?.(false);
        await this.deps.setStatusBarVisible?.(true);
      },
    });
    this.fullscreen.bind();
    this.orientation = new OrientationController();
  }

  /* ================= 事件 ================= */

  on<K extends PlayerEventName>(event: K, cb: PlayerListener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set<(payload: never) => void>();
    set.add(cb as (payload: never) => void);
    this.listeners.set(event, set);
    return () => {
      set.delete(cb as (payload: never) => void);
    };
  }

  private emit<K extends PlayerEventName>(event: K, payload: PlayerEventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        (cb as (p: PlayerEventMap[K]) => void)(payload);
      } catch {
        /* 单个订阅者异常不影响其它订阅者 */
      }
    }
  }

  /* ================= 挂载与加载 ================= */

  mount(container: HTMLElement): void {
    this.container = container;
    if (!this.videoHost) {
      const host = document.createElement('div');
      host.className = 'player-canvas';
      host.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
      this.videoHost = host;
    }
    // 视频挂到设计约定的 `[data-player-host]`（位于 PlayerSurface 内部），
    // 让亮度遮罩/字幕等兄弟元素自然叠加在画面之上；找不到时回退容器（测试/兜底）。
    const target = container.querySelector<HTMLElement>('[data-player-host]') ?? container;
    if (this.videoHost.parentElement !== target) target.appendChild(this.videoHost);
    this.engine?.attach(this.videoHost);
    this.fullscreen.setElement(container);
  }

  async load(opts: PlayerLoadOptions): Promise<void> {
    if (this.destroyed) throw new AppError('E_INVALID_STATE', '播放器已销毁');
    // 递增加载代次：await 后校验，过期则中止（防止卸载后僵尸播放）
    const seq = ++this.loadSeq;
    // 切集/切线路：取消上一轮尚未触发的网络重试，避免旧重试把新加载顶掉（REV-06）
    this.clearRetryTimer();
    // 上一集的预载参数对新集已过期（CHG-21）
    this.clearPreload();
    // 黑屏检测按「每次加载」重置
    this.clearNoVideoCheck();
    // P0-2：停滞自愈按「每次加载」重置（复位机会不得跨集复用）
    this.stopStallWatchdog();
    this.stallRecovered = false;
    this.setState('loading');
    this.options = opts;
    this.networkRetries = 0;
    this.lastSubtitleText = '';
    // EXT-07：切集清空内嵌轨道，避免上一集的字幕/音轨留在菜单里
    this.setEmbeddedTracks(emptyEmbeddedTracks());
    this.subtitles.setTracks(opts.playback.subtitles);
    this.emit('subtitlechange', {
      activeId: this.subtitles.getActiveId(),
      tracks: this.subtitles.getTracks(),
      text: '',
      failedIds: this.subtitles.getFailedIds(),
    });

    try {
      await this.attachEngine(opts.playback);
      // 加载期间被更新的加载/销毁取消：不覆盖新状态、不误报错误
      if (this.destroyed || seq !== this.loadSeq) {
        this.destroyEngine();
        throw new AppError('E_ABORTED', '播放已切换，本次加载作废');
      }
      const start = this.resolveStartPosition(opts);
      // P0-3：原生引擎把续播位置随 prepare 一起下发了（NativeEngine.load → startPositionMs），
      // 这里再 seek 一次等于二次定位——本地大文件上每次定位都要重扫容器并重启硬解，
      // 起播因此多卡 1~3 秒。位置已由引擎预置时跳过补 seek。
      const prepositionedByEngine = (opts.playback.startPositionMs ?? 0) > 0;
      if (start > 0 && !(this.engineKind === 'native' && prepositionedByEngine)) {
        this.engine?.seek(start);
      }
      this.engine?.setRate(this.rate);
      this.engine?.setVolume(this.volume);
      this.engine?.setResizeMode(this.resizeMode);
      this.setState('ready');
      this.progress.update(start, this.engine?.getDuration() ?? 0);
      this.progress.start();
      // 切集/自动连播后通知 UI 同步当前集（上下集按钮禁用态依赖 player.episodeId）
      this.emit('loaded', { episodeId: opts.episodeId });
      this.scheduleControlsHide();
      // P1-6: 起播后即预载下一集（给足时间预热连接/DNS），临近片尾的二次调用由幂等保护跳过
      this.preloadNext();
    } catch (e) {
      // 预检被更新的加载/销毁取消：不覆盖新状态、不误报错误
      if (e instanceof AppError && e.code === 'E_ABORTED') throw e;
      const error = toErrorShape(
        e instanceof AppError ? e : new AppError('E_DECODE', '视频加载失败，请尝试切换线路', { cause: e }),
      );
      this.setState('error');
      this.emit('error', error);
      throw e instanceof AppError ? e : new AppError('E_DECODE', error.message, { cause: e });
    }
  }

  /** 根据格式与原生能力选择引擎并 attach/load */
  private async attachEngine(playback: PlaybackSource): Promise<void> {
    // 解析层应已把网页播放页换回直链；走到这里仍是页面说明解析失败，
    // 快速报错交给容错链换线/换源，不让两个引擎对着 HTML 白等超时。
    if (isWebPlayPageUrl(playback.url)) {
      throw new AppError('E_NO_PLAY_URL', '播放地址仍是网页播放页，未解析到视频直链');
    }
    const format = playback.format === 'other' ? guessFormatFromUrl(playback.url) ?? 'mp4' : playback.format;

    this.destroyEngine();

    const host = this.videoHost ?? this.container;
    if (!host) throw new AppError('E_INVALID_STATE', '播放器容器未挂载');

    // v1.8 优化：原生引擎支持 DASH/DRM，只在 WebView 引擎路径上做前置检查
    // P0-4：本地文件一律优先原生引擎。WebView 的 <video> 对 `file://` 大文件支持参差
    // （`.ts` 直接解不了封装，`.mp4` 的 seek 与硬件解码也不受控），ExoPlayer 走
    // FileDataSource + 硬解， seek 精确、后台可续播。
    const preferNativeForLocal = playback.isLocal;
    const useNativeEngine = (this.options?.preferNativeEngine === true || preferNativeForLocal)
      && await isExoPlayerAvailable();

    // P1-5：离线裸 .ts 只有原生引擎能解。原生不可用（安全模式 / 插件缺失 / 非 Android）
    // 时直接报错，不要让 WebView 的 <video> 对着必然失败的文件等满元数据超时。
    if (playback.isLocal && format === 'ts' && !useNativeEngine) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '该离线文件需要原生播放器，当前不可用');
    }

    // AC-40：WebView 路径在创建任何引擎前完成两级前置检查，命中即拒绝——
    // 1) URL 级：DASH(.mpd) / 地址内嵌的 SAMPLE-AES 标记，不发请求；
    // 2) 清单级：拉取 m3u8 文本识别 `#EXT-X-KEY:METHOD=SAMPLE-AES`（预检失败一律放行，
    //    绝不把网络抖动误判成 DRM）。
    // 每次进入 attachEngine 先让上一轮预检作废，避免切集/重试时旧结果覆盖新播放。
    const preflightEpoch = this.supersedePreflight();
    if (!useNativeEngine) {
      assertSourceSupported(playback.url);
      await this.runManifestPreflight(playback, preflightEpoch);
    }

    /*
     * v1.8/CHG-25：实验性原生引擎（ExoPlayer surface 模式）。
     * 开关由 View 经 PlayerLoadOptions 注入（本层不读 Service/设置，保持分层约束）；
     * 不可用或加载失败时**静默回退**下方 WebView 分支并发 notice——
     * 不计为播放失败，避免误触发 PlayerView 的换线/换源兜底（FR-53）。
     * v1.8 优化：原生引擎支持 DASH/DRM，跳过前置检查
     */
    if (useNativeEngine) {
      const nativeEngine = new NativeEngine({
        onLoadedMetadata: (duration) => this.handleLoadedMetadata(duration),
        onTimeUpdate: (currentTime, duration, buffered) =>
          this.handleTimeUpdate(currentTime, duration, buffered),
        onWaiting: () => this.emit('statechange', { playing: true, waiting: true }),
        onEnded: () => this.handleEnded(),
        onError: (error) => this.handleEngineError(error),
        onQualitiesChange: (qualities) => this.emit('qualitychange', { quality: this.quality, levels: qualities }),
        // EXT-07：内嵌字幕/音轨状态（两个原生引擎构造点都要接）
        onEmbeddedTracksChange: (state) => this.setEmbeddedTracks(state),
        // P1-a：原生侧回报"seek 后画面落地"，立即收口等待态并写历史
        onSeekSettled: () => this.settleSeek(),
        // B1：原生侧播放意图变化（通知栏/线控/音频焦点）与上下集指令
        onPlayingChange: (playing) => this.handleRemotePlaying(playing),
        onRemoteCommand: (command) => this.emit('remotecommand', { command }),
      });
      nativeEngine.attach(host);
      nativeEngine.setMediaInfo(this.mediaInfoOf());
      // 切集重建引擎后，后台播放/纯音频开关必须重放，否则用户设置被静默重置
      nativeEngine.setBackgroundPlayback(this.backgroundPlayback);
      nativeEngine.setAudioOnly(this.audioOnly);
      try {
        await this.withMetadataTimeout(nativeEngine.load(playback), NATIVE_METADATA_TIMEOUT_MS);
        // 加载期间被销毁：销毁刚创建的引擎，不赋值给 this.engine
        if (this.destroyed) {
          nativeEngine.destroy();
          throw new AppError('E_ABORTED', '播放器已销毁，本次加载作废');
        }
        this.engine = nativeEngine;
        this.setEngineKind('native');
        this.quality = QUALITY_AUTO;
        this.emit('qualitychange', { quality: QUALITY_AUTO, levels: [] });
        this.progress.update(0, nativeEngine.getDuration());
        return;
      } catch (nativeError) {
        try {
          nativeEngine.destroy();
        } catch {
          /* 回退路径上的清理失败可忽略 */
        }
        // P1-5：离线裸 .ts 只有原生引擎能解（WebView 的 <video> 不认 MPEG-TS）。
        // 静默回退等于让 <video> 对着必然失败的文件白等 20s 元数据超时，
        // 用户看到的就是"点了播放一直卡住"——这里直接给明确结论。
        if (playback.isLocal && format === 'ts') {
          throw new AppError('E_UNSUPPORTED_FORMAT', '该离线文件需要原生播放器，当前不可用', {
            detail: toErrorShape(nativeError, 'E_DECODE').message,
          });
        }
        this.emit('notice', { message: '原生引擎不可用，已切回内置引擎' });
        // 落入下方 WebView 分支继续加载
      }
    } else if (this.options?.preferNativeEngine === true) {
      this.emit('notice', { message: '原生引擎不可用，已切回内置引擎' });
    }

    // P0-7: 有头 HLS 强制 hls.js（原生 <video> 无法注入头）
    const hasHeaders = Object.keys(playback.headers ?? {}).length > 0;
    const useHls = format === 'hls' && (!canPlayNativeHls() || hasHeaders);
    // v1.8 优化：WebView 引擎加载失败时自动降级到原生引擎（如果可用且未尝试过）
    let webviewFailed = false;
    let webviewError: unknown = null;
    if (useHls) {
      const supported = await isHlsSupported();
      if (!supported) {
        throw new AppError('E_UNSUPPORTED_FORMAT', '当前环境不支持 HLS 播放');
      }
      const hlsEngine = new HlsEngine({
        onLoadedMetadata: (duration) => this.handleLoadedMetadata(duration),
        onTimeUpdate: (currentTime, duration, buffered) =>
          this.handleTimeUpdate(currentTime, duration, buffered),
        onPlay: () => this.setState('playing'),
        onPause: () => this.handlePause(),
        onWaiting: () => this.emit('statechange', { playing: true, waiting: true }),
        onPlaying: () => {
          this.emit('statechange', { playing: true, waiting: false });
          this.setState('playing');
        },
        onEnded: () => this.handleEnded(),
        onError: (error) => this.handleEngineError(error),
        onQualityChange: (quality, levels) => {
          this.quality = quality;
          this.emit('qualitychange', { quality, levels });
        },
      });
      hlsEngine.attach(host);
      try {
        await this.withMetadataTimeout(hlsEngine.load(playback), HLS_METADATA_TIMEOUT_MS);
        // 加载期间被销毁：销毁刚创建的引擎，不赋值给 this.engine
        if (this.destroyed) {
          hlsEngine.destroy();
          throw new AppError('E_ABORTED', '播放器已销毁，本次加载作废');
        }
        this.engine = hlsEngine;
        this.setEngineKind('hls');
        this.progress.update(0, hlsEngine.getDuration());
        return;
      } catch (e) {
        webviewFailed = true;
        webviewError = e;
        this.destroyEngine();
      }
    } else {
      const videoEngine = new VideoEngine({
        onLoadedMetadata: (duration) => this.handleLoadedMetadata(duration),
        onTimeUpdate: (currentTime, duration, buffered) =>
          this.handleTimeUpdate(currentTime, duration, buffered),
        onPlay: () => this.setState('playing'),
        onPause: () => this.handlePause(),
        onWaiting: () => this.emit('statechange', { playing: true, waiting: true }),
        onPlaying: () => {
          this.emit('statechange', { playing: true, waiting: false });
          this.setState('playing');
        },
        onEnded: () => this.handleEnded(),
        onError: (error) => this.handleEngineError(error),
      });
      videoEngine.attach(host);
      try {
        await this.withMetadataTimeout(videoEngine.load(playback));
        // 加载期间被销毁：销毁刚创建的引擎，不赋值给 this.engine
        if (this.destroyed) {
          videoEngine.destroy();
          throw new AppError('E_ABORTED', '播放器已销毁，本次加载作废');
        }
        this.engine = videoEngine;
        this.setEngineKind('video');
        this.quality = QUALITY_AUTO;
        this.emit('qualitychange', { quality: QUALITY_AUTO, levels: [] });
        return;
      } catch (e) {
        webviewFailed = true;
        webviewError = e;
        this.destroyEngine();
      }
    }

    // v1.8 优化：WebView 引擎失败后自动降级到原生引擎
    if (webviewFailed && this.options?.preferNativeEngine !== true && await isExoPlayerAvailable()) {
      this.emit('notice', { message: '内置引擎加载失败，自动切换到原生引擎' });
      const nativeEngine = new NativeEngine({
        onLoadedMetadata: (duration) => this.handleLoadedMetadata(duration),
        onTimeUpdate: (currentTime, duration, buffered) =>
          this.handleTimeUpdate(currentTime, duration, buffered),
        onWaiting: () => this.emit('statechange', { playing: true, waiting: true }),
        onEnded: () => this.handleEnded(),
        onError: (error) => this.handleEngineError(error),
        onQualitiesChange: (qualities) => this.emit('qualitychange', { quality: this.quality, levels: qualities }),
        // EXT-07：WebView 失败降级到原生时同样要接轨道状态
        onEmbeddedTracksChange: (state) => this.setEmbeddedTracks(state),
        onSeekSettled: () => this.settleSeek(),
        // B1：原生侧播放意图变化（通知栏/线控/音频焦点）与上下集指令
        onPlayingChange: (playing) => this.handleRemotePlaying(playing),
        onRemoteCommand: (command) => this.emit('remotecommand', { command }),
      });
      nativeEngine.attach(host);
      nativeEngine.setMediaInfo(this.mediaInfoOf());
      // 切集重建引擎后，后台播放/纯音频开关必须重放，否则用户设置被静默重置
      nativeEngine.setBackgroundPlayback(this.backgroundPlayback);
      nativeEngine.setAudioOnly(this.audioOnly);
      try {
        await this.withMetadataTimeout(nativeEngine.load(playback), NATIVE_METADATA_TIMEOUT_MS);
        // 加载期间被销毁：销毁刚创建的引擎，不赋值给 this.engine
        if (this.destroyed) {
          nativeEngine.destroy();
          throw new AppError('E_ABORTED', '播放器已销毁，本次加载作废');
        }
        this.engine = nativeEngine;
        this.setEngineKind('native');
        this.quality = QUALITY_AUTO;
        this.emit('qualitychange', { quality: QUALITY_AUTO, levels: [] });
        this.progress.update(0, nativeEngine.getDuration());
        return;
      } catch {
        try {
          nativeEngine.destroy();
        } catch {
          /* 回退路径上的清理失败可忽略 */
        }
        // 原生也失败，抛出原始 WebView 错误
        throw webviewError;
      }
    }

    // 原生引擎不可用或已尝试过，抛出 WebView 错误
    throw webviewError;
  }

  /** 作废上一轮清单预检（切集/重试/销毁）：取消在飞请求并递增代次 */
  private supersedePreflight(): number {
    this.preflightEpoch += 1;
    this.preflightAbort?.abort();
    this.preflightAbort = null;
    return this.preflightEpoch;
  }

  /**
   * 清单级 DRM 预检（AC-40 / REV-27）。
   *
   * 只有 m3u8 会真正发请求；`.mp4`/`.webm` 在 `scanManifestForDrm` 内直接返回空结果。
   * master playlist 会继续拉取变体清单做同口径断言（加密标记通常写在变体里），
   * 命中即抛 `E_DRM_PROTECTED`，调用方在创建 hls/video 实例之前中止。
   * 子清单拉取失败不判 DRM；期间被更新的加载取代时抛 `E_ABORTED`（由 `load()` 静默处理）。
   */
  private async runManifestPreflight(playback: PlaybackSource, epoch: number): Promise<void> {
    const controller = new AbortController();
    this.preflightAbort = controller;
    try {
      const scan = await scanManifestForDrm(playback.url, {
        headers: playback.headers,
        signal: controller.signal,
      });
      if (epoch !== this.preflightEpoch) throw new AppError('E_ABORTED', '播放已切换，本次预检作废');
      // DASH / URL 级标记；顶层清单命中也在 detectUnsupportedSource 内覆盖
      assertSourceSupported(playback.url, scan.manifestText);
      if (scan.drm) throw new AppError('E_DRM_PROTECTED', undefined, { retryable: false });
    } finally {
      if (this.preflightAbort === controller) this.preflightAbort = null;
    }
  }

  private withMetadataTimeout(promise: Promise<void>, timeoutMs: number = LOAD_METADATA_TIMEOUT_MS): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppError('E_TIMEOUT', '加载超时，请检查网络后重试'));
      }, timeoutMs);
      promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private resolveStartPosition(opts: PlayerLoadOptions): number {
    const duration = this.engine?.getDuration() ?? 0;
    if (duration <= 0) return Math.max(0, opts.startPositionSec);
    const ratio = opts.startPositionSec / duration;
    if (ratio <= RESUME_MIN_RATIO || ratio >= RESUME_MAX_RATIO) return 0;
    return opts.startPositionSec;
  }

  private handleLoadedMetadata(duration: number): void {
    this.progress.update(this.engine?.getCurrentTime() ?? 0, duration);
    this.emit('ready', { duration });
  }

  private handleTimeUpdate(currentTime: number, duration: number, buffered: number): void {
    this.progress.update(currentTime, duration);
    // P1-a：引擎回报已经跑到目标附近 = 定位真的落了地
    if (this.seekSettleTarget !== null
      && Math.abs(currentTime - this.seekSettleTarget) <= SEEK_SETTLE_TOLERANCE_SEC) {
      this.settleSeek();
    }
    this.emit('timeupdate', { currentTime, duration, buffered });
    // 黑屏检测：起播后 5s 仍一帧未出 → 上报一次（每次加载最多一次）
    if (currentTime > 0) this.scheduleNoVideoCheck();
    // 字幕：只在当前 cue 可能变化时才查找（跳过同一时间区间内的重复 timeupdate）
    if (this.subtitles.getActiveId()) {
      const text = this.subtitles.textAt(currentTime);
      if (text !== this.lastSubtitleText) {
        this.lastSubtitleText = text;
        this.emit('subtitlechange', {
          activeId: this.subtitles.getActiveId(),
          tracks: this.subtitles.getTracks(),
          text,
          failedIds: this.subtitles.getFailedIds(),
        });
      }
    }
    // v1.7/CHG-21：临近片尾（剩 90s）预载下一集，连播切换零等待
    if (duration > 0 && duration - currentTime <= 90 && this.canNext()) {
      this.preloadNext();
    }
  }

  private handlePause(): void {
    this.setState('paused');
    void this.progress.flush();
  }

  private handleEnded(): void {
    this.setState('ended');
    void this.progress.finish();
    this.emit('ended', undefined);
  }

  /* ---------- 黑屏检测（码流在播但无画面） ---------- */

  private noVideoTimer: ReturnType<typeof setTimeout> | null = null;
  private noVideoReported = false;

  private clearNoVideoCheck(): void {
    if (this.noVideoTimer !== null) {
      clearTimeout(this.noVideoTimer);
      this.noVideoTimer = null;
    }
    this.noVideoReported = false;
  }

  private scheduleNoVideoCheck(): void {
    if (this.noVideoReported || this.noVideoTimer !== null) return;
    this.noVideoTimer = setTimeout(() => {
      this.noVideoTimer = null;
      this.checkNoVideo();
    }, NO_VIDEO_CHECK_DELAY_MS);
  }

  /**
   * 一帧都没解出来 → 上报 `novideo`（每次加载最多一次）。
   *
   * 判据三条同时成立才算：有视频元数据（videoWidth > 0）、时间在推进（>1s）、
   * `totalFrames === 0`。原生 surface 引擎拿不到帧统计（返回 null）直接跳过，
   * 避免误报。
   */
  private checkNoVideo(): void {
    if (this.destroyed || this.noVideoReported) return;
    const stats = this.engine?.getFrameStats?.() ?? null;
    const elapsedSec = this.engine?.getCurrentTime() ?? 0;
    if (!isNoVideo(stats, elapsedSec)) return;
    if (!stats) return;
    this.noVideoReported = true;
    this.emit('novideo', {
      videoWidth: stats.videoWidth,
      videoHeight: stats.videoHeight,
      elapsedSec,
    });
  }

  private handleEngineError(error: AppErrorShape): void {
    if (error.code === 'E_NETWORK' && this.networkRetries < NETWORK_RETRY_TIMES) {
      this.networkRetries += 1;
      this.emit('statechange', { playing: false, waiting: true });
      // 先清旧定时器再登记新定时器：同一时刻最多一个在飞
      this.clearRetryTimer();
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        const opts = this.options;
        if (!opts || this.destroyed) return;
        void this.attachEngine(opts.playback)
          .then(() => this.engine?.play())
          .catch((e: unknown) => {
            this.setState('error');
            this.emit('error', toErrorShape(e, 'E_NETWORK'));
          });
      }, NETWORK_RETRY_DELAY_MS);
      return;
    }
    this.setState('error');
    this.emit('error', error);
  }

  /** 取消网络重试定时器（load / destroy 共用，REV-06） */
  private clearRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /* ================= 播放控制 ================= */

  async play(): Promise<void> {
    if (!this.engine || this.destroyed) return;
    try {
      await this.engine.play();
      // 播放期间被销毁：立即暂停，不更新状态
      if (this.destroyed) {
        this.engine.pause();
        return;
      }
      this.setState('playing');
      this.progress.start();
      this.startStallWatchdog();
    } catch (e) {
      this.emit('error', toErrorShape(e, 'E_DECODE'));
    }
    this.scheduleControlsHide();
  }

  pause(): void {
    this.stopStallWatchdog();
    this.engine?.pause();
    this.setState('paused');
    void this.progress.flush();
  }

  /* ---------- P0-2：本地播放停滞自愈 ---------- */

  /**
   * 登记停滞窗口：位置连续 {@link STALL_STUCK_MS} 不推进即视为卡死。
   *
   * 只对本地产物启用——网络源的卡顿是缓冲，本引擎已有 waiting/重试链路，
   * 这里插一脚只会把慢网速误报成"文件坏了"。
   */
  private startStallWatchdog(): void {
    this.stopStallWatchdog();
    const engine = this.engine;
    if (!engine || !this.options?.playback.isLocal) return;
    this.stallAnchorSec = engine.getCurrentTime();
    this.stallAnchorAt = Date.now();
    this.stallTimer = setInterval(() => this.tickStallWatchdog(), STALL_CHECK_INTERVAL_MS);
  }

  private stopStallWatchdog(): void {
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private tickStallWatchdog(): void {
    if (this.destroyed || this.state !== 'playing') return;
    const engine = this.engine;
    if (!engine) return;
    const now = Date.now();
    // 定位在飞：原生 seek 本身要秒级（扫容器 + 重启硬解），此时不能算停滞
    if (this.seekSettleTarget !== null) {
      this.stallAnchorAt = now;
      this.stallAnchorSec = engine.getCurrentTime();
      return;
    }
    const position = engine.getCurrentTime();
    if (position - this.stallAnchorSec >= STALL_MIN_ADVANCE_SEC) {
      this.stallAnchorSec = position;
      this.stallAnchorAt = now;
    }
    if (!isPlaybackStalled(this.stallAnchorSec, position, now - this.stallAnchorAt)) return;
    this.stopStallWatchdog();
    if (!this.stallRecovered) {
      this.stallRecovered = true;
      void this.restartLocalPlayback(position);
      return;
    }
    this.setState('error');
    this.emit('error', toErrorShape(new AppError('E_LOCAL_STALL', undefined, {
      detail: `position=${position.toFixed(1)}s 内无推进`,
    })));
  }

  /**
   * 停滞后的唯一一次复位：重新 prepare（等价于用户退出重进），从头起播。
   *
   * 复位能救的是"引擎侧一次性状态错乱"；时间轴本身坏掉的产物复位后仍会停滞，
   * 由第二次 tick 收口成 E_LOCAL_STALL。
   */
  private async restartLocalPlayback(stalledAtSec: number): Promise<void> {
    const opts = this.options;
    if (!opts || this.destroyed) return;
    this.emit('notice', { message: '离线起播异常，正在重试' });
    try {
      await this.attachEngine(opts.playback);
    } catch (e) {
      if (!this.destroyed) {
        this.setState('error');
        this.emit('error', toErrorShape(e, 'E_DECODE'));
      }
      return;
    }
    if (this.destroyed) return;
    this.setState('ready');
    logger.warn('本地播放停滞，已复位重备', { stalledAtSec, url: opts.playback.url });
    await this.play();
  }

  async toggle(): Promise<void> {
    if (this.state === 'playing') this.pause();
    else await this.play();
  }

  seek(sec: number): void {
    const duration = this.engine?.getDuration() ?? 0;
    const target = duration > 0 ? Math.min(Math.max(0, sec), duration) : Math.max(0, sec);
    this.engine?.seek(target);
    this.emit('timeupdate', {
      currentTime: target,
      duration,
      buffered: this.engine?.getBuffered() ?? 0,
    });
    // P1-a：不在这里写历史。定位未完成时引擎仍停在旧位置，此刻落库写的既不是目标
    // 也不是真实位置；等引擎回报落地再写（见 settleSeek）。
    this.armSeekSettle(target);
  }

  /** 登记一次待落地的 seek；裸 TS 额外给一句"正在定位"提示（转封装失败时的兜底路径） */
  private armSeekSettle(target: number): void {
    const isRawTs = this.options?.playback.isLocal === true && this.options.playback.format === 'ts';
    const shouldHint = isRawTs && this.seekSettleTarget === null;
    this.seekSettleTarget = target;
    if (this.seekSettleTimer !== null) clearTimeout(this.seekSettleTimer);
    this.seekSettleTimer = setTimeout(() => this.settleSeek(), SEEK_SETTLE_TIMEOUT_MS);
    if (shouldHint) this.emit('notice', { message: '正在定位画面…' });
  }

  /** seek 落地：收口等待态并把真实位置写进历史 */
  private settleSeek(): void {
    if (this.seekSettleTarget === null) return;
    this.seekSettleTarget = null;
    if (this.seekSettleTimer !== null) {
      clearTimeout(this.seekSettleTimer);
      this.seekSettleTimer = null;
    }
    this.emit('statechange', { playing: this.state === 'playing', waiting: false });
    void this.progress.flush();
  }

  /** 换引擎/切集/销毁：作废待落地的 seek，不让旧定位把新位置写进历史 */
  private clearSeekSettle(): void {
    this.seekSettleTarget = null;
    if (this.seekSettleTimer !== null) {
      clearTimeout(this.seekSettleTimer);
      this.seekSettleTimer = null;
    }
  }

  seekBy(deltaSec: number): void {
    const current = this.engine?.getCurrentTime() ?? 0;
    this.seek(current + deltaSec);
  }

  setRate(rate: PlaybackRate): void {
    this.rate = rate;
    this.engine?.setRate(rate);
    this.emit('ratechange', { rate });
  }

  setVolume(volume: number): void {
    this.volume = Math.min(100, Math.max(0, Math.round(volume)));
    this.engine?.setVolume(this.volume);
  }

  getVolume(): number {
    return this.volume;
  }

  setResizeMode(mode: ResizeMode): void {
    this.resizeMode = mode;
    this.engine?.setResizeMode(mode);
  }

  getResizeMode(): ResizeMode {
    return this.resizeMode;
  }

  /** 画面亮度 0~100（100 = 无遮罩，0 = 遮罩最暗，AC-48） */
  setBrightness(brightness: number): void {
    this.brightness = clampBrightness(brightness);
  }

  getBrightness(): number {
    return this.brightness;
  }

  /* ================= 字幕 ================= */

  async setSubtitle(id: string | null): Promise<void> {
    try {
      await this.subtitles.setActive(id);
    } finally {
      // 失败也要同步：`failedIds` 变化需让面板立刻显示「不可用」（AC-46），
      // 错误继续向上抛给 View 弹 Toast，播放不中断。
      this.emit('subtitlechange', {
        activeId: this.subtitles.getActiveId(),
        tracks: this.subtitles.getTracks(),
        text: this.subtitles.textAt(this.engine?.getCurrentTime() ?? 0),
        failedIds: this.subtitles.getFailedIds(),
      });
    }
  }

  setSubtitleOffset(offsetSec: number): void {
    this.subtitles.setOffset(offsetSec);
  }

  /** 重试加载失败的字幕轨（AC-46）：成功后标记消失并激活 */
  async retrySubtitle(id: string): Promise<void> {
    await this.subtitles.retry(id);
    this.emit('subtitlechange', {
      activeId: this.subtitles.getActiveId(),
      tracks: this.subtitles.getTracks(),
      text: this.subtitles.textAt(this.engine?.getCurrentTime() ?? 0),
      failedIds: this.subtitles.getFailedIds(),
    });
  }

  /** 当前失败的字幕轨 id（AC-46） */
  getFailedSubtitleIds(): string[] {
    return this.subtitles.getFailedIds();
  }

  async addLocalSubtitle(file: File): Promise<SubtitleTrack> {
    const track = await this.subtitles.addLocal(file);
    this.emit('subtitlechange', {
      activeId: this.subtitles.getActiveId(),
      tracks: this.subtitles.getTracks(),
      text: '',
      failedIds: this.subtitles.getFailedIds(),
    });
    return track;
  }

  getSubtitleTrack(): string {
    return this.subtitles.textAt(this.engine?.getCurrentTime() ?? 0);
  }

  /* ================= 清晰度 ================= */

  setQuality(quality: string): void {
    this.quality = quality;
    this.engine?.setQuality(quality);
    this.emit('qualitychange', { quality, levels: this.engine?.getQualities() ?? [] });
  }

  getQuality(): string {
    return this.quality;
  }

  /* ================= EXT-07：内嵌字幕 / 音轨 ================= */

  /** 订阅轨道状态变化，返回解绑函数（View 卸载时调用） */
  onEmbeddedTracksChange(cb: (state: EmbeddedTrackState) => void): () => void {
    this.trackListeners.add(cb);
    return () => {
      this.trackListeners.delete(cb);
    };
  }

  /** 当前轨道状态（打开菜单前先读一次，避免空等推送） */
  getEmbeddedTracks(): EmbeddedTrackState {
    return this.embeddedTracks;
  }

  /** 切换内嵌字幕轨；`null` = 关闭字幕。仅原生引擎支持 */
  async setEmbeddedSubtitleTrack(id: number | null): Promise<void> {
    const engine = this.nativeEngine();
    if (!engine) throw new AppError('E_NOT_IMPLEMENTED', '当前播放器不支持内嵌字幕切换');
    await engine.setEmbeddedSubtitle(id);
    this.setEmbeddedTracks({ ...this.embeddedTracks, activeTextId: id });
  }

  /** 切换内嵌音轨。仅原生引擎支持 */
  async setAudioTrack(id: number): Promise<void> {
    const engine = this.nativeEngine();
    if (!engine) throw new AppError('E_NOT_IMPLEMENTED', '当前播放器不支持音轨切换');
    await engine.setAudioTrack(id);
    this.setEmbeddedTracks({ ...this.embeddedTracks, activeAudioId: id });
  }

  /** 重拉轨道列表（菜单「重试」） */
  async refreshEmbeddedTracks(): Promise<void> {
    await this.nativeEngine()?.refreshEmbeddedTracks();
  }

  /** 原生 PiP 是否可用（WebView 引擎一律 false，走旧的 web PiP 服务） */
  async isNativePipSupported(): Promise<boolean> {
    return (await this.nativeEngine()?.isPipSupported()) ?? false;
  }

  /** 进入原生 PiP（Android 8.0+；比例由 Java 侧按视频尺寸限幅） */
  async enterNativePip(): Promise<void> {
    const engine = this.nativeEngine();
    if (!engine) throw new AppError('E_NOT_IMPLEMENTED', '当前播放器不支持画中画');
    await engine.enterPip();
  }

  /** 当前是否在 PiP 中（Android 无主动退出 API，View 轮询该值同步状态） */
  async isNativePipActive(): Promise<boolean> {
    return (await this.nativeEngine()?.isPipActive()) ?? false;
  }

  private nativeEngine(): NativeEngine | null {
    return this.engine instanceof NativeEngine ? this.engine : null;
  }

  /* ---------- B1/B2：媒体会话 / 后台播放 / 纯音频 ---------- */

  /** 锁屏与通知栏元数据：片名 + 当前集名 + 海报 */
  private mediaInfoOf(): NativeMediaInfo {
    const opts = this.options;
    const episode = opts?.episodes.find((e) => e.episodeId === opts.episodeId);
    return {
      title: opts?.title ?? '',
      subtitle: episode?.title ?? '',
      artworkUrl: opts?.posterUrl ?? null,
    };
  }

  /**
   * 原生侧播放意图变化（通知栏/线控/音频焦点被抢）。
   *
   * 只同步状态、不回写引擎：否则「原生暂停 → JS 暂停 → 原生暂停」会形成回环。
   */
  private handleRemotePlaying(playing: boolean): void {
    if (this.destroyed) return;
    if (playing) {
      this.setState('playing');
    } else {
      this.handlePause();
    }
  }

  /**
   * B2：后台继续播放。切集会重建引擎，故记住开关并在新引擎上重放。
   * WebView 引擎不支持（切后台仍由 View 层暂停）。
   */
  setBackgroundPlayback(enabled: boolean): void {
    this.backgroundPlayback = enabled;
    this.nativeEngine()?.setBackgroundPlayback(enabled);
  }

  /** B2：纯音频模式（禁视频轨 + 收起原生 surface）。仅原生引擎支持 */
  setAudioOnly(enabled: boolean): void {
    this.audioOnly = enabled;
    this.nativeEngine()?.setAudioOnly(enabled);
  }

  private setEmbeddedTracks(next: EmbeddedTrackState): void {
    this.embeddedTracks = next;
    for (const cb of this.trackListeners) {
      try {
        cb(next);
      } catch {
        /* 单个订阅者异常不影响其它订阅者 */
      }
    }
  }

  /* ================= 全屏 ================= */

  async enterFullscreen(): Promise<void> {
    await this.fullscreen.enter();
    void this.orientation.lock('landscape');
  }

  async exitFullscreen(): Promise<void> {
    await this.fullscreen.exit();
    // CHG-29：退出全屏回到竖屏。用 lock('portrait') 而非 unlock()，避免把方向控制权
    // 交还给传感器导致应用自动翻转。
    void this.orientation.lock('portrait');
  }

  async toggleFullscreen(): Promise<void> {
    if (this.fullscreen.isActive) await this.exitFullscreen();
    else await this.enterFullscreen();
  }

  /* ================= 切集 ================= */

  canNext(): boolean {
    return this.nextEpisodeRef() !== null;
  }

  canPrev(): boolean {
    return this.prevEpisodeRef() !== null;
  }

  private nextEpisodeRef(): EpisodeRef | null {
    const opts = this.options;
    if (!opts) return null;
    const idx = opts.episodes.findIndex((e) => e.episodeId === opts.episodeId);
    if (idx < 0) return null;
    return opts.episodes[idx + 1] ?? null;
  }

  private prevEpisodeRef(): EpisodeRef | null {
    const opts = this.options;
    if (!opts) return null;
    const idx = opts.episodes.findIndex((e) => e.episodeId === opts.episodeId);
    if (idx <= 0) return null;
    return opts.episodes[idx - 1] ?? null;
  }

  async nextEpisode(): Promise<void> {
    const next = this.nextEpisodeRef();
    if (!next) throw new AppError('E_INVALID_STATE', '已经是最后一集');
    await this.switchTo(next.episodeId);
  }

  async prevEpisode(): Promise<void> {
    const prev = this.prevEpisodeRef();
    if (!prev) throw new AppError('E_INVALID_STATE', '已经是第一集');
    await this.switchTo(prev.episodeId);
  }

  private async switchTo(episodeId: string): Promise<void> {
    const opts = this.options;
    if (!opts?.resolveEpisode) throw new AppError('E_INVALID_STATE', '当前不支持切集');
    await this.progress.flush();
    // v1.7/CHG-21：命中预载时直接复用已解析好的下一集参数（<1s 起播）
    const preloaded = this.preloadEpisodeId === episodeId ? this.preloadOpts : null;
    this.clearPreload();
    const nextOpts = await (preloaded ?? opts.resolveEpisode(episodeId));
    await this.load({ ...nextOpts, resolveEpisode: opts.resolveEpisode });
    await this.play();
  }

  /* ---------- v1.7/CHG-21：下一集预载 ---------- */

  private preloadOpts: Promise<PlayerLoadOptions> | null = null;
  private preloadEpisodeId: string | null = null;

  private clearPreload(): void {
    this.preloadOpts = null;
    this.preloadEpisodeId = null;
  }

  /**
   * 预载下一集：仅预取播放地址与 m3u8 清单（resolvePlay + manifest 预检），
   * 不拉分片、不触碰当前播放。幂等——同集已预载则跳过；失败静默清空。
   */
  preloadNext(): void {
    const next = this.nextEpisodeRef();
    const opts = this.options;
    if (!next || !opts?.resolveEpisode) return;
    if (this.preloadEpisodeId === next.episodeId && this.preloadOpts) return;
    this.preloadEpisodeId = next.episodeId;
    this.preloadOpts = opts.resolveEpisode(next.episodeId).catch(() => {
      this.clearPreload();
      return null as unknown as PlayerLoadOptions;
    });
  }

  /* ================= 进度 ================= */

  async flushProgress(): Promise<void> {
    await this.progress.flush();
  }

  getState(): { currentTime: number; duration: number; playing: boolean; rate: number } {
    return {
      currentTime: this.engine?.getCurrentTime() ?? 0,
      duration: this.engine?.getDuration() ?? 0,
      playing: this.state === 'playing',
      rate: this.rate,
    };
  }

  getPlayerState(): PlayerState {
    return this.state;
  }

  /** v1.8/CHG-25：当前引擎类型；null = 尚未加载 */
  getEngineKind(): 'native' | 'hls' | 'video' | null {
    return this.engineKind;
  }

  private setEngineKind(kind: 'native' | 'hls' | 'video'): void {
    if (this.engineKind === kind) return;
    this.engineKind = kind;
    this.emit('enginechange', { kind });
  }

  getCurrentOptions(): PlayerLoadOptions | null {
    return this.options;
  }

  /* ================= 手势 ================= */

  createGestureRecognizer(onIntent: (intent: GestureIntent) => void): GestureRecognizer {
    this.recognizer?.destroy();
    this.recognizer = new GestureRecognizer({ onIntent });
    return this.recognizer;
  }

  destroyRecognizer(): void {
    this.recognizer?.destroy();
    this.recognizer = null;
  }

  /* ================= 生命周期 ================= */

  private setState(next: PlayerState): void {
    if (this.state === next) return;
    this.state = next;
    const playing = next === 'playing';
    this.emit('statechange', { playing, waiting: next === 'loading' });
  }

  private scheduleControlsHide(): void {
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.emit('statechange', { playing: this.state === 'playing', waiting: false });
    }, CONTROLS_HIDE_DELAY_MS);
  }

  private destroyEngine(): void {
    this.clearSeekSettle();
    if (!this.engine) return;
    try {
      this.engine.destroy();
    } catch (e) {
      logger.warn('destroy: engine.destroy 抛错', e);
    }
    this.engine = null;
    logger.info('destroy: 引擎已拆');
  }

  async destroy(): Promise<void> {
    logger.info('destroy: 开始', { hasEngine: this.engine != null });
    this.destroyed = true;
    this.supersedePreflight();
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.clearRetryTimer();
    this.clearNoVideoCheck();
    this.stopStallWatchdog();
    this.progress.stop();
    // 引擎先拆：原生引擎出声不归页面 DOM 管，进度落盘卡住/失败不得拖住销毁
    // （真机实证：flush 抛错中断 destroy → 离开播放页后声音不停）
    this.destroyEngine();
    this.engineKind = null;
    // EXT-07：轨道状态与订阅者一并释放（不通知，View 正在卸载）
    this.embeddedTracks = emptyEmbeddedTracks();
    this.trackListeners.clear();
    try {
      await this.progress.flush();
    } catch {
      /* 落盘失败可忽略 */
    }
    this.progress.dispose();
    this.recognizer?.destroy();
    this.recognizer = null;
    this.subtitles.clear();
    this.fullscreen.destroy();
    this.orientation.destroy();
    if (this.videoHost?.parentElement) this.videoHost.parentElement.removeChild(this.videoHost);
    this.videoHost = null;
    this.container = null;
    this.listeners.clear();
    this.state = 'idle';
  }
}
