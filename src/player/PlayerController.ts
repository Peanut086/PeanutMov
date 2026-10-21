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
  QUALITY_AUTO,
  RESUME_MAX_RATIO,
  RESUME_MIN_RATIO,
} from '@/player/constants';
import { canPlayNativeHls, VideoEngine } from '@/player/VideoEngine';
import { HlsEngine, isHlsSupported } from '@/player/HlsEngine';
import { SubtitleManager } from '@/player/SubtitleManager';
import { GestureRecognizer, type GestureIntent } from '@/player/GestureRecognizer';
import { ProgressReporter, type ProgressSnapshot } from '@/player/ProgressReporter';
import { FullscreenController } from '@/player/FullscreenController';
import { OrientationController } from '@/player/OrientationController';
import { assertSourceSupported, preflightManifest } from '@/player/sourceGuard';

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
    this.setState('loading');
    this.options = opts;
    this.networkRetries = 0;
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

    /*
     * AC-40 / FR-17：DASH 与 DRM 流**明确拒绝且不尝试绕过**。
     *
     * 必须在 `destroyEngine()` 与任何引擎实例创建**之前**判断：`.mpd` 不创建 video/hls、
     * 不发任何请求。`.mpd` 在 `guessFormatFromUrl` 里返回 null（SCF 冻结，不改），
     * 旧行为会当普通视频试播并最终显示「视频解码失败」，与此 AC 不符。
     */
    assertSourceSupported(playback.url);

    this.destroyEngine();

    const host = this.videoHost ?? this.container;
    if (!host) throw new AppError('E_INVALID_STATE', '播放器容器未挂载');

    const useHls = format === 'hls' && !canPlayNativeHls();
    if (format === 'hls') {
      // AC-40：m3u8 清单 DRM 预检——可取消、失败即放行（不把网络抖动当 DRM）。
      // 原生 HLS 与 hls.js 两条路径共用同一判定，行为一致。
      const manifest = await preflightManifest(playback.url, {
        signal: this.preflightAbort?.signal,
        headers: playback.headers,
      });
      assertSourceSupported(playback.url, manifest);
    }
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
      await hlsEngine.load(playback);
      this.progress.update(0, hlsEngine.getDuration());
      return;
    }

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
    this.quality = QUALITY_AUTO;
    this.emit('qualitychange', { quality: QUALITY_AUTO, levels: [] });

    await this.withMetadataTimeout(videoEngine.load(playback));
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
    if (this.subtitles.getActiveId()) {
      const text = this.subtitles.textAt(currentTime);
      this.emit('subtitlechange', {
        activeId: this.subtitles.getActiveId(),
        tracks: this.subtitles.getTracks(),
        text,
        failedIds: this.subtitles.getFailedIds(),
      });
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
    void this.orientation.unlock();
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
    const nextOpts = await opts.resolveEpisode(episodeId);
    await this.load({ ...nextOpts, resolveEpisode: opts.resolveEpisode });
    await this.play();
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
    } catch {
      /* ignore */
    }
    this.engine = null;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.hideTimer !== null) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    this.clearRetryTimer();
    this.progress.stop();
    await this.progress.flush();
    this.progress.dispose();
    this.recognizer?.destroy();
    this.recognizer = null;
    this.subtitles.clear();
    this.destroyEngine();
    this.fullscreen.destroy();
    this.orientation.destroy();
    if (this.videoHost?.parentElement) this.videoHost.parentElement.removeChild(this.videoHost);
    this.videoHost = null;
    this.container = null;
    this.listeners.clear();
    this.state = 'idle';
  }
}
