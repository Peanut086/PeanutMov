/**
 * 需要 Origin / Referer / 响应头 / 二进制的弹幕源请求
 *
 * WebView 的 fetch 会静默丢弃 Origin 与 Referer 这两个 forbidden header：B 站接口缺 Referer
 * 直接 403，腾讯搜索缺 Origin 返回空结果（ret=20607）。原生端改用 CapacitorHttp 插件原样发送；
 * Web/单测环境没有这个限制，继续走 httpClient。
 *
 * 三类扩展能力按需提供：
 * - `requestWithHeaders`：只要响应体（B 站/腾讯/芒果/搜狐/乐视）；
 * - `requestResponse`：还要响应头（优酷 mtop 需从 Set-Cookie 取签名 token）；
 * - `requestBytes`：二进制响应体（爱奇艺分片是 Brotli 压缩流）。
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

import { httpClient, type HttpRequestOptions } from '@/sources/base/httpClient';

/** 原生/网页两通路统一的响应结构；headers 键名统一小写 */
export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Record<string, string>;
}

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

/**
 * 小写化响应头：Capacitor 原样回传服务端大小写，调用方按 `set-cookie` 读取。
 * 重名头（优酷一次下发两条 `set-cookie`）按 HTTP 语义以逗号合并——`Headers.get` 也是这个行为，
 * 直接覆盖会只剩后写的那条，`_m_h5_tk` 就取不到了。
 */
function lowerHeaders(raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const lower = key.toLowerCase();
    out[lower] = out[lower] === undefined ? String(value) : `${out[lower]}, ${value}`;
  }
  return out;
}

export async function requestResponse<T>(
  url: string,
  options: HttpRequestOptions & { responseType: 'json' | 'text' },
): Promise<HttpResponse<T>> {
  if (!Capacitor.isNativePlatform()) {
    const response = await httpClient.requestWithMeta<T>(url, options);
    const pairs: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      pairs[lower] = pairs[lower] === undefined ? value : `${pairs[lower]}, ${value}`;
    });
    return { data: response.data, status: response.status, headers: pairs };
  }
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
  return { data: response.data as T, status: response.status, headers: lowerHeaders(response.headers) };
}

/** 二进制响应：原生通路按 Capacitor 约定拿到 base64 字符串，Web 通路拿 ArrayBuffer */
export async function requestBytes(url: string, options: HttpRequestOptions = {}): Promise<Uint8Array> {
  if (!Capacitor.isNativePlatform()) {
    const buffer = await httpClient.request<ArrayBuffer>(url, { ...options, responseType: 'arrayBuffer' });
    return new Uint8Array(buffer);
  }
  const timeout = options.timeoutMs ?? 10_000;
  const response = await CapacitorHttp.request({
    url,
    method: options.method ?? 'GET',
    headers: options.headers ?? {},
    data: options.body ?? undefined,
    responseType: 'arraybuffer',
    connectTimeout: timeout,
    readTimeout: timeout,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`HTTP ${response.status}`);
  }
  return base64ToBytes(String(response.data ?? ''));
}

/** 原生通路只给 base64，且可能是含换行的 MIME 变体（OkHttp/HttpURLConnection 默认 NO_WRAP，仍统一容错） */
export function base64ToBytes(value: string): Uint8Array {
  const clean = value.replace(/[^0-9a-zA-Z+/=]/g, '');
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
