/**
 * 适配器统一 HTTP 客户端（API-01 支撑）
 *
 * 职责：超时、取消（外部 AbortSignal 联动）、有限重试、错误码映射。
 * 约束：
 * - 所有失败都抛 `AppError`；不发请求前先检查取消状态。
 * - 仅对"可重试"的失败重试：网络错误、超时、429、5xx；4xx 直接抛出。
 * - 不在此层做鉴权注入，headers 由各适配器按源配置拼装。
 */
import { AppError, httpStatusToErrorCode, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PROPFIND' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | null;
  /** 单次尝试超时（毫秒），默认 10s */
  timeoutMs?: number;
  /** 失败重试次数（不含首次），默认 1 */
  retries?: number;
  signal?: AbortSignal;
  /** 期望的响应体类型，默认 json */
  responseType?: 'json' | 'text' | 'blob' | 'arrayBuffer' | 'none';
}

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_RETRIES = 1;

const RETRY_BACKOFF_MS = [400, 900, 1600] as const;

/* ---------- 探测超时作用域（AC-15） ---------- */
/**
 * 健康检查 / 测试连接的探测超时（毫秒）。默认值 `DEFAULT_HTTP_TIMEOUT_MS`（10s）保持不变，
 * 只在探测窗口内生效：`withProbeTimeout(3000, fn, baseUrl)` 执行期间，**同一源（URL 前缀匹配）**
 * 且未显式传 `timeoutMs` 的请求按 3s 超时、不重试。
 *
 * 为什么需要作用域：适配器的 `probe` 都在内部调用 `httpClient.request` 且不传 `timeoutMs`、
 * 多数也不透传 AbortSignal（`probe` 只收 `source`），因此 `BaseAdapter` 外层的 3s AbortController
 * 管不到底层 fetch；若不在此处兜底，断网时实际要等满 10s（含 1 次重试更久），与 AC-15 冲突。
 * 按 baseUrl 前缀匹配可避免影响其它源的并发请求；显式 `timeoutMs` 始终优先。
 */
interface ProbeScope {
  timeoutMs: number;
  baseUrl: string | null;
}

const probeScopes: ProbeScope[] = [];

/** 该 URL 在探测窗口内的有效超时；不在窗口内 → null */
export function probeTimeoutFor(url: string): number | null {
  for (let i = probeScopes.length - 1; i >= 0; i -= 1) {
    const scope = probeScopes[i];
    if (!scope) continue;
    if (scope.baseUrl === null || matchesBase(url, scope.baseUrl)) return scope.timeoutMs;
  }
  return null;
}

/** 同源前缀匹配（`https://a.com` 不应匹配 `https://a.com.evil.com`） */
function matchesBase(url: string, baseUrl: string): boolean {
  if (url === baseUrl) return true;
  const next = url.charAt(baseUrl.length);
  return url.startsWith(baseUrl) && (next === '/' || next === '?' || next === '#');
}

/** 在探测窗口内执行 `fn`（AC-15：健康检查 / 测试连接 3s 超时） */
export async function withProbeTimeout<T>(
  timeoutMs: number,
  fn: () => Promise<T>,
  baseUrl?: string | null,
): Promise<T> {
  const scope: ProbeScope = { timeoutMs, baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : null };
  probeScopes.push(scope);
  try {
    return await fn();
  } finally {
    const index = probeScopes.lastIndexOf(scope);
    if (index >= 0) probeScopes.splice(index, 1);
  }
}

/** 本次请求的有效超时：显式值 → 10s 默认；探测窗口内无显式值时用窗口值（≤10s） */
function effectiveTimeoutMs(url: string, options: HttpRequestOptions): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  return probeTimeoutFor(url) ?? DEFAULT_HTTP_TIMEOUT_MS;
}

/** 本次请求的有效重试次数：探测窗口内一律不重试（否则 3s 上限会被二次尝试突破） */
function effectiveRetries(url: string, options: HttpRequestOptions): number {
  if (probeTimeoutFor(url) !== null) return 0;
  return options.retries ?? DEFAULT_HTTP_RETRIES;
}

/** 可重试的错误码 */
const RETRYABLE: ReadonlySet<string> = new Set([
  'E_NETWORK',
  'E_TIMEOUT',
  'E_HTTP_429',
  'E_HTTP_5XX',
]);

function abortError(): AppError {
  return new AppError('E_ABORTED');
}

function timeoutError(timeoutMs: number): AppError {
  return new AppError('E_TIMEOUT', undefined, { detail: `请求超过 ${timeoutMs}ms 未完成` });
}

/** 把 fetch 抛出的异常映射为 AppError */
function mapFetchError(e: unknown, timeoutMs: number, timedOut: boolean): AppError {
  if (e instanceof AppError) return e;
  if (timedOut) return timeoutError(timeoutMs);
  const base = toAppError(e, 'E_NETWORK');
  if (base.code === 'E_ABORTED') return abortError();
  if (base.code === 'E_UNKNOWN') return new AppError('E_NETWORK', undefined, { detail: base.message, cause: e });
  return base;
}

function mapStatusError(status: number, statusText: string): AppError {
  const code = httpStatusToErrorCode(status);
  // AC-39 / REV-16：401 才是"需要登录"（E_AUTH），403 是"无权限访问"（E_HTTP_403），
  // 不能合并，否则浏览/播放链路 403 文案会退化为「认证失败」。
  // 两者都不在 RETRYABLE 集合中，AppError.retryable 自然为 false。
  const mapCode = status === 401 ? 'E_AUTH' : code;
  return new AppError(mapCode, undefined, {
    detail: `HTTP ${status}${statusText ? ` ${statusText}` : ''}`,
    httpStatus: status,
  });
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** 单次 fetch（带超时与外部取消） */
async function fetchOnce(url: string, options: HttpRequestOptions): Promise<Response> {
  const { method = 'GET', headers = {}, body = null, signal } = options;
  const timeoutMs = effectiveTimeoutMs(url, options);

  if (signal?.aborted) throw abortError();

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ?? undefined,
      signal: controller.signal,
      // 直链播放/下载与 XML 请求都不希望被浏览器缓存策略干扰
      cache: 'no-store',
    });
    if (!response.ok) throw mapStatusError(response.status, response.statusText);
    return response;
  } catch (e) {
    throw mapFetchError(e, timeoutMs, timedOut);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readBody<T>(response: Response, responseType: HttpRequestOptions['responseType']): Promise<T> {
  try {
    switch (responseType) {
      case 'none':
        return undefined as T;
      case 'text':
        return (await response.text()) as T;
      case 'blob':
        return (await response.blob()) as T;
      case 'arrayBuffer':
        return (await response.arrayBuffer()) as T;
      case 'json':
      default: {
        const text = await response.text();
        if (text.trim().length === 0) {
          throw new AppError('E_PARSE', undefined, { detail: '响应体为空' });
        }
        try {
          return JSON.parse(text) as T;
        } catch (e) {
          throw new AppError('E_PARSE', undefined, { detail: '响应不是合法 JSON', cause: e });
        }
      }
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('E_PARSE', undefined, { detail: toAppError(e, 'E_PARSE').message, cause: e });
  }
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/** 带重试的请求入口：成功返回解析后的数据 */
export async function httpRequest<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
  const result = await httpRequestWithMeta<T>(url, options);
  return result.data;
}

/** 同 `httpRequest`，额外返回状态码与响应头（Jellyfin/AList 需要读 header） */
export async function httpRequestWithMeta<T>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const retries = effectiveRetries(url, options);
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetchOnce(url, options);
      const data = await readBody<T>(response, options.responseType);
      return { data, status: response.status, headers: response.headers };
    } catch (e) {
      const error = toAppError(e);
      if (error.code === 'E_ABORTED' && options.signal?.aborted) throw error;
      if (attempt >= retries || !RETRYABLE.has(error.code)) throw error;
      const wait = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 1000;
      logger.debug('HTTP 请求失败，准备重试', { url, attempt, code: error.code });
      attempt += 1;
      await sleep(wait, options.signal);
    }
  }
}

/** 构造 Basic Auth 头 */
export function basicAuthHeader(username: string, password: string): string {
  const raw = `${username}:${password}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === 'function' ? btoa(binary) : Buffer.from(raw, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

/** 直接暴露 fetch 供下载引擎流式读取（不带重试与 JSON 解析） */
export async function rawFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw toAppError(e, 'E_NETWORK');
  }
}

export const httpClient = {
  request: httpRequest,
  requestWithMeta: httpRequestWithMeta,
  rawFetch,
  basicAuthHeader,
  /** 探测窗口：窗口内未显式传 timeoutMs 的请求按 3s 超时（AC-15） */
  withProbeTimeout,
  probeTimeoutFor,
};
