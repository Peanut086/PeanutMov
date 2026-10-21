/**
 * 播放器类型（API-15）
 *
 * 与 `src/types/index.ts` 的 `PlayerController` 契约保持一致；
 * 这里补充 UI 内部使用的引擎接口与事件类型。
 */
import type {
  AppErrorShape,
  PlaybackRate,
  PlaybackSource,
  SubtitleTrack,
} from '@/types';

/* ---------- 事件 ---------- */
export type PlayerEventMap = {
  ready: { duration: number };
  timeupdate: { currentTime: number; duration: number; buffered: number };
  statechange: { playing: boolean; waiting: boolean };
  ratechange: { rate: PlaybackRate };
  ended: void;
  error: AppErrorShape;
  subtitlechange: {
    activeId: string | null;
    tracks: SubtitleTrack[];
    text: string;
    /** 加载失败的轨道 id（AC-46：面板标记「不可用」） */
    failedIds: string[];
  };
  qualitychange: { quality: string; levels: string[] };
  /** 引擎加载完成（可播放）——与 ready 的区别：loadedmetadata 前触发 */
  loaded: void;
  /** 全屏状态变化 */
  fullscreenchange: { fullscreen: boolean };
};

export type PlayerEventName = keyof PlayerEventMap;

export type PlayerListener<K extends PlayerEventName> = (payload: PlayerEventMap[K]) => void;

/* ---------- 状态机 ---------- */
export type PlayerState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error';

/* ---------- 剧集引用 ---------- */
export interface EpisodeRef {
  episodeId: string;
  number: number;
  title: string;
}

/* ---------- 加载参数 ---------- */
export interface PlayerLoadOptions {
  mediaId: string;
  episodeId: string;
  lineId: string;
  title: string;
  posterUrl: string | null;
  /** 由 libraryStore.resolvePlay() 解析好的播放源 */
  playback: PlaybackSource;
  /** 起播位置（秒） */
  startPositionSec: number;
  totalEpisodes: number | null;
  episodes: EpisodeRef[];
  preferLocal: boolean;
  /** 切集时由 View 提供，返回新一集的完整加载参数 */
  resolveEpisode?: (episodeId: string) => Promise<PlayerLoadOptions>;
}

/* ---------- 引擎接口 ---------- */
export interface EngineCapabilities {
  readonly kind: 'video' | 'hls';
  /** 引擎是否支持注入请求头 */
  readonly supportsHeaders: boolean;
}

export interface PlayableEngine {
  readonly capabilities: EngineCapabilities;
  /** 创建/挂载到容器（幂等） */
  attach(container: HTMLElement): void;
  /** 加载播放源 */
  load(source: PlaybackSource, headers?: Record<string, string>): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(sec: number): void;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getBuffered(): number;
  setQuality(quality: string): void;
  getQualities(): string[];
  /** 销毁并释放资源 */
  destroy(): void;
}

/* ---------- 字幕 ---------- */
export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}
