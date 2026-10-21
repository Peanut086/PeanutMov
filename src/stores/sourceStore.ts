/**
 * 源 Store（API-14）
 *
 * 只暴露契约中列出的 state/getters/actions；所有写操作经 `sourceService` 落库后刷新内存。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { sourceService } from '@/services/sourceService';
import { appEvents } from '@/services/events';
import { toAppError, toErrorShape } from '@/shared/errors';
import type { AppErrorShape, Source, SourceInput } from '@/types';

/** `testConnection` 的 UI 投影（不暴露 health/itemCount 等枚举细节） */
export interface TestConnectionFeedback {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export const useSourceStore = defineStore('source', () => {
  const sources = ref<Source[]>([]);
  const currentSourceId = ref<string | null>(null);
  const loading = ref(false);
  const healthChecking = ref(false);
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
      if (!unsubscribe) {
        unsubscribe = appEvents.on('sources:changed', () => {
          void reload();
        });
      }
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
      await sourceService.checkHealth();
      await reload();
    } catch (e) {
      error.value = toErrorShape(e, 'E_NETWORK');
    } finally {
      healthChecking.value = false;
    }
  }

  /** 测试/登出时重置（非契约方法，仅供内部使用） */
  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
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
    error,
    enabledSources,
    currentSource,
    defaultSource,
    load,
    select,
    setEnabled,
    reorder,
    refreshHealth,
    create,
    update,
    remove,
    testConnection,
    $dispose,
  };
});

export type SourceStore = ReturnType<typeof useSourceStore>;
