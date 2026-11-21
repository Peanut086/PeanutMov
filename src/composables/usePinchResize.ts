/**
 * 双指捏合切画幅的编排层（G-A09）。
 *
 * 几何判定在 `player/PinchResizeRecognizer`（纯逻辑），指针接线在 `GestureLayer`，
 * 这里只管三件事：把档位实时生效、抬手后用弹簧把画幅尺吸附到停靠位、把结果写回设置。
 *
 * 两条刻意的设计：
 * - **中途被打断（pointercancel / 组件被拆）一律还原到手势开始前的档位且不落盘**——
 *   非本意的画面变化不该留下痕迹；
 * - **只有真正换档才发一次 `apply`**，避免每一帧都往原生桥打一枪。
 */
import { onBeforeUnmount, ref } from 'vue';

import { MODE_ANCHORS } from '@/player/PinchResizeRecognizer';
import { animateSpring, prefersReducedMotion } from '@/composables/useSpring';
import type { ResizeMode } from '@/types';

/** 吸附到位后给眼睛留出读结果的窗口，再收掉 HUD */
const SETTLE_DWELL_MS = 320;

export interface PinchResizeOptions {
  /** 手势开始前的档位，用于未越过阈值或被中断时还原 */
  currentMode: () => ResizeMode;
  /** 立即生效（不写存储） */
  apply: (mode: ResizeMode) => void;
  /** 抬手吸附成功后写存储 */
  commit: (mode: ResizeMode) => void;
  /** 换档瞬间的反馈（触觉），每次换档只调一次 */
  onShift?: (mode: ResizeMode) => void;
}

export function usePinchResize(options: PinchResizeOptions) {
  const visible = ref(false);
  const pos = ref(0);
  const mode = ref<ResizeMode>('contain');

  /** 本次会话是否已越过触发阈值（决定 HUD 该不该出现、要不要还原） */
  let started = false;
  let original: ResizeMode = 'contain';
  /** 本手势最后一次真正生效的档位；与 original 不同才需要还原 */
  let applied: ResizeMode | null = null;
  let stopSpring: (() => void) | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelSettle(): void {
    stopSpring?.();
    stopSpring = null;
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function hide(): void {
    visible.value = false;
  }

  function onSample(nextPos: number, nextMode: ResizeMode): void {
    if (!started) {
      started = true;
      original = options.currentMode();
      applied = null;
      mode.value = original;
      cancelSettle();
      visible.value = true;
    }
    pos.value = nextPos;
    if (nextMode === mode.value) return;
    mode.value = nextMode;
    options.apply(nextMode);
    applied = nextMode === original ? null : nextMode;
    options.onShift?.(nextMode);
  }

  function onEnd(next: ResizeMode | null, _pos: number, reason: 'up' | 'cancel'): void {
    if (!started) return;
    started = false;
    const target = next ?? original;
    if (applied !== null && target !== applied) options.apply(target);
    applied = null;
    mode.value = target;

    if (!next) {
      // 还原是「撤销」，不该用弹簧庆祝一下：立刻收 HUD
      cancelSettle();
      hide();
      return;
    }
    if (reason === 'up') options.commit(next);

    const anchor = MODE_ANCHORS[target];
    if (prefersReducedMotion()) {
      pos.value = anchor;
      hideTimer = setTimeout(() => {
        hideTimer = null;
        hide();
      }, SETTLE_DWELL_MS);
      return;
    }
    stopSpring = animateSpring({
      from: pos.value,
      target: anchor,
      onFrame: (value) => {
        pos.value = value;
      },
      onSettle: () => {
        stopSpring = null;
        hideTimer = setTimeout(() => {
          hideTimer = null;
          hide();
        }, SETTLE_DWELL_MS);
      },
    });
  }

  /** 会话没走到收尾就被拆掉（组件卸载/页面切走）：静默复位并还原画面 */
  function abort(): void {
    if (!started) return;
    onEnd(null, pos.value, 'cancel');
  }

  onBeforeUnmount(() => {
    cancelSettle();
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = null;
  });

  return { visible, pos, mode, onSample, onEnd, abort };
}
