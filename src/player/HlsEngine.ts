/**
 * HLS 引擎（hls.js 懒加载）
 *
 * - 仅在格式为 hls 且原生不支持时使用；`import('hls.js')` 动态加载，独立 chunk
 * - 支持注入请求头（xhrSetup）——站点源必需
 * - 错误恢复：NETWORK_ERROR 先 `startLoad()` 一次；MEDIA_ERROR 先 `recoverMediaError()` 一次；
 *   仍失败则抛出映射后的 AppError（技术方案 9.1）
 * - 清晰度：`levels` 按 height 命名（1080p/720p…），`auto` = currentLevel = -1
 */
import type { AppErrorShape, PlaybackSource } from '@/types';

import type { EngineCapabilities, PlayableEngine } from '@/player/types';
import { VideoEngine } from '@/player/VideoEngine';
import { NETWORK_RETRY_TIMES } from '@/player/constants';
import {
  HLS_MAX_BUFFER_DEFAULT_S,
  HLS_MAX_BUFFER_HIGH_S,
  LIVE_SYNC_COUNT,
} from '@/shared/constants';
import { assertSourceSupported } from '@/player/sourceGuard';

type HlsModule = typeof import('hls.js');
type HlsInstance = InstanceType<HlsModule['default']>;

export interface HlsEngineEvents {
  onLoadedMetadata: (duration: number, videoWidth: number, videoHeight: number) => void;
  onTimeUpdate: (currentTime: number, duration: number, buffered: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onWaiting: () => void;
  onPlaying: () => void;
  onEnded: () => void;
  onError: (error: AppErrorShape) => void;
  onQualityChange: (quality: string, levels: string[]) => void;
}

let modulePromise: Promise<HlsModule> | null = null;

/** 懒加载 hls.js 模块（并发调用共享同一 Promise） */
export function loadHlsModule(): Promise<HlsModule> {
  if (!modulePromise) {
    modulePromise = import('hls.js').catch((e: unknown) => {
      modulePromise = null;
      throw e;
    });
  }
  return modulePromise;
}

/** hls.js 是否可用（模块未加载时返回 false，不触网） */
export async function isHlsSupported(): Promise<boolean> {
  try {
    const mod = await loadHlsModule();
    return mod.default.isSupported();
  } catch {
    return false;
  }
}

export class HlsEngine implements PlayableEngine {
  readonly capabilities: EngineCapabilities = { kind: 'hls', supportsHeaders: true };

  private readonly videoEngine: VideoEngine;
  private hls: HlsInstance | null = null;
  private hlsModule: HlsModule | null = null;
  private qualities: string[] = [];
  private currentQuality = 'auto';
  private networkRetries = 0;
  private mediaRetries = 0;
  private pendingSource: PlaybackSource | null = null;

  constructor(private readonly events: HlsEngineEvents) {
    this.videoEngine = new VideoEngine({
      onLoadedMetadata: events.onLoadedMetadata,
      onTimeUpdate: events.onTimeUpdate,
      onPlay: events.onPlay,
      onPause: events.onPause,
      onWaiting: events.onWaiting,
      onPlaying: events.onPlaying,
      onEnded: events.onEnded,
      onError: (error) => {
        // hls.js 接管后原生 error 多为附带现象，仅在无 hls 实例时上报
        if (!this.hls) events.onError(error);
      },
    });
  }

  get video(): HTMLVideoElement {
    return this.videoEngine.video;
  }

  attach(container: HTMLElement): void {
    this.videoEngine.attach(container);
  }

  async load(source: PlaybackSource): Promise<void> {
    // AC-40：DASH / 明显加密地址直接拒绝，不创建 hls 实例、不发请求。
    // 清单文本级预检（#EXT-X-KEY:METHOD=SAMPLE-AES）在 PlayerController 统一完成，
    // 这里只做不触网的 URL 级兜底（防止其他调用方绕过控制器）。
    assertSourceSupported(source.url);

    this.pendingSource = source;
    const mod = await loadHlsModule();
    this.hlsModule = mod;

    const HlsCtor = mod.default;
    if (!HlsCtor.isSupported()) {
      throw new Error('HLS is not supported in this environment');
    }

    this.destroyHls();
    this.networkRetries = 0;
    this.mediaRetries = 0;

    const headers = source.headers ?? {};
    const isLive = source.isLive === true;
    const hls = new HlsCtor({
      enableWorker: true,
      // 直播用低延迟模式（liveSyncDurationCount=LIVE_SYNC_COUNT），点播关闭
      lowLatencyMode: isLive,
      liveSyncDurationCount: isLive ? LIVE_SYNC_COUNT : undefined,
      // 回看缓冲：点播 90s 够回退重看一段；直播保持 15s 控内存
      backBufferLength: isLive ? 15 : 90,
      // 初始前向缓冲：起播阶段只需要首帧，不需要大量预缓冲
      maxBufferLength: isLive ? 10 : 30,
      // 内存上限：高码率时 hls.js 会自行收窄到 maxBufferSize 以下
      maxBufferSize: 60 * 1000 * 1000, // 60MB
      maxMaxBufferLength: isLive ? 20 : 120,
      capLevelToPlayerSize: true,
      /*
       * 起播优化（真机实测：黑屏/转圈主要耗在「清单解析完到第一帧」）：
       * - startFragPrefetch：解析清单的同时就预取首个分片，省掉一次串行等待
       * - testBandwidth:false：VOD 首片不做带宽探测（默认会多下一次）
       * - abrEwmaDefaultEstimate：2Mbps 更贴近国内常见宽带，避免首帧选 240p 再跳档
       * - maxStarvationDelay/maxLoadingDelay：卡顿容忍从 4s 收紧到 2s，尽快切档/追帧
       * - fragLoadingTimeOut：分片加载 20s 超时（默认太长，移动网络下用户早已等不及）
       * - manifestLoadingTimeOut：清单加载 8s 超时（比默认 10s 更早触发重试）
       */
      startFragPrefetch: true,
      testBandwidth: false,
      abrEwmaDefaultEstimate: 2_000_000,
      maxStarvationDelay: 2,
      maxLoadingDelay: 2,
      fragLoadingTimeOut: 20000,
      fragLoadingMaxRetry: 4,
      manifestLoadingTimeOut: 8000,
      manifestLoadingMaxRetry: 3,
      // ABR 平滑：避免码率频繁跳动（视觉上的清晰度闪烁）
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.7,
      // 元数据就绪即开始播放，不等缓冲填满
      startLevel: -1,
      xhrSetup: (xhr: XMLHttpRequest, url: string) => {
        void url;
        for (const [key, value] of Object.entries(headers)) {
          try {
            xhr.setRequestHeader(key, value);
          } catch {
            /* 部分头在浏览器层禁止设置，忽略以免中断加载 */
          }
        }
      },
    });
    this.hls = hls;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (ok: boolean, message?: string): void => {
        if (settled) return;
        settled = true;
        if (ok) resolve();
        else reject(new Error(message ?? 'hls load failed'));
      };

      hls.on(HlsCtor.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(source.url);
      });

      hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
        this.qualities = buildQualityList(hls);
        this.events.onQualityChange(this.currentQuality, this.qualities);
        settle(true);
      });

      hls.on(HlsCtor.Events.LEVEL_SWITCHED, () => {
        const level = hls.levels[hls.currentLevel];
        const quality = qualityOf(level);
        this.currentQuality = hls.currentLevel < 0 ? 'auto' : quality;
        // 高码率（≥1080p）前向缓冲扩大到 60s，换卡顿为预缓冲；低码率维持 30s 控内存
        const height = level?.height ?? 0;
        const isLive = this.pendingSource?.isLive === true;
        if (!isLive) {
          hls.config.maxBufferLength = height >= 1080 ? HLS_MAX_BUFFER_HIGH_S : HLS_MAX_BUFFER_DEFAULT_S;
        }
        this.events.onQualityChange(this.currentQuality, this.qualities);
      });

      hls.on(HlsCtor.Events.ERROR, (_event: unknown, data: unknown) => {
        const info = data as { fatal?: boolean; type?: string; details?: string };
        if (!info?.fatal) return;

        if (info.type === 'networkError' && this.networkRetries < NETWORK_RETRY_TIMES) {
          this.networkRetries += 1;
          hls.startLoad();
          return;
        }
        if (info.type === 'mediaError' && this.mediaRetries < NETWORK_RETRY_TIMES) {
          this.mediaRetries += 1;
          hls.recoverMediaError();
          return;
        }

        const error: AppErrorShape = {
          code: info.type === 'mediaError' ? 'E_DECODE' : 'E_NETWORK',
          message: info.type === 'mediaError' ? '视频解码失败，请尝试切换线路' : '视频加载失败，请检查网络',
          detail: info.details ?? null,
          retryable: true,
          httpStatus: null,
        };
        settle(false, error.message);
        this.events.onError(error);
      });

      hls.attachMedia(this.video);
    });
  }

  async play(): Promise<void> {
    await this.videoEngine.play();
  }

  /** 黑屏检测：hls.js 最终仍由 <video> 解码，帧统计口径与 VideoEngine 一致 */
  getFrameStats(): { videoWidth: number; videoHeight: number; totalFrames: number } | null {
    return this.videoEngine.getFrameStats();
  }

  pause(): void {
    this.videoEngine.pause();
  }

  seek(sec: number): void {
    this.videoEngine.seek(sec);
  }

  setRate(rate: number): void {
    this.videoEngine.setRate(rate);
  }

  setVolume(volume: number): void {
    this.videoEngine.setVolume(volume);
  }

  getCurrentTime(): number {
    return this.videoEngine.getCurrentTime();
  }

  getDuration(): number {
    return this.videoEngine.getDuration();
  }

  getBuffered(): number {
    return this.videoEngine.getBuffered();
  }

  getQualities(): string[] {
    return [...this.qualities];
  }

  /**
   * 切换清晰度：'auto' → currentLevel = -1；
   * 具体档位 → 匹配 levels 中同名档位（不存在则忽略）。
   */
  setQuality(quality: string): void {
    const hls = this.hls;
    if (!hls) return;
    if (quality === 'auto') {
      hls.currentLevel = -1;
      this.currentQuality = 'auto';
      return;
    }
    const index = this.qualities.indexOf(quality);
    if (index < 0) return;
    // qualities 与 levels 同序（buildQualityList 可含重复档位时取首个）
    const sorted = sortLevelIndexes(hls);
    const levelIndex = sorted[index];
    if (levelIndex === undefined) return;
    hls.currentLevel = levelIndex;
    this.currentQuality = quality;
  }

  destroy(): void {
    this.destroyHls();
    this.videoEngine.destroy();
    this.pendingSource = null;
  }

  private destroyHls(): void {
    if (!this.hls) return;
    try {
      this.hls.destroy();
    } catch {
      /* 忽略 hls 卸载异常 */
    }
    this.hls = null;
    this.qualities = [];
    this.currentQuality = 'auto';
    void this.hlsModule;
    void this.pendingSource;
  }
}

function qualityOf(level: { height?: number; name?: string } | undefined): string {
  if (!level) return 'auto';
  if (typeof level.height === 'number' && level.height > 0) return `${level.height}p`;
  if (typeof level.name === 'string' && level.name.length > 0) return level.name;
  return 'auto';
}

function buildQualityList(hls: HlsInstance): string[] {
  const list: string[] = [];
  for (const level of hls.levels) {
    const q = qualityOf(level);
    if (q !== 'auto' && !list.includes(q)) list.push(q);
  }
  return list;
}

/** 与 buildQualityList 对齐的 levels 下标（按出现顺序） */
function sortLevelIndexes(hls: HlsInstance): number[] {
  const seen = new Set<string>();
  const indexes: number[] = [];
  hls.levels.forEach((level: { height?: number; name?: string }, i: number) => {
    const q = qualityOf(level);
    if (q === 'auto' || seen.has(q)) return;
    seen.add(q);
    indexes.push(i);
  });
  return indexes;
}
