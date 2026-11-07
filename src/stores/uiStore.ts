/**
 * UI Store（PKG-A 自有）
 *
 * 只承载纯界面状态：Toast 队列、离线标记、当前 Tab、确认对话框请求。
 * 契约见技术方案 API-14 的 `uiStore` 部分；不读写 IndexedDB。
 */
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';

import type { ConfirmState, LoadState, ToastMessage } from '@/types';
import { newId } from '@/shared/id';

export type TabKey = 'home' | 'library' | 'live' | 'downloads' | 'me';

const TOAST_MAX = 3;
const TOAST_DURATION = { info: 2400, error: 2400, success: 1800 } as const;

export const useUiStore = defineStore('ui', () => {
  const toasts = ref<ToastMessage[]>([]);
  const isOffline = ref(false);
  const activeTab = ref<TabKey>('home');
  const confirmState = ref<ConfirmState | null>(null);

  /** 全局页面级 loading（仅欢迎页等少数场景使用） */
  const globalState = shallowRef<LoadState>('idle');

  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let confirmResolver: ((value: boolean) => void) | null = null;

  const hasToasts = computed(() => toasts.value.length > 0);

  function dismiss(id: string): void {
    const timer = timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(id);
    }
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  function toast(
    text: string,
    type: ToastMessage['type'] = 'info',
    durationMs?: number,
    action?: ToastMessage['action'],
  ): string {
    const id = newId();
    const duration = durationMs ?? TOAST_DURATION[type];
    toasts.value = [...toasts.value, { id, type, text, durationMs: duration, action }];
    // 超上限移除最旧
    while (toasts.value.length > TOAST_MAX) {
      const oldest = toasts.value[0];
      if (oldest) dismiss(oldest.id);
      else break;
    }
    if (duration > 0) {
      timers.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    }
    return id;
  }

  function setOffline(v: boolean): void {
    isOffline.value = v;
  }

  function setActiveTab(tab: TabKey): void {
    activeTab.value = tab;
  }

  function setGlobalState(state: LoadState): void {
    globalState.value = state;
  }

  /**
   * 弹出确认框，返回用户选择。
   * 同一时刻只允许一个确认框；新的请求会先把旧的按"取消"结束，避免悬挂 Promise。
   */
  function confirm(opts: Partial<ConfirmState> & { title: string }): Promise<boolean> {
    if (confirmResolver) {
      confirmResolver(false);
      confirmResolver = null;
    }
    confirmState.value = {
      title: opts.title,
      message: opts.message ?? '',
      confirmText: opts.confirmText ?? '确定',
      cancelText: opts.cancelText ?? '取消',
      danger: opts.danger ?? false,
    };
    return new Promise<boolean>((resolve) => {
      confirmResolver = resolve;
    });
  }

  function resolveConfirm(value: boolean): void {
    const resolver = confirmResolver;
    confirmResolver = null;
    confirmState.value = null;
    resolver?.(value);
  }

  /** 测试辅助 */
  function reset(): void {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    toasts.value = [];
    isOffline.value = false;
    resolveConfirm(false);
  }

  return {
    toasts,
    isOffline,
    activeTab,
    confirmState,
    globalState,
    hasToasts,
    toast,
    dismiss,
    setOffline,
    setActiveTab,
    setGlobalState,
    confirm,
    resolveConfirm,
    reset,
  };
});
