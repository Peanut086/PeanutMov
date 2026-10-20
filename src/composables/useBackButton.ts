/**
 * 返回键 / 浏览器后退处理（组合式函数）
 *
 * 优先级（页面蓝图 18.3）：页面自己注册的 handler（弹层、全屏等）先处理；
 * 未消费时才走 `router.back()`（无历史时回落首页）。
 *
 * - Android：动态 import `@capacitor/app` 监听 `hardwareBackButton`；
 * - Web：交由浏览器前进/后退与各组件自身的 Esc/遮罩关闭逻辑，
 *   不劫持 `popstate`（劫持会与 vue-router 的 hash 历史互相打架）。
 *
 * 返回值 `handleBack` 可直接绑定到顶栏返回按钮，保证两条路径行为一致。
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { isNative } from '@/shared/platform';

export type BackHandler = () => boolean;

export interface BackButtonOptions {
  /** 返回 true 表示已消费本次返回，不再走路由 */
  handler?: BackHandler;
  /** 无历史可退时回落的路由，默认首页 */
  fallback?: string;
}

export function useBackButton(options: BackButtonOptions = {}): { handleBack: () => void } {
  const router = useRouter();
  const fallback = options.fallback ?? '/';
  let removeNative: (() => void) | null = null;
  let disposed = false;

  const runHandler = (): boolean => {
    if (!options.handler) return false;
    try {
      return options.handler();
    } catch {
      return false;
    }
  };

  const handleBack = (): void => {
    if (runHandler()) return;
    const h = globalThis.history;
    const hasHistory = typeof h?.length === 'number' && h.length > 1;
    if (hasHistory) router.back();
    else void router.replace(fallback);
  };

  onMounted(() => {
    if (!isNative()) return;
    void import('@capacitor/app')
      .then(({ App }) => {
        if (disposed) return;
        void App.addListener('backButton', () => {
          handleBack();
        }).then((handle) => {
          if (disposed) {
            void handle.remove();
            return;
          }
          removeNative = () => {
            void handle.remove();
          };
        });
      })
      .catch(() => {
        /* 插件不可用：交给系统默认行为 */
      });
  });

  onBeforeUnmount(() => {
    disposed = true;
    removeNative?.();
    removeNative = null;
  });

  return { handleBack };
}
