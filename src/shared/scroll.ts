/**
 * 页面滚动管理工具
 *
 * 所有列表页的主滚动容器统一使用 `data-scroll="page"` 属性标记，
 * 以便全局工具函数定位并操作滚动位置。
 *
 * 解决的问题：
 * - AppTabBar 点击当前 Tab 回顶部（window.scrollTo 对内层容器无效）
 * - 路由返回时恢复列表页滚动位置（非 KeepAlive 页面会丢失）
 */

import { prefersReducedMotion } from '@/composables/useSpring';

const SCROLL_ATTR = 'data-scroll="page"';

/**
 * 系统「减少动态效果」下，JS 侧的滚动也必须瞬时到位。
 *
 * reset.css 的全局降级只管 CSS 动画与过渡，`scrollTo({ behavior: 'smooth' })`
 * 是浏览器行为，不受那条规则约束——只能在这里现读媒体查询。
 */
function behavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

/**
 * 获取当前页面的主滚动容器
 * 优先查找带 data-scroll="page" 的元素，回退到 window
 */
export function getScrollContainer(): HTMLElement | Window {
  const el = document.querySelector<HTMLElement>(`[${SCROLL_ATTR}]`);
  return el ?? window;
}

/**
 * 平滑滚动到顶部
 * @param container 滚动容器，默认自动查找
 */
export function scrollToTop(container?: HTMLElement | Window): void {
  const target = container ?? getScrollContainer();
  if (target instanceof Window) {
    target.scrollTo({ top: 0, behavior: behavior() });
  } else {
    target.scrollTo({ top: 0, behavior: behavior() });
  }
}

/**
 * 保存当前滚动位置到 history.state
 * 用于路由离开前调用，以便返回时恢复
 */
export function saveScrollPosition(container?: HTMLElement | Window): void {
  const target = container ?? getScrollContainer();
  if (target instanceof Window) return; // window 滚动由浏览器/路由自动处理
  try {
    const state = history.state ?? {};
    history.replaceState({ ...state, scrollTop: target.scrollTop }, '');
  } catch {
    // 静默失败，不阻塞导航
  }
}

/**
 * 从 history.state 恢复滚动位置
 * @param container 滚动容器，默认自动查找
 * @returns 是否成功恢复（state 中有 scrollTop）
 */
export function restoreScrollPosition(container?: HTMLElement | Window): boolean {
  const target = container ?? getScrollContainer();
  if (target instanceof Window) return false;
  const scrollTop = (history.state as { scrollTop?: number })?.scrollTop;
  if (typeof scrollTop === 'number' && scrollTop > 0) {
    target.scrollTop = scrollTop;
    return true;
  }
  return false;
}
