/**
 * 原生 `<video>` 引擎
 *
 * - 负责 DOM 创建、事件转发与基础操作（play/pause/seek/rate/volume）
 * - 不处理业务错误文案；错误以 `AppError` 回调抛给 PlayerController
 * - 所有原生监听在 `destroy()` 中解绑，避免重复挂载造成内存泄漏
 */
import type { AppErrorShape, PlaybackSource, ResizeMode } from '@/types';
import { AppError, toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';

import type { EngineCapabilities, PlayableEngine } from '@/player/types';
import { videoFrameLumaSource } from '@/player/frameLuma';

export interface VideoEngineEvents {
  onLoadedMetadata: (duration: number, videoWidth: number, videoHeight: number) => void;
  onTimeUpdate: (currentTime: number, duration: number, buffered: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onWaiting: () => void;
  onPlaying: () => void;
  onEnded: () => void;
  onError: (error: AppErrorShape) => void;
  /** 首个视频帧真正提交渲染；旧环境由控制器轮询帧统计兜底 */
  onFirstFrame?: () => void;
}

/** 原生 HLS 支持判定（Safari / iOS） */
export function canPlayNativeHls(video: HTMLVideoElement | null = null): boolean {
  const el = video ?? (typeof document !== 'undefined' ? document.createElement('video') : null);
  if (!el) return false;
  try {
    return el.canPlayType('application/vnd.apple.mpegurl') !== '';
  } catch {
    return false;
  }
}

export class VideoEngine implements PlayableEngine {
  readonly capabilities: EngineCapabilities = { kind: 'video', supportsHeaders: false };

  readonly video: HTMLVideoElement;

  private container: HTMLElement | null = null;
  private listeners: Array<() => void> = [];
  private destroyed = false;
  private loading = false;
  private frameCallbackId: number | null = null;
  private firstFrameSent = false;
  private readonly frameLuma = videoFrameLumaSource(() => this.container);

  constructor(private readonly events: VideoEngineEvents) {
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', 'true');
    this.video.setAttribute('webkit-playsinline', 'true');
    this.video.preload = 'metadata';
    this.video.controls = false;
    // 不设置 `crossOrigin`：匿名跨域会让未返回 ACAO 头的源站直接加载失败；
    // 黑帧取样遇到 Canvas 污染时由调用方降级，不能为诊断牺牲播放兼容性。
    this.bindNativeEvents();
  }

  attach(container: HTMLElement): void {
    if (this.container === container) return;
    if (this.video.parentElement) this.video.parentElement.removeChild(this.video);
    container.appendChild(this.video);
    this.container = container;
  }

  /** 某些源需要 cookie/凭据；首版统一带 `use-credentials` 会造成 CORS 失败，故保持默认 */
  load(source: PlaybackSource): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.destroyed) {
        reject(new Error('engine destroyed'));
        return;
      }
      this.loading = true;
      this.cancelFrameCallback();
      this.firstFrameSent = false;
      const url = withHeadersHint(source.url, source.headers);
      const onLoaded = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        this.cancelFrameCallback();
        // P1-2：按 MediaError.code 映射具体错误码，不再统一折叠为 E_DECODE
        const mediaError = this.video.error;
        const msg = mediaError?.message ?? 'media error';
        switch (mediaError?.code) {
          case MediaError.MEDIA_ERR_NETWORK:
            reject(new AppError('E_NETWORK', `网络错误：${msg}`));
            break;
          case MediaError.MEDIA_ERR_DECODE:
            reject(new AppError('E_DECODE', `解码错误：${msg}`));
            break;
          case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            // OPT-26（P0-②-1）：这一族的成因是「本机接不住」，不是种子——
            // 挂上子原因，界面才不会给出「本 App 不做种子下载」这种对不上号的话
            reject(new AppError('E_UNSUPPORTED_FORMAT', `格式不支持：${msg}`, { reason: 'player_capability' }));
            break;
          default:
            reject(new AppError('E_DECODE', msg));
        }
      };
      const cleanup = (): void => {
        this.loading = false;
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
      this.video.addEventListener('error', onError, { once: true });
      this.video.src = url;
      this.observeFirstFrame();
      this.video.load();
    });
  }

  async play(): Promise<void> {
    try {
      await this.video.play();
    } catch (e) {
      // 自动播放被拦截（无用户手势）：交由上层判定为"待用户点击"，不当作错误
      const err = e as { name?: string };
      if (err.name === 'NotAllowedError') return;
      throw e;
    }
  }

  pause(): void {
    this.video.pause();
  }

  seek(sec: number): void {
    const duration = this.getDuration();
    const target = Math.min(Math.max(0, sec), Number.isFinite(duration) ? duration : sec);
    try {
      this.video.currentTime = target;
    } catch {
      /* 元数据未就绪时忽略 */
    }
  }

  setRate(rate: number): void {
    this.video.playbackRate = rate;
  }

  setVolume(volume: number): void {
    this.video.volume = Math.min(1, Math.max(0, volume / 100));
  }

  getCurrentTime(): number {
    return Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0;
  }

  getDuration(): number {
    return Number.isFinite(this.video.duration) ? this.video.duration : 0;
  }

  getBuffered(): number {
    const ranges = this.video.buffered;
    if (!ranges || ranges.length === 0) return 0;
    return ranges.end(ranges.length - 1);
  }

  /**
   * 画面帧统计（P0-播放黑屏）：
   *
   * Android WebView 上 HEVC / 部分封装会出现「能读元数据、能出声、但一帧都不解」的
   * 情况——`videoWidth > 0`、`currentTime` 正常推进、`error` 为 null，用户看到的是
   * 黑屏 + 声音，以为播放器坏了。`totalVideoFrames` 是唯一可靠的判据。
   */
  getFrameStats(): { videoWidth: number; videoHeight: number; totalFrames: number } | null {
    const v = this.video;
    if (!v) return null;
    const quality = v.getVideoPlaybackQuality?.();
    return {
      videoWidth: v.videoWidth,
      videoHeight: v.videoHeight,
      totalFrames: quality ? quality.totalVideoFrames : -1,
    };
  }

  sampleFrameLuma() {
    return this.frameLuma(this.video.videoWidth, this.video.videoHeight, 'fill');
  }

  canObserveFirstFrame(): boolean {
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    return typeof video.requestVideoFrameCallback === 'function'
      || typeof video.getVideoPlaybackQuality === 'function';
  }

  /** 原生引擎无多码率，返回空数组 */
  getQualities(): string[] {
    return [];
  }

  setQuality(): void {
    /* 原生引擎不支持清晰度切换 */
  }

  /**
   * 通过 CSS object-fit 控制画面缩放：
   * - contain → contain（留黑边，完整显示）
   * - cover → cover（裁剪铺满，不变形）
   * - fill → fill（拉伸铺满，会变形）
   */
  setResizeMode(mode: ResizeMode): void {
    this.video.style.objectFit = mode;
  }

  private observeFirstFrame(): void {
    const video = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof video.requestVideoFrameCallback !== 'function') return;
    this.frameCallbackId = video.requestVideoFrameCallback(() => {
      this.frameCallbackId = null;
      if (this.destroyed || this.firstFrameSent) return;
      this.firstFrameSent = true;
      this.events.onFirstFrame?.();
    });
  }

  private cancelFrameCallback(): void {
    const video = this.video as HTMLVideoElement & {
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (this.frameCallbackId === null) return;
    if (typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(this.frameCallbackId);
    }
    this.frameCallbackId = null;
  }

  destroy(): void {
    this.destroyed = true;
    this.loading = false;
    this.cancelFrameCallback();
    this.pause();
    for (const off of this.listeners) off();
    this.listeners = [];
    this.video.removeAttribute('src');
    try {
      this.video.load();
    } catch {
      /* 忽略卸载异常 */
    }
    if (this.video.parentElement) this.video.parentElement.removeChild(this.video);
    this.container = null;
  }

  private bindNativeEvents(): void {
    const v = this.video;
    const add = <K extends keyof HTMLMediaElementEventMap>(
      type: K,
      handler: (ev: HTMLMediaElementEventMap[K]) => void,
    ): void => {
      v.addEventListener(type, handler as EventListener);
      this.listeners.push(() => v.removeEventListener(type, handler as EventListener));
    };

    add('loadedmetadata', () => {
      this.events.onLoadedMetadata(this.getDuration(), v.videoWidth, v.videoHeight);
    });

    add('timeupdate', () => {
      this.events.onTimeUpdate(this.getCurrentTime(), this.getDuration(), this.getBuffered());
    });

    add('play', () => this.events.onPlay());
    add('pause', () => {
      // 播放结束时的 pause 由 ended 处理，避免状态抖动
      if (!v.ended) this.events.onPause();
    });
    add('waiting', () => this.events.onWaiting());
    add('playing', () => this.events.onPlaying());
    add('ended', () => this.events.onEnded());

    add('error', () => {
      /*
       * OPT-26（P0-②-2）：`MediaError.code` 是分清「网络断开 / 解码失败 / 地址接不住」
       * 的唯一原始证据——Android WebView 的 `message` 常年是空串，映射后的文案只剩一句
       * 「暂不支持该格式」。这一行不带处置结论，只把现场记下来（地址由 logger 统一脱敏）。
       */
      logger.warn('WebView MediaError', {
        mediaErrorCode: v.error?.code ?? null,
        mediaErrorMessage: v.error?.message ?? '',
        src: v.currentSrc || v.src || '',
        networkState: v.networkState,
        readyState: v.readyState,
      });
      if (this.loading || this.destroyed) return;
      this.events.onError(mapMediaError(v.error));
    });
  }
}

/**
 * 把 `MediaError` 映射为 AppErrorShape。
 * 仅使用 `ERROR_MESSAGES` 已有码；解码类错误给出更明确提示。
 */
export function mapMediaError(error: MediaError | null): AppErrorShape {
  const base = { detail: error?.message ?? null, httpStatus: null };
  switch (error?.code) {
    case 1:
      return { code: 'E_ABORTED', message: '播放已取消', retryable: false, ...base };
    case 2:
      return { code: 'E_NETWORK', message: '网络中断，请检查网络后重试', retryable: true, ...base };
    case 3:
      return { code: 'E_DECODE', message: '视频解码失败，请尝试切换线路', retryable: true, ...base };
    case 4:
      return {
        code: 'E_UNSUPPORTED_FORMAT',
        message: '暂不支持该格式',
        retryable: false,
        // OPT-26（P0-②-1）：`MediaError.code === 4` 说的是本机播不了，与种子无关
        reason: 'player_capability',
        ...base,
      };
    default:
      return toErrorShape(error ?? new Error('media error'));
  }
}

/**
 * 直链播放无法注入自定义请求头（原生 video 限制）。
 * 这里把 `Referer` 这类必要头作为查询串透传是不安全的，故只在 URL 已带鉴权时原样使用。
 * 该函数保留为"单一出口"，便于二期接入 Service Worker 代理。
 */
function withHeadersHint(url: string, headers: Record<string, string>): string {
  if (!headers || Object.keys(headers).length === 0) return url;
  return url;
}
