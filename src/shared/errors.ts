/**
 * 统一错误模型（SCF 冻结，PKG-B 只读）
 *
 * 规则（技术方案第 13 章）：
 * - 一律 `throw new AppError(code, message?, extra?)`；
 * - UI 只读 `code` / `message`（必要时读 `detail`）；
 * - 文案集中在 `ERROR_MESSAGES`，AC-60 单测直接断言该表。
 */
import type { AppErrorShape, ErrorCode } from '@/types';

/* ---------- 错误码 → 用户文案（技术方案第 15 章） ---------- */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  E_UNKNOWN: '操作失败，请重试',
  E_NETWORK: '网络不可用，请检查网络后重试',
  E_TIMEOUT: '请求超时，请稍后重试',
  E_ABORTED: '已取消',
  E_HTTP_400: '请求参数有误(400)',
  E_HTTP_401: '认证失败，请检查账号或 Token',
  E_HTTP_403: '无权限访问(403)',
  E_HTTP_404: '资源不存在(404)',
  E_HTTP_429: '请求过于频繁，请稍后再试',
  E_HTTP_5XX: '服务器异常，请稍后重试',
  E_AUTH: '认证失败，请检查账号或 Token',
  E_PARSE: '数据解析失败，源可能已变更',
  E_INVALID_INPUT: '输入内容不合法，请检查后重试',
  // AC-60 指定文案：`E_NOT_FOUND → "资源不存在(404)"`（REV-04）
  E_NOT_FOUND: '资源不存在(404)',
  E_NOT_IMPLEMENTED: '该源不支持此操作',
  E_SOURCE_DISABLED: '该源已禁用，请先在源管理中启用',
  E_SOURCE_UNAVAILABLE: '该源暂不可用，可切换其他源',
  E_NO_PLAY_URL: '该集暂无可播放地址',
  E_NETDISK_LOGIN_REQUIRED: '网盘未登录，请先登录',
  E_UNSUPPORTED_FORMAT: '暂不支持该格式',
  E_DRM_PROTECTED: '不支持受保护内容',
  E_DECODE: '视频解码失败，请尝试切换线路',
  // P0-2：离线文件能打开、能出首帧，但时间轴不可信导致永不推进——重试无意义，只能重下
  E_LOCAL_STALL: '离线文件时间轴异常，请重新下载这一集',
  E_INVALID_STATE: '当前状态不允许该操作',
  E_STORAGE_QUOTA: '存储空间不足',
  E_FILE_MISSING: '本地文件不可用，请重新下载',
  E_DB: '本地数据读写失败，请重试',
  E_VERSION_UNSUPPORTED: '数据版本不支持，请升级 App',
  E_CANCELED: '已取消',
  E_KEYWORD_IGNORED: '源未返回与关键词相关的内容',
};

/* ---------- 可重试性（技术方案第 15 章"可重试"列） ---------- */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'E_UNKNOWN',
  'E_NETWORK',
  'E_TIMEOUT',
  'E_HTTP_429',
  'E_HTTP_5XX',
  'E_PARSE',
  'E_SOURCE_UNAVAILABLE',
  'E_DECODE',
]);

/** HTTP 状态码 → ErrorCode（httpClient / 适配器共用） */
export function httpStatusToErrorCode(status: number): ErrorCode {
  if (status >= 500) return 'E_HTTP_5XX';
  switch (status) {
    case 400:
      return 'E_HTTP_400';
    case 401:
      return 'E_HTTP_401';
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

export interface AppErrorExtra {
  detail?: string | null;
  retryable?: boolean;
  httpStatus?: number | null;
  /** 保留原始异常，仅用于日志，不进入 AppErrorShape */
  cause?: unknown;
}

/**
 * 应用统一异常。
 * `message` 缺省取 `ERROR_MESSAGES[code]`，自定义文案请保持"发生了什么 + 可能原因 + 下一步动作"。
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail: string | null;
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(code: ErrorCode, message?: string, extra?: AppErrorExtra) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.detail = extra?.detail ?? null;
    this.retryable = extra?.retryable ?? RETRYABLE_CODES.has(code);
    this.httpStatus = extra?.httpStatus ?? null;
    if (extra?.cause !== undefined) {
      (this as { cause?: unknown }).cause = extra.cause;
    }
  }

  toShape(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      detail: this.detail,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
    };
  }
}

/* ---------- 归一化 ---------- */

function isAbortError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === 'AbortError' || name === 'AbortSignal';
}

function isQuotaError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === 'QuotaExceededError';
}

/**
 * 任意异常 → AppError。
 * 已是 AppError 时原样返回（保留 code/detail），避免多层包装丢失语义。
 */
export function toAppError(e: unknown, fallbackCode: ErrorCode = 'E_UNKNOWN'): AppError {
  if (e instanceof AppError) return e;
  if (isAbortError(e)) {
    return new AppError('E_ABORTED', ERROR_MESSAGES.E_ABORTED, { cause: e });
  }
  if (isQuotaError(e)) {
    return new AppError('E_STORAGE_QUOTA', ERROR_MESSAGES.E_STORAGE_QUOTA, { cause: e });
  }
  if (e instanceof Error) {
    // fetch 在网络层失败时抛 TypeError('Failed to fetch')
    const isNetwork = e instanceof TypeError && /fetch|network/i.test(e.message);
    return new AppError(isNetwork ? 'E_NETWORK' : fallbackCode, undefined, {
      detail: e.message,
      cause: e,
    });
  }
  if (typeof e === 'string' && e.length > 0) {
    return new AppError(fallbackCode, undefined, { detail: e });
  }
  return new AppError(fallbackCode);
}

/** 任意异常 → AppErrorShape（UI 层 catch 后直接写入 store/state） */
export function toErrorShape(e: unknown, fallbackCode: ErrorCode = 'E_UNKNOWN'): AppErrorShape {
  return toAppError(e, fallbackCode).toShape();
}

/** 便捷断言：不满足条件时抛 AppError */
export function assertOrThrow(condition: unknown, code: ErrorCode, message?: string): asserts condition {
  if (!condition) throw new AppError(code, message);
}

/** 判断是否为"用户主动取消"，调用方通常静默处理 */
export function isCanceled(e: unknown): boolean {
  return e instanceof AppError ? e.code === 'E_ABORTED' || e.code === 'E_CANCELED' : isAbortError(e);
}
