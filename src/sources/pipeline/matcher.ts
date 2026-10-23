/**
 * 规则匹配器（纯函数，无 IO）
 *
 * 语义：
 * - 候选规则按 `priority` 升序、同优先级按声明顺序；
 * - `when.all` 全满足 且 `when.any` 至少一条满足 且 `when.not` 全不满足；
 * - `terminal` 只终止"继续匹配"，不终止降级链；
 * - 正则只在 8KB 前缀上跑，且加载期已校验长度与嵌套量词。
 */
import { getHost } from '@/shared/url';
import type {
  ConditionField,
  ConditionOp,
  CrawlIntent,
  CrawlRule,
  Fingerprint,
  MatchCondition,
} from './types';

/** 正则长度上限（防止灾难性回溯） */
export const MAX_PATTERN_LENGTH = 200;

/** 嵌套量词特征：组内已有量词，组本身再被量词修饰（如 `(\w+)+`、`(a*)*`） */
const NESTED_QUANTIFIER = /\([^()]*[*+][^()]*\)[*+{]/;

/** 正则是否安全（长度 + 嵌套量词） */
export function isSafePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) return false;
  return !NESTED_QUANTIFIER.test(pattern);
}

/** 编译正则；不安全或语法错误返回 null */
export function compilePattern(pattern: string, flags?: string): RegExp | null {
  if (!isSafePattern(pattern)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function fieldValue(field: ConditionField, fp: Fingerprint, url: string, headers: Headers): unknown {
  switch (field) {
    case 'status':
      return fp.status;
    case 'contentType':
      return fp.contentType;
    case 'mime':
      return fp.mime;
    case 'charset':
      return fp.charset;
    case 'bodyPrefix':
      return fp.prefix;
    case 'bodyRegex':
      return fp.prefix;
    case 'magic':
      return fp.magic;
    case 'json.hasKey':
      return fp.jsonKeys;
    case 'json.isArray':
      return fp.looksLikeJson && fp.firstChar === '[';
    case 'looksLike.json':
      return fp.looksLikeJson;
    case 'looksLike.xml':
      return fp.looksLikeXml;
    case 'looksLike.html':
      return fp.looksLikeHtml;
    case 'looksLike.image':
      return fp.looksLikeImage;
    case 'looksLike.empty':
      return fp.empty;
    case 'header':
      return headers;
    case 'host':
      return safeHost(url);
    case 'finalHost':
      return fp.finalHost;
    case 'url':
      return url;
    default:
      return undefined;
  }
}

function safeHost(url: string): string | null {
  try {
    return getHost(url);
  } catch {
    return null;
  }
}

function asStringList(value: MatchCondition['value']): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

function compareString(
  actual: string | null,
  op: ConditionOp,
  expected: MatchCondition['value'],
  flags?: string,
): boolean {
  if (actual === null) return op === 'neq' ? true : false;
  const list = asStringList(expected);
  switch (op) {
    case 'eq':
      return list.length > 0 && actual === list[0];
    case 'neq':
      return list.length === 0 || actual !== list[0];
    case 'in':
      return list.includes(actual);
    case 'contains':
      return list.some((item) => actual.includes(item));
    case 'notContains':
      return list.every((item) => !actual.includes(item));
    case 'regex': {
      // flags 在条件对象上，不混进 value 数组
      const pattern = typeof expected === 'string' ? expected : String(list[0] ?? '');
      const re = compilePattern(pattern, flags);
      return re !== null && re.test(actual);
    }
    case 'exists':
      return actual.length > 0;
    default:
      return false;
  }
}

function compareNumber(actual: number, op: ConditionOp, expected: MatchCondition['value']): boolean {
  const list = asStringList(expected).map((v) => Number(v));
  switch (op) {
    case 'eq':
      return list.length > 0 && actual === list[0];
    case 'neq':
      return list.length === 0 || actual !== list[0];
    case 'in':
      return list.includes(actual);
    case 'gte':
      return list.length > 0 && actual >= list[0]!;
    default:
      return false;
  }
}

function compareBoolean(actual: boolean, op: ConditionOp, expected: MatchCondition['value']): boolean {
  const expectedBool = typeof expected === 'boolean' ? expected : String(expected) === 'true';
  if (op === 'eq') return actual === expectedBool;
  if (op === 'neq') return actual !== expectedBool;
  return false;
}

/** 单条件求值 */
export function evaluateCondition(cond: MatchCondition, fp: Fingerprint, url: string, headers: Headers): boolean {
  if (cond.field === 'header') {
    const name = cond.name ?? '';
    if (name.length === 0) return false;
    const value = headers.get(name);
    if (cond.op === 'exists') return value !== null && value.length > 0;
    return compareString(value, cond.op, cond.value, cond.flags);
  }

  const actual = fieldValue(cond.field, fp, url, headers);

  if (cond.field === 'json.hasKey') {
    const keys = Array.isArray(actual) ? (actual as string[]) : [];
    const expected = asStringList(cond.value);
    switch (cond.op) {
      case 'exists':
        return expected.every((key) => keys.includes(key));
      case 'eq':
        return expected.length > 0 && keys.includes(expected[0]!);
      case 'in':
        return expected.some((key) => keys.includes(key));
      default:
        return false;
    }
  }

  if (typeof actual === 'number') return compareNumber(actual, cond.op, cond.value);
  if (typeof actual === 'boolean') return compareBoolean(actual, cond.op, cond.value);
  return compareString(typeof actual === 'string' ? actual : null, cond.op, cond.value, cond.flags);
}

/** 整条规则的 when 求值 */
export function matchesWhen(rule: CrawlRule, fp: Fingerprint, url: string, headers: Headers): boolean {
  const { all, any, not } = rule.when;
  if (all && !all.every((cond) => evaluateCondition(cond, fp, url, headers))) return false;
  if (any && any.length > 0 && !any.some((cond) => evaluateCondition(cond, fp, url, headers))) return false;
  if (not && not.some((cond) => evaluateCondition(cond, fp, url, headers))) return false;
  return true;
}

export interface MatchInput {
  intent: CrawlIntent;
  fingerprint: Fingerprint;
  url: string;
  headers: Headers;
  /** 单源覆盖：这些规则 id 提优先级 */
  preferRules?: readonly string[];
  /**
   * 只考虑这些规则（用于 4xx/5xx：只允许显式声明 `status` 条件的规则命中，
   * 否则 `reject.empty` 之类的规则会把 403/404 误判成"格式不支持"）。
   */
  onlyRules?: ReadonlySet<string>;
}

/** 规则是否显式声明了 `status` 条件（错误状态码下只有这类规则可以命中） */
export function isStatusAware(rule: CrawlRule): boolean {
  const conditions = [...(rule.when.all ?? []), ...(rule.when.any ?? []), ...(rule.when.not ?? [])];
  return conditions.some((cond) => cond.field === 'status');
}

/** 命中即返回；`terminal` 只影响是否继续评估，不在这里体现 */
export function matchRule(rules: readonly CrawlRule[], input: MatchInput): CrawlRule | null {
  const candidates = rules.filter(
    (rule) => rule.intent.includes(input.intent) && (!input.onlyRules || input.onlyRules.has(rule.id)),
  );
  const prefer = new Set(input.preferRules ?? []);
  const sorted = candidates
    .map((rule, index) => ({ rule, index }))
    .sort((a, b) => {
      const pa = prefer.has(a.rule.id) ? a.rule.priority - 1000 : a.rule.priority;
      const pb = prefer.has(b.rule.id) ? b.rule.priority - 1000 : b.rule.priority;
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    });

  for (const { rule } of sorted) {
    if (matchesWhen(rule, input.fingerprint, input.url, input.headers)) return rule;
  }
  return null;
}

/** 按 id 建索引（降级链查找） */
export function indexRules(rules: readonly CrawlRule[]): Map<string, CrawlRule> {
  const map = new Map<string, CrawlRule>();
  for (const rule of rules) map.set(rule.id, rule);
  return map;
}
