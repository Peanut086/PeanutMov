/**
 * 需要 Origin / Referer 的弹幕源请求
 *
 * WebView 的 fetch 会静默丢弃这两个 forbidden header：B 站接口缺 Referer 直接 403，
 * 腾讯搜索缺 Origin 返回空结果（ret=20607）。原生端改用 CapacitorHttp 插件（OkHttp）
 * 原样发送；Web/单测环境没有这个限制，继续走 httpClient。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

import { httpClient, type HttpRequestOptions } from '@/sources/base/httpClient';

export async function requestWithHeaders<T>(
  url: string,
  options: HttpRequestOptions & { responseType: 'json' | 'text' },
): Promise<T> {
  if (!Capacitor.isNativePlatform()) return httpClient.request<T>(url, options);
  const timeout = options.timeoutMs ?? 10_000;
  const response = await CapacitorHttp.request({
    url,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    data: options.body ?? undefined,
    responseType: options.responseType,
    connectTimeout: timeout,
    readTimeout: timeout,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.data as T;
}
