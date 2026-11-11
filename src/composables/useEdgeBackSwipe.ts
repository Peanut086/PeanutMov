/**
 * 边缘滑动返回（B-07）
 *
 * 把「跟手拖当前页」和「松手后交给谁」两件事分开：
 * - 拖动只是视觉：给 surface 加 `translate3d`，全程 passive 监听、绝不 preventDefault，
 *   所以列表照常滚、手势层照常收得到触摸，判定不成立时页面完全无感。
 * - 提交走 `pressBackButton()`，与系统返回键同一条链路（弹层先消费，再路由回退），
 *   返回栈行为与按物理键**完全一致**，不另起一套导航。
 *
 * 回弹复用 A-02 的弹簧：慢放慢慢贴回、快甩先顺着走一点再收回来。
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue';

import { prefersReducedMotion, animateSpring } from '@/composables/useSpring';
import { pressBackButton } from '@/native/appLifecycle';
import { EdgeSwipeRecognizer, type EdgeSwipeConfig } from '@/shared/EdgeSwipeRecognizer';

/** 拖动期间挂在 surface 上的类：只负责左缘投影，让"这一层是浮起来的"看得出来 */
const DRAG_CLASS = 'edge-drag';

export interface EdgeBackSwipeOptions {
  /** 被拖动的容器（一般是页面内容区，不含固定 TabBar） */
  surface: Ref<HTMLElement | null>;
  /** 是否允许本次手势（播放器 / 全屏等由调用方关掉） */
  enabled: Ref<boolean>;
  config?: Partial<EdgeSwipeConfig>;
}

/** 起点是否落在一个真能横向滚动的容器里：是就整段放弃，不跟列表抢手势 */
function startsInHorizontalScroller(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  let node: Element | null = target;
  while (node && node !== document.body) {
    const style = window.getComputedStyle(node);
    const overflowX = style.overflowX;
    if ((overflowX === 'auto' || overflowX === 'scroll') && node.scrollWidth - node.clientWidth > 1) {
      return true;
    }
    node = node.parentElement;
  }
  return false;
}

export function useEdgeBackSwipe(options: EdgeBackSwipeOptions): void {
  const recognizer = new EdgeSwipeRecognizer(options.config);
  let pointerId = -1;
  let dragging = false;
  let stopSpring: (() => void) | null = null;

  function surfaceEl(): HTMLElement | null {
    return options.surface.value;
  }

  function applyOffset(px: number): void {
    const el = surfaceEl();
    if (!el) return;
    el.style.transform = px > 0 ? `translate3d(${px}px, 0, 0)` : '';
  }

  function clearSurface(): void {
    const el = surfaceEl();
    if (!el) return;
    el.style.transform = '';
    el.style.willChange = '';
    el.classList.remove(DRAG_CLASS);
  }

  function endGesture(): void {
    pointerId = -1;
    dragging = false;
  }

  function onPointerDown(event: PointerEvent): void {
    if (pointerId !== -1 || !options.enabled.value) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (startsInHorizontalScroller(event.target)) return;
    if (recognizer.begin(event.clientX, event.clientY, event.timeStamp, window.innerWidth) !== 'pending') return;
    pointerId = event.pointerId;
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const verdict = recognizer.move(event.clientX, event.clientY, event.timeStamp);
    if (verdict === 'abandon' || verdict === 'none') {
      if (dragging) clearSurface();
      endGesture();
      return;
    }
    if (verdict !== 'drag') return;

    if (!dragging) {
      stopSpring?.();
      stopSpring = null;
      dragging = true;
      const el = surfaceEl();
      if (el) {
        el.style.willChange = 'transform';
        el.classList.add(DRAG_CLASS);
      }
    }
    applyOffset(recognizer.offset);
  }

  function onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    const result = recognizer.end(event.timeStamp);
    endGesture();
    surfaceEl()?.classList.remove(DRAG_CLASS);
    if (!result.dragging) {
      clearSurface();
      return;
    }
    if (result.commit) {
      // 先清掉内联位移再交回路由：CSS 的 slide-right 从 0 起步，两者不会叠着算
      clearSurface();
      pressBackButton();
      return;
    }
    const el = surfaceEl();
    if (!el || prefersReducedMotion()) {
      clearSurface();
      return;
    }
    stopSpring = animateSpring({
      from: result.offset,
      target: 0,
      velocity: result.velocity,
      clamp: (v) => Math.max(0, v),
      onFrame: applyOffset,
      onSettle: () => {
        stopSpring = null;
        clearSurface();
      },
    });
  }

  function onPointerCancel(event: PointerEvent): void {
    if (event.pointerId !== pointerId) return;
    recognizer.end(event.timeStamp);
    endGesture();
    clearSurface();
  }

  onMounted(() => {
    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    document.addEventListener('pointerup', onPointerUp, { passive: true });
    document.addEventListener('pointercancel', onPointerCancel, { passive: true });
  });

  onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onPointerDown);
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    document.removeEventListener('pointercancel', onPointerCancel);
    stopSpring?.();
    clearSurface();
  });
}
