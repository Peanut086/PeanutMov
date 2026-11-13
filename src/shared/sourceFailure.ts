/**
 * 源侧失败分类与文案收敛（P0-1 / P1-5）
 *
 * 背景（真机实测 2026-10-28）：
 * - resolve 失败一律「该源暂不可用」，用户不知道该换源、等一等、还是换外部播放器；
 * - 规则脚本的原始异常（`expecting ';'`、`'data' is not defined`、
 *   `cannot read property '1' of null`）直接进 UI 明细，既看不懂也泄露实现。
 *
 * 本模块是**唯一**分类口径：
 * 1. `classifySourceFailure` 把 `AppErrorShape` 归成 4 类可行动原因；
 * 2. `guidanceOf` 给出对应文案与动作集合，UI 只按动作渲染按钮；
 * 3. `sanitizeSourceMessage` 把脚本内部异常收敛成一句人话（原文只进日志）。
 */
import type { AppErrorShape } from '@/types';

/** 源失败原因（面向用户的可行动分类） */
export type SourceFailureKind =
  | 'source_dead'
  | 'timeout'
  | 'protocol_unsupported'
  | 'rule_script'
  | 'source_internal'
  | 'safe_mode'
  | 'quarantined'
  | 'spider_mismatch'
  | 'jar_conflict'
  | 'auth'
  | 'keyword_ignored'
  | 'unknown';

/** UI 可渲染的动作 */
export type SourceFailureAction =
  | 'retry'
  | 'switch-source'
  | 'switch-line'
  | 'external'
  | 'health-check'
  | 'edit-source';

export interface SourceFailureGuidance {
  kind: SourceFailureKind;
  /** 一句原因（替代 ERROR_MESSAGES 的通用文案） */
  title: string;
  /** 可能原因 + 下一步 */
  hint: string;
  /** 建议动作，按优先级排序 */
  actions: SourceFailureAction[];
}

/** 脚本内部异常收敛后的统一文案（原文仅入日志/调试面板） */
export const RULE_SCRIPT_MESSAGE = '规则脚本异常（源站问题）';
/** 爬虫/插件内部异常（Java 侧 NPE、JSON 结构不符等）的统一文案 */
export const SOURCE_INTERNAL_MESSAGE = '源侧执行异常（源站问题）';
/** 磁力链接的统一文案（App 无种子下载链路，只能外部打开） */
export const MAGNET_MESSAGE = '磁力链接需用外部下载器/播放器打开';
/** 安全模式保护：爬虫源与原生播放器被暂停（近期连续崩溃触发） */
export const SAFE_MODE_MESSAGE = '安全模式保护中：爬虫源已暂停';
/** 爬虫隔离：同签名 24h 内崩溃 2 次，隔离 7 天 */
export const QUARANTINE_MESSAGE = '该爬虫因连续崩溃被隔离';
/** 订阅 api 类名与 jar 内容不匹配 */
export const SPIDER_MISMATCH_MESSAGE = '爬虫类缺失，源配置与 jar 不匹配';
/** 爬虫 jar 之间的依赖冲突（同一 dex 里同类名不同签名） */
export const JAR_CONFLICT_MESSAGE = '爬虫 jar 依赖冲突，无法加载';
/** 源返回了结果但全部与关键词无关（典型：采集站关闭搜索，返回最新目录） */
export const KEYWORD_IGNORED_MESSAGE = '源忽略了关键词';

const MAGNET_PREFIX = 'magnet:';

/** 是否为磁力链接 */
export function isMagnetUrl(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith(MAGNET_PREFIX);
}

/**
 * 判定一段错误文本是否来自 JS/规则脚本内部。
 *
 * 覆盖真机实际出现过的形态：语法错误（`expecting ';'`）、未定义变量
 * （`'data' is not defined`）、空值取属性（`cannot read property '1' of null`）、
 * 以及 V8/QuickJS 的 `TypeError: ...` 形态。
 */
export function isRuleScriptMessage(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return (
    /expecting\s+['"]|unexpected\s+(token|identifier|end of)|is not defined|cannot read propert|undefined is not|is not a function|Cannot convert undefined|of null|of undefined/i.test(
      raw,
    ) ||
    /\b(SyntaxError|ReferenceError|TypeError|RangeError)\b/.test(raw) ||
    /\bat\s+\S+\.(js|mjs):\d+/.test(raw)
  );
}

/**
 * 判定是否来自爬虫/插件的 Java 侧内部异常。
 *
 * 真机明细里这类文案同样不可读，且暴露实现：
 * `爬虫调用失败: NullPointerException: Attempt to invoke virtual method ...`、
 * `JsonSyntaxException: Expected BEGIN_OBJECT but was STRING`。
 */
export function isSourceInternalMessage(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return (
    /\b(NullPointerException|ArrayIndexOutOfBoundsException|IndexOutOfBoundsException|ClassCastException|IllegalStateException|IllegalArgumentException|JsonSyntaxException|NumberFormatException|NoSuchMethodError|NoSuchFieldError|ClassNotFoundException|InvocationTargetException)\b/.test(
      raw,
    ) ||
    /Attempt to invoke (virtual|interface) method|Expected BEGIN_(OBJECT|ARRAY)/.test(raw) ||
    /\bat\s+(com|java|android|kotlin)\./.test(raw)
  );
}

/**
 * 判定是否 jar 依赖冲突（F9）。
 *
 * 真机实测（光影源，进程内每次调用必现）：
 * `IncompatibleClassChangeError: org.slf4j.impl.AndroidLoggerFactory does not implement
 * com.github.catvod.spider.merge.Pu`
 * ——多份 guard jar 各自携带同名 slf4j binding，合入同一 DexClassLoader 后签名互不兼容。
 *
 * 只收 `LinkageError` 家族（`IncompatibleClassChangeError` / `NoClassDefFoundError` /
 * `UnsatisfiedLinkError`）与显式的 `does not implement` / `could not initialize class`，
 * **故意不含** `ExceptionInInitializerError`：它常见于 jar 静态块里的瞬时网络失败，
 * 归到确定性故障会误伤。同一故障在第二次调用后必然以 `NoClassDefFoundError` 现形，届时再归类。
 */
export function isJarLinkageMessage(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return (
    /\b(IncompatibleClassChangeError|LinkageError|NoClassDefFoundError|UnsatisfiedLinkError)\b/.test(raw) ||
    /does not implement [a-z][\w.$]*|could not initialize class /i.test(raw)
  );
}

/**
 * 用户可见文案收敛：
 * - 脚本内部异常 → 「规则脚本异常（源站问题）」
 * - jar 依赖冲突 → 「爬虫 jar 依赖冲突，无法加载」
 * - 爬虫/插件内部异常 → 「源侧执行异常（源站问题）」
 * - 其它原样返回；空串返回空串（调用方自行回退到 `ERROR_MESSAGES`）
 */
export function sanitizeSourceMessage(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (isRuleScriptMessage(trimmed)) return RULE_SCRIPT_MESSAGE;
  if (isJarLinkageMessage(trimmed)) return JAR_CONFLICT_MESSAGE;
  if (isSourceInternalMessage(trimmed)) return SOURCE_INTERNAL_MESSAGE;
  return trimmed;
}

/** 从错误里取出磁力地址（detail 承载原始地址，避免 UI 重新解析） */
export function magnetUrlOf(error: AppErrorShape | null | undefined): string | null {
  if (!error) return null;
  if (isMagnetUrl(error.detail)) return error.detail?.trim() ?? null;
  if (isMagnetUrl(error.message)) return error.message.trim();
  return null;
}

/** 错误 → 分类（唯一口径） */
export function classifySourceFailure(error: AppErrorShape | null | undefined): SourceFailureKind {
  if (!error) return 'unknown';
  const text = `${error.message ?? ''} ${error.detail ?? ''}`;
  if (isMagnetUrl(error.detail) || isMagnetUrl(error.message)) return 'protocol_unsupported';
  // 保护态/配置态优先于内部异常判定（detail 里带 IllegalStateException 等原文）
  if (error.message === SAFE_MODE_MESSAGE || text.includes('safe mode active')) return 'safe_mode';
  if (error.message === QUARANTINE_MESSAGE || /quarantined/i.test(text)) return 'quarantined';
  if (error.message === SPIDER_MISMATCH_MESSAGE) return 'spider_mismatch';
  // F9：jar 依赖冲突是进程内确定性的，必须先于「脚本/内部异常」判定，否则会被归成可重试的 source_internal
  if (isJarLinkageMessage(text) || error.message === JAR_CONFLICT_MESSAGE) return 'jar_conflict';
  if (isRuleScriptMessage(text) || error.message === RULE_SCRIPT_MESSAGE) return 'rule_script';
  if (isSourceInternalMessage(text) || error.message === SOURCE_INTERNAL_MESSAGE) return 'source_internal';

  switch (error.code) {
    case 'E_UNSUPPORTED_FORMAT':
      return 'protocol_unsupported';
    case 'E_TIMEOUT':
      return 'timeout';
    case 'E_KEYWORD_IGNORED':
      return 'keyword_ignored';
    case 'E_PARSE':
      // 解析失败但不像脚本异常：多为源站改版 / 返回结构变化
      return 'source_dead';
    case 'E_AUTH':
    case 'E_HTTP_401':
    case 'E_HTTP_403':
      return 'auth';
    case 'E_NETWORK':
    case 'E_HTTP_404':
    case 'E_HTTP_5XX':
    case 'E_SOURCE_UNAVAILABLE':
    case 'E_NOT_FOUND':
    case 'E_NO_PLAY_URL':
      return 'source_dead';
    default:
      return 'unknown';
  }
}

const GUIDANCE: Record<SourceFailureKind, Omit<SourceFailureGuidance, 'kind'>> = {
  source_dead: {
    title: '源站已失效',
    hint: '该源没有返回可用内容（源站下线、改版或被限制）。换一个源通常最快。',
    actions: ['switch-source', 'retry'],
  },
  timeout: {
    title: '解析超时',
    hint: '源站响应过慢，可能是瞬时拥塞。可以稍后重试，或直接换源。',
    actions: ['retry', 'switch-source'],
  },
  protocol_unsupported: {
    title: MAGNET_MESSAGE,
    hint: '本 App 不做种子下载，需要交给外部下载器/播放器处理。',
    actions: ['external', 'switch-source'],
  },
  rule_script: {
    title: RULE_SCRIPT_MESSAGE,
    hint: '源自带的规则脚本执行失败，属于源站侧问题，本 App 无法修复。建议换源。',
    actions: ['switch-source', 'health-check'],
  },
  source_internal: {
    title: SOURCE_INTERNAL_MESSAGE,
    hint: '爬虫在源站侧执行出错（空指针、结构不符等），本 App 无法修复。建议换源或换线路。',
    actions: ['switch-source', 'switch-line'],
  },
  safe_mode: {
    title: SAFE_MODE_MESSAGE,
    hint: '近期连续崩溃触发了保护，爬虫源与原生播放器被暂停。点顶部提示条「恢复」立即解除；下次稳定启动也会自动退出。',
    actions: ['retry', 'switch-source'],
  },
  quarantined: {
    title: QUARANTINE_MESSAGE,
    hint: '同一爬虫短时间内崩溃 2 次被隔离 7 天（源体检可手动解除）。建议换源播放。',
    actions: ['switch-source', 'health-check'],
  },
  spider_mismatch: {
    title: SPIDER_MISMATCH_MESSAGE,
    hint: '订阅里写的爬虫类名与 jar 内容不符（源配置过期）。单蜘蛛 jar 会自动自愈；仍失败请更新订阅或换源。',
    actions: ['switch-source', 'edit-source'],
  },
  jar_conflict: {
    title: JAR_CONFLICT_MESSAGE,
    hint: '多份爬虫 jar 装了同名的底层库但版本不兼容（源站侧问题），重试无效。建议换源；长期无效可在源管理停用该源。',
    actions: ['switch-source', 'health-check', 'edit-source'],
  },
  auth: {
    title: '源鉴权失败',
    hint: '账号、Token 或访问权限失效。请到源管理更新凭据后重试。',
    actions: ['edit-source', 'switch-source'],
  },
  keyword_ignored: {
    title: KEYWORD_IGNORED_MESSAGE,
    hint: '该源返回的内容与关键词无关（常见于关闭搜索的采集站，会把最新目录当结果）。已过滤，不影响其它源的结果。',
    actions: ['switch-source'],
  },
  unknown: {
    title: '播放失败',
    hint: '解析过程中出现异常。可重试；持续失败请换源或换线路。',
    actions: ['retry', 'switch-source'],
  },
};

/**
 * 判定一段错误是否属于"瞬态可自动重试"类型。
 *
 * 适用场景：guard jar 惰性初始化失败（首次 NPE，第二次热路径成功）、
 * 解析页偶发空结果（E_NO_PLAY_URL）、源站瞬时 5xx/超时。
 * 不适用：鉴权、磁力、DRM、安全模式、隔离、类名不匹配、jar 依赖冲突——这些重试无意义。
 */
export function isTransientFailure(kind: SourceFailureKind): boolean {
  return kind === 'source_internal'
    || kind === 'rule_script'
    || kind === 'timeout'
    || kind === 'source_dead';
}

/** 分类 → 文案与动作 */
export function guidanceOf(error: AppErrorShape | null | undefined): SourceFailureGuidance {
  const kind = classifySourceFailure(error);
  const base = GUIDANCE[kind];
  // 磁力/格式不支持时保留原始标题以外的场景文案（换行源），其余用分类标题
  return { kind, ...base };
}
