/**
 * 源 Store（API-14）
 *
 * 只暴露契约中列出的 state/getters/actions；所有写操作经 `sourceService` 落库后刷新内存。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { sourceService } from '@/services/sourceService';
import { healthService } from '@/services/healthService';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import { liveService } from '@/services/liveService';
import { appEvents } from '@/services/events';
import { sourceRegistry } from '@/sources/registry';
import { logger } from '@/shared/logger';
import { toAppError, toErrorShape, isCanceled } from '@/shared/errors';
import type { AppErrorShape, Source, SourceInput, SubscriptionSummary } from '@/types';

/** 批量治理并发上限（183 源场景下避免 N 次串行阻塞 UI） */
const BATCH_CONCURRENCY = 4;

/** 并发受限执行；单项失败不中断批量，返回失败数（OPT-03 / FIX-01） */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  let cursor = 0;
  let done = 0;
  let failed = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      try {
        await worker(item);
      } catch (e) {
        failed += 1;
        logger.warn('批量操作单项失败', e);
      }
      done += 1;
      onProgress?.(done, items.length);
    }
  });
  await Promise.all(runners);
  return failed;
}

/** `testConnection` 的 UI 投影（不暴露 health/itemCount 等枚举细节） */
export interface TestConnectionFeedback {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

/** 批量测速进度（CHG-05 / API-14）：`done / total`，未开始或已结束为 null */
export interface HealthProgress {
  done: number;
  total: number;
}

export const useSourceStore = defineStore('source', () => {
  const sources = ref<Source[]>([]);
  const currentSourceId = ref<string | null>(null);
  const loading = ref(false);
  const healthChecking = ref(false);
  /** 批量测速进度（CHG-05）：由 `sources:healthProgress` 驱动，结束后置 null */
  const healthProgress = ref<HealthProgress | null>(null);
  /** v1.7/CHG-19：按订阅来源聚合的健康摘要（`loadSummaries` 填充） */
  const subscriptionSummaries = ref<SubscriptionSummary[]>([]);
  /** v1.7/CHG-19：订阅自动刷新进行中 */
  const refreshingSubscriptions = ref(false);
  const error = ref<AppErrorShape | null>(null);

  /** OPT-03：健康检查取消句柄（同一时刻只允许一轮） */
  let healthAbort: AbortController | null = null;
  /** 批量治理期间屏蔽 `sources:changed` 的逐条重载，结束后统一 reload 一次 */
  let batchDepth = 0;

  const enabledSources = computed(() => sources.value.filter((source) => source.enabled));
  const currentSource = computed(() => {
    const id = currentSourceId.value;
    if (id !== null) {
      const found = sources.value.find((source) => source.id === id);
      if (found) return found;
    }
    return enabledSources.value.find((source) => !source.builtin) ?? enabledSources.value[0] ?? null;
  });
  const defaultSource = computed(() => enabledSources.value.find((source) => !source.builtin) ?? enabledSources.value[0] ?? null);

  /** 取消订阅句柄（store 生命周期内只订阅一次） */
  let unsubscribe: (() => void) | null = null;
  let unsubscribeProgress: (() => void) | null = null;

  /** 订阅数据层事件（幂等，store 生命周期内只订阅一次） */
  function ensureSubscriptions(): void {
    if (!unsubscribe) {
      unsubscribe = appEvents.on('sources:changed', () => {
        // 批量治理会为每个源发一次事件；期间不逐条重载，避免 183 源场景卡 UI
        if (batchDepth > 0) return;
        void reload();
      });
    }
    if (!unsubscribeProgress) {
      unsubscribeProgress = appEvents.on('sources:healthProgress', (payload) => {
        healthProgress.value = { done: payload.done, total: payload.total };
      });
    }
  }

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      sources.value = await sourceService.list();
      if (currentSourceId.value === null) {
        const preferred = await sourceService.getDefault();
        currentSourceId.value = preferred?.id ?? null;
      } else if (!sources.value.some((source) => source.id === currentSourceId.value)) {
        currentSourceId.value = null;
      }
      ensureSubscriptions();
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
    } finally {
      loading.value = false;
    }
    warmupSpiderSources();
  }

  /** 静默重载（不发 loading，供事件驱动） */
  async function reload(): Promise<void> {
    try {
      sources.value = await sourceService.list();
      if (currentSourceId.value !== null && !sources.value.some((s) => s.id === currentSourceId.value)) {
        currentSourceId.value = null;
      }
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
    }
    warmupSpiderSources();
  }

  /**
   * CHG-15：爬虫源后台预热（fire-and-forget）。
   * 冷启动就加载 jar 拿句柄，搜索/浏览才不至于被 jar 下载拖到超时。
   * 适配器内部对句柄/预热中去重，load 与 reload 双入口重复调用无副作用。
   *
   * P0-5: 预热收敛——只预热当前源+默认源+健康前 3，其余懒加载；并发从 3 降到 2。
   */
  function warmupSpiderSources(): void {
    const candidates = sources.value.filter(
      (source) => source.enabled && source.type === 'spider' && source.health !== 'unreachable',
    );
    if (candidates.length === 0) return;

    // P0-5: 只预热前 5 个（当前源/默认源优先 + 健康前 3）
    const preferredId = currentSourceId.value;
    const prioritized = preferredId === null
      ? candidates
      : [
          ...candidates.filter((s) => s.id === preferredId),
          ...candidates.filter((s) => s.id !== preferredId),
        ];
    const toWarmup = prioritized.slice(0, 5);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < toWarmup.length) {
        const source = toWarmup[cursor];
        cursor += 1;
        if (!source) continue;
        try {
          await sourceRegistry.forSource(source).warmup?.(source);
        } catch {
          /* 预热失败静默：真实调用时再报错 */
        }
      }
    };
    // P0-5: 并发从 3 降到 2
    for (let i = 0; i < Math.min(2, toWarmup.length); i += 1) void worker();
  }

  async function select(sourceId: string | null): Promise<void> {
    if (sourceId !== null && !sources.value.some((source) => source.id === sourceId)) {
      error.value = toErrorShape(new Error('源不存在'), 'E_NOT_FOUND');
      return;
    }
    currentSourceId.value = sourceId;
  }

  async function setEnabled(id: string, v: boolean): Promise<void> {
    error.value = null;
    try {
      await sourceService.setEnabled(id, v);
      await reload();
      if (!v && currentSourceId.value === id) {
        currentSourceId.value = null;
      }
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw e;
    }
  }

  /**
   * 一键禁用全部失效源（爬虫订阅场景：体检后隔离死源）。
   * 只处理「检测过且确定失效」的源：unreachable / bad_config / auth_failed；
   * timeout 可能是瞬时网络慢，保留不自动禁用。返回禁用数量。
   *
   * FIX-01：按 `BATCH_CONCURRENCY` 并发执行并逐项回调进度，避免 183 源时串行卡 UI；
   * 批量期间屏蔽逐条 `sources:changed` 重载，结束后统一刷新一次。
   */
  async function disableUnhealthy(
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    const latest = await sourceService.list();
    const targets = latest.filter(
      (source) =>
        source.enabled &&
        source.healthCheckedAt !== null &&
        (source.health === 'unreachable' ||
          source.health === 'bad_config' ||
          source.health === 'auth_failed'),
    );
    if (targets.length === 0) return 0;
    let disabled = 0;
    batchDepth += 1;
    try {
      await forEachLimited(
        targets,
        BATCH_CONCURRENCY,
        async (source) => {
          await sourceService.setEnabled(source.id, false);
          disabled += 1;
        },
        onProgress,
      );
    } finally {
      batchDepth -= 1;
    }
    if (disabled > 0) {
      if (currentSourceId.value !== null && targets.some((s) => s.id === currentSourceId.value)) {
        currentSourceId.value = null;
      }
      await reload();
    }
    return disabled;
  }

  /**
   * 批量清理已禁用源（FIX-01）。
   * 只删除 `enabled=false` 且非内置的源；内置源只能禁用不能删除（REV-14）。
   * 返回删除/失败数量，供 UI 结果统计；并发执行 + 进度回调。
   */
  async function purgeDisabled(
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ removed: number; failed: number }> {
    const latest = await sourceService.list();
    const targets = latest.filter((source) => !source.enabled && !source.builtin);
    if (targets.length === 0) return { removed: 0, failed: 0 };
    let removed = 0;
    let failed = 0;
    batchDepth += 1;
    try {
      failed = await forEachLimited(
        targets,
        BATCH_CONCURRENCY,
        async (source) => {
          await sourceService.remove(source.id);
          removed += 1;
        },
        onProgress,
      );
    } finally {
      batchDepth -= 1;
    }
    if (removed > 0) {
      if (currentSourceId.value !== null && targets.some((s) => s.id === currentSourceId.value)) {
        currentSourceId.value = null;
      }
      await reload();
    }
    return { removed, failed };
  }

  /** 按订阅来源删除全部源（CHG-12 订阅管理）；返回删除数量 */
  async function removeBySubscription(subscriptionId: string): Promise<number> {
    const latest = await sourceService.list();
    const targets = latest.filter((source) => source.subscriptionId === subscriptionId);
    let removed = 0;
    for (const source of targets) {
      try {
        await sourceService.remove(source.id);
        removed += 1;
      } catch (e) {
        logger.warn('按订阅删除源失败', source.name, e);
      }
    }
    if (removed > 0) {
      if (currentSourceId.value !== null && targets.some((s) => s.id === currentSourceId.value)) {
        currentSourceId.value = null;
      }
      await reload();
    }
    // 级联删除关联的直播源（功能扩展-2）
    const removedLives = await liveService.removeBySubscription(subscriptionId);
    if (removedLives > 0) {
      logger.info('按订阅级联删除直播源', { subscriptionId, removedLives });
    }
    return removed;
  }

  async function reorder(ids: string[]): Promise<void> {
    error.value = null;
    try {
      await sourceService.reorder(ids);
      await reload();
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw e;
    }
  }

  /**
   * 健康检查（OPT-03）。
   *
   * - 用户主动触发：`force` 绕过 healthService 的 10 分钟缓存；
   * - `failedOnly`：只复检「检测过且非 ok」的启用源（timeout/unreachable/bad_config/auth_failed）；
   * - 支持 `cancelHealthCheck()` 取消：取消后 refreshHealth 正常返回，不写错误态；
   * - 结束后统一：自动禁用退化处置 → 重载列表 → 刷新订阅摘要。
   */
  async function refreshHealth(options: { failedOnly?: boolean } = {}): Promise<void> {
    if (healthChecking.value) return;
    healthChecking.value = true;
    error.value = null;
    const controller = new AbortController();
    healthAbort = controller;
    try {
      if (options.failedOnly) {
        const latest = await sourceService.list();
        const ids = latest
          .filter(
            (source) =>
              source.enabled &&
              source.healthCheckedAt !== null &&
              source.health !== 'ok' &&
              source.health !== 'unknown',
          )
          .map((source) => source.id);
        if (ids.length === 0) return;
        await healthService.check(ids, controller.signal);
      } else {
        // 走 healthService 而非 sourceService：后者不维护延迟快照，
        // 会导致 `latencyOf` 恒为 null → 所有 ok 源被降级为「异常」（CHG-05 / AC-106）。
        await healthService.checkAll({ force: true, signal: controller.signal });
      }
      if (controller.signal.aborted) {
        // 取消前已完成的探测已写库（markHealth 不发 changed 事件），刷新一次让部分结果可见
        await reload();
        return;
      }
      // v1.7/CHG-19：体检后处置连续失败源（自动禁用；UI 经 autoDisabledAt 角标/摘要感知）
      await subscriptionLifecycleService.applyHealthDegradation();
      await reload();
      void loadSummaries();
    } catch (e) {
      if (!isCanceled(e)) {
        error.value = toErrorShape(e, 'E_NETWORK');
        throw e;
      }
      // 取消同样刷新，展示已完成部分的健康结果
      await reload();
    } finally {
      if (healthAbort === controller) {
        healthAbort = null;
        healthChecking.value = false;
        healthProgress.value = null;
      }
    }
  }

  /** 取消进行中的健康检查（OPT-03）；未在检测时为空操作 */
  function cancelHealthCheck(): void {
    healthAbort?.abort();
  }

  /** 需要「仅检测失败源」的目标数量（UI 判断入口是否可点） */
  function failedSourceIds(): string[] {
    return sources.value
      .filter(
        (source) =>
          source.enabled &&
          source.healthCheckedAt !== null &&
          source.health !== 'ok' &&
          source.health !== 'unknown',
      )
      .map((source) => source.id);
  }

  /**
   * 单源延迟（CHG-05 / API-14）：代理 `healthService`，UI 不得直接 import 服务层。
   * `Source` 实体没有 `latencyMs` 字段（类型冻结）。
   */
  function latencyOf(sourceId: string): number | null {
    return healthService.latencyOf(sourceId);
  }

  /* ---------- v1.7（CHG-19）新增：订阅生命周期 ---------- */

  /** 订阅健康摘要（订阅管理页） */
  async function loadSummaries(): Promise<void> {
    try {
      subscriptionSummaries.value = await subscriptionLifecycleService.summarize();
    } catch (e) {
      logger.warn('订阅摘要加载失败', e);
    }
  }

  /** 立即刷新全部订阅（TTL 判定跳过；返回刷新/失败数） */
  async function refreshAllSubscriptions(): Promise<{ refreshed: number; failed: number }> {
    refreshingSubscriptions.value = true;
    try {
      const result = await subscriptionLifecycleService.maybeAutoRefresh();
      await reload();
      void loadSummaries();
      return result;
    } finally {
      refreshingSubscriptions.value = false;
    }
  }

  /** 恢复被自动禁用的源 */
  async function restoreAutoDisabled(id: string): Promise<void> {
    await subscriptionLifecycleService.restore(id);
    await reload();
    void loadSummaries();
  }

  /** 一键恢复全部被自动禁用的源（FIX-01 / AC-117）；返回恢复数量 */
  async function restoreAllAutoDisabled(
    onProgress?: (done: number, total: number) => void,
  ): Promise<number> {
    const latest = await sourceService.list();
    const targets = latest.filter((source) => source.autoDisabledAt);
    if (targets.length === 0) return 0;
    let restored = 0;
    batchDepth += 1;
    try {
      await forEachLimited(
        targets,
        BATCH_CONCURRENCY,
        async (source) => {
          await subscriptionLifecycleService.restore(source.id);
          restored += 1;
        },
        onProgress,
      );
    } finally {
      batchDepth -= 1;
    }
    if (restored > 0) {
      await reload();
      void loadSummaries();
    }
    return restored;
  }

  /** 测试/登出时重置（非契约方法，仅供内部使用） */
  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeProgress?.();
    unsubscribeProgress = null;
    healthAbort?.abort();
    healthAbort = null;
    healthProgress.value = null;
  }

  /* ---------- v1.1（CHG-01）新增：写操作统一「落库 → 刷新内存」 ---------- */

  async function create(input: SourceInput): Promise<Source> {
    error.value = null;
    try {
      const created = await sourceService.create(input);
      await reload();
      return created;
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw toAppError(e, 'E_DB');
    }
  }

  async function update(id: string, patch: Partial<SourceInput>): Promise<Source> {
    error.value = null;
    try {
      const updated = await sourceService.update(id, patch);
      await reload();
      return updated;
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw toAppError(e, 'E_DB');
    }
  }

  async function remove(id: string, opts?: { removeDownloads?: boolean }): Promise<void> {
    error.value = null;
    try {
      await sourceService.remove(id, opts);
      if (currentSourceId.value === id) currentSourceId.value = null;
      await reload();
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw toAppError(e, 'E_DB');
    }
  }

  /**
   * 连接测试：直接转发 `sourceService.testConnection` 的真实探测结果。
   * 与 API-01 一致，本方法不抛错——失败经 `ok:false` + `message` 表达。
   */
  async function testConnection(input: SourceInput): Promise<TestConnectionFeedback> {
    try {
      const result = await sourceService.testConnection(input);
      return {
        ok: result.ok,
        message: result.error?.message ?? (result.ok ? '连接成功' : '连接失败'),
        latencyMs: result.latencyMs,
      };
    } catch (e) {
      // 兜底：适配器意外抛错也不穿透到 UI
      return { ok: false, message: toErrorShape(e, 'E_NETWORK').message };
    }
  }

  return {
    sources,
    currentSourceId,
    loading,
    healthChecking,
    healthProgress,
    subscriptionSummaries,
    refreshingSubscriptions,
    error,
    enabledSources,
    currentSource,
    defaultSource,
    load,
    select,
    setEnabled,
    disableUnhealthy,
    purgeDisabled,
    removeBySubscription,
    reorder,
    refreshHealth,
    cancelHealthCheck,
    failedSourceIds,
    create,
    update,
    remove,
    testConnection,
    latencyOf,
    loadSummaries,
    refreshAllSubscriptions,
    restoreAutoDisabled,
    restoreAllAutoDisabled,
    $dispose,
  };
});

export type SourceStore = ReturnType<typeof useSourceStore>;
