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
  | 'cooldown'
  | 'spider_mismatch'
  | 'jar_conflict'
  | 'auth'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'no_play_url'
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
/**
 * P0-1：短时冷却——崩过一次但当场没有 tombstone 实锤，只拦半小时，不进隔离名单。
 * 原生抛的原文是 `spider cooling down (…)`（见 SpiderPlugin.spiderBlockMessage），
 * 分类认 `cooling down` 关键字，两边措辞要一起改。
 */
export const COOLDOWN_MESSAGE = '该爬虫刚崩过一次，短时冷却中';
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
 * `JsonSyntaxException: Expected BEGIN_OBJECT but was STRING`、
 * `SQLiteCantOpenDatabaseException: Cannot open database '.../databases/tv' ... doesn't exist`
 * （jar 按 TVBox 宿主约定去开宿主的 `databases/tv`，本 App 不建这个库；真机里每次 jar 加载后
 * 成对出现、D 级、jar 自己接住——属源侧环境缺失噪音，不能据此判源死）。
 */
export function isSourceInternalMessage(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return (
    /\b(NullPointerException|ArrayIndexOutOfBoundsException|IndexOutOfBoundsException|ClassCastException|IllegalStateException|IllegalArgumentException|JsonSyntaxException|NumberFormatException|NoSuchMethodError|NoSuchFieldError|ClassNotFoundException|InvocationTargetException|SQLiteCantOpenDatabaseException|SQLiteException)\b/.test(
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
 * 判定上游是否在说「你请求太快了」。
 *
 * P1-2 要求把限流从「源站已失效」里分出来：429 的正确反应是等一等或换线路，
 * 而不是判源死、更不是立刻重试——立刻重试只会把限流坐实。
 * 词表收 `Retry-After`（上游给了等待时长，是最硬的信号）与各家中英写法。
 */
export function isRateLimitedMessage(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return (
    /retry[-_ ]?after|too many requests|rate ?limit(ed)?|请求过于频繁|访问频率|操作频繁|频率过高|触发.{0,4}限流|被限流/i.test(
      raw,
    ) || /\bHTTP\s*429\b|\bstatus[\"']?\s*[:=]\s*429\b/i.test(raw)
  );
}

/**
 * 判定上游是否在说「接口额度用完了」。
 *
 * 真机现象：解析接口弹出「本接口免费使用…」一类提示，App 却把它当源失效处理。
 * 这类文案既不是鉴权（改凭据没用），也不是瞬时故障（重试没用），只能换解析接口/线路。
 *
 * 词表刻意收窄：用 `免费使用` 而不是 `免费`——导出日志里 72 处「免费」全是订阅名
 * （`…免费资源`），宽一格就会把正常源判成额度耗尽。`上限/次数` 同样只认与额度连用的写法。
 */
export function isQuotaExhaustedMessage(raw: string | null | undefined): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  return (
    /额度|配额|quota|余额不足|免费使用|请充值|付费.{0,4}(开通|使用|解锁)|升级.{0,4}(会员|套餐|版本)|试用(已|结束|到期)|次数已?(用完|耗尽|超限|达.{0,4}上限)|超出.{0,4}(次数|限额|上限)|接口.{0,6}(收费|付费|额度)|exceed.{0,8}(quota|limit)|no (available )?(quota|credits?)/i.test(
      raw,
    ) ||
    // 业务码形态：只在响应体里说额度问题、没有 HTTP 状态可依据的常见值
    /["']?code["']?\s*[:=]\s*["']?(?:40001|40002|40003|42900|42901)["']?/i.test(raw)
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
  // P0-1：冷却不是隔离——到点自动放行，也不进隔离名单。混在一起说会让用户去解一份没有记录的隔离。
  if (error.message === COOLDOWN_MESSAGE || /cooling down/i.test(text)) return 'cooldown';
  if (error.message === SPIDER_MISMATCH_MESSAGE) return 'spider_mismatch';
  // F9：jar 依赖冲突是进程内确定性的，必须先于「脚本/内部异常」判定，否则会被归成可重试的 source_internal
  if (isJarLinkageMessage(text) || error.message === JAR_CONFLICT_MESSAGE) return 'jar_conflict';
  if (isRuleScriptMessage(text) || error.message === RULE_SCRIPT_MESSAGE) return 'rule_script';
  if (isSourceInternalMessage(text) || error.message === SOURCE_INTERNAL_MESSAGE) return 'source_internal';

  // P1-2：HTTP 状态比错误码和文案都硬，先按状态分档（401/403 改凭据、429 等一等）
  if (error.httpStatus === 429) return 'rate_limited';
  if (error.httpStatus === 401 || error.httpStatus === 403) return 'auth';

  switch (error.code) {
    case 'E_UNSUPPORTED_FORMAT':
      return 'protocol_unsupported';
    case 'E_TIMEOUT':
      return 'timeout';
    case 'E_KEYWORD_IGNORED':
      return 'keyword_ignored';
    // P1-2：401/403 与 429 是三种不同处置（改凭据 / 等一等 / 换接口），不能都算源失效
    case 'E_HTTP_429':
      return 'rate_limited';
    case 'E_AUTH':
    case 'E_HTTP_401':
    case 'E_HTTP_403':
      return 'auth';
    default:
      break;
  }
  // 到这里只剩「内容/网络类」和未登记码。上游的额度与限流常常只在 msg 里说、
  // 不给独立错误码，所以在读代码之前先读文案；文案也没有才落到下面的档位。
  const business = businessNoticeKind(text);
  if (business) return business;
  switch (error.code) {
    case 'E_NO_PLAY_URL':
      return 'no_play_url';
    case 'E_PARSE':
      // 解析失败但不像脚本异常：多为源站改版 / 返回结构变化
      return 'source_dead';
    case 'E_NETWORK':
    case 'E_HTTP_404':
    case 'E_HTTP_5XX':
    case 'E_SOURCE_UNAVAILABLE':
    case 'E_NOT_FOUND':
      return 'source_dead';
    default:
      return 'unknown';
  }
}

/**
 * P1-2：没有独立错误码时，从上游文案里读「限流」或「额度用尽」。
 *
 * 两种都不是重试或改凭据能解决的，所以不进 `isTransientFailure`；
 * 判定顺序先限流后额度：`请求过于频繁` 与 `额度` 同时出现时，等一等比换接口更省事。
 */
function businessNoticeKind(text: string): SourceFailureKind | null {
  if (isRateLimitedMessage(text)) return 'rate_limited';
  if (isQuotaExhaustedMessage(text)) return 'quota_exhausted';
  return null;
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
    hint: '同一爬虫 24 小时内崩 2 次，或原生崩溃实锤落在整个 jar 上，会被隔离 7 天（健康中心可手动解除）。建议换源播放。',
    actions: ['switch-source', 'health-check'],
  },
  cooldown: {
    title: COOLDOWN_MESSAGE,
    hint: '这个爬虫在进程崩溃时正在加载，但当场没有原生崩溃实锤，所以只短时冷却半小时，到点自动放行（健康中心的「冷却中」可立即放行）。先换源看，不必去解一份不存在的隔离。',
    actions: ['switch-source', 'health-check', 'retry'],
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
  rate_limited: {
    title: '请求过于频繁，被限流了',
    hint: '上游明确说这一阵子请求太多（HTTP 429 / Retry-After）。立刻重试只会续上限，等一会儿再试或先换源；已取消这次请求，不占用爬虫线程。',
    actions: ['retry', 'switch-source'],
  },
  quota_exhausted: {
    title: '接口额度已用完',
    hint: '解析接口/网盘接口返回了额度类提示（如「本接口免费使用…」）。这不是源失效，也不是登录问题：换一条解析接口或换一个源才有效，改凭据没用。',
    actions: ['switch-line', 'switch-source', 'edit-source'],
  },
  no_play_url: {
    title: '该线路没有返回播放地址',
    hint: '源里能看到这一集，但线路没吐出可播地址（常见于线路失效或需要另一条解析）。换条线路通常立刻能播。',
    actions: ['switch-line', 'retry', 'switch-source'],
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
  return (
    kind === 'source_internal'
    || kind === 'rule_script'
    || kind === 'timeout'
    || kind === 'source_dead'
    // P1-2：`no_play_url` 是从 `source_dead` 里分出来的（E_NO_PLAY_URL 一直按瞬态重试一次），
    // 只是档位变了，重试语义不变——收紧它会让解析页偶发空结果变成永久失败。
    || kind === 'no_play_url'
  );
}

/** 分类 → 文案与动作 */
export function guidanceOf(error: AppErrorShape | null | undefined): SourceFailureGuidance {
  const kind = classifySourceFailure(error);
  const base = GUIDANCE[kind];
  // 磁力/格式不支持时保留原始标题以外的场景文案（换行源），其余用分类标题
  return { kind, ...base };
}
