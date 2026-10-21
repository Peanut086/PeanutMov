/**
 * 源服务（API-03）
 *
 * 责任：CRUD、内置源保护、默认源回退、级联删除、连通性探测与健康标记。
 * 所有写操作成功后发 `sources:changed`；`markHealth` 发 `sources:health`。
 */
import { withTx } from '@/db/index';
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { DEMO_SOURCE_ID, DEMO_SOURCE_SORT, seedDemoData } from '@/data/demo/demoSeed';
import { appEvents } from '@/services/events';
import { settingsService } from '@/services/settingsService';
import {
  HEALTH_CHECK_CONCURRENCY,
  SOURCE_NAME_MAX_LENGTH,
  SOURCE_NAME_MIN_LENGTH,
  TIMEOUT_TEST_CONNECTION_MS,
} from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { newId } from '@/shared/id';
import { isValidHttpUrl, normalizeBaseUrl } from '@/shared/url';
import { httpClient } from '@/sources/base/httpClient';
import { sourceRegistry } from '@/sources/registry';
import type {
  AppErrorShape,
  ConnectionResult,
  HealthCheckResult,
  Source,
  SourceAuth,
  SourceHealth,
  SourceInput,
  SourceType,
} from '@/types';

export interface TestConnectionInput {
  type: SourceType;
  baseUrl: string;
  pathPrefix?: string | null;
  auth?: Partial<SourceAuth> | null;
  headers?: Record<string, string> | null;
  ext?: Record<string, unknown> | null;
}

const SUPPORTED_TYPES: readonly SourceType[] = ['demo', 'alist', 'webdav', 'jellyfin', 'site'];

function normalizeAuth(input: Partial<SourceAuth> | null | undefined): SourceAuth {
  const mode = input?.mode ?? (input?.token ? 'token' : input?.username ? 'basic' : 'none');
  return {
    mode,
    username: input?.username ?? null,
    password: input?.password ?? null,
    token: input?.token ?? null,
  };
}

function normalizeHeaders(input: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    const trimmedKey = key.trim();
    if (trimmedKey.length === 0 || typeof value !== 'string') continue;
    out[trimmedKey] = value;
  }
  return out;
}

/** 手工新增源的 key 生成：`${type}-${id前 8 位}`，冲突时加序号 */
function generateKey(type: SourceType): string {
  return `${type}-${newId().slice(0, 8)}`;
}

async function assertUniqueKey(key: string, exceptId?: string): Promise<void> {
  const existing = await sourceRepo.getByKey(key);
  if (existing && existing.id !== exceptId) {
    throw new AppError('E_INVALID_INPUT', '源标识（key）已存在，请更换');
  }
}

function validateInput(input: SourceInput): {
  name: string;
  type: SourceType;
  baseUrl: string;
  pathPrefix: string | null;
} {
  const name = (input.name ?? '').trim();
  if (name.length < SOURCE_NAME_MIN_LENGTH || name.length > SOURCE_NAME_MAX_LENGTH) {
    throw new AppError('E_INVALID_INPUT', `源名称需为 1-${SOURCE_NAME_MAX_LENGTH} 个字符`);
  }
  if (!SUPPORTED_TYPES.includes(input.type)) {
    throw new AppError('E_INVALID_INPUT', '暂不支持该源类型');
  }
  const rawBase = (input.baseUrl ?? '').trim();
  if (input.type === 'demo') {
    return { name, type: input.type, baseUrl: '', pathPrefix: null };
  }
  if (!isValidHttpUrl(rawBase)) {
    throw new AppError('E_INVALID_INPUT', '源地址必须是 http(s):// 开头的合法地址');
  }
  const pathPrefix = input.pathPrefix ? `/${input.pathPrefix}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '') : null;
  return { name, type: input.type, baseUrl: normalizeBaseUrl(rawBase), pathPrefix };
}

async function emitChange(reason: 'create' | 'update' | 'remove' | 'enable' | 'reorder' | 'default' | 'import' | 'restore'): Promise<void> {
  appEvents.emit('sources:changed', { reason });
}

/** 并发受限的批量执行（AC-16：并发上限 3，单源失败不影响其它） */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * AC-15 / FR-07：探测（健康检查 + 测试连接）统一 3s 超时。
 *
 * 适配器 `probe` 内部的 `httpClient` 调用不传 `timeoutMs`（默认 10s），且多数不透传 AbortSignal，
 * 所以由 `httpClient.withProbeTimeout` 在该源的探测窗口内把默认超时收到 `TIMEOUT_TEST_CONNECTION_MS`
 * 并关闭重试；超时抛 `E_TIMEOUT` → `healthOfError` → `'timeout'` → `HealthBadge` 显示「连接超时」。
 */
function probeWithinTimeout<T>(source: Source, run: () => Promise<T>): Promise<T> {
  // 演示源无网络请求（baseUrl 为空），不进窗口，避免误伤其它并发请求
  if (source.baseUrl.length === 0) return run();
  return httpClient.withProbeTimeout(TIMEOUT_TEST_CONNECTION_MS, run, source.baseUrl);
}

export const sourceService = {
  /** 按 sort 升序，demo 恒最后（仓储已保证） */
  async list(): Promise<Source[]> {
    return sourceRepo.list();
  },

  async get(id: string): Promise<Source | null> {
    return sourceRepo.get(id);
  },

  async create(input: SourceInput): Promise<Source> {
    const valid = validateInput(input);
    if (valid.type === 'demo') {
      throw new AppError('E_INVALID_INPUT', '演示源由系统内置，无需手工新增');
    }
    const now = Date.now();
    const desiredKey = (input.key ?? '').trim() || generateKey(valid.type);
    await assertUniqueKey(desiredKey);

    const source: Source = {
      id: newId(),
      key: desiredKey,
      name: valid.name,
      type: valid.type,
      enabled: input.enabled ?? true,
      builtin: false,
      sort: typeof input.sort === 'number' && Number.isFinite(input.sort) ? input.sort : now,
      baseUrl: valid.baseUrl,
      pathPrefix: valid.pathPrefix,
      auth: normalizeAuth(input.auth),
      headers: normalizeHeaders(input.headers),
      ext: input.ext ?? null,
      subscriptionId: null,
      warning: null,
      health: 'unknown',
      healthCheckedAt: null,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    await sourceRepo.save(source);
    await emitChange('create');
    return source;
  },

  async update(
    id: string,
    patch: Partial<SourceInput> & { enabled?: boolean; sort?: number },
  ): Promise<Source> {
    const existing = await sourceRepo.get(id);
    if (!existing) throw new AppError('E_NOT_FOUND', '源不存在');

    const nextInput: SourceInput = {
      name: patch.name ?? existing.name,
      type: patch.type ?? existing.type,
      baseUrl: patch.baseUrl ?? existing.baseUrl,
      pathPrefix: patch.pathPrefix !== undefined ? patch.pathPrefix : existing.pathPrefix,
    };
    const valid = validateInput(nextInput);
    if (existing.builtin && valid.type !== existing.type) {
      throw new AppError('E_INVALID_INPUT', '内置源的源类型不可修改');
    }

    const connectionChanged =
      valid.baseUrl !== existing.baseUrl ||
      valid.pathPrefix !== existing.pathPrefix ||
      (patch.type !== undefined && patch.type !== existing.type);

    const next: Source = {
      ...existing,
      name: valid.name,
      type: valid.type,
      baseUrl: valid.baseUrl,
      pathPrefix: valid.pathPrefix,
      enabled: patch.enabled ?? existing.enabled,
      sort: typeof patch.sort === 'number' && Number.isFinite(patch.sort) ? patch.sort : existing.sort,
      auth: patch.auth !== undefined ? normalizeAuth(patch.auth) : existing.auth,
      headers: patch.headers !== undefined ? normalizeHeaders(patch.headers) : existing.headers,
      ext: patch.ext !== undefined ? patch.ext : existing.ext,
      warning: patch.name !== undefined || patch.baseUrl !== undefined ? null : existing.warning,
      health: connectionChanged ? 'unknown' : existing.health,
      healthCheckedAt: connectionChanged ? null : existing.healthCheckedAt,
      lastErrorCode: connectionChanged ? null : existing.lastErrorCode,
      updatedAt: Date.now(),
    };
    if (typeof patch.key === 'string' && patch.key.trim().length > 0 && patch.key !== existing.key) {
      await assertUniqueKey(patch.key.trim(), existing.id);
      next.key = patch.key.trim();
    }

    await sourceRepo.save(next);
    if (connectionChanged) {
      // 地址变化 → 清空该源缓存，下次进入媒体库重新拉取（FR-02）
      await withTx(['media', 'lines', 'episodes', 'categories'], 'readwrite', async (tx) => {
        await mediaRepo.removeBySource(id, tx);
        await lineRepo.removeBySource(id, tx);
        await episodeRepo.removeBySource(id, tx);
        await categoryRepo.removeBySource(id, tx);
      });
    }
    await emitChange('update');
    return next;
  },

  async remove(id: string, opts?: { removeDownloads?: boolean }): Promise<void> {
    const existing = await sourceRepo.get(id);
    if (!existing) return;
    if (existing.builtin) {
      throw new AppError('E_INVALID_INPUT', '内置源不可删除，可禁用');
    }

    await withTx(
      ['sources', 'media', 'lines', 'episodes', 'categories', 'favorites', 'downloads'],
      'readwrite',
      async (tx) => {
        await mediaRepo.removeBySource(id, tx);
        await lineRepo.removeBySource(id, tx);
        await episodeRepo.removeBySource(id, tx);
        await categoryRepo.removeBySource(id, tx);
        // 收藏保留快照并标记"源已移除"（AC-35）；历史保留（展示时按源存在性判断）
        const favorites = await tx
          .objectStore('favorites')
          .index('by-source')
          .getAll(IDBKeyRange.only(id));
        for (const record of favorites) {
          await tx.objectStore('favorites').put({ ...record, sourceRemoved: true });
        }
        if (opts?.removeDownloads) {
          await downloadRepo.removeBySource(id, tx);
        }
        await tx.objectStore('sources').delete(id);
      },
    );

    // 默认源被删除：清空设置中的默认源，读取时自动回退
    const settings = await settingsService.get();
    if (settings.defaultSourceId === id) {
      await settingsService.update({ defaultSourceId: null });
    }
    await emitChange('remove');
  },

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const existing = await sourceRepo.get(id);
    if (!existing) throw new AppError('E_NOT_FOUND', '源不存在');
    if (existing.enabled === enabled) return;
    await sourceRepo.save({ ...existing, enabled, updatedAt: Date.now() });
    await emitChange('enable');
  },

  async reorder(orderedIds: string[]): Promise<void> {
    const sources = await sourceRepo.list();
    const byId = new Map(sources.map((source) => [source.id, source]));
    const now = Date.now();
    const updates: Source[] = [];
    let sort = 0;
    for (const id of orderedIds) {
      const source = byId.get(id);
      if (!source) continue;
      if (source.builtin) continue; // 演示源恒为 9999
      updates.push({ ...source, sort, updatedAt: now });
      sort += 1;
    }
    if (updates.length === 0) return;
    await sourceRepo.saveMany(updates);
    await emitChange('reorder');
  },

  async setDefault(id: string | null): Promise<void> {
    if (id !== null) {
      const target = await sourceRepo.get(id);
      if (!target) throw new AppError('E_NOT_FOUND', '源不存在');
    }
    await settingsService.update({ defaultSourceId: id });
    await emitChange('default');
  },

  /** 默认源：设置值有效则用之；否则取第一个启用源（演示源排最后） */
  async getDefault(): Promise<Source | null> {
    const [settings, sources] = await Promise.all([settingsService.get(), sourceRepo.list()]);
    const enabled = sources.filter((source) => source.enabled);
    if (enabled.length === 0) return null;
    if (settings.defaultSourceId) {
      const configured = enabled.find((source) => source.id === settings.defaultSourceId);
      if (configured) return configured;
    }
    return enabled.find((source) => !source.builtin) ?? enabled[0] ?? null;
  },

  async testConnection(input: TestConnectionInput): Promise<ConnectionResult> {
    if (!SUPPORTED_TYPES.includes(input.type)) {
      return {
        ok: false,
        latencyMs: 0,
        health: 'bad_config',
        error: {
          code: 'E_INVALID_INPUT',
          message: '暂不支持该源类型',
          detail: null,
          retryable: false,
          httpStatus: null,
        },
        itemCount: null,
      };
    }
    const now = Date.now();
    const probeSource: Source = {
      id: `probe-${now}`,
      key: `probe-${now}`,
      name: '连接测试',
      type: input.type,
      enabled: true,
      builtin: false,
      sort: 0,
      baseUrl: input.type === 'demo' ? '' : normalizeBaseUrl(input.baseUrl ?? ''),
      pathPrefix: input.pathPrefix ?? null,
      auth: normalizeAuth(input.auth),
      headers: normalizeHeaders(input.headers),
      ext: input.ext ?? null,
      subscriptionId: null,
      warning: null,
      health: 'unknown',
      healthCheckedAt: null,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };

    if (input.type !== 'demo' && !isValidHttpUrl(probeSource.baseUrl)) {
      return {
        ok: false,
        latencyMs: 0,
        health: 'bad_config',
        error: {
          code: 'E_INVALID_INPUT',
          message: '源地址必须是 http(s):// 开头的合法地址',
          detail: null,
          retryable: false,
          httpStatus: null,
        },
        itemCount: null,
      };
    }

    const adapter = sourceRegistry.get(input.type);
    // testConnection 本身不抛错（API-01）；AC-15：探测窗口 3s
    return probeWithinTimeout(probeSource, () => adapter.testConnection(probeSource));
  },

  /** 并发上限 3 的批量健康检查（AC-16） */
  async checkHealth(ids?: string[]): Promise<Record<string, HealthCheckResult>> {
    const sources = await sourceRepo.list();
    const targets = sources.filter(
      (source) => source.enabled && (ids === undefined || ids.includes(source.id)),
    );
    const results = await runWithConcurrency(targets, HEALTH_CHECK_CONCURRENCY, async (source) => {
      const adapter = sourceRegistry.has(source.type) ? sourceRegistry.get(source.type) : null;
      const checkedAt = Date.now();
      if (!adapter) {
        const result: HealthCheckResult = {
          sourceId: source.id,
          health: 'bad_config',
          checkedAt,
          latencyMs: 0,
          error: {
            code: 'E_UNSUPPORTED_FORMAT',
            message: '暂不支持该源类型',
            detail: null,
            retryable: false,
            httpStatus: null,
          },
        };
        await sourceService.markHealth(source.id, result.health, result.error);
        return result;
      }
      const connection = await probeWithinTimeout(source, () => adapter.testConnection(source));
      const result: HealthCheckResult = {
        sourceId: source.id,
        health: connection.health,
        checkedAt,
        latencyMs: connection.latencyMs,
        error: connection.error,
      };
      await sourceService.markHealth(source.id, result.health, result.error);
      return result;
    });

    const map: Record<string, HealthCheckResult> = {};
    for (const result of results) map[result.sourceId] = result;
    return map;
  },

  async markHealth(sourceId: string, health: SourceHealth, error?: AppErrorShape | null): Promise<void> {
    const existing = await sourceRepo.get(sourceId);
    if (!existing) return;
    const now = Date.now();
    await sourceRepo.save({
      ...existing,
      health,
      healthCheckedAt: now,
      lastErrorCode: error?.code ?? null,
      updatedAt: existing.updatedAt,
    });
    appEvents.emit('sources:health', { sourceId, health });
  },

  /** 幂等：确保演示源与演示条目存在（启动时调用） */
  async ensureDemoSource(): Promise<Source> {
    const existing = await sourceRepo.get(DEMO_SOURCE_ID);
    if (existing) {
      // 源已存在但条目可能被清空 → 重新补齐（不重复插入）
      await seedDemoData({ sourceId: DEMO_SOURCE_ID });
      const refreshed = await sourceRepo.get(DEMO_SOURCE_ID);
      if (refreshed) return refreshed;
    }
    return seedDemoData({ sourceId: DEMO_SOURCE_ID });
  },

  /** 恢复演示源：重新启用并补齐条目（AC-97） */
  async restoreDemo(): Promise<Source> {
    const source = await seedDemoData({ sourceId: DEMO_SOURCE_ID, restore: true });
    await emitChange('restore');
    return { ...source, sort: DEMO_SOURCE_SORT };
  },

  /** 供订阅导入等场景批量写入（单事务） */
  async createBatch(sources: Source[]): Promise<void> {
    await withTx(['sources'], 'readwrite', async (tx) => {
      const store = tx.objectStore('sources');
      for (const source of sources) await store.put(source);
    });
    await emitChange('import');
  },

  /** 内部工具：把异常统一成 AppError（供上层复用） */
  toError(e: unknown): AppError {
    return toAppError(e, 'E_DB');
  },
};

export type SourceService = typeof sourceService;
