/**
 * TVBox 解析接口服务（功能扩展-6）
 *
 * 解析接口（jx）是第三方 URL 解析服务，典型形态：
 * `https://jx.xxx.com/?url=VIDEO_URL` → 返回 JSON `{ url: '实际播放地址' }`
 *
 * 本服务按配置顺序尝试多个解析接口，命中 直连 API 取结果；
 * 全部失败 由调用方回退到 WebView 嗅（嗅niffPlayUrl）。
 */
import { httpClient } from '@/sources/base/httpClient';
import { logger } from '@/shared/logger';

/** 解析接口响应 返回结构（兼容 实现差异大，按宽松 字段取） */
interface ResolverResponse {
  url?: string;
  playUrl?: string;
  videoUrl?: string;
  data?: {
    url?: string;
    playUrl?: string;
  };
  code?: number | string;
  msg?: string;
}

/**
 * 尝试用解析接口解析视频地址。
 *
 * @param resolverUrl 解析接口模板，含 `{url}` 占位符或已拼接好 `?url=xxx`
 * @param videoUrl 待解析的视频地址
 * @param signal 中断信号
 * @returns 解析成功的实际视频地址；失败 返回 null
 */
export async function resolveViaApi(
  resolverUrl: string,
  videoUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // 拼接最终请求（支持占位符或已带 ?url=）
  const finalUrl = resolverUrl.includes('{url}')
    ? resolverUrl.replace('{url}', encodeURIComponent(videoUrl))
    : resolverUrl.includes('?')
      ? `${resolverUrl}&url=${encodeURIComponent(videoUrl)}`
      : `${resolverUrl}?url=${encodeURIComponent(videoUrl)}`;

  try {
    const response = await httpClient.request<ResolverResponse>(finalUrl, {
      timeoutMs: 8000,
      retries: 0,
      signal,
    });

    // 按优先级取字段（不同解析接口返回结构不同）
    const resolved = response.url ?? response.playUrl ?? response.videoUrl ?? response.data?.url ?? response.data?.playUrl;

    if (!resolved || typeof resolved !== 'string') {
      logger.debug('解析接口未返回有效 URL', { resolverUrl, response });
      return null;
    }

    // 基本校验：必须是 http/https 开头
    if (!/^https?:\/\//i.test(resolved)) {
      logger.debug('解析接口返回非 HTTP 地址', { resolved });
      return null;
    }

    logger.debug('解析接口命中', { resolverUrl, videoUrl, resolved });
    return resolved;
  } catch (e) {
    logger.warn('解析接口调用失败', { resolverUrl, error: e });
    return null;
  }
}

/**
 * 批量尝试多个解析接口，返回第一个成功的结果。
 *
 * @param resolvers 解析接口列表（可含 `{url}` 占位符）
 * @param videoUrl 待解析的视频地址
 * @param signal 中断信号
 * @returns 解析成功的视频地址；全部失败 返回 null
 */
export async function resolveViaMultiple(
  resolvers: string[],
  videoUrl: string,
  signal?: AbortSignal,
): Promise<string | null> {
  for (const resolver of resolvers) {
    if (signal?.aborted) return null;
    const resolved = await resolveViaApi(resolver, videoUrl, signal);
    if (resolved) return resolved;
  }
  return null;
}
