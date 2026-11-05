<script setup lang="ts">
/**
 * 手势层（技术方案 9.3 / 设计规范 12.1）
 *
 * 只负责把 Pointer 事件转成 `GestureRecognizer` 的调用，并把 intent 抛给父级。
 * 位于控制条下层（z-index 更低），控制条按钮优先响应。
 *
 * 由于 recognizer 是纯类，本组件保持"薄"：无业务判断，便于调试与替换。
 *
 * OPT-10：增加长按 2 秒触发帮助浮层的能力，以及触摸视觉反馈（光晕）。
 */
import { ref, onBeforeUnmount } from 'vue';

import { usePlayerStore } from '@/stores/playerStore';
import { GestureRecognizer, type GestureIntent, type GestureContext } from '@/player/GestureRecognizer';
import { dimOpacityToBrightness } from '@/player/brightness';

const emit = defineEmits<{
  (e: 'intent', intent: GestureIntent): void;
  /** OPT-10：长按 2 秒触发帮助 */
  (e: 'long-press-help'): void;
}>();

const props = withDefaults(
  defineProps<{
    /** 水平满屏拖动映射秒数 */
    seekMaxSec?: number;
    sensitivity?: 'low' | 'medium' | 'high';
    /** OPT-10：是否启用触摸光晕反馈 */
    touchGlow?: boolean;
  }>(),
  { seekMaxSec: 90, sensitivity: 'medium', touchGlow: true },
);

const player = usePlayerStore();
const layerRef = ref<HTMLElement | null>(null);

let recognizer: GestureRecognizer | null = null;

// OPT-10：长按检测
const LONG_PRESS_MS = 2000;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressTriggered = false;
let longPressStartX = 0;
let longPressStartY = 0;
const LONG_PRESS_MOVE_THRESHOLD = 10; // 移动超过此距离取消长按

// OPT-10：触摸光晕
const touchGlowVisible = ref(false);
const touchGlowX = ref(0);
const touchGlowY = ref(0);

function ctx(): GestureContext {
  const el = layerRef.value;
  return {
    width: el?.clientWidth ?? 360,
    height: el?.clientHeight ?? 640,
    currentTime: player.currentTime,
    duration: player.duration,
    volume: Math.min(100, Math.max(0, player.volume)),
    brightness: dimOpacityToBrightness(player.dim),
    seekMaxSec: props.seekMaxSec,
    sensitivity: props.sensitivity,
  };
}

function ensureRecognizer(): GestureRecognizer {
  if (!recognizer) {
    recognizer = new GestureRecognizer({
      onIntent: (intent) => {
        emit('intent', intent);
      },
    });
  }
  return recognizer;
}

function onPointerDown(ev: PointerEvent): void {
  // 显式捕获：保证滑出层/跨到控制条时仍能收到 move/up，避免 sample 残留
  (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
  ensureRecognizer().pointerDown({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY }, ctx());

  // OPT-10：启动长按检测
  longPressTriggered = false;
  longPressStartX = ev.clientX;
  longPressStartY = ev.clientY;
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = setTimeout(() => {
    if (!longPressTriggered) {
      longPressTriggered = true;
      // REV-09 修复：2000ms 帮助浮层触发时，主动取消 recognizer 的长按倍速手势
      recognizer?.cancelActiveGesture();
      emit('long-press-help');
    }
  }, LONG_PRESS_MS);

  // OPT-10：触摸光晕
  if (props.touchGlow) {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    touchGlowX.value = ev.clientX - rect.left;
    touchGlowY.value = ev.clientY - rect.top;
    touchGlowVisible.value = true;
  }
}

function clearLongPressTimer(): void {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

function onPointerMove(ev: PointerEvent): void {
  ensureRecognizer().pointerMove({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY }, ctx());

  // REV-10：如果 recognizer 已进入确定手势模式，取消长按帮助计时器
  if (recognizer && recognizer.getMode() !== 'undetermined' && recognizer.getMode() !== 'none') {
    clearLongPressTimer();
  }

  // OPT-10：移动超过阈值取消长按
  if (longPressTimer && !longPressTriggered) {
    const dx = ev.clientX - longPressStartX;
    const dy = ev.clientY - longPressStartY;
    if (Math.sqrt(dx * dx + dy * dy) > LONG_PRESS_MOVE_THRESHOLD) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  // OPT-10：更新光晕位置
  if (props.touchGlow && touchGlowVisible.value) {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    touchGlowX.value = ev.clientX - rect.left;
    touchGlowY.value = ev.clientY - rect.top;
  }
}

function onPointerUp(ev: PointerEvent): void {
  (ev.currentTarget as HTMLElement | null)?.releasePointerCapture?.(ev.pointerId);
  ensureRecognizer().pointerUp({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY });

  // OPT-10：清理长按计时器
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  touchGlowVisible.value = false;
}

function onPointerCancel(ev: PointerEvent): void {
  ensureRecognizer().pointerCancel({ pointerId: ev.pointerId });

  // OPT-10：清理
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
  touchGlowVisible.value = false;
}

// OPT-10：组件卸载时清理
onBeforeUnmount(() => {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
});

defineExpose({ destroy: () => recognizer?.destroy() });
</script>

<template>
  <div
    ref="layerRef"
    class="gesture-layer"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @contextmenu.prevent
  >
    <!-- OPT-10：触摸光晕反馈 -->
    <div
      v-if="touchGlow && touchGlowVisible"
      class="gesture-touch-glow"
      :style="{
        left: `${touchGlowX}px`,
        top: `${touchGlowY}px`,
      }"
      aria-hidden="true"
    />
  </div>
</template>

<style scoped>
.gesture-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  touch-action: none;
  background: transparent;
  overflow: hidden;
}

/* OPT-10：触摸光晕 */
.gesture-touch-glow {
  position: absolute;
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    rgba(240, 168, 46, 0.25) 0%,
    rgba(240, 168, 46, 0.08) 40%,
    transparent 70%
  );
  transform: translate(-50%, -50%);
  pointer-events: none;
  animation: touch-glow-pulse 600ms ease-out;
}

@keyframes touch-glow-pulse {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.5);
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.6;
    transform: translate(-50%, -50%) scale(1);
  }
}
</style>
