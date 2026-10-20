/**
 * 原生 `<video>` 引擎
 *
 * - 负责 DOM 创建、事件转发与基础操作（play/pause/seek/rate/volume）
 * - 不处理业务错误文案；错误以 `AppError` 回调抛给 PlayerController
 * - 所有原生监听在 `destroy()` 中解绑，避免重复挂载造成内存泄漏
 */
import type { AppErrorShape, PlaybackSource } from '@/types';
import { toErrorShape } from '@/shared/errors';

import type { EngineCapabilities, PlayableEngine } from '@/player/types';

export interface VideoEngineEvents {
  onLoadedMetadata: (duration: number, videoWidth: number, videoHeight: number) => void;
  onTimeUpdate: (currentTime: number, duration: number, buffered: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onWaiting: () => void;
  onPlaying: () => void;
  onEnded: () => void;
  onError: (error: AppErrorShape) => void;
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

  constructor(private readonly events: VideoEngineEvents) {
    this.video = document.createElement('video');
    this.video.setAttribute('playsinline', 'true');
    this.video.setAttribute('webkit-playsinline', 'true');
    this.video.preload = 'metadata';
    this.video.controls = false;
    this.video.crossOrigin = 'anonymous';
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
      const url = withHeadersHint(source.url, source.headers);
      const onLoaded = (): void => {
        cleanup();
        resolve();
      };
      const onError = (): void => {
        cleanup();
        reject(new Error(this.video.error?.message ?? 'media error'));
      };
      const cleanup = (): void => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
      this.video.addEventListener('error', onError, { once: true });
      this.video.src = url;
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

  /** 原生引擎无多码率，返回空数组 */
  getQualities(): string[] {
    return [];
  }

  setQuality(): void {
    /* 原生引擎不支持清晰度切换 */
  }

  destroy(): void {
    this.destroyed = true;
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
      return { code: 'E_UNSUPPORTED_FORMAT', message: '暂不支持该格式', retryable: false, ...base };
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
