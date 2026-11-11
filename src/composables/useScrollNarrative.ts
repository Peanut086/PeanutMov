/**
 * 详情页滚动叙事（C-10）
 *
 * 三层效果由同一个 rAF 节流的 passive scroll 监听驱动，**只写 CSS 变量与 data 属性**，
 * 不碰布局属性：
 * 1. 背景海报视差后退（`--dn-shift` 只走 transform）+ 渐进模糊（`data-blur` 5 档离散）；
 * 2. 大标题收进 sticky 顶栏（`--dn-nav` / `--dn-hero` 互补淡出淡入，`--dn-nav-x` 对齐横坐标）；
 * 3. 段落主色切换：回报 `activeSection`，由调用方换算强调色（复用取色能力）。
 *
 * 两条性能纪律：
 * - 一帧内**先读完所有矩形再写样式**，否则每次 setProperty 都会引发同步重排；
 * - `filter: blur()` 不逐帧插值（每帧重建高斯核是低端 WebView 上最贵的一笔），
 *   改成离散 5 档 + 300ms 过渡，视觉一样是"渐渐糊下去"。
 */
import { onBeforeUnmount, ref, watch, type Ref } from 'vue';

import { prefersReducedMotion } from '@/composables/useSpring';

/** 背景图模糊档位（px）：滚动进度按档离散取值 */
export const BLUR_STEPS = [14, 17, 20, 23, 26] as const;
/** 视差最大位移（px）：背景最多比内容慢这么多，也决定了背景图需要向上留出的余量 */
const MAX_SHIFT = 120;
/** 滚完这么多像素视为"头部叙事结束"，进度封顶 */
const DEFAULT_SPAN = 300;
/** 顶栏标题从进度 42% 开始出现，到 72% 完全到位 */
const NAV_START = 0.42;
const NAV_SPAN = 0.3;
/** 段落判定线：滚动视口上 1/3 处 */
const SECTION_LINE = 0.34;
/** 停止滚动后撤掉 will-change：只在交互中提示合成 */
const IDLE_MS = 180;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export interface ScrollNarrativeOptions {
  /** 写变量的容器（页面根节点） */
  root: Ref<HTMLElement | null>;
  /** 真正滚的那个容器 */
  scroller: Ref<HTMLElement | null>;
  /** 头部区块：进度按它的高度算，标题的横坐标也对齐它 */
  hero: Ref<HTMLElement | null>;
}

export interface ScrollNarrativeApi {
  /** 当前滚到的段落下标（-1 = 还在头部） */
  activeSection: Ref<number>;
  /** 内容变化（换片、选集加载完）后重新量一次 */
  refresh: () => void;
}

export function useScrollNarrative(options: ScrollNarrativeOptions): ScrollNarrativeApi {
  const { root, scroller, hero } = options;
  const activeSection = ref(-1);

  let bound: HTMLElement | null = null;
  let frame = 0;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let sections: HTMLElement[] = [];
  let span = DEFAULT_SPAN;

  /** 一次性量完本帧要用的全部几何量 */
  function read(): { y: number; line: number; tops: number[] } {
    const el = scroller.value;
    if (!el) return { y: 0, line: 0, tops: [] };
    const base = el.getBoundingClientRect().top;
    return {
      y: el.scrollTop,
      line: el.clientHeight * SECTION_LINE,
      tops: sections.map((node) => node.getBoundingClientRect().top - base),
    };
  }

  function write(): void {
    const rootEl = root.value;
    if (!rootEl) return;
    const geo = read();
    const p = clamp01(geo.y / span);

    if (prefersReducedMotion()) {
      // 背景静止、标题直接切换：停在设计稿的静态档位上，不做视差与逐档模糊
      for (const [name, value] of [
        ['--dn-shift', '0px'],
        ['--dn-p', '0.5'],
        ['--dn-nav', p >= NAV_START ? '1' : '0'],
        ['--dn-hero', p >= NAV_START ? '0' : '1'],
      ] as const) {
        rootEl.style.setProperty(name, value);
      }
      rootEl.dataset.blur = '2';
    } else {
      const steps = BLUR_STEPS.length;
      rootEl.dataset.blur = String(Math.min(steps - 1, Math.floor(p * steps)));
      for (const [name, value] of [
        ['--dn-shift', `${(p * MAX_SHIFT).toFixed(1)}px`],
        ['--dn-p', p.toFixed(3)],
        ['--dn-nav', clamp01((p - NAV_START) / NAV_SPAN).toFixed(3)],
        ['--dn-hero', clamp01(1 - p * 1.25).toFixed(3)],
      ] as const) {
        rootEl.style.setProperty(name, value);
      }
    }

    let next = -1;
    for (let i = 0; i < geo.tops.length; i += 1) {
      if ((geo.tops[i] ?? 0) <= geo.line) next = i;
    }
    if (next === activeSection.value) return;
    sections[activeSection.value]?.removeAttribute('data-narrative-active');
    activeSection.value = next;
    if (next >= 0) sections[next]?.setAttribute('data-narrative-active', '');
  }

  function measure(): void {
    const el = scroller.value;
    if (!el) return;
    sections = [...el.querySelectorAll<HTMLElement>('[data-narrative]')];
    const heroEl = hero.value;
    span = Math.max(200, (heroEl?.offsetHeight ?? 0) + 100);

    // 顶栏标题要与大标题落在同一根竖线上，否则收进去的瞬间会横跳。
    // 先撤掉对齐偏移再量：不然量到的是"加上一次 margin 的位置"，每次 refresh 都会往右漂。
    const titleEl = heroEl?.querySelector<HTMLElement>('[data-narrative-title]');
    const navEl = root.value?.querySelector<HTMLElement>('[data-narrative-nav-title]');
    if (titleEl && navEl) {
      root.value?.style.removeProperty('--dn-nav-x');
      const delta = Math.max(
        0,
        Math.round(titleEl.getBoundingClientRect().left - navEl.getBoundingClientRect().left),
      );
      root.value?.style.setProperty('--dn-nav-x', `${delta}px`);
    }
  }

  function onScroll(): void {
    if (frame === 0) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        write();
      });
    }
    // 只在滚动进行中提示合成层，停下来就还给主线程
    root.value?.setAttribute('data-narrative-live', '');
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => {
      idle = null;
      root.value?.removeAttribute('data-narrative-live');
    }, IDLE_MS);
  }

  function detach(): void {
    bound?.removeEventListener('scroll', onScroll);
    bound = null;
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    if (idle !== null) {
      clearTimeout(idle);
      idle = null;
    }
  }

  function attach(): void {
    const el = scroller.value;
    if (!el || el === bound) return;
    detach();
    bound = el;
    el.addEventListener('scroll', onScroll, { passive: true });
    measure();
    write();
  }

  function refresh(): void {
    if (!scroller.value) return;
    measure();
    write();
  }

  watch(scroller, attach, { immediate: true });
  onBeforeUnmount(detach);

  return { activeSection, refresh };
}
