/**
 * 订阅解析（API-04，纯函数，无 IO）
 *
 * 支持两种格式（技术方案 7 章）：
 * - 简化格式：`sources[]`，`type` 为字符串；
 * - TVBox 风格：`sites[]`，`type` 为数字。
 *
 * 行为：
 * - 不抛异常：JSON / 结构错误写入 `globalIssues`，`entries = []`；
 * - 单条缺字段 → 该条 `valid:false`，其它条照常可导入；
 * - 命中敏感词 → `warning`（不阻断）；
 * - 同批重复 key → 后者 `valid:false`（`DUPLICATE_KEY`）。
 */
import { MAX_SUBSCRIPTION_SOURCES, SOURCE_NAME_MAX_LENGTH } from '@/shared/constants';
import { isValidHttpUrl, normalizeBaseUrl } from '@/shared/url';
import type {
  ImportIssue,
  ImportOrigin,
  ImportPreview,
  ImportPreviewEntry,
  SourceInput,
  SourceType,
} from '@/types';

export interface ParseOptions {
  origin: ImportOrigin;
  sourceUrl?: string | null;
  fileName?: string | null;
}

export interface SubscriptionParser {
  parse(rawText: string, opts: ParseOptions): ImportPreview;
}

const SENSITIVE_WORDS = /破解|vip|付费|会员|盗版/i;
const WARNING_TEXT = '该源名称包含敏感词，请确认内容来源合法';

const TYPE_MAP: Record<string, SourceType> = {
  alist: 'alist',
  '3': 'alist',
  webdav: 'webdav',
  '4': 'webdav',
  jellyfin: 'jellyfin',
  '5': 'jellyfin',
  site: 'site',
  '0': 'site',
  '1': 'site',
  // TVBox 里 2 也常指 CMS 站点；api 仍需是 http(s) 地址，非 URL 的条目会在下面按 URL_INVALID 跳过
  '2': 'site',
};

function issue(
  level: ImportIssue['level'],
  code: string,
  field: string | null,
  message: string,
): ImportIssue {
  return { level, code, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseExt(value: unknown): { ext: Record<string, unknown> | null; warning: string | null } {
  if (value === null || value === undefined || value === '') return { ext: null, warning: null };
  if (isRecord(value)) return { ext: value, warning: null };
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return { ext: parsed, warning: null };
      return { ext: null, warning: 'ext 不是合法 JSON，已忽略' };
    } catch {
      return { ext: null, warning: 'ext 不是合法 JSON，已忽略' };
    }
  }
  return { ext: null, warning: 'ext 类型不受支持，已忽略' };
}

function mapType(value: unknown): SourceType | null {
  if (typeof value === 'number' && Number.isFinite(value)) return TYPE_MAP[String(value)] ?? null;
  if (typeof value === 'string') return TYPE_MAP[value.trim().toLowerCase()] ?? null;
  return null;
}

function parseHeaders(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === 'string') out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function flagToBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

/**
 * 解析单条 `sites[]` / `sources[]` 条目。
 * index 用于 message 中的"第 N 条"。
 */
function parseEntry(raw: unknown, index: number, seenKeys: Set<string>): ImportPreviewEntry {
  const issues: ImportIssue[] = [];
  const ordinal = `第 ${index + 1} 条`;

  if (!isRecord(raw)) {
    issues.push(issue('error', 'MISSING_FIELD', null, `${ordinal}不是对象`));
    return {
      key: '',
      name: '',
      type: 'unknown',
      baseUrl: '',
      enabled: false,
      selected: false,
      valid: false,
      duplicateOf: null,
      warning: null,
      issues,
      normalized: null,
    };
  }

  const rawKey = typeof raw['key'] === 'string' ? raw['key'].trim() : '';
  const rawName = typeof raw['name'] === 'string' ? raw['name'].trim() : '';
  const rawApi = typeof raw['api'] === 'string' ? raw['api'].trim() : '';
  const type = mapType(raw['type']);

  if (rawKey.length === 0) issues.push(issue('error', 'MISSING_FIELD', 'key', `${ordinal}缺少 key 字段`));
  if (rawName.length === 0) issues.push(issue('error', 'MISSING_FIELD', 'name', `${ordinal}缺少 name 字段`));
  if (rawApi.length === 0) issues.push(issue('error', 'MISSING_FIELD', 'api', `${ordinal}缺少 api 字段`));
  if (type === null) {
    issues.push(
      issue('error', 'TYPE_UNKNOWN', 'type', `${ordinal}源类型不支持（${String(raw['type'] ?? '未填写')}）`),
    );
  }
  if (rawApi.length > 0 && !isValidHttpUrl(rawApi)) {
    issues.push(issue('error', 'URL_INVALID', 'api', `${ordinal}地址不合法（需 http/https）`));
  }
  if (rawName.length > SOURCE_NAME_MAX_LENGTH) {
    issues.push(
      issue('error', 'MISSING_FIELD', 'name', `${ordinal}名称超过 ${SOURCE_NAME_MAX_LENGTH} 字`),
    );
  }

  let duplicateKey = false;
  if (rawKey.length > 0) {
    if (seenKeys.has(rawKey)) {
      duplicateKey = true;
      issues.push(issue('error', 'DUPLICATE_KEY', 'key', `${ordinal}与前面的源 key 重复`));
    } else {
      seenKeys.add(rawKey);
    }
  }

  const extResult = parseExt(raw['ext']);
  const warning = extResult.warning ?? (SENSITIVE_WORDS.test(`${rawName} ${rawKey}`) ? WARNING_TEXT : null);

  const baseUrl = rawApi.length > 0 && isValidHttpUrl(rawApi) ? normalizeBaseUrl(rawApi) : rawApi;
  const searchable = flagToBool(raw['searchable'] ?? raw['search'], true);

  const valid = issues.every((i) => i.level !== 'error') && !duplicateKey;
  const normalized: SourceInput | null =
    valid && type !== null
      ? {
          key: rawKey,
          name: rawName,
          type,
          baseUrl,
          pathPrefix: null,
          auth: null,
          headers: parseHeaders(raw['headers']),
          // ext 解析失败时保持 null（技术方案 7.7）；成功时把 searchable 合入 ext 供适配器读取
          ext: extResult.ext === null ? null : { ...extResult.ext, searchable },
          enabled: true,
        }
      : null;

  return {
    key: rawKey || `entry-${index + 1}`,
    name: rawName || `未命名源 ${index + 1}`,
    type: type ?? 'unknown',
    baseUrl,
    enabled: true,
    selected: valid,
    valid,
    duplicateOf: null,
    warning,
    issues,
    normalized,
  };
}

function emptyPreview(opts: ParseOptions, name: string | null, globalIssues: ImportIssue[]): ImportPreview {
  return {
    origin: opts.origin,
    sourceUrl: opts.sourceUrl ?? null,
    fileName: opts.fileName ?? null,
    fetchedAt: Date.now(),
    name,
    total: 0,
    entries: [],
    globalIssues,
    repos: [],
  };
}

/**
 * 多仓索引识别：顶层 `urls[]`（TVBox 多仓）或整份内容是逐行 URL 的文本。
 * 只做识别与去重，不发起网络请求（展开由 `importService` 负责，保持解析器纯函数）。
 */
function reposOf(payload: unknown, rawText: string): string[] {
  const urlOf = (item: unknown): string => {
    if (typeof item === 'string') return item.trim();
    if (isRecord(item) && typeof item['url'] === 'string') return item['url'].trim();
    return '';
  };
  const collect = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.map(urlOf).filter((item) => item.length > 0 && isValidHttpUrl(item));
  };

  const fromPayload = isRecord(payload) ? collect(payload['urls']) : [];
  const fromText = fromPayload.length > 0 ? fromPayload : collect(rawText.split(/\r?\n/));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of fromText) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** 多仓索引预览：`entries` 为空，仓库列表放 `repos` 交给 UI 选择 */
function reposPreview(opts: ParseOptions, name: string | null, repos: string[]): ImportPreview {
  return {
    origin: opts.origin,
    sourceUrl: opts.sourceUrl ?? null,
    fileName: opts.fileName ?? null,
    fetchedAt: Date.now(),
    name,
    total: 0,
    entries: [],
    globalIssues: [
      issue(
        'info',
        'MULTI_REPO',
        null,
        `这是多仓索引，包含 ${repos.length} 个仓库，请选择其中一个展开`,
      ),
    ],
    repos,
  };
}

export const subscriptionParser: SubscriptionParser = {
  parse(rawText: string, opts: ParseOptions): ImportPreview {
    const text = typeof rawText === 'string' ? rawText.trim() : '';
    if (text.length === 0) {
      return emptyPreview(opts, null, [issue('error', 'PARSE_JSON', null, '内容不是合法 JSON')]);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      // 逐行 URL 的多仓文本（dc.txt）：不是 JSON，但可以展开
      const repos = reposOf(null, text);
      if (repos.length > 0) return reposPreview(opts, null, repos);
      return emptyPreview(opts, null, [issue('error', 'PARSE_JSON', null, '内容不是合法 JSON')]);
    }

    if (!isRecord(payload)) {
      return emptyPreview(opts, null, [issue('error', 'FORMAT_UNSUPPORTED', null, '订阅格式不支持')]);
    }

    const rawList = Array.isArray(payload['sites'])
      ? payload['sites']
      : Array.isArray(payload['sources'])
        ? payload['sources']
        : null;

    const name = typeof payload['name'] === 'string' && payload['name'].trim().length > 0 ? payload['name'].trim() : null;

    if (!rawList) {
      const repos = reposOf(payload, text);
      if (repos.length > 0) return reposPreview(opts, name, repos);
      return emptyPreview(opts, name, [issue('error', 'FORMAT_UNSUPPORTED', null, '订阅格式不支持')]);
    }
    if (rawList.length === 0) {
      return emptyPreview(opts, name, [issue('error', 'EMPTY', null, '订阅中没有任何源')]);
    }
    if (rawList.length > MAX_SUBSCRIPTION_SOURCES) {
      return emptyPreview(opts, name, [
        issue(
          'error',
          'TOO_MANY',
          null,
          `订阅源数量超出上限（${MAX_SUBSCRIPTION_SOURCES}），请分批导入`,
        ),
      ]);
    }

    const seenKeys = new Set<string>();
    const entries = rawList.map((raw, index) => parseEntry(raw, index, seenKeys));
    const globalIssues: ImportIssue[] = [];
    const invalidCount = entries.filter((entry) => !entry.valid).length;
    if (invalidCount > 0) {
      globalIssues.push(
        issue('warning', 'PARTIAL', null, `${invalidCount} 个源存在问题，将被跳过，其余源可正常导入`),
      );
    }

    return {
      origin: opts.origin,
      sourceUrl: opts.sourceUrl ?? null,
      fileName: opts.fileName ?? null,
      fetchedAt: Date.now(),
      name,
      total: entries.length,
      entries,
      globalIssues,
      repos: [],
    };
  },
};

/** 测试/调试辅助：把 type 数字映射暴露出来 */
export function mapSourceType(value: unknown): SourceType | null {
  return mapType(value);
}
