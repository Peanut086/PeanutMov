/**
 * WebView 媒体嗅探插件 `Sniffer` 的 JS 代理
 *
 * 用途：parse=1 / jx 解析器地址（`https://jx.xx.com/?url=...`）无法静态解析——
 * 页面靠 JS 执行后才发起真实的 m3u8/mp4 请求。原生侧用离屏 WebView 加载页面，
 * 在 `shouldInterceptRequest` 里捕获媒体请求，返回第一个命中直链。
 *
 * Web / 插件缺失时 `sniffPlayUrl` 返回 null（调用方保留原错误语义）。
 */
import { registerPlugin } from '@capacitor/core';

import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';

export interface SnifferPlugin {
  /** 加载 url 并嗅探媒体请求；命中返回 `{ url }`，超时未命中返回 `{ url: null }` */
  sniff(options: {
    url: string;
    headers?: Record<string, string>;
    /** 嗅探窗口（毫秒），默认 15000 */
    timeoutMs?: number;
  }): Promise<{ url: string | null }>;
  /** 插件是否可用（原生环境恒 true） */
  isSupported(): Promise<{ supported: boolean }>;
}

export const Sniffer = registerPlugin<SnifferPlugin>('Sniffer');

/** 默认嗅探窗口：解析页 JS 执行 + 跳转一般不超过 15s */
export const SNIFF_TIMEOUT_MS = 15_000;

/**
 * 嗅探页面媒体直链。非原生环境 / 插件缺失 / 超时未命中 → null。
 * 抛出的错误仅代表嗅探本身失败（如插件崩溃），调用方可自行兜底。
 */
export async function sniffPlayUrl(
  url: string,
  headers?: Record<string, string>,
  timeoutMs: number = SNIFF_TIMEOUT_MS,
): Promise<string | null> {
  if (!isNative()) return null;
  try {
    const supported = await Sniffer.isSupported();
    if (!supported.supported) return null;
  } catch {
    return null;
  }
  const result = await Sniffer.sniff({ url, headers, timeoutMs });
  logger.debug('嗅探结果', url, result.url);
  return result.url ?? null;
}
