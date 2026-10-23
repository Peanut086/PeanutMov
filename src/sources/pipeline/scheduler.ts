/**
 * 爬虫管道调度器
 *
 * 一次 `crawl()` 的流程：
 *   握手（按规则）→ 传输（保留状态码）→ 指纹 → 规则匹配 → 解析器 → 降级链
 *
 * 设计约束：
 * - **状态码不抛错**：403/429 也要交给规则判断（UA 适配场景），
 *   只有"没有任何规则命中且状态码 ≥400"时才按 `httpClient` 同一映射抛错；
 * - **重试权唯一**：`httpClient` 侧强制 `retries: 0`，退避只由规则 `retry` 决定；
 * - **预算是硬上限**：剩余不足 `MIN_ATTEMPT_MS` 立即停止，不把用户卡在 loading；
 * - **不新增 ErrorCode**：失败复用既有枚举，原因写 `detail`。
 */
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { probeTimeoutFor } from '@/sources/base/httpClient';
import { stripHtml } from '@/sources/base/normalize';
import { toAbsoluteUrl } from '@/shared/url';
import { fingerprintOf } from './fingerprint';
import { tolerantParse } from './jsonTolerant';
import { extractMediaFromPage } from './mediaExtract';
import { indexRules, isStatusAware, matchRule } from './matcher';
import { parserRegistry } from './parserRegistry';
import { defaultRules } from './rules/defaults';
import { statusError, transport } from './transport';
import type {
  AttemptRecord,
  AttemptStep,
  CrawlIntent,
  CrawlParser,
  CrawlRequest,
  CrawlResult,
  CrawlRule,
  Fingerprint,
  HandshakeProfile,
  ParserContext,
  ParserUtils,
} from './types';

/** 降级链最大跳数（防规则环导致的无限尝试） */
const MAX_FALLBACK_DEPTH = 3;
/** 为"再来一次降级"预留的预算 */
const RESERVE_MS = 800;
/** 剩余预算低于此值不再发起新尝试 */
const MIN_ATTEMPT_MS = 500;
/** 单次尝试超时下限 / 上限 */
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 15000;

/** 各意图的默认预算（调用方未显式给 budgetMs 时使用） */
export const DEFAULT_BUDGET_MS: Record<CrawlIntent, number> = {
  subscription: 12000,
  catalog: 8000,
  detail: 8000,
  search: 8000,
  playpage: 10000,
  probe: 3000,
};

/** 解析器可用的纯函数工具集（只读，不发请求） */
const PARSER_UTILS: ParserUtils = {
  tolerantParse: (text) => {
    const result = tolerantParse(text);
    return result ? { value: result.value, relaxed: result.relaxed } : null;
  },
  extractMediaFromPage: (html, pageUrl) => extractMediaFromPage(html, pageUrl),
  toAbsoluteUrl: (base, value) => toAbsoluteUrl(base, value),
  stripHtml: (value) => stripHtml(value) ?? '',
  decodeBase64: (s) => {
    try {
      if (typeof atob === 'function') return atob(s);
      return Buffer.from(s, 'base64').toString('utf8');
    } catch {
      return null;
    }
  },
};

/** 规则集（可被规则包追加；内置规则不可覆盖） */
let activeRules: CrawlRule[] = defaultRules();

/** 显式声明 status 条件的规则 id（4xx/5xx 时只有它们可以命中） */
let statusAwareRuleIds: ReadonlySet<string> = new Set(
  activeRules.filter(isStatusAware).map((rule) => rule.id),
);

/** 替换规则集（规则包加载/测试用） */
export function setRules(rules: readonly CrawlRule[]): void {
  activeRules = [...rules];
  statusAwareRuleIds = new Set(activeRules.filter(isStatusAware).map((rule) => rule.id));
}

/** 读取当前规则集（诊断/测试用） */
export function getRules(): readonly CrawlRule[] {
  return activeRules;
}

export interface CrawlOptions extends Partial<Omit<CrawlRequest, 'intent' | 'url'>> {
  intent: CrawlIntent;
  url: string;
}

interface PlanStep {
  kind: AttemptStep;
  /** 提供握手/UA 变体的规则；`null` 用默认握手 */
  handshakeRule: CrawlRule | null;
  /** 降级步骤：强制使用该规则（不再按指纹匹配） */
  forcedRule: CrawlRule | null;
  variantIndex: number;
}

/** 该意图的默认规则：只用于握手与 UA 变体，解析仍按指纹匹配 */
function baseRuleFor(intent: CrawlIntent): CrawlRule | null {
  const id = intent === 'subscription' ? 'sub.raw' : intent === 'playpage' ? 'playpage.html-media' : 'cms.json';
  return activeRules.find((rule) => rule.id === id) ?? null;
}

function handshakeFor(rule: CrawlRule | null, variantIndex = 0): HandshakeProfile | null {
  if (!rule) return null;
  if (variantIndex === 0) return rule.handshake ?? null;
  return rule.handshakeVariants?.[variantIndex - 1] ?? null;
}

function attemptTimeoutMs(rule: CrawlRule | null, remainingMs: number): number {
  const wanted = rule?.handshake?.timeoutMs ?? 8000;
  const budgetLimited = Math.max(remainingMs - RESERVE_MS, MIN_TIMEOUT_MS);
  return Math.min(Math.max(wanted, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS, budgetLimited);
}

function backoffOf(rule: CrawlRule, attempt: number): number {
  const base = rule.retry.backoffMs[Math.min(attempt - 1, rule.retry.backoffMs.length - 1)] ?? 0;
  const jitter = rule.retry.jitterRatio ?? 0;
  if (base === 0 || jitter === 0) return base;
  const delta = base * jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(base + delta));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AppError('E_ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeRecord(
  step: PlanStep,
  matchedRule: CrawlRule | null,
  parserId: string | null,
  error: AppError | null,
  status: number | null,
  ms: number,
  ok = false,
): AttemptRecord {
  return {
    step: step.kind,
    ruleId: matchedRule?.id ?? null,
    parserId,
    handshakeUa: handshakeFor(step.handshakeRule, step.variantIndex)?.ua ?? null,
    httpStatus: status,
    ok,
    errorCode: error?.code ?? null,
    detail: error?.detail ?? error?.message ?? null,
    ms,
  };
}

/** 本次尝试命中的规则（供重试/降级使用；未命中则保持 null） */
interface AttemptTrace {
  matchedRule: CrawlRule | null;
  status: number | null;
}

interface AttemptOutcome<T> {
  value: T;
  fingerprint: Fingerprint;
  rule: CrawlRule;
  parser: CrawlParser;
  status: number;
}

/** 一次请求 + 指纹 + 规则匹配 + 解析 */
async function attemptOnce<T>(
  step: PlanStep,
  request: CrawlRequest,
  deadline: number,
  trace: AttemptTrace,
): Promise<AttemptOutcome<T>> {
  const remaining = deadline - Date.now();
  const timeoutMs = attemptTimeoutMs(step.handshakeRule, remaining);

  const response = await transport({
    url: request.url,
    intent: request.intent,
    handshake: handshakeFor(step.handshakeRule, step.variantIndex),
    baseHeaders: request.headers,
    timeoutMs,
    signal: request.signal,
    maxBytes: request.maxBytes,
  });
  trace.status = response.status;

  const fingerprint = fingerprintOf({
    status: response.status,
    headers: response.headers,
    text: response.text,
    bytes: response.bytes,
    url: request.url,
    finalUrl: response.finalUrl,
  });

  const matched =
    step.forcedRule ??
    matchRule(activeRules, {
      intent: request.intent,
      fingerprint,
      url: request.url,
      headers: response.headers,
      preferRules: request.preferRules,
      // 4xx/5xx 只允许显式声明 status 条件的规则命中：
      // 否则 `reject.empty` 会把 403/404 的空响应体误判成"格式不支持"
      onlyRules: response.status >= 400 ? statusAwareRuleIds : undefined,
    });

  if (!matched) {
    // 无规则命中：4xx/5xx 按 httpClient 同一映射抛错，2xx 视为格式不支持
    if (response.status >= 400) throw statusError(response.status, response.statusText);
    throw new AppError('E_UNSUPPORTED_FORMAT', '暂不支持该格式', {
      detail: `没有规则匹配该响应（status=${response.status}，mime=${fingerprint.mime || '不可读'}，首字符=${fingerprint.firstChar || '空'}）`,
      retryable: false,
    });
  }
  trace.matchedRule = matched;

  const parser = parserRegistry.require(matched.parser);
  if (!parser.intents.includes(request.intent)) {
    throw new AppError('E_UNSUPPORTED_FORMAT', `解析器 ${parser.id} 不支持 ${request.intent}`);
  }

  const ctx: ParserContext = {
    intent: request.intent,
    url: request.url,
    status: response.status,
    headers: response.headers,
    text: response.text,
    bytes: response.bytes,
    charset: response.charset,
    fingerprint,
    options: matched.parserOptions ?? {},
    signal: request.signal,
    logger: logger.scope('crawler'),
    utils: PARSER_UTILS,
  };

  const value = (await parser.parse(ctx)) as T;
  return { value, fingerprint, rule: matched, parser, status: response.status };
}

/** 调度主入口 */
export async function crawl<T>(options: CrawlOptions): Promise<CrawlResult<T>> {
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS[options.intent];
  const deadline = startedAt + budgetMs;

  const request: CrawlRequest = {
    intent: options.intent,
    url: options.url,
    budgetMs,
    headers: options.headers,
    signal: options.signal,
    preferRules: options.preferRules,
    configHash: options.configHash,
    maxBytes: options.maxBytes,
  };

  const attempts: AttemptRecord[] = [];
  const rulesById = indexRules(activeRules);
  const visitedRules = new Set<string>();
  let lastError: AppError | null = null;

  let step: PlanStep = {
    kind: 'matched',
    handshakeRule: baseRuleFor(options.intent),
    forcedRule: null,
    variantIndex: 0,
  };

  for (let depth = 0; depth < MAX_FALLBACK_DEPTH; depth += 1) {
    if (Date.now() + MIN_ATTEMPT_MS >= deadline) break;

    let retryCount = 0;
    let failedRule: CrawlRule | null = null;
    // 探测窗口内一律不重试、不试 UA 变体（AC-15：3s 上限不能被二次尝试突破）。
    // 按 URL 判定而非 intent：适配器 probe() 走的是 catalog 意图。
    const probeWindow = probeTimeoutFor(request.url) !== null;

    for (;;) {
      if (Date.now() + MIN_ATTEMPT_MS >= deadline) break;

      const trace: AttemptTrace = { matchedRule: null, status: null };
      const attemptStarted = Date.now();

      try {
        const result = await attemptOnce<T>(step, request, deadline, trace);
        attempts.push(
          makeRecord(step, result.rule, result.parser.id, null, result.status, Date.now() - attemptStarted, true),
        );
        return {
          value: result.value,
          ruleId: result.rule.id,
          parserId: result.parser.id,
          fingerprint: result.fingerprint,
          attempts,
          totalMs: Date.now() - startedAt,
        };
      } catch (e) {
        const error = toAppError(e, 'E_PARSE');
        lastError = error;
        // 网络类失败拿不到响应，也就没有指纹匹配结果：退回本步的握手规则做重试判定
        const rule = trace.matchedRule ?? step.forcedRule ?? step.handshakeRule;
        failedRule = rule;
        attempts.push(
          makeRecord(step, rule, rule?.parser ?? null, error, trace.status, Date.now() - attemptStarted),
        );

        if (error.code === 'E_ABORTED') throw error;
        if (!rule) break; // 没有命中规则：无从重试/变体
        if (probeWindow) break; // 探测窗口内不重试

        // UA 变体：仅 403/429，且还有未尝试的变体
        const variantCount = rule.handshakeVariants?.length ?? 0;
        if ((error.code === 'E_HTTP_403' || error.code === 'E_HTTP_429') && step.variantIndex < variantCount) {
          step = { ...step, kind: 'variant', handshakeRule: rule, variantIndex: step.variantIndex + 1 };
          continue;
        }

        // 规则内重试：只对 retryOn 里的 code 且未超 maxAttempts
        if (rule.retry.retryOn.includes(error.code) && retryCount + 1 < rule.retry.maxAttempts) {
          const wait = backoffOf(rule, retryCount + 1);
          if (Date.now() + wait + MIN_ATTEMPT_MS < deadline) {
            retryCount += 1;
            await sleep(wait, request.signal);
            continue;
          }
        }
        break;
      }
    }

    // 降级链：按 fallback 顺序找第一条未尝试过的规则
    const nextId = (failedRule?.fallback ?? []).find((id) => !visitedRules.has(id));
    if (!nextId) break;
    visitedRules.add(nextId);
    const nextRule = rulesById.get(nextId);
    if (!nextRule) break;

    step = { kind: 'fallback', handshakeRule: nextRule, forcedRule: nextRule, variantIndex: 0 };
  }

  const error = lastError ?? new AppError('E_TIMEOUT', undefined, { detail: `管道预算耗尽（${budgetMs}ms）` });
  throw decorateError(error, attempts);
}

/** 在错误 detail 后追加规则/尝试摘要（不改变 code 与 message） */
function decorateError(error: AppError, attempts: AttemptRecord[]): AppError {
  if (attempts.length === 0) return error;
  const trail = attempts.map((a) => `${a.ruleId ?? 'auto'}/${a.errorCode ?? 'ok'}`).join(' → ');
  const detail = error.detail ? `${error.detail}；尝试：${trail}` : `尝试：${trail}`;
  return new AppError(error.code, error.message, {
    detail,
    retryable: error.retryable,
    httpStatus: error.httpStatus,
    cause: error,
  });
}
