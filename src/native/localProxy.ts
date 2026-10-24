/**
 * 本地回环代理插件 `LocalProxy` 的 JS 代理
 *
 * 用途：直链 MP4 等交给 `<video src>` 的播放无法注入自定义请求头
 * （CapacitorHttp 只补丁 fetch/XHR；hls.js 自带 xhrSetup 不受影响），
 * 带 Referer/UA 防盗链的源需要经原生回环代理转发。
 */
import { registerPlugin } from '@capacitor/core';

import { isNative } from '@/shared/platform';
import type { PlaybackSource } from '@/types';

export interface LocalProxyPlugin {
  /** 登记 url+headers，返回本机代理地址 */
  proxy(options: { url: string; headers?: Record<string, string> }): Promise<{ url: string }>;
  isSupported(): Promise<{ supported: boolean }>;
}

export const LocalProxy = registerPlugin<LocalProxyPlugin>('LocalProxy');

/** 是否需要走本地代理：原生环境 + 非本地文件 + 有注入头 + 非 HLS（HLS 由 hls.js 注入头） */
export function needsHeaderProxy(playback: PlaybackSource): boolean {
  if (!isNative() || playback.isLocal) return false;
  if (playback.format === 'hls') return false;
  return Object.keys(playback.headers ?? {}).length > 0;
}

/**
 * 返回可交给 `<video>` 的地址：需要时登记本机代理并返回代理地址；
 * 不需要 / 插件失败 → null（调用方沿用原地址）。
 */
export async function localProxyUrl(playback: PlaybackSource): Promise<string | null> {
  if (!needsHeaderProxy(playback)) return null;
  try {
    const result = await LocalProxy.proxy({ url: playback.url, headers: playback.headers });
    return result.url;
  } catch {
    return null;
  }
}
