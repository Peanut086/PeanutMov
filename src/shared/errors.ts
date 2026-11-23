/**
 * 统一错误模型（SCF 冻结，PKG-B 只读）
 *
 * 规则（技术方案第 13 章）：
 * - 一律 `throw new AppError(code, message?, extra?)`；
 * - UI 只读 `code` / `message`（必要时读 `detail`）；
 * - 文案集中在 `ERROR_MESSAGES`，AC-60 单测直接断言该表。
 */
import type { AppErrorShape, ErrorCode, UnsupportedFormatReason } from '@/types';

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
  // P1-3：源正忙不是源死了——上一次原生调用还在跑，等它落定就有可能成功
  E_SOURCE_BUSY: '该源正忙，上一次请求还没跑完',
  E_NO_PLAY_URL: '该集暂无可播放地址',
  E_NETDISK_LOGIN_REQUIRED: '网盘未登录，请先登录',
  E_UNSUPPORTED_FORMAT: '暂不支持该格式',
  E_DRM_PROTECTED: '不支持受保护内容',
  E_DECODE: '视频解码失败，请尝试切换线路',
  // P0-2：离线文件能打开、能出首帧，但时间轴不可信导致永不推进——重试无意义，只能重下
  E_LOCAL_STALL: '离线文件时间轴异常，请重新下载这一集',
  // FIX-PLAY-C1：离线文件能起播但解码中途报错（分片损坏/污染）——同样只能重下，换线路无效
  E_LOCAL_CORRUPT: '离线文件可能损坏，请重新下载这一集',
  E_INVALID_STATE: '当前状态不允许该操作',
  E_STORAGE_QUOTA: '存储空间不足',
  E_FILE_MISSING: '本地文件不可用，请重新下载',
  E_NAME_TOO_LONG: '本地文件路径过长，无法保存，请更换线路或源后重试',
  E_FAKE_SOURCE_CONTENT: '该线路返回的疑似占位内容（分片高度重复），请更换线路或源',
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
  // P1-3：忙是「等一会儿再试」，不是「立刻再投一次」——这里只决定界面上要不要给重试按钮，
  // 自动重试的闸门在 `isTransientFailure`（`source_busy` 刻意不在其中）。
  'E_SOURCE_BUSY',
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
  /**
   * OPT-26（P0-②-1）：同码不同成因时带上来历。
   *
   * 只登记在 `E_UNSUPPORTED_FORMAT` 这一族：这个码此前被 4 个来源共用，
   * 下游按码分类时全部套上「磁力链接」文案，连「用外部应用打开」都跟着出现。
   * 其它码继续沿用「码 + 文案」的既有口径，不在这里扩表。
   */
  reason?: UnsupportedFormatReason | null;
  /**
   * OPT-26（P0-③-2）：闸门多久后放行（毫秒），只在 `E_SOURCE_BUSY` 上有值。
   * 数值必须来自 `SpiderAdapter` 的真实占用读数，界面不许自己猜。
   */
  retryAfterMs?: number | null;
  /**
   * 结构化补充信息，供调用方决定「下一步动作」。
   *
   * 只挂在 AppError 实例上、不进 `AppErrorShape`：形状会落库/进日志，而这类字段
   * （如搜索全失败时未启动的源 id）只在一次 catch 里有意义。
   */
  meta?: Record<string, unknown> | null;
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
  readonly reason: UnsupportedFormatReason | null;
  readonly retryAfterMs: number | null;
  readonly meta: Record<string, unknown> | null;

  constructor(code: ErrorCode, message?: string, extra?: AppErrorExtra) {
    super(message ?? ERROR_MESSAGES[code]);
    this.name = 'AppError';
    this.code = code;
    this.detail = extra?.detail ?? null;
    this.retryable = extra?.retryable ?? RETRYABLE_CODES.has(code);
    this.httpStatus = extra?.httpStatus ?? null;
    this.reason = extra?.reason ?? null;
    this.retryAfterMs = extra?.retryAfterMs ?? null;
    this.meta = extra?.meta ?? null;
    if (extra?.cause !== undefined) {
      (this as { cause?: unknown }).cause = extra.cause;
    }
  }

  toShape(): AppErrorShape {
    const shape: AppErrorShape = {
      code: this.code,
      message: this.message,
      detail: this.detail,
      retryable: this.retryable,
      httpStatus: this.httpStatus,
    };
    // 只在有值时带上：这两个字段是 OPT-26 新增的可选档位，
    // 给每条错误都塞 null 会让既有快照断言（toEqual）无意义地全红。
    if (this.reason !== null) shape.reason = this.reason;
    if (this.retryAfterMs !== null) shape.retryAfterMs = this.retryAfterMs;
    return shape;
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
  /*
   * OPT-26（P1-②-3）：已经分类好的结论不许再折回 fallbackCode。
   *
   * 原生引擎把 exostate 的 error 直接 reject 出来（`toPlayError` 给的是 `AppErrorShape`，
   * 不是 Error），此前这条路在每一层都被折成泛化的 E_DECODE——一次真实的「源站断连」在
   * 日志、面板和引擎链归属里都成了「本机解不了」。只有 code 是已登记错误码时才接管。
   */
  if (typeof e === 'object' && e !== null) {
    const shape = e as Partial<AppErrorShape>;
    if (typeof shape.code === 'string' && shape.code in ERROR_MESSAGES) {
      return new AppError(shape.code as ErrorCode, shape.message ?? undefined, {
        detail: shape.detail ?? null,
        retryable: shape.retryable ?? undefined,
        httpStatus: shape.httpStatus ?? undefined,
        reason: shape.reason ?? undefined,
        retryAfterMs: shape.retryAfterMs ?? undefined,
        cause: e,
      });
    }
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
