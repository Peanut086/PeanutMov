/**
 * 管道传输层
 *
 * 职责边界（与 `httpClient` 的分工）：
 * - `httpClient` 仍负责超时、取消、错误码映射；
 * - 本层负责"按规则握手 + 保留状态码 + 字节解码"，并把重试权**收归调度器**
 *   （这里强制 `retries: 0`，否则两套退避会叠成 6 次请求）。
 *
 * 为什么取 `arrayBuffer` 而不是 `text`：
 * Web 端 `response.text()` 按 header charset 解码，缺失时按 UTF-8，GBK 站点会乱码；
 * 取原始字节后由 `decodeBody` 统一按 BOM → header → 探测解码。
 *
 * CapacitorHttp 兼容性：原生补丁把 body 读成字符串再 `new Response(data)`，
 * `arrayBuffer()` 会把该字符串按 UTF-8 编码成字节——此时正文已是正确文本，
 * `decodeBody` 的 UTF-8 探测会命中，不会二次误解码。
 */
import { AppError, toAppError } from '@/shared/errors';
import { httpClient, probeTimeoutFor } from '@/sources/base/httpClient';
import { decodeBody } from './decode';
import type { CrawlIntent, HandshakeProfile } from './types';

/** 默认握手参数（规则未覆盖时使用） */
const DEFAULT_ACCEPT: Record<CrawlIntent, string> = {
  subscription: 'application/json, text/plain, */*',
  catalog: 'application/json, text/plain, */*',
  detail: 'application/json, text/plain, */*',
  search: 'application/json, text/plain, */*',
  playpage: 'text/html,application/xhtml+xml',
  probe: 'application/json, text/plain, */*',
};

export interface TransportRequest {
  url: string;
  intent: CrawlIntent;
  handshake: HandshakeProfile | null;
  /** 调用方提供的 headers（源的鉴权/自定义头） */
  baseHeaders?: Record<string, string>;
  /** 单次尝试超时（已由调度器按剩余预算收敛） */
  timeoutMs: number;
  signal?: AbortSignal;
  /** 响应体字节上限；超限直接抛 `E_INVALID_INPUT`（订阅 2MB 上限） */
  maxBytes?: number;
}

export interface TransportResponse {
  status: number;
  statusText: string;
  headers: Headers;
  text: string;
  charset: string;
  bytes: Uint8Array;
  /** 最终 URL（跨域跳转后为落地地址） */
  finalUrl: string | null;
  /** 请求耗时（毫秒） */
  ms: number;
}

/** 合并 headers：调用方 headers 优先，握手参数补充缺省项 */
export function mergeHeaders(
  base: Record<string, string> | undefined,
  handshake: HandshakeProfile | null,
  intent: CrawlIntent,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base ?? {})) out[key] = value;

  const has = (name: string): boolean => Object.keys(out).some((k) => k.toLowerCase() === name);

  if (!has('accept')) out['Accept'] = handshake?.accept ?? DEFAULT_ACCEPT[intent];
  if (handshake?.ua && !has('user-agent')) out['User-Agent'] = handshake.ua;
  for (const [key, value] of Object.entries(handshake?.extraHeaders ?? {})) {
    if (!has(key.toLowerCase())) out[key] = value;
  }
  return out;
}

/**
 * 发一次请求并解码正文。
 *
 * 关键：`throwOnHttpError: false` —— 403/429 也要拿到响应交给规则判断（UA 适配场景）。
 * 网络/超时类失败仍抛 `AppError`，由调度器决定是否重试或降级。
 */
export async function transport(request: TransportRequest): Promise<TransportResponse> {
  const startedAt = Date.now();
  const headers = mergeHeaders(request.baseHeaders, request.handshake, request.intent);

  // 探测窗口内以窗口值为准（AC-15：3s 硬上限），不被规则里的 8s/10s 超时突破
  const probeTimeout = probeTimeoutFor(request.url);
  const timeoutMs = probeTimeout !== null ? Math.min(probeTimeout, request.timeoutMs) : request.timeoutMs;

  let response: { data: ArrayBuffer; status: number; headers: Headers };
  try {
    response = await httpClient.requestWithMeta<ArrayBuffer>(request.url, {
      method: 'GET',
      headers,
      signal: request.signal,
      redirect: request.handshake?.redirect ?? 'follow',
      throwOnHttpError: false,
      retries: 0,
      timeoutMs,
      responseType: 'arrayBuffer',
    });
  } catch (e) {
    throw toAppError(e, 'E_NETWORK');
  }

  const bytes = new Uint8Array(response.data ?? new ArrayBuffer(0));
  if (request.maxBytes !== undefined && bytes.byteLength > request.maxBytes) {
    throw new AppError('E_INVALID_INPUT', '订阅内容过大（上限 2MB）', {
      detail: `响应体 ${bytes.byteLength} 字节，超过上限 ${request.maxBytes}`,
      retryable: false,
    });
  }
  const contentType = response.headers.get('content-type');
  const decoded = decodeBody({ bytes, contentType });

  return {
    status: response.status,
    statusText: statusTextOf(response.status),
    headers: response.headers,
    text: decoded.text,
    charset: decoded.charset,
    bytes,
    finalUrl: null,
    ms: Date.now() - startedAt,
  };
}

/** `fetch` 的 Response.statusText 在原生补丁下可能为空，统一给空串 */
function statusTextOf(_status: number): string {
  return '';
}

/** 状态码 → AppError（与 `httpClient.mapStatusError` 保持同一映射） */
export function statusError(status: number, statusText: string): AppError {
  const code = httpStatusToAppCode(status);
  return new AppError(code, undefined, {
    detail: `HTTP ${status}${statusText ? ` ${statusText}` : ''}`,
    httpStatus: status,
  });
}

/** 401 映射 E_AUTH（与 httpClient 的 AC-39 / REV-16 规则一致） */
function httpStatusToAppCode(
  status: number,
): 'E_AUTH' | 'E_HTTP_400' | 'E_HTTP_403' | 'E_HTTP_404' | 'E_HTTP_429' | 'E_HTTP_5XX' | 'E_UNKNOWN' {
  if (status >= 500) return 'E_HTTP_5XX';
  switch (status) {
    case 400:
      return 'E_HTTP_400';
    case 401:
      return 'E_AUTH';
    case 403:
      return 'E_HTTP_403';
    case 404:
      return 'E_HTTP_404';
    case 429:
      return 'E_HTTP_429';
    default:
      return 'E_UNKNOWN';
  }
}
