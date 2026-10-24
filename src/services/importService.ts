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
import { subscriptionParser } from '@/services/subscriptionParser';
import {
  KV_KEY_IMPORT_RECORDS,
  MAX_SUBSCRIPTION_BYTES,
  TIMEOUT_SUBSCRIPTION_FETCH_MS,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { newId, nextKey } from '@/shared/id';
import { isNative } from '@/shared/platform';
import { isValidHttpUrl } from '@/shared/url';
import { httpClient } from '@/sources/base/httpClient';
import { crawl } from '@/sources/pipeline/scheduler';
import type { SubscriptionText } from '@/sources/pipeline/parsers';
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
  previewFromUrl(url: string, signal?: AbortSignal): Promise<ImportPreview>;
  /** 多仓索引展开：拉取其中一个仓库地址的源列表 */
  previewFromRepo(repoUrl: string, signal?: AbortSignal): Promise<ImportPreview>;
  previewFromText(text: string, fileName: string): Promise<ImportPreview>;
  previewFromFile(file: File): Promise<ImportPreview>;
  commit(preview: ImportPreview, options: ImportCommitOptions): Promise<ImportResult>;
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
): Promise<ImportPreview> {
  const preview = subscriptionParser.parse(text, opts);
  const annotated = await annotateDuplicates(preview);
  return precheckSpiderJars(annotated, signal);
}

/* ---------- 爬虫 jar 预检（CHG-10）：导入前筛掉死源 ---------- */

const JAR_CHECK_CONCURRENCY = 6;
const JAR_CHECK_TIMEOUT_MS = 3000;

/** 提取爬虫条目的 jar 地址；非爬虫 jar 条目返回 null */
function spiderJarUrlOf(entry: ImportPreviewEntry): string | null {
  if (entry.type !== 'spider' || !entry.valid || !entry.normalized) return null;
  const ext = entry.normalized.ext as { kind?: unknown; jarUrl?: unknown } | null;
  if (!ext || ext.kind !== 'jar' || typeof ext.jarUrl !== 'string' || ext.jarUrl.length === 0) {
    return null;
  }
  return ext.jarUrl;
}

/** HEAD 结论不确定（不据此判死）：超时可能是慢网络；Web 端网络错可能是 CORS 假阳性；405/501 不支持 HEAD */
function jarCheckInconclusive(e: AppError): boolean {
  if (e.code === 'E_TIMEOUT') return true;
  if (!isNative() && (e.code === 'E_NETWORK' || e.httpStatus === null)) return true;
  return e.httpStatus === 405 || e.httpStatus === 501;
}

/**
 * 并发 HEAD jar（同一 jar 地址共享结果），判死的条目取消默认勾选并追加警示。
 * 实测 4k.json 类订阅大半 jar 已 403 / 域名失效，预览时可见，导入后不再反复失败。
 */
async function precheckSpiderJars(preview: ImportPreview, signal?: AbortSignal): Promise<ImportPreview> {
  const targets = preview.entries.filter((entry) => spiderJarUrlOf(entry) !== null);
  if (targets.length === 0) return preview;

  /** jar 地址 → 判定 + 失败原因（dead 时用于警示文案） */
  const verdicts = new Map<string, { verdict: 'ok' | 'dead' | 'unknown'; detail?: string }>();
  const uniqueUrls = [...new Set(targets.map((entry) => spiderJarUrlOf(entry) as string))];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(JAR_CHECK_CONCURRENCY, uniqueUrls.length) }, async () => {
      while (cursor < uniqueUrls.length) {
        const jarUrl = uniqueUrls[cursor++]!;
        const url = jarUrl.split(';')[0] ?? jarUrl; // `;md5;hash` 后缀由原生侧解析，HTTP 须剥掉
        try {
          await httpClient.request(url, {
            method: 'HEAD',
            responseType: 'none',
            timeoutMs: JAR_CHECK_TIMEOUT_MS,
            retries: 0,
            signal,
          });
          verdicts.set(jarUrl, { verdict: 'ok' });
        } catch (e) {
          const err = toAppError(e, 'E_NETWORK');
          if (jarCheckInconclusive(err)) {
            verdicts.set(jarUrl, { verdict: 'unknown' });
          } else {
            verdicts.set(jarUrl, { verdict: 'dead', detail: err.detail ?? err.message });
          }
        }
      }
    }),
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

/**
 * 拉取订阅文本（10s 超时 / 2MB 上限），URL 预览与多仓展开共用。
 *
 * 走爬虫管道：指纹 + 规则决定"这是 JSON / 纯文本 URL 列表 / 图片伪装"，
 * 并按 BOM → header → 探测解码字符集（GBK 站点不再乱码）。
 * 失败时抛出带用户文案的 `AppError`（文案由规则里的解析器决定）。
 */
async function fetchSubscriptionText(url: string, signal?: AbortSignal): Promise<string> {
  const trimmed = url.trim();
  if (!isValidHttpUrl(trimmed)) {
    throw new AppError('E_INVALID_INPUT', '订阅地址必须是 http(s):// 开头的合法地址');
  }

  const result = await crawl<SubscriptionText>({
    intent: 'subscription',
    url: trimmed,
    signal,
    budgetMs: TIMEOUT_SUBSCRIPTION_FETCH_MS,
    headers: { Accept: 'application/json, text/plain, */*' },
    maxBytes: MAX_SUBSCRIPTION_BYTES,
  });

  const text = result.value.text;

  // 兜底：管道按字节校验过，这里再按 UTF-8 编码长度确认一次（中文按 3 字节）
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > MAX_SUBSCRIPTION_BYTES) {
    throw new AppError('E_INVALID_INPUT', '订阅内容过大（上限 2MB）');
  }
  return text;
}

export const importService: ImportService = {
  async previewFromUrl(url: string, signal?: AbortSignal): Promise<ImportPreview> {
    const text = await fetchSubscriptionText(url, signal);
    return previewFromRaw(text, { origin: 'url', sourceUrl: url.trim() }, signal);
  },

  /** 展开多仓索引中的一个仓库地址，返回该仓库的源预览 */
  async previewFromRepo(repoUrl: string, signal?: AbortSignal): Promise<ImportPreview> {
    const text = await fetchSubscriptionText(repoUrl, signal);
    return previewFromRaw(text, { origin: 'url', sourceUrl: repoUrl.trim() }, signal);
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
            const created = buildSource(entry, key, now);
            toWrite.push(created);
            sourceIds.push(created.id);
            continue;
          }
          const created = buildSource(entry, baseKey, now);
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
        const created = buildSource(entry, key, now);
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
      const created = buildSource(entry, key, now);
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

function buildSource(entry: ImportPreviewEntry, key: string, now: number): Source {
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
    subscriptionId: entry.key,
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
