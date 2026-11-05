/**
 * 原生播放引擎（ExoPlayer surface 模式桥接，v1.8/CHG-25）
 *
 * - 实现 `PlayableEngine`：把 Java 侧 `ExoPlayerPlugin`（Media3 硬解，
 *   WebView 之上叠原生 surface）适配进 PlayerController 的引擎选择
 * - 进度靠 500ms 轮询 `progress()`（无逐帧事件桥），buffered 以 position 近似
 * - rect 对齐：ResizeObserver + 窗口 resize/orientationchange 防抖后 `setRect`
 * - 清晰度为空数组（面板天然隐藏）；PoC 边界见 `契约变更-v1.7.md` §2.4
 */
import type { AppErrorShape, PlaybackSource, ResizeMode } from '@/types';
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { PluginListenerHandle } from '@capacitor/core';

import type { EngineCapabilities, PlayableEngine } from '@/player/types';
import { assertSourceSupported } from '@/player/sourceGuard';
import { ExoPlayer, exoHeadersOf, type ExoQuality, type ExoTextTrack } from '@/native/exoPlayerPlugin';

// P2-2: 进度轮询从 500ms 放宽到 1000ms，减少 CPU 开销
const PROGRESS_POLL_MS = 1000;
const RECT_SYNC_DEBOUNCE_MS = 150;

export interface NativeEngineEvents {
  onLoadedMetadata: (duration: number) => void;
  onTimeUpdate: (currentTime: number, duration: number, buffered: number) => void;
  onWaiting: () => void;
  onEnded: () => void;
  onError: (error: AppErrorShape) => void;
  /** v1.8 优化：清晰度列表更新 */
  onQualitiesChange?: (qualities: string[]) => void;
  /** v1.8 优化：字幕轨列表更新 */
  onTextTracksChange?: (tracks: Array<{ id: number; label: string }>) => void;
}

type ExoStateData = { state: string; message?: string; duration?: number };

export class NativeEngine implements PlayableEngine {
  readonly capabilities: EngineCapabilities = { kind: 'hls', supportsHeaders: true };

  private host: HTMLElement | null = null;
  private detachState: PluginListenerHandle | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private observer: ResizeObserver | null = null;
  private rectSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private onWindowResize: (() => void) | null = null;

  /** load() 的结算句柄：ready/error 事件到达前由 exostate 负责 resolve/reject */
  private pending: { resolve: () => void; reject: (e: unknown) => void } | null = null;

  private positionSec = 0;
  private durationSec = 0;
  private droppedFrames = 0;
  private ready = false;
  /** v1.8 优化：当前清晰度列表 */
  private qualities: ExoQuality[] = [];
  /** v1.8 优化：当前字幕轨列表 */
  private textTracks: ExoTextTrack[] = [];

  constructor(private readonly events: NativeEngineEvents) {}

  attach(container: HTMLElement): void {
    this.host = container;
  }

  async load(source: PlaybackSource): Promise<void> {
    assertSourceSupported(source.url);
    const host = this.host;
    if (!host) throw new AppError('E_INVALID_STATE', '播放器容器未挂载');

    this.ready = false;
    this.positionSec = 0;
    this.durationSec = 0;

    // PluginListenerHandle 是 { remove } 对象不是函数（Capacitor 7）：
    // 旧代码 `this.detachState?.()` 每次抛 TypeError，release 被跳过 →
    // 离开播放页后原生引擎继续出声（真机实证 2026-11-03）
    void this.detachState?.remove().catch(() => undefined);
    this.detachState = await ExoPlayer.addListener('exostate', (data: ExoStateData) =>
      this.onState(data),
    );

    const loadPromise = new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    try {
      await ExoPlayer.prepare({
        url: source.url,
        headers: exoHeadersOf(source.headers ?? {}),
        // format 由 URL 路径推不出来的（中转/代理地址）必须显式带过去，否则 ExoPlayer
        // 按 progressive 嗅探 m3u8 → UnrecognizedInputFormatException（真机实证）
        mime: source.format === 'hls' ? 'application/x-mpegURL' : undefined,
        rect: rectOf(host),
        // P0-7: 续播位置随 prepare 下发
        startPositionMs: source.startPositionMs ?? 0,
      });
    } catch (e) {
      this.pending = null;
      throw toLoadError(e);
    }

    this.watchRect(host);
    this.startPolling();
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
    this.positionSec = sec;
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

  setResizeMode(mode: ResizeMode): void {
    void ExoPlayer.setResizeMode({ mode }).catch((e: unknown) =>
      logger.debug('ExoPlayer setResizeMode 失败', e),
    );
  }

  /** 本次会话累计丢帧（AC-125 帧率采样用） */
  getDroppedFrames(): number {
    return this.droppedFrames;
  }

  destroy(): void {
    logger.info('NativeEngine.destroy: release 播放器');
    try {
      this.stopPolling();
      this.teardownRectWatch();
      void this.detachState?.remove().catch(() => undefined);
    } catch (e) {
      // 清理步骤异常不得拦住 release：否则原生引擎成孤儿，声音关不掉
      logger.warn('NativeEngine.destroy: teardown 异常', (e as Error)?.message ?? String(e));
    }
    this.detachState = null;
    this.pending = null;
    this.ready = false;
    try {
      const p = ExoPlayer.release();
      logger.info('NativeEngine.destroy: release 桥接已发出');
      void p.catch((e: unknown) => logger.debug('ExoPlayer release 失败', e));
    } catch (e) {
      logger.warn('NativeEngine.destroy: release 同步异常', (e as Error)?.message ?? String(e));
    }
  }

  /* ---------- 内部 ---------- */

  private onState(data: { state: string; message?: string; duration?: number; qualities?: ExoQuality[]; textTracks?: ExoTextTrack[] }): void {
    switch (data.state) {
      case 'ready': {
        if (typeof data.duration === 'number' && data.duration > 0) {
          this.durationSec = data.duration / 1000;
        }
        this.ready = true;
        this.events.onLoadedMetadata(this.durationSec);
        this.pending?.resolve();
        this.pending = null;
        break;
      }
      case 'buffering':
        if (this.ready) this.events.onWaiting();
        break;
      case 'ended':
        this.ready = false;
        this.events.onEnded();
        break;
      case 'qualities': {
        // v1.8 优化：清晰度列表更新
        if (data.qualities) {
          this.qualities = data.qualities;
          this.events.onQualitiesChange?.(this.qualities.map((q) => q.label));
        }
        break;
      }
      case 'textTracks': {
        // v1.8 优化：字幕轨列表更新
        if (data.textTracks) {
          this.textTracks = data.textTracks;
          this.events.onTextTracksChange?.(this.textTracks.map((t) => ({ id: t.id, label: t.label })));
        }
        break;
      }
      case 'error': {
        const error = toPlayError(data.message);
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

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (!this.ready) return;
      void ExoPlayer.progress()
        .then((p) => {
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

  /** 全屏/旋屏/窗口变化 → 防抖重算 rect 对齐原生 overlay */
  private watchRect(host: HTMLElement): void {
    this.teardownRectWatch();
    const scheduleSync = (): void => {
      if (this.rectSyncTimer !== null) clearTimeout(this.rectSyncTimer);
      this.rectSyncTimer = setTimeout(() => {
        this.rectSyncTimer = null;
        void ExoPlayer.setRect(rectOf(host)).catch(() => undefined);
      }, RECT_SYNC_DEBOUNCE_MS);
    };
    this.onWindowResize = scheduleSync;
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('orientationchange', scheduleSync);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(scheduleSync);
      this.observer.observe(host);
    }
  }

  private teardownRectWatch(): void {
    if (this.rectSyncTimer !== null) clearTimeout(this.rectSyncTimer);
    this.rectSyncTimer = null;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.onWindowResize) {
      window.removeEventListener('resize', this.onWindowResize);
      window.removeEventListener('orientationchange', this.onWindowResize);
      this.onWindowResize = null;
    }
  }
}

/** host 元素的 CSS px rect（Java 侧 ×density 换算物理像素） */
function rectOf(host: HTMLElement): { x: number; y: number; width: number; height: number } {
  const r = host.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(r.left)),
    y: Math.max(0, Math.round(r.top)),
    width: Math.max(1, Math.round(r.width)),
    height: Math.max(1, Math.round(r.height)),
  };
}

function toLoadError(e: unknown): AppError {
  return new AppError('E_DECODE', '原生引擎加载失败', { cause: e });
}

/** 播放中错误：网络类（HTTP/超时/连接）归 E_NETWORK 以复用控制器自动重试 */
function toPlayError(message: string | undefined): AppErrorShape {
  const text = message ?? '';
  const isNetwork = /http|network|connect|timeout|source/i.test(text);
  return {
    code: isNetwork ? 'E_NETWORK' : 'E_DECODE',
    message: isNetwork ? '视频加载失败，请检查网络' : '视频播放失败，请尝试切换线路',
    detail: text || null,
    retryable: true,
    httpStatus: null,
  };
}
