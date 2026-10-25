/**
 * 导入服务（API-05）
 *
 * - 预览：URL（10s 超时 / 2MB 上限）与文件（.json / 2MB / 非空）；
 * - 提交：单事务写入全部源，失败回滚；支持 skip / overwrite / keep-both。
 *
 * `ImportResult` 口径（CHG-03，AC-13）：
 * - `success`：本次真正写入的条目数（含 overwrite 更新、keep-both 新建）；
 * - `skipped`：**未被写入**的条目数，包含两类：
 *   ① 预览阶段即判定无效（`!valid` 或 `normalized === null`）的条目；
 *   ② 与已有源重复且 `onDuplicate === 'skip'` 的条目；
 * - `failed`：逐条写入失败数（单事务模式下写入失败会整体抛错，正常恒为 0）；
 * - `issues`：无效条目以一条汇总 `info`（`SKIPPED_INVALID`）表达，重复条目逐条
 *   `SKIPPED_DUPLICATE` 表达。
 *
 * 不变量：`success + skipped + failed + 未勾选的合法条目 = preview.total`。
 * 即"预览共 N 个源 / 可导入 M 个"与提交结果可对账（M = success + 重复但被覆盖/保留的条目）。
 * `skipped` 不包含"合法但用户未勾选"的条目——那是用户主动排除，不是跳过。
 */
import { withTx } from '@/db/index';
import { sourceRepo, toStorableSource } from '@/db/repositories/sourceRepo';
import { appEvents } from '@/services/events';
import { probeJarUrls } from '@/services/jarProbe';
import { subscriptionParser } from '@/services/subscriptionParser';
import { extractTvboxLives } from '@/sources/live/liveParsers';
import {
  HTML_SNIFF_MAX_CANDIDATES,
  KV_KEY_IMPORT_RECORDS,
  MAX_SUBSCRIPTION_BYTES,
  TIMEOUT_SUBSCRIPTION_FETCH_MS,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { newId, nextKey } from '@/shared/id';
import { isValidHttpUrl } from '@/shared/url';
import { normalizeImportUrl } from '@/shared/urlNormalize';
import { crawl } from '@/sources/pipeline/scheduler';
import { detectCmsApiPayload, detectLiveList } from '@/sources/pipeline/detectors';
import type { HtmlLandingResult, SubscriptionText } from '@/sources/pipeline/parsers';
import { kvRepo } from '@/db/repositories/kvRepo';
import type {
  ImportCommitOptions,
  ImportIssue,
  ImportPreview,
  ImportPreviewEntry,
  ImportResult,
  Source,
} from '@/types';

export interface ImportService {
  previewFromUrl(
    url: string,
    signal?: AbortSignal,
    opts?: { jarPrecheck?: boolean },
  ): Promise<ImportPreview>;
  /** 多仓索引展开：拉取其中一个仓库地址的源列表 */
  previewFromRepo(repoUrl: string, signal?: AbortSignal): Promise<ImportPreview>;
  previewFromText(text: string, fileName: string): Promise<ImportPreview>;
  previewFromFile(file: File): Promise<ImportPreview>;
  commit(preview: ImportPreview, options: ImportCommitOptions): Promise<ImportResult>;
  refreshSubscription: typeof refreshSubscriptionImpl;
}

export interface ImportRecord {
  url: string;
  name: string | null;
  importedAt: number;
  success: number;
}

async function readImportRecords(): Promise<ImportRecord[]> {
  const records = await kvRepo.get<ImportRecord[]>(KV_KEY_IMPORT_RECORDS);
  return Array.isArray(records) ? records : [];
}

async function appendImportRecord(record: ImportRecord): Promise<void> {
  const existing = await readImportRecords();
  const next = [record, ...existing.filter((item) => item.url !== record.url)].slice(0, 20);
  await kvRepo.set(KV_KEY_IMPORT_RECORDS, next);
}

/** 把"与现有源重复"的条目补上 `duplicateOf`（parser 只做同批去重） */
async function annotateDuplicates(preview: ImportPreview): Promise<ImportPreview> {
  const existing = await sourceRepo.list();
  const byKey = new Map(existing.map((source) => [source.key, source]));
  const byNameUrl = new Map(existing.map((source) => [`${source.name}::${source.baseUrl}`, source]));

  const entries = preview.entries.map((entry) => {
    if (!entry.valid || entry.normalized === null) return entry;
    const match =
      byKey.get(entry.normalized.key ?? entry.key) ??
      byNameUrl.get(`${entry.normalized.name}::${entry.normalized.baseUrl}`) ??
      null;
    if (!match) return entry;
    return { ...entry, duplicateOf: match.id };
  });
  return { ...preview, entries };
}

async function previewFromRaw(
  text: string,
  opts: { origin: 'url' | 'file'; sourceUrl?: string | null; fileName?: string | null },
  signal?: AbortSignal,
  precheckOpts?: { jarPrecheck?: boolean },
): Promise<ImportPreview> {
  const parsed = subscriptionParser.parse(text, opts);
  // CHG-13：顺带提取 TVBox lives[] 直播源（导入成功后由 UI 添加到直播页）
  const parsedPreview: ImportPreview = { ...parsed, lives: extractTvboxLives(text) };
  // v1.7/CHG-18：非订阅内容兜底建议（直播列表 / 单流 / CMS 采集接口）
  const preview = attachSuggestions(parsedPreview, text, opts.sourceUrl ?? null);
  const annotated = await annotateDuplicates(preview);
  if (precheckOpts?.jarPrecheck === false) return annotated;
  return precheckSpiderJars(annotated, signal);
}

/* ---------- 爬虫 jar 预检（CHG-10；探测逻辑抽取至 jarProbe 供评测复用） ---------- */

/** 提取爬虫条目的 jar 地址；非爬虫 jar 条目返回 null */
function spiderJarUrlOf(entry: ImportPreviewEntry): string | null {
  if (entry.type !== 'spider' || !entry.valid || !entry.normalized) return null;
  const ext = entry.normalized.ext as { kind?: unknown; jarUrl?: unknown } | null;
  if (!ext || ext.kind !== 'jar' || typeof ext.jarUrl !== 'string' || ext.jarUrl.length === 0) {
    return null;
  }
  return ext.jarUrl;
}

/**
 * 并发 HEAD jar（同一 jar 地址共享结果），判死的条目取消默认勾选并追加警示。
 * 实测 4k.json 类订阅大半 jar 已 403 / 域名失效，预览时可见，导入后不再反复失败。
 */
async function precheckSpiderJars(preview: ImportPreview, signal?: AbortSignal): Promise<ImportPreview> {
  const targets = preview.entries.filter((entry) => spiderJarUrlOf(entry) !== null);
  if (targets.length === 0) return preview;

  const verdicts = await probeJarUrls(
    targets.map((entry) => spiderJarUrlOf(entry) as string),
    signal,
  );

  const entries = preview.entries.map((entry) => {
    const jarUrl = spiderJarUrlOf(entry);
    if (!jarUrl) return entry;
    const result = verdicts.get(jarUrl);
    if (!result || result.verdict !== 'dead') return entry;
    return {
      ...entry,
      selected: false,
      warning: [entry.warning, `jar 不可达（${result.detail ?? '请求失败'}），导入后无法浏览`]
        .filter(Boolean)
        .join('；'),
    };
  });
  return { ...preview, entries };
}

/* ---------- v1.7/CHG-18：URL 归一化变体 + 落地页嗅探拉取 ---------- */

type SubscriptionFetchValue = SubscriptionText | HtmlLandingResult;

export interface SubscriptionFetch {
  text: string;
  /** 响应是 HTML 落地页且嗅探到同域候选配置链接；其余为 null */
  htmlCandidates: string[] | null;
}

async function crawlSubscription(
  variantUrl: string,
  signal: AbortSignal | undefined,
  budgetMs: number,
): Promise<SubscriptionFetch> {
  const { value } = await crawl<SubscriptionFetchValue>({
    intent: 'subscription',
    url: variantUrl,
    signal,
    budgetMs,
    headers: { Accept: 'application/json, text/plain, */*' },
    maxBytes: MAX_SUBSCRIPTION_BYTES,
  });
  if ('kind' in value && value.kind === 'html-landing') {
    return { text: value.text, htmlCandidates: value.candidates };
  }
  return { text: value.text, htmlCandidates: null };
}

/** 网络类失败才继续换变体；HTTP 4xx/5xx / 格式错误说明资源本身有问题 */
function isRetryableVariantError(e: unknown): boolean {
  const code = e instanceof AppError ? e.code : null;
  return code === 'E_NETWORK' || code === 'E_TIMEOUT';
}

/**
 * 拉取订阅文本（默认 10s 预算 / 2MB 上限），URL 预览与多仓展开共用。
 *
 * v1.7/CHG-18 拉取顺序（全部共享同一预算）：
 *   ① 首选地址（GitHub raw 自带镜像回退；gh-proxy 前缀地址失败先剥前缀直连）
 *   ② `normalizeImportUrl` 变体（CDN 互换、重写后地址等）
 *
 * 走爬虫管道：指纹 + 规则决定"这是 JSON / 纯文本 URL 列表 / 直播列表 / HTML 落地页"，
 * 并按 BOM → header → 探测解码字符集（GBK 站点不再乱码）。
 * 失败时抛出带用户文案的 `AppError`（文案由规则里的解析器决定）。
 */
async function fetchSubscriptionText(
  url: string,
  signal?: AbortSignal,
  budgetOverrideMs?: number,
): Promise<SubscriptionFetch> {
  const trimmed = url.trim();
  if (!isValidHttpUrl(trimmed)) {
    throw new AppError('E_INVALID_INPUT', '订阅地址必须是 http(s):// 开头的合法地址');
  }

  const normalized = normalizeImportUrl(trimmed);
  const deadline = Date.now() + (budgetOverrideMs ?? TIMEOUT_SUBSCRIPTION_FETCH_MS);

  let lastError: unknown;
  try {
    const { value } = await withGithubMirrorFallback(
      normalized.url,
      (variantUrl) => crawlSubscription(variantUrl, signal, Math.max(2000, deadline - Date.now())),
      signal,
    );
    return value;
  } catch (e) {
    lastError = e;
    if (!isRetryableVariantError(e) || signal?.aborted) throw e;
  }

  for (const variant of normalized.variants) {
    if (signal?.aborted) throw lastError;
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    try {
      return await crawlSubscription(variant, signal, remaining);
    } catch (e) {
      if (!isRetryableVariantError(e)) throw e;
      lastError = e;
    }
  }
  throw lastError;
}

/** 把 URL 归一化提示追加为 info issue（不改预览结构） */
function withNotes(preview: ImportPreview, notes: string[]): ImportPreview {
  if (notes.length === 0) return preview;
  return {
    ...preview,
    globalIssues: [
      ...preview.globalIssues,
      ...notes.map((message) => ({ level: 'info' as const, code: 'URL_NORMALIZED', field: null, message })),
    ],
  };
}

/**
 * v1.7/CHG-18：内容不是普通订阅时给出可操作建议（纯函数，URL 与文件导入共用）。
 * 仅当没有可导入条目/仓库/直播时才兜底判定，payload 需要可寻址 URL。
 */
function attachSuggestions(preview: ImportPreview, text: string, payloadUrl: string | null): ImportPreview {
  if (payloadUrl === null) return preview;
  if (preview.entries.length > 0 || preview.repos.length > 0 || preview.lives.length > 0) return preview;
  if (preview.suggestions && preview.suggestions.length > 0) return preview;

  const live = detectLiveList(text);
  if (live) {
    return {
      ...preview,
      suggestions:
        live.kind === 'single-stream'
          ? [{ kind: 'single-stream', action: 'add-channel', payload: payloadUrl }]
          : [{ kind: 'live-list', action: 'add-live', payload: payloadUrl, channelCount: live.channelCount }],
    };
  }
  if (detectCmsApiPayload(text)) {
    return { ...preview, suggestions: [{ kind: 'cms-api', action: 'add-site', payload: payloadUrl }] };
  }
  return preview;
}

export const importService: ImportService = {
  async previewFromUrl(
    url: string,
    signal?: AbortSignal,
    opts?: { jarPrecheck?: boolean },
  ): Promise<ImportPreview> {
    const trimmed = url.trim();
    const normalized = normalizeImportUrl(trimmed);
    const fetched = await fetchSubscriptionText(trimmed, signal);

    // v1.7/CHG-18：落地页候选跟进——同域 ≤3 条，首个产出有效内容的胜出
    if (fetched.htmlCandidates !== null) {
      const candidates = fetched.htmlCandidates.slice(0, HTML_SNIFF_MAX_CANDIDATES);
      let lastError: unknown = new AppError(
        'E_UNSUPPORTED_FORMAT',
        '该地址返回的不是订阅 JSON，可能是网页地址或已被拦截',
        { detail: 'HTML 落地页内未发现可用的配置链接', retryable: false },
      );
      for (const candidate of candidates) {
        try {
          const sub = await fetchSubscriptionText(candidate, signal);
          if (sub.htmlCandidates !== null) continue; // 候选又是落地页：不递归
          const preview = await previewFromRaw(sub.text, { origin: 'url', sourceUrl: trimmed }, signal, opts);
          if (preview.entries.length > 0 || preview.repos.length > 0 || preview.lives.length > 0) {
            return withNotes(preview, [
              `已从落地页发现的配置链接导入：${candidate}`,
              ...normalized.notes,
            ]);
          }
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError;
    }

    const preview = await previewFromRaw(fetched.text, { origin: 'url', sourceUrl: trimmed }, signal, opts);
    return withNotes(preview, normalized.notes);
  },

  /** 展开多仓索引中的一个仓库地址，返回该仓库的源预览 */
  async previewFromRepo(repoUrl: string, signal?: AbortSignal): Promise<ImportPreview> {
    const fetched = await fetchSubscriptionText(repoUrl, signal);
    return previewFromRaw(fetched.text, { origin: 'url', sourceUrl: repoUrl.trim() }, signal);
  },

  async previewFromText(text: string, fileName: string): Promise<ImportPreview> {
    if (text.trim().length === 0) {
      throw new AppError('E_INVALID_INPUT', '文件内容为空');
    }
    return previewFromRaw(text, { origin: 'file', fileName });
  },

  async previewFromFile(file: File): Promise<ImportPreview> {
    if (!/\.json$/i.test(file.name)) {
      throw new AppError('E_INVALID_INPUT', '仅支持 JSON 文件');
    }
    if (file.size > MAX_SUBSCRIPTION_BYTES) {
      throw new AppError('E_INVALID_INPUT', '文件过大（上限 2MB）');
    }
    if (file.size === 0) {
      throw new AppError('E_INVALID_INPUT', '文件内容为空');
    }
    const text = await file.text();
    if (text.trim().length === 0) {
      throw new AppError('E_INVALID_INPUT', '文件内容为空');
    }
    return previewFromRaw(text, { origin: 'file', fileName: file.name });
  },

  refreshSubscription: refreshSubscriptionImpl,

  /**
   * 提交导入（单事务）。
   *
   * `selectedKeys` 语义（CHG-03）：
   * - **空数组 = 导入全部有效项**（等价于"全选"）；非空 = 仅导入 key 命中的条目。
   * - 该约定是给"程序化调用"用的便捷语义；UI 侧的"全选/全不选"必须自行区分：
   *   `ImportSubscriptionView` 在 `importableCount === 0` 时直接返回、按钮置灰，
   *   因此"一个都没勾选但存在有效项"不会走到这里被误当全量导入。新增调用方需遵守同一约束。
   * - 合法但未被勾选的条目既不计 `success` 也不计 `skipped`（用户主动排除，不是"跳过"）。
   *
   * `skipped` 口径见文件头注释：预览无效 + 重复源（skip 策略）。
   */
  async commit(preview: ImportPreview, options: ImportCommitOptions): Promise<ImportResult> {
    const selected = new Set(options.selectedKeys);
    const invalidEntries = preview.entries.filter((entry) => !entry.valid || entry.normalized === null);
    const candidates = preview.entries.filter((entry) => entry.valid && entry.normalized !== null);
    const chosen = selected.size === 0 ? candidates : candidates.filter((entry) => selected.has(entry.key));
    if (preview.globalIssues.some((item) => item.level === 'error')) {
      throw new AppError('E_INVALID_INPUT', '订阅存在全局错误，无法导入');
    }
    // CHG-11：新建源也归一到「订阅来源标识」（URL / 文件名）
    const subscriptionId = preview.sourceUrl ?? preview.fileName ?? null;

    const issues: ImportIssue[] = [];
    let skipped = 0;
    const toWrite: Source[] = [];
    const sourceIds: string[] = [];

    // ① 预览阶段即无效的条目：无法写入，如实计入 `skipped`（AC-13 口径统一）
    if (invalidEntries.length > 0) {
      skipped += invalidEntries.length;
      const names = invalidEntries.map((entry) => entry.name || entry.key || '未命名源');
      const head = names.slice(0, 3).join('、');
      const suffix = names.length > 3 ? ` 等 ${names.length} 个源` : '';
      issues.push({
        level: 'info',
        code: 'SKIPPED_INVALID',
        field: null,
        message: `${names.length} 个源配置无效，未提交：${head}${suffix}`,
      });
    }

    const existingSources = await sourceRepo.list();
    const existingKeys = new Set(existingSources.map((source) => source.key));
    const existingById = new Map(existingSources.map((source) => [source.id, source]));
    const existingByKey = new Map(existingSources.map((source) => [source.key, source]));
    const now = Date.now();

    for (const entry of chosen) {
      const normalized = entry.normalized;
      if (!normalized) continue;
      const baseKey = normalized.key ?? entry.key;

      if (entry.duplicateOf) {
        const existing = existingById.get(entry.duplicateOf);
        if (!existing) {
          // 已不存在（预览后删除了）：按新源处理，但 key 可能被其它源占用
          if (existingKeys.has(baseKey)) {
            const holder = existingByKey.get(baseKey);
            if (options.onDuplicate === 'skip') {
              skipped += 1;
              issues.push({
                level: 'info',
                code: 'SKIPPED_DUPLICATE',
                field: 'key',
                message: `${entry.name} 的 key 已存在，已跳过`,
              });
              continue;
            }
            if (options.onDuplicate === 'overwrite' && holder) {
              toWrite.push(mergeIntoExisting(holder, entry, preview, now));
              sourceIds.push(holder.id);
              continue;
            }
            const key = nextKey(baseKey, existingKeys);
            existingKeys.add(key);
            const created = buildSource(entry, key, now, subscriptionId);
            toWrite.push(created);
            sourceIds.push(created.id);
            continue;
          }
          const created = buildSource(entry, baseKey, now, subscriptionId);
          toWrite.push(created);
          sourceIds.push(created.id);
          existingKeys.add(created.key);
          continue;
        }
        if (options.onDuplicate === 'skip') {
          skipped += 1;
          issues.push({
            level: 'info',
            code: 'SKIPPED_DUPLICATE',
            field: 'key',
            message: `${entry.name} 已存在，已跳过`,
          });
          continue;
        }
        if (options.onDuplicate === 'overwrite') {
          toWrite.push(mergeIntoExisting(existing, entry, preview, now));
          sourceIds.push(existing.id);
          continue;
        }
        // keep-both
        const key = nextKey(baseKey, existingKeys);
        existingKeys.add(key);
        const created = buildSource(entry, key, now, subscriptionId);
        toWrite.push(created);
        sourceIds.push(created.id);
        continue;
      }

      let key = baseKey;
      if (existingKeys.has(key)) {
        if (options.onDuplicate === 'skip') {
          skipped += 1;
          issues.push({
            level: 'info',
            code: 'SKIPPED_DUPLICATE',
            field: 'key',
            message: `${entry.name} 的 key 已存在，已跳过`,
          });
          continue;
        }
        if (options.onDuplicate === 'overwrite') {
          // 预览未标注重复但 key 已被占用（预览后新增/重复提交同一份预览）：
          // 同样按覆盖处理，否则会写入重复 key 触发唯一索引约束（E_DB）
          const existing = existingByKey.get(key);
          if (existing) {
            toWrite.push(mergeIntoExisting(existing, entry, preview, now));
            sourceIds.push(existing.id);
            continue;
          }
        }
        if (options.onDuplicate === 'keep-both') {
          key = nextKey(key, existingKeys);
        }
      }
      existingKeys.add(key);
      const created = buildSource(entry, key, now, subscriptionId);
      toWrite.push(created);
      sourceIds.push(created.id);
    }

    if (toWrite.length === 0) {
      return { success: 0, skipped, failed: 0, sourceIds: [], issues };
    }

    const overwrittenIds = toWrite.filter((s) => existingById.has(s.id)).map((s) => s.id);
    try {
      await withTx(['sources', 'media', 'lines', 'episodes', 'categories'], 'readwrite', async (tx) => {
        const sourceStore = tx.objectStore('sources');
        // 预览对象来自 Vue 响应式状态，ext/headers 可能是 Proxy，
        // 结构化克隆会抛 DataCloneError，写入前必须还原成纯值
        for (const source of toWrite) await sourceStore.put(toStorableSource(source));
        for (const sourceId of overwrittenIds) {
          // overwrite：清空该源缓存（FR-04）
          const mediaKeys = await tx
            .objectStore('media')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of mediaKeys) await tx.objectStore('media').delete(key);
          const lineKeys = await tx
            .objectStore('lines')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of lineKeys) await tx.objectStore('lines').delete(key);
          const epKeys = await tx
            .objectStore('episodes')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of epKeys) await tx.objectStore('episodes').delete(key);
          const catKeys = await tx
            .objectStore('categories')
            .index('by-source')
            .getAllKeys(IDBKeyRange.only(sourceId));
          for (const key of catKeys) await tx.objectStore('categories').delete(key);
        }
      });
    } catch (e) {
      const error = toAppError(e, 'E_DB');
      throw error;
    }

    if (preview.sourceUrl) {
      await appendImportRecord({
        url: preview.sourceUrl,
        name: preview.name,
        importedAt: Date.now(),
        success: toWrite.length,
      }).catch(() => undefined);
    }

    appEvents.emit('sources:changed', { reason: 'import' });
    return { success: toWrite.length, skipped, failed: 0, sourceIds, issues };
  },
};

/** 覆盖策略：保留原 `id`/`key`/`createdAt`，用订阅里的配置更新可变字段（FR-04） */
function mergeIntoExisting(
  existing: Source,
  entry: ImportPreviewEntry,
  preview: ImportPreview,
  now: number,
): Source {
  const normalized = entry.normalized;
  if (!normalized) return existing;
  return {
    ...existing,
    name: normalized.name,
    type: normalized.type,
    baseUrl: normalized.baseUrl,
    pathPrefix: normalized.pathPrefix ?? existing.pathPrefix,
    auth: normalized.auth
      ? {
          mode: normalized.auth.mode ?? 'none',
          username: normalized.auth.username ?? null,
          password: normalized.auth.password ?? null,
          token: normalized.auth.token ?? null,
        }
      : existing.auth,
    headers: normalized.headers ?? existing.headers,
    ext: normalized.ext ?? existing.ext,
    enabled: true,
    subscriptionId: preview.sourceUrl ?? preview.fileName ?? existing.subscriptionId,
    warning: entry.warning,
    updatedAt: now,
  };
}

function buildSource(
  entry: ImportPreviewEntry,
  key: string,
  now: number,
  subscriptionId: string | null,
): Source {
  const normalized = entry.normalized;
  if (!normalized) throw new AppError('E_INVALID_INPUT');
  return {
    id: newId(),
    key,
    name: normalized.name,
    type: normalized.type,
    enabled: normalized.enabled ?? true,
    builtin: false,
    sort: now,
    baseUrl: normalized.baseUrl,
    pathPrefix: normalized.pathPrefix ?? null,
    auth: {
      mode: normalized.auth?.mode ?? 'none',
      username: normalized.auth?.username ?? null,
      password: normalized.auth?.password ?? null,
      token: normalized.auth?.token ?? null,
    },
    headers: normalized.headers ?? {},
    ext: normalized.ext ?? null,
    // CHG-11：subscriptionId 统一为「订阅来源标识」（URL / 文件名），
    // 与 mergeIntoExisting 口径一致，供订阅管理按来源聚合（此前误写 entry.key）
    subscriptionId,
    warning: entry.warning,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 读取历史导入记录（"检查更新"入口使用） */
export async function listImportRecords(): Promise<ImportRecord[]> {
  return readImportRecords();
}

/** 刷新订阅实现（挂在 importService 上，见对象字面量） */
async function refreshSubscriptionImpl(
  url: string,
  signal?: AbortSignal,
): Promise<{ updated: number; newCount: number; jarDead: number }> {
  const preview = await importService.previewFromUrl(url, signal);
  const valid = preview.entries.filter((entry) => entry.valid && entry.normalized !== null);
  const jarDead = valid.filter((entry) => (entry.warning ?? '').includes('jar 不可达')).length;
  // 只覆盖已有源：勾选 = 有效 && 预检未判死 && 已存在（duplicateOf 指向现有源 id）
  const updateKeys = valid.filter((entry) => entry.selected && entry.duplicateOf).map((entry) => entry.key);
  const result = await importService.commit(preview, { selectedKeys: updateKeys, onDuplicate: 'overwrite' });
  const newCount = valid.filter((entry) => entry.selected && !entry.duplicateOf).length;
  return { updated: result.success, newCount, jarDead };
}
