/**
 * 源适配管道（crawler pipeline）类型
 *
 * 把原先写死在 `SiteAdapter.parsePayload` / `subscriptionParser` / `playPageResolver`
 * 里的"取响应 → 判断格式 → 解析"流程，抽象为可扩展的规则驱动管道：
 *
 *   调用方 → crawl() → 指纹 → 规则匹配 → 解析器 → 结果
 *
 * 约束（与 SCF 冻结契约的关系）：
 * - 本文件是管道私有类型，**不进** `src/types/index.ts`（契约冻结）；
 * - 只复用既有 `ErrorCode`，不新增枚举值；失败原因写 `detail`；
 * - 规则与缓存存 `kv` store，**不升** `DB_VERSION`。
 */
import type { ErrorCode } from '@/types';
import type { Logger } from '@/shared/logger';

/** 管道意图：一次 crawl 的目的是什么（决定默认规则与握手参数） */
export type CrawlIntent = 'subscription' | 'catalog' | 'detail' | 'search' | 'playpage' | 'probe';

export const CRAWL_INTENTS: readonly CrawlIntent[] = [
  'subscription',
  'catalog',
  'detail',
  'search',
  'playpage',
  'probe',
];

/* ---------- 指纹 ---------- */

/** 顶层 JSON 键的分类命中（用于判定 TVBox 形状） */
export interface FingerprintShape {
  json: boolean;
  jsonArray: boolean;
  html: boolean;
  xml: boolean;
  textUrlList: boolean;
  empty: boolean;
}

/** 图片魔数判定（不信 Content-Type，看文件头字节） */
export type MagicKind = 'bmp' | 'png' | 'jpeg' | 'gif' | null;

/**
 * 结构指纹：只含"结构"特征，不含易变内容（列表条目、时间戳、byteLength），
 * 否则同源的列表一变化缓存即失效。
 */
export interface Fingerprint {
  status: number;
  /** 原始 Content-Type；跨域不可读时为 null */
  contentType: string | null;
  /** 归一化主类型，如 `application/json`；不可读时为空串 */
  mime: string;
  charset: string | null;
  /** 已解码正文前 8KB（匹配与正则只在这里跑，限制回溯成本） */
  prefix: string;
  /** 去空白后首字符：`{` `[` `<` `h` … */
  firstChar: string;
  /** 首字符是 JSON 开头的可能性（词法层，未真正 parse） */
  looksLikeJson: boolean;
  /** 首字符是 XML 声明的可能性 */
  looksLikeXml: boolean;
  /** 首字符是 HTML 标签/doctype 的可能性 */
  looksLikeHtml: boolean;
  /** 顶层 JSON 键的廉价词法扫描结果（不 parse 前缀，避免截断误判） */
  jsonKeys: string[];
  magic: MagicKind;
  /** 是否包含图片魔数 */
  looksLikeImage: boolean;
  /** 空正文（去空白后无内容） */
  empty: boolean;
  /** 少量 header 信号（跨域下多数不可读，只能作为 any 条件之一） */
  headerHints: {
    cfRay: boolean;
    server: string | null;
    retryAfterSec: number | null;
  };
  /** 是否跨 host 跳转（fetch 只能读到最终 url） */
  redirected: boolean;
  finalHost: string | null;
  /** 结构哈希：status|mime|firstChar|json|xml|html|image|sorted(jsonKeys) */
  hash: string;
}

/* ---------- 解码 ---------- */

/** 解码结果：文本 + 实际使用的字符集（诊断用） */
export interface DecodedBody {
  text: string;
  charset: string;
}

/* ---------- 规则 ---------- */

/** 解析器 id（开放字符串，便于插件注册自定义 id） */
export type ParserId = string;

/** 规则的来源：内置 / 规则包 / 单源覆盖 */
export type RuleSource = 'builtin' | 'pack' | 'user';

export type ConditionField =
  | 'status'
  | 'contentType'
  | 'mime'
  | 'charset'
  | 'bodyPrefix'
  | 'bodyRegex'
  | 'magic'
  | 'json.hasKey'
  | 'json.isArray'
  | 'looksLike.json'
  | 'looksLike.xml'
  | 'looksLike.html'
  | 'looksLike.image'
  | 'looksLike.empty'
  | 'header'
  | 'host'
  | 'finalHost'
  | 'url';

export type ConditionOp = 'eq' | 'neq' | 'in' | 'contains' | 'notContains' | 'regex' | 'exists' | 'gte';

export interface MatchCondition {
  field: ConditionField;
  op: ConditionOp;
  value: string | number | boolean | Array<string | number>;
  /** regex 专用 */
  flags?: string;
  /** header 条件专用，如 'server' | 'cf-ray' | 'retry-after' */
  name?: string;
}

/** 规则的匹配条件：`all` 全满足 且 `any` 至少一条满足 且 `not` 全不满足 */
export interface MatchWhen {
  all?: MatchCondition[];
  any?: MatchCondition[];
  not?: MatchCondition[];
}

export interface RetryPolicy {
  /** 含首次；1 = 不重试 */
  maxAttempts: number;
  /** 第 n 次失败取 backoffMs[n-1]，末尾复用最后一项 */
  backoffMs: number[];
  /** 只有这些 code 才重试 */
  retryOn: ErrorCode[];
  /** ±比例抖动，避免多源同时重试形成尖峰 */
  jitterRatio?: number;
}

/** 握手参数：按规则可覆写 UA/Accept/超时/重定向 */
export interface HandshakeProfile {
  ua?: string;
  accept?: string;
  extraHeaders?: Record<string, string>;
  /** 单次尝试超时，实际值 = min(此值, 剩余预算) */
  timeoutMs?: number;
  /** 'follow'（默认）| 'error'；不用 'manual'：跨域只会拿到 opaqueredirect，读不到 body */
  redirect?: 'follow' | 'error';
}

export interface CrawlRule {
  id: string;
  /** 升序，越小越优先；同优先级按数组声明顺序稳定 */
  priority: number;
  intent: CrawlIntent[];
  when: MatchWhen;
  parser: ParserId;
  parserOptions?: Record<string, unknown>;
  /** 降级链：本规则失败后按序尝试的规则 id（运行期最多 3 跳） */
  fallback?: string[];
  /** 命中即不再评估更低优先级规则；不终止降级链 */
  terminal?: boolean;
  retry: RetryPolicy;
  handshake?: HandshakeProfile;
  /** 仅在 403/429 时依次尝试的 UA 变体，最多 2 个，防止把源打挂 */
  handshakeVariants?: HandshakeProfile[];
  cost?: 'cheap' | 'normal' | 'expensive';
  source?: RuleSource;
  version?: number;
}

/** 规则包：按导入顺序追加，不允许覆盖内置规则 */
export interface RulePack {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  rules: CrawlRule[];
}

/* ---------- 解析器 ---------- */

/** 解析器上下文：`text` 已按 charset 解码，`parsedJson` 若已解析过则复用 */
export interface ParserContext {
  intent: CrawlIntent;
  url: string;
  status: number;
  headers: Headers;
  /** 已解码正文（≤2MB） */
  text: string;
  /** 原始响应字节（供 text.charset 这类需要重解码的解析器使用） */
  bytes: Uint8Array;
  charset: string;
  parsedJson?: unknown;
  fingerprint: Fingerprint;
  options: Record<string, unknown>;
  signal: AbortSignal | undefined;
  logger: Logger;
  /** 受限工具集：只读纯函数，禁止在 parser 内发请求 */
  utils: ParserUtils;
}

/** 解析器可用的纯函数工具集 */
export interface ParserUtils {
  tolerantParse: (text: string) => { value: unknown; relaxed: 'none' | 'comments' | 'wrapped' | 'both' } | null;
  extractMediaFromPage: (html: string, pageUrl: string) => Array<{ url: string; rank: number }>;
  toAbsoluteUrl: (base: string, value: string | null | undefined) => string | null;
  stripHtml: (value: string | null | undefined) => string;
  decodeBase64: (s: string) => string | null;
}

export interface CrawlParser<TOut = unknown> {
  readonly id: ParserId;
  readonly version: number;
  /** 能力声明，加载时校验规则是否越界使用 */
  readonly intents: readonly CrawlIntent[];
  parse(ctx: ParserContext): TOut | Promise<TOut>;
}

export interface ParserRegistry {
  register(parser: CrawlParser): void;
  /** 未注册 → `E_UNSUPPORTED_FORMAT` */
  require(id: ParserId): CrawlParser;
  has(id: ParserId): boolean;
  list(): CrawlParser[];
}

/* ---------- 结果与诊断 ---------- */

export type AttemptStep = 'cached' | 'matched' | 'fallback' | 'variant';

export interface AttemptRecord {
  step: AttemptStep;
  ruleId: string | null;
  parserId: ParserId | null;
  handshakeUa: string | null;
  httpStatus: number | null;
  ok: boolean;
  errorCode: ErrorCode | null;
  detail: string | null;
  ms: number;
}

export interface CrawlResult<T> {
  value: T;
  ruleId: string;
  parserId: ParserId;
  fingerprint: Fingerprint;
  attempts: AttemptRecord[];
  totalMs: number;
}

/** 一次 crawl 的输入（不含 URL，URL 单独传） */
export interface CrawlRequest {
  intent: CrawlIntent;
  url: string;
  /** 总预算（毫秒），调度器在此内完成所有尝试 */
  budgetMs: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 单源覆盖的规则 id（提优先级用） */
  preferRules?: readonly string[];
  /** 源配置指纹：变化时策略缓存立即失效 */
  configHash?: string;
  /** 响应体字节上限（订阅链路用，超限抛 `E_INVALID_INPUT`） */
  maxBytes?: number;
}
