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
  ResizeMode,
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
  /** 一次加载成功完成（含切集/自动连播），携带当前集 id 供 UI 同步上下集按钮态 */
  loaded: { episodeId: string };
  /** 全屏状态变化 */
  fullscreenchange: { fullscreen: boolean };
  /** v1.8/CHG-25：当前引擎变化（首次接入与原生→WebView 回退都会触发） */
  enginechange: { kind: 'native' | 'hls' | 'video' };
  /** v1.8/CHG-25：非致命提示（如原生引擎回退），由 View 转 Toast */
  notice: { message: string };
  /**
   * 黑屏检测：码流在播（时间在走）但一帧画面都没解出来。
   * 触发一次/每次加载，由 View 提示「只有声音没有画面」并给换线路/原生引擎入口。
   */
  novideo: { videoWidth: number; videoHeight: number; elapsedSec: number };
  /**
   * B1：媒体会话远端指令（通知栏/锁屏/蓝牙线控的上一集、下一集、关闭）。
   * 原生侧只转发意图，真正的切集由 View 层执行。
   */
  remotecommand: { command: 'previous' | 'next' | 'stop' };
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
  /**
   * v1.8/CHG-25：优先使用实验性原生引擎（ExoPlayer surface 模式）。
   * 由 View 读 `experimentalNativePlayer` 设置注入——控制器保持「不调用任何 Service」
   * 的分层约束；不可用/失败时控制器静默回退 WebView 引擎并发 `notice` 事件。
   */
  preferNativeEngine?: boolean;
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
  /**
   * 画面帧统计（黑屏检测）：`totalFrames === 0` 且 `videoWidth > 0` 表示
   * 「解码器吃下了码流但一帧都没出」（多为 WebView 不支持该视频编码）。
   * 原生 surface 引擎无法统计，返回 null。
   */
  getFrameStats?(): { videoWidth: number; videoHeight: number; totalFrames: number } | null;
  setQuality(quality: string): void;
  getQualities(): string[];
  /** 设置画面缩放模式（contain/cover/fill） */
  setResizeMode(mode: ResizeMode): void;
  /** 销毁并释放资源 */
  destroy(): void;
}

/* ---------- 字幕 ---------- */
export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

/* ---------- 播放面板抽屉 ---------- */

/** 抽屉页签：与原型 ⑤' 的四个 pane 一一对应 */
export type DrawerTab = "ep" | "line" | "av" | "more";
