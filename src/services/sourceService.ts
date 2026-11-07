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
  TIMEOUT_PROBE_SPIDER_MS,
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

const SUPPORTED_TYPES: readonly SourceType[] = [
  'demo',
  'alist',
  'webdav',
  'jellyfin',
  'site',
  'spider',
  'douban',
];

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

/**
 * 并发受限的批量执行（AC-16：并发上限 3，单源失败不影响其它）
 *
 * OPT-03：传入 `signal` 后，取消会让仍在排队的项立刻停止；
 * 已在飞行中的探测无法中断网络层，但返回后会因 signal 已取消而丢弃结果。
 */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new AppError('E_ABORTED');
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  });
  const all = Promise.all(runners);
  if (!signal) {
    await all;
    return results;
  }
  /**
   * 所有 worker 都在飞行中时，仅靠 runner 循环里的检查要等某个探测返回才会抛错，
   * 取消会「看起来没反应」。这里用 abort 事件与 Promise.race，保证取消立即返回；
   * 未完成的 runner 返回后会在下一次循环检查 signal 并丢弃结果（不写库）。
   * `all` 的后续拒绝已被 race 的处理器接管，不会产生 unhandled rejection。
   */
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new AppError('E_ABORTED'));
      return;
    }
    onAbort = () => reject(new AppError('E_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([all, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
  return results;
}

/**
 * AC-15 / FR-07：探测（健康检查 + 测试连接）统一 3s 超时。
 *
 * 适配器 `probe` 内部的 `httpClient` 调用不传 `timeoutMs`（默认 10s），且多数不透传 AbortSignal，
 * 所以由 `httpClient.withProbeTimeout` 在该源的探测窗口内把默认超时收到 `TIMEOUT_TEST_CONNECTION_MS`
 * 并关闭重试；超时抛 `E_TIMEOUT` → `healthOfError` → `'timeout'` → `HealthBadge` 显示「连接超时」。
 *
 * P0-3：爬虫源探活不止 HTTP（还要下载 jar、加载 dex、初始化防护），3s 窗口会把
 * 「慢网络下的活源」判成不可用；真机实测 92 个源被误标 unreachable 并面临自动禁用。
 * 故按源类型分级：spider 15s，其余保持 3s（AC-15 口径不变）。
 */
export function probeTimeoutOf(source: Source): number {
  return source.type === 'spider' ? TIMEOUT_PROBE_SPIDER_MS : TIMEOUT_TEST_CONNECTION_MS;
}

function probeWithinTimeout<T>(source: Source, run: () => Promise<T>): Promise<T> {
  // 演示源无网络请求（baseUrl 为空），不进窗口，避免误伤其它并发请求
  if (source.baseUrl.length === 0) return run();
  return httpClient.withProbeTimeout(probeTimeoutOf(source), run, source.baseUrl);
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
      // REV-24：地址变化 → 只清 lines/episodes/categories，**保留 media**。
      // 删 media 会让 history/favorites/downloads 全部断链（PlayerView 依赖 mediaRepo.get），
      // 而 media 行本身很小（元数据），保留不影响空间；下次打开详情时 adapter 会用新 baseUrl 重新抓取并覆盖。
      await withTx(['lines', 'episodes', 'categories'], 'readwrite', async (tx) => {
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

  /** 需要优先检测的源 id（当前源 + 默认源）；读取失败不影响检测 */
  async prioritySourceIds(): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      const settings = await settingsService.get();
      if (settings.defaultSourceId) out.add(settings.defaultSourceId);
    } catch {
      // 设置读取失败：仅按默认顺序检测
    }
    return out;
  },

  /**
   * 批量健康检查（AC-16 / AC-107）
   *
   * - 并发上限 `HEALTH_CHECK_CONCURRENCY`（CHG-05 起为 6，不写死）；
   * - 进度事件 `sources:healthProgress`（唯一发送方）：起点 `{0,total}`，每完成一个源（
   *   `markHealth` 之后，成功失败均计）`{n,total}` 严格 +1，终点 `{total,total}`；
   * - `total === 0` 只发一次 `{0,0}`；整体抛错时不发终点事件。
   * - 排序：当前源与默认源优先检测（用户最关心「我正在用的能不能用」），
   *   其余按线路质量档位从好到差；结果每个源完成即写库，源列表实时刷新。
   * - OPT-03：传 `signal` 可取消。取消后立刻抛 `E_ABORTED`，不再为剩余源发起探测；
   *   在飞行中的探测返回后也丢弃结果，不写健康状态、不计进度。
   */
  async checkHealth(
    ids?: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, HealthCheckResult>> {
    if (signal?.aborted) throw new AppError('E_ABORTED');
    const sources = await sourceRepo.list();
    if (signal?.aborted) throw new AppError('E_ABORTED');
    const targets = sources.filter(
      (source) => source.enabled && (ids === undefined || ids.includes(source.id)),
    );
    // 当前源/默认源排最前：最坏耗时按源数动态估算
    // （启用源数 × TIMEOUT_PROBE_SPIDER_MS ÷ HEALTH_CHECK_CONCURRENCY，
    //   183 个冷启 spider ≈ 17.8 分钟），所以 UI 必须给进度并允许取消，
    //   不能再沿用旧的「183 条全量检测要 2 分钟」口径。
    const priorityIds = await this.prioritySourceIds();
    const ordered = [...targets].sort((a, b) => {
      const pa = priorityIds.has(a.id) ? 0 : 1;
      const pb = priorityIds.has(b.id) ? 0 : 1;
      return pa - pb;
    });
    const total = ordered.length;
    let done = 0;
    let lastEmitted = -1;
    /** 进度去重：最后一个源完成时已经发过 {total,total}，终点不再重复发（AC-107 不重不漏） */
    const emitProgress = (value: number): void => {
      if (signal?.aborted) return;
      if (value === lastEmitted) return;
      lastEmitted = value;
      appEvents.emit('sources:healthProgress', { done: value, total });
    };
    emitProgress(0);
    if (total === 0) return {};

    const results = await runWithConcurrency(
      ordered,
      HEALTH_CHECK_CONCURRENCY,
      async (source) => {
        const adapter = sourceRegistry.has(source.type) ? sourceRegistry.get(source.type) : null;
        const checkedAt = Date.now();
        let result: HealthCheckResult;
        if (!adapter) {
          result = {
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
          if (signal?.aborted) throw new AppError('E_ABORTED');
          await sourceService.markHealth(source.id, result.health, result.error);
        } else {
          const connection = await probeWithinTimeout(source, () => adapter.testConnection(source));
          // OPT-03：取消发生在探测期间 → 丢弃这次结果，不落库
          if (signal?.aborted) throw new AppError('E_ABORTED');
          result = {
            sourceId: source.id,
            health: connection.health,
            checkedAt,
            latencyMs: connection.latencyMs,
            error: connection.error,
          };
          await sourceService.markHealth(source.id, result.health, result.error);
        }
        if (signal?.aborted) throw new AppError('E_ABORTED');
        done += 1;
        emitProgress(done);
        return result;
      },
      signal,
    );

    emitProgress(total);

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

  /**
   * 使用即校准（P0-3）：真实调用（browse / detail / resolve / search）成功时，
   * 若当前健康结论不是 ok，就地回写 ok。
   *
   * 为什么需要：体检的探活口径（尤其爬虫 jar 冷启动）与真实链路不完全等价，
   * 一次体检抖动就能让好源长期挂「无法连接」，并叠加 `applyHealthDegradation`
   * 的连续 3 次计数把源自动禁掉。真实调用成功是比探活更强的证据，必须回写。
   *
   * P2-8：'empty' 状态（空壳）不在此处重置——它需要详情有剧集才能恢复，
   * 由 libraryService.refreshDetail 专门处理。
   */
  async noteAlive(sourceId: string): Promise<void> {
    const existing = await sourceRepo.get(sourceId);
    if (!existing || existing.health === 'ok' || existing.health === 'empty') return;
    await sourceService.markHealth(sourceId, 'ok', null);
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
