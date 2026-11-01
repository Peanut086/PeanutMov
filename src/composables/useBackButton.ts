/**
 * 返回键 / 浏览器后退处理（组合式函数）
 *
 * 优先级（页面蓝图 18.3）：页面自己注册的 handler（弹层、全屏等）先处理；
 * 未消费时由 `appLifecycle` 的全局兜底决定：能回退路由就 router.back()，
 * 否则才退出 App（避免二级页按返回直接杀进程）。
 *
 * - Android：统一注册到 `onBackButton` 总线（全 App 只有一个原生监听器，
 *   避免"多个监听器各干各的"导致双重处理）；
 * - Web：交由浏览器前进/后退与各组件自身的 Esc/遮罩关闭逻辑。
 *
 * 返回值 `handleBack` 可直接绑定到顶栏返回按钮，保证两条路径行为一致。
 */
import { onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';

import { isNative } from '@/shared/platform';
import { onBackButton } from '@/native/appLifecycle';

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
  let off: (() => void) | null = null;

  const runHandler = (): boolean => {
    if (!options.handler) return false;
    try {
      return options.handler();
    } catch {
      return false;
    }
  };

  /** 供 UI 返回按钮复用：先问页面 handler，再走路由 */
  const handleBack = (): void => {
    if (runHandler()) return;
    const h = globalThis.history;
    const hasHistory = typeof h?.length === 'number' && h.length > 1;
    if (hasHistory) router.back();
    else void router.replace(fallback);
  };

  onMounted(() => {
    if (!isNative()) return;
    // 交给全局总线：返回 true 表示本页已消费，不会再触发兜底/退出
    off = onBackButton(runHandler);
  });

  onBeforeUnmount(() => {
    off?.();
    off = null;
  });

  return { handleBack };
}
