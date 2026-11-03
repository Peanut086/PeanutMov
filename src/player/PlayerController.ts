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
import type { AppErrorShape, PlaybackRate, PlaybackSource, SubtitleTrack } from '@/types';
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
  DIM_MAX_OPACITY,
  LOAD_METADATA_TIMEOUT_MS,
  NETWORK_RETRY_DELAY_MS,
  NETWORK_RETRY_TIMES,
  NO_VIDEO_CHECK_DELAY_MS,
  QUALITY_AUTO,
  RESUME_MAX_RATIO,
  RESUME_MIN_RATIO,
} from '@/player/constants';
import { canPlayNativeHls, VideoEngine } from '@/player/VideoEngine';
import { HlsEngine, isHlsSupported } from '@/player/HlsEngine';
import { NativeEngine } from '@/player/NativeEngine';
import { isExoPlayerAvailable } from '@/native/exoPlayerPlugin';
import { SubtitleManager } from '@/player/SubtitleManager';
import { GestureRecognizer, type GestureIntent } from '@/player/GestureRecognizer';
import { ProgressReporter, type ProgressSnapshot } from '@/player/ProgressReporter';
import { FullscreenController } from '@/player/FullscreenController';
import { OrientationController } from '@/player/OrientationController';
import { assertSourceSupported, preflightManifest } from '@/player/sourceGuard';

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

  private rate: PlaybackRate = 1;
  private volume = 100;
  private dim = 0;
  private quality: string = QUALITY_AUTO;

  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  /** 网络错误自动重试定时器（REV-06）：必须可取消，避免页面销毁/切集后仍触发 */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private networkRetries = 0;

  /** m3u8 DRM 预检的取消句柄（AC-40）：切集/重试/销毁时中止上一轮预检 */
  private preflightAbort: AbortController | null = null;

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
      // AC-52：全屏隐藏状态栏，退出恢复。异常不得阻断全屏（FullscreenController 已兜底）
      onEnter: () => this.deps.setStatusBarVisible?.(false),
      onExit: () => this.deps.setStatusBarVisible?.(true),
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
    if (this.videoHost.parentElement !== container) container.appendChild(this.videoHost);
    this.engine?.attach(this.videoHost);
    this.fullscreen.setElement(container);
  }

  async load(opts: PlayerLoadOptions): Promise<void> {
    if (this.destroyed) throw new AppError('E_INVALID_STATE', '播放器已销毁');
    // 切集/切线路：取消上一轮尚未触发的网络重试，避免旧重试把新加载顶掉（REV-06）
    this.clearRetryTimer();
    // 同时中止上一轮 m3u8 DRM 预检（AC-40）：旧预检结果不得影响本次加载
    this.resetPreflight();
    // 上一集的预载参数对新集已过期（CHG-21）
    this.clearPreload();
    // 黑屏检测按「每次加载」重置
    this.clearNoVideoCheck();
    this.setState('loading');
    this.options = opts;
    this.networkRetries = 0;
    this.lastSubtitleText = '';
    this.subtitles.setTracks(opts.playback.subtitles);
    this.emit('subtitlechange', {
      activeId: this.subtitles.getActiveId(),
      tracks: this.subtitles.getTracks(),
      text: '',
      failedIds: this.subtitles.getFailedIds(),
    });

    try {
      await this.attachEngine(opts.playback);
      const start = this.resolveStartPosition(opts);
      if (start > 0) this.engine?.seek(start);
      this.engine?.setRate(this.rate);
      this.engine?.setVolume(this.volume);
      this.applyDim();
      this.setState('ready');
      this.progress.update(start, this.engine?.getDuration() ?? 0);
      this.progress.start();
      this.scheduleControlsHide();
    } catch (e) {
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
    const format = playback.format === 'other' ? guessFormatFromUrl(playback.url) ?? 'mp4' : playback.format;

    this.destroyEngine();

    const host = this.videoHost ?? this.container;
    if (!host) throw new AppError('E_INVALID_STATE', '播放器容器未挂载');

    // v1.8 优化：原生引擎支持 DASH/DRM，只在 WebView 引擎路径上做前置检查
    const useNativeEngine = this.options?.preferNativeEngine === true && await isExoPlayerAvailable();

    if (!useNativeEngine) {
      // WebView 引擎路径：DASH/DRM 明确拒绝（AC-40 / FR-17）
      if (format === 'hls') {
        const manifest = await preflightManifest(playback.url, {
          signal: this.preflightAbort?.signal,
          headers: playback.headers,
        });
        assertSourceSupported(playback.url, manifest);
      } else {
        assertSourceSupported(playback.url);
      }
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
      });
      nativeEngine.attach(host);
      try {
        await this.withMetadataTimeout(nativeEngine.load(playback));
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
        this.emit('notice', { message: '原生引擎不可用，已切回内置引擎' });
        // 落入下方 WebView 分支继续加载
      }
    } else if (this.options?.preferNativeEngine === true) {
      this.emit('notice', { message: '原生引擎不可用，已切回内置引擎' });
    }

    const useHls = format === 'hls' && !canPlayNativeHls();
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
      this.engine = hlsEngine;
      this.setEngineKind('hls');
      try {
        await hlsEngine.load(playback);
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
      this.engine = videoEngine;
      this.setEngineKind('video');
      this.quality = QUALITY_AUTO;
      this.emit('qualitychange', { quality: QUALITY_AUTO, levels: [] });
      try {
        await this.withMetadataTimeout(videoEngine.load(playback));
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
      });
      nativeEngine.attach(host);
      try {
        await this.withMetadataTimeout(nativeEngine.load(playback));
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

  private withMetadataTimeout(promise: Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new AppError('E_TIMEOUT', '加载超时，请检查网络后重试'));
      }, LOAD_METADATA_TIMEOUT_MS);
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

  /** 丢弃上一轮 DRM 预检（中止在飞请求并新建句柄，AC-40） */
  private resetPreflight(): void {
    this.preflightAbort?.abort();
    this.preflightAbort = typeof AbortController === 'function' ? new AbortController() : null;
  }

  /* ================= 播放控制 ================= */

  async play(): Promise<void> {
    if (!this.engine) return;
    try {
      await this.engine.play();
      this.setState('playing');
      this.progress.start();
    } catch (e) {
      this.emit('error', toErrorShape(e, 'E_DECODE'));
    }
    this.scheduleControlsHide();
  }

  pause(): void {
    this.engine?.pause();
    this.setState('paused');
    void this.progress.flush();
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
    void this.progress.flush();
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

  /** 亮度遮罩：100 = 无遮罩，0 = 最暗（保留 20% 亮度，AC-48） */
  setDim(percent: number): void {
    this.dim = Math.min(100, Math.max(0, percent));
    this.applyDim();
  }

  getDim(): number {
    return this.dim;
  }

  private applyDim(): void {
    if (!this.container) return;
    const opacity = ((100 - this.dim) / 100) * DIM_MAX_OPACITY;
    const layer = this.container.querySelector<HTMLElement>('[data-dim-layer]');
    if (layer) layer.style.opacity = String(opacity);
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
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.clearRetryTimer();
    this.clearNoVideoCheck();
    this.progress.stop();
    // 引擎先拆：原生引擎出声不归页面 DOM 管，进度落盘卡住/失败不得拖住销毁
    // （真机实证：flush 抛错中断 destroy → 离开播放页后声音不停）
    this.destroyEngine();
    this.engineKind = null;
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
