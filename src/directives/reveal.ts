/**
 * E1 结果显影：列表行入场 reveal 指令（stagger + blur-up，IO 仅首次触发）
 *
 * 复用 WatchReportView 的 data-reveal 约定与观察参数（rootMargin -40px / threshold 0.01）。
 * 共享单个 IntersectionObserver；行卸载即 unobserve，翻页追加只 reveal 新行，
 * 已 reveal 的行保持 data-reveal="in"，回退/重渲染不重复播放。
 * binding.value 传行索引，stagger delay = min(index, 8) * 40ms。
 */
import type { Directive } from 'vue';

import { prefersReducedMotion } from '@/composables/useSpring';

let io: IntersectionObserver | null = null;

function getIO(): IntersectionObserver | null {
  if (typeof IntersectionObserver !== 'function') return null;
  if (!io) {
    io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute('data-reveal', 'in');
          io?.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -40px 0px', threshold: 0.01 },
    );
  }
  return io;
}

export const reveal: Directive<HTMLElement, number | undefined> = {
  mounted(el, binding) {
    const idx = typeof binding.value === 'number' ? binding.value : 0;
    el.style.setProperty('--rv-delay', `${Math.min(idx, 8) * 40}ms`);
    if (prefersReducedMotion()) {
      el.setAttribute('data-reveal', 'in');
      return;
    }
    const obs = getIO();
    if (!obs) {
      el.setAttribute('data-reveal', 'in');
      return;
    }
    el.setAttribute('data-reveal', '');
    obs.observe(el);
  },
  unmounted(el) {
    io?.unobserve(el);
  },
};
