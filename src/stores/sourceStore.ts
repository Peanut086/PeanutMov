/**
 * 源 Store（API-14）
 *
 * 只暴露契约中列出的 state/getters/actions；所有写操作经 `sourceService` 落库后刷新内存。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { sourceService } from '@/services/sourceService';
import { healthService } from '@/services/healthService';
import { appEvents } from '@/services/events';
import { logger } from '@/shared/logger';
import { toAppError, toErrorShape } from '@/shared/errors';
import type { AppErrorShape, Source, SourceInput } from '@/types';

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
  const error = ref<AppErrorShape | null>(null);

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
   * 注意：markHealth 不发 sources:changed，内存快照可能滞后，必须从仓储读最新状态。
   */
  async function disableUnhealthy(): Promise<number> {
    const latest = await sourceService.list();
    const targets = latest.filter(
      (source) =>
        source.enabled &&
        source.healthCheckedAt !== null &&
        (source.health === 'unreachable' ||
          source.health === 'bad_config' ||
          source.health === 'auth_failed'),
    );
    let disabled = 0;
    for (const source of targets) {
      try {
        await sourceService.setEnabled(source.id, false);
        disabled += 1;
      } catch (e) {
        // 单个失败不中断批量，最终数量如实上报
        logger.warn('批量禁用失效源失败', source.name, e);
      }
    }
    if (disabled > 0) {
      if (currentSourceId.value !== null && targets.some((s) => s.id === currentSourceId.value)) {
        currentSourceId.value = null;
      }
      await reload();
    }
    return disabled;
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

  async function refreshHealth(): Promise<void> {
    healthChecking.value = true;
    error.value = null;
    try {
      // 走 healthService 而非 sourceService：后者不维护延迟快照，
      // 会导致 `latencyOf` 恒为 null → 所有 ok 源被降级为「异常」（CHG-05 / AC-106）。
      await healthService.checkAll();
      await reload();
    } catch (e) {
      error.value = toErrorShape(e, 'E_NETWORK');
    } finally {
      healthChecking.value = false;
      healthProgress.value = null;
    }
  }

  /**
   * 单源延迟（CHG-05 / API-14）：代理 `healthService`，UI 不得直接 import 服务层。
   * `Source` 实体没有 `latencyMs` 字段（类型冻结）。
   */
  function latencyOf(sourceId: string): number | null {
    return healthService.latencyOf(sourceId);
  }

  /** 测试/登出时重置（非契约方法，仅供内部使用） */
  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeProgress?.();
    unsubscribeProgress = null;
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
    error,
    enabledSources,
    currentSource,
    defaultSource,
    load,
    select,
    setEnabled,
    disableUnhealthy,
    reorder,
    refreshHealth,
    create,
    update,
    remove,
    testConnection,
    latencyOf,
    $dispose,
  };
});

export type SourceStore = ReturnType<typeof useSourceStore>;
