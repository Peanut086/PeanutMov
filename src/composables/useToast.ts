/**
 * Toast 便捷入口（组合式函数）
 *
 * 页面里 `const toast = useToast()` 后直接 `toast.success('已保存')`。
 * 底层写 `uiStore`，全局只有一个 ToastHost 渲染。
 */
import { useUiStore } from '@/stores/uiStore';

export interface ToastApi {
  info(text: string, durationMs?: number): void;
  success(text: string, durationMs?: number): void;
  error(text: string, durationMs?: number): void;
}

export function useToast(): ToastApi {
  const ui = useUiStore();
  return {
    info: (text, durationMs) => {
      ui.toast(text, 'info', durationMs);
    },
    success: (text, durationMs) => {
      ui.toast(text, 'success', durationMs);
    },
    error: (text, durationMs) => {
      ui.toast(text, 'error', durationMs);
    },
  };
}
