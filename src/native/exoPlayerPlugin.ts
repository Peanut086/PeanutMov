/**
 * ExoPlayer 原生引擎插件代理（v1.7 / CHG-21 PoC，Spike）
 *
 * Android 端 `ExoPlayerPlugin.java`（Media3 1.3.1，surface 模式）：
 * 在 WebView 之上叠加 `PlayerView`，JS 侧用 `setRect` 对齐占位元素。
 *
 * **默认不启用**：设置 `experimentalNativePlayer` 开关（SettingsView，默认关）
 * 为真时 PlayerView 才路由到本引擎；未启用时本文件零调用、WebView 链路不变。
 * 退出标准（MuMu 4K 不掉帧）与移除方式见 `契约变更-v1.7.md` §2.4。
 */
import { registerPlugin } from '@capacitor/core';

import { logger } from '@/shared/logger';

export interface ExoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExoPrepareOptions {
  url: string;
  /** 头数组形态（Java 侧 `call.getArray("headers")` 逐项还原；用 exoHeadersOf 转换） */
  headers?: Array<{ key: string; value: string }>;
  rect?: ExoRect;
  autoPlay?: boolean;
}

export interface ExoQuality {
  id: number;
  label: string;
  width: number;
  height: number;
  bitrate: number;
}

export interface ExoTextTrack {
  id: number;
  label: string;
  mimeType: string;
}

export interface ExoPlayerPlugin {
  isSupported(): Promise<{ supported: boolean }>;
  prepare(options: ExoPrepareOptions): Promise<void>;
  setRect(options: ExoRect): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { positionMs: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  /** v1.8/CHG-25：音量 0~100（Java 侧映射 0~1） */
  setVolume(options: { volume: number }): Promise<void>;
  /** v1.8/CHG-25：droppedFrames 为本次会话累计丢帧（AC-125 帧率采样） */
  progress(): Promise<{ positionMs: number; durationMs: number; droppedFrames?: number }>;
  release(): Promise<void>;
  /** v1.8 优化：获取视频轨列表（清晰度） */
  getQualities(): Promise<{ qualities: ExoQuality[] }>;
  /** v1.8 优化：切换视频轨（清晰度） */
  setQuality(options: { id: number }): Promise<void>;
  /** v1.8 优化：获取字幕轨列表 */
  getTextTracks(): Promise<{ textTracks: ExoTextTrack[] }>;
  /** v1.8 优化：切换字幕轨（-1 表示关闭） */
  setTextTrack(options: { id: number }): Promise<void>;
  /** v1.8 优化：获取播放质量指标 */
  getPlaybackStats(): Promise<{
    bufferEvents: number;
    bufferDurationMs: number;
    currentBitrate: number;
    decoderName: string;
    droppedFrames: number;
    currentPosition: number;
    duration: number;
    playbackSpeed: number;
  }>;
  /** v1.8 优化：进入画中画模式 */
  enterPip(): Promise<void>;
  /** v1.8 优化：退出画中画模式 */
  exitPip(): Promise<void>;
  /** 状态监听（ready / buffering / ended / error / qualities / textTracks）；返回解绑函数 */
  addListener(
    eventName: 'exostate',
    cb: (data: { state: string; message?: string; duration?: number; qualities?: ExoQuality[]; textTracks?: ExoTextTrack[] }) => void,
  ): Promise<() => void>;
}

export const ExoPlayer = registerPlugin<ExoPlayerPlugin>('ExoPlayer');

export async function isExoPlayerAvailable(): Promise<boolean> {
  try {
    const result = await ExoPlayer.isSupported();
    return result.supported === true;
  } catch (e) {
    logger.debug('ExoPlayer 插件不可用（回退 WebView 引擎）', e);
    return false;
  }
}

/** headers 对象 → 插件数组格式（Java 侧逐项还原） */
export function exoHeadersOf(headers: Record<string, string>): Array<{ key: string; value: string }> {
  return Object.entries(headers).map(([key, value]) => ({ key, value }));
}
