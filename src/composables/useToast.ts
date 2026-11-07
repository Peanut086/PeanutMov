/**
 * Toast 便捷入口（组合式函数）
 *
 * 页面里 `const toast = useToast()` 后直接 `toast.success('已保存')`。
 * 底层写 `uiStore`，全局只有一个 ToastHost 渲染。
 */
import type { ToastAction } from '@/types';
import { useUiStore } from '@/stores/uiStore';

export interface ToastApi {
  info(text: string, durationMs?: number): void;
  success(text: string, durationMs?: number): void;
  error(text: string, durationMs?: number): void;
  /** 带操作按钮的 Toast（点击按钮后自动关闭） */
  action(text: string, action: ToastAction, type?: 'info' | 'success', durationMs?: number): void;
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
    action: (text, action, type = 'info', durationMs) => {
      const id = ui.toast(text, type, durationMs, action);
      // action toast 点击按钮后手动关闭（不自动消失，等用户操作）
      // 但保留超时兜底，避免永久悬挂
      if (durationMs === undefined) {
        // 默认给 8s 超时
        setTimeout(() => ui.dismiss(id), 8000);
      }
    },
  };
}
