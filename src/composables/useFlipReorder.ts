/**
 * 列表重排的 FLIP 位移（G-B01 色相墙用，也可给其它「同一批卡片换顺序」的场景）。
 *
 * First-Last-Invert-Play：重排前量一次位置，DOM 更新后再量一次，把差值反向写成
 * `transform`，下一帧放开让它回到 0 —— 位移只走 transform，不碰 width/height，
 * 因此不会挤压网格、也不会让虚拟列表的行高估算跑偏。
 *
 * 读取与写入分两趟做完：交错读写会每行强制一次回流，12 张卡片就是 12 次。
 */
import { nextTick, onBeforeUnmount, watch } from 'vue';

import { prefersReducedMotion } from '@/composables/useSpring';

/** 位移时长：再长就会让人觉得墙「跟不上手」 */
export const FLIP_DURATION_MS = 260;

export interface FlipReorderOptions {
  /** 承载卡片的容器元素 */
  root: () => HTMLElement | null;
  /** 顺序来源（通常是 items）；变化即触发一次快照对比 */
  source: () => unknown;
  /** 关掉后完全静默，连快照都不量 */
  enabled: () => boolean;
}

interface Spot {
  left: number;
  top: number;
}

function measure(root: HTMLElement): Map<string, Spot> {
  const map = new Map<string, Spot>();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'))) {
    const key = el.dataset.flipKey;
    if (!key) continue;
    const rect = el.getBoundingClientRect();
    map.set(key, { left: rect.left, top: rect.top });
  }
  return map;
}

export function useFlipReorder(options: FlipReorderOptions): void {
  let cleanup: ReturnType<typeof setTimeout> | null = null;

  function play(before: Map<string, Spot>): void {
    const root = options.root();
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-flip-key]'));

    const moved: { el: HTMLElement; dx: number; dy: number }[] = [];
    for (const el of nodes) {
      const key = el.dataset.flipKey;
      if (!key) continue;
      const prev = before.get(key);
      if (!prev) continue;
      const rect = el.getBoundingClientRect();
      const dx = prev.left - rect.left;
      const dy = prev.top - rect.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      moved.push({ el, dx, dy });
    }
    if (moved.length === 0) return;

    for (const { el, dx, dy } of moved) {
      el.style.transition = 'none';
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    // 一次回流把起始帧提交，之后统一放开
    void root.offsetWidth;
    for (const { el } of moved) {
      el.style.transition = `transform ${FLIP_DURATION_MS}ms var(--ease-standard)`;
      el.style.transform = '';
    }

    if (cleanup !== null) clearTimeout(cleanup);
    cleanup = setTimeout(() => {
      cleanup = null;
      for (const { el } of moved) el.style.transition = '';
    }, FLIP_DURATION_MS + 60);
  }

  watch(options.source, () => {
    if (!options.enabled() || prefersReducedMotion()) return;
    const root = options.root();
    if (!root) return;
    const before = measure(root);
    void nextTick(() => play(before));
  });

  onBeforeUnmount(() => {
    if (cleanup !== null) clearTimeout(cleanup);
    cleanup = null;
  });
}
