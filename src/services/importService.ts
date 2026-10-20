/**
 * 导入服务（API-05）
 *
 * - 预览：URL（10s 超时 / 2MB 上限）与文件（.json / 2MB / 非空）；
 * - 提交：单事务写入全部源，失败回滚；支持 skip / overwrite / keep-both。
 */
import { withTx } from '@/db/index';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { appEvents } from '@/services/events';
import { subscriptionParser } from '@/services/subscriptionParser';
import {
  KV_KEY_IMPORT_RECORDS,
  MAX_SUBSCRIPTION_BYTES,
  TIMEOUT_SUBSCRIPTION_FETCH_MS,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { newId, nextKey } from '@/shared/id';
import { isValidHttpUrl } from '@/shared/url';
import { httpClient } from '@/sources/base/httpClient';
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
): Promise<ImportPreview> {
  const preview = subscriptionParser.parse(text, opts);
  return annotateDuplicates(preview);
}

export const importService: ImportService = {
  async previewFromUrl(url: string, signal?: AbortSignal): Promise<ImportPreview> {
    const trimmed = url.trim();
    if (!isValidHttpUrl(trimmed)) {
      throw new AppError('E_INVALID_INPUT', '订阅地址必须是 http(s):// 开头的合法地址');
    }
    const response = await httpClient.requestWithMeta<string>(trimmed, {
      method: 'GET',
      responseType: 'text',
      timeoutMs: TIMEOUT_SUBSCRIPTION_FETCH_MS,
      retries: 0,
      signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });

    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader) {
      const declared = Number.parseInt(lengthHeader, 10);
      if (Number.isFinite(declared) && declared > MAX_SUBSCRIPTION_BYTES) {
        throw new AppError('E_INVALID_INPUT', '订阅内容过大（上限 2MB）');
      }
    }

    const text = response.data ?? '';
    // 用 UTF-8 字节长度判断（中文按 3 字节）
    const bytes = new TextEncoder().encode(text).byteLength;
    if (bytes > MAX_SUBSCRIPTION_BYTES) {
      throw new AppError('E_INVALID_INPUT', '订阅内容过大（上限 2MB）');
    }
    return previewFromRaw(text, { origin: 'url', sourceUrl: trimmed });
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

  async commit(preview: ImportPreview, options: ImportCommitOptions): Promise<ImportResult> {
    const selected = new Set(options.selectedKeys);
    const candidates = preview.entries.filter((entry) => entry.valid && entry.normalized !== null);
    const chosen = candidates.filter((entry) => selected.size === 0 || selected.has(entry.key));
    if (preview.globalIssues.some((item) => item.level === 'error')) {
      throw new AppError('E_INVALID_INPUT', '订阅存在全局错误，无法导入');
    }

    const issues: ImportIssue[] = [];
    let skipped = 0;
    const toWrite: Source[] = [];
    const sourceIds: string[] = [];

    const existingSources = await sourceRepo.list();
    const existingKeys = new Set(existingSources.map((source) => source.key));
    const existingById = new Map(existingSources.map((source) => [source.id, source]));
    const now = Date.now();

    for (const entry of chosen) {
      const normalized = entry.normalized;
      if (!normalized) continue;
      const baseKey = normalized.key ?? entry.key;

      if (entry.duplicateOf) {
        const existing = existingById.get(entry.duplicateOf);
        if (!existing) {
          // 已不存在（预览后删除了）：按新源处理
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
          toWrite.push({
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
          });
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
        for (const source of toWrite) await sourceStore.put(source);
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
