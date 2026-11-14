<script setup lang="ts">
/**
 * 手势层（技术方案 9.3 / 设计规范 12.1）
 *
 * 只负责把 Pointer 事件转成 `GestureRecognizer` 的调用，并把 intent 抛给父级。
 * 位于控制条下层（z-index 更低），控制条按钮优先响应。
 *
 * 由于 recognizer 是纯类，本组件保持"薄"：无业务判断，便于调试与替换。
 *
 * OPT-10：增加触摸视觉反馈（光晕）。长按（含升级为帮助浮层）的时序统一由
 * `GestureRecognizer` 裁决，本层不再自建第二份长按计时器。
 */
import { ref, onBeforeUnmount } from 'vue';

import { usePlayerStore } from '@/stores/playerStore';
import { GestureRecognizer, type GestureIntent, type GestureContext } from '@/player/GestureRecognizer';
import { clampBrightness } from '@/player/brightness';

const emit = defineEmits<{
  (e: 'intent', intent: GestureIntent): void;
  /** 按下瞬间：父级用它刷新可能已被实体音量键改动的基准值 */
  (e: 'pointer-down'): void;
}>();

const props = withDefaults(
  defineProps<{
    /** 水平满屏拖动映射秒数 */
    seekMaxSec?: number;
    sensitivity?: 'low' | 'medium' | 'high';
    /** OPT-10：是否启用触摸光晕反馈 */
    touchGlow?: boolean;
    /** 允许把「按住不动」升级为手势帮助 */
    longPressHelpEnabled?: boolean;
  }>(),
  { seekMaxSec: 90, sensitivity: 'medium', touchGlow: true, longPressHelpEnabled: false },
);

const player = usePlayerStore();
const layerRef = ref<HTMLElement | null>(null);

let recognizer: GestureRecognizer | null = null;

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
    brightness: clampBrightness(player.brightness),
    seekMaxSec: props.seekMaxSec,
    sensitivity: props.sensitivity,
    longPressHelpEnabled: props.longPressHelpEnabled,
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
  // 先通知父级校准基准：系统音量在按下前一刻仍可能被实体按键改动
  emit('pointer-down');
  ensureRecognizer().pointerDown({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY }, ctx());

  // OPT-10：触摸光晕
  if (props.touchGlow) {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    touchGlowX.value = ev.clientX - rect.left;
    touchGlowY.value = ev.clientY - rect.top;
    touchGlowVisible.value = true;
  }
}

function onPointerMove(ev: PointerEvent): void {
  ensureRecognizer().pointerMove({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY }, ctx());

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
  touchGlowVisible.value = false;
}

function onPointerCancel(ev: PointerEvent): void {
  ensureRecognizer().pointerCancel({ pointerId: ev.pointerId });
  touchGlowVisible.value = false;
}

// REV-12：卸载时销毁 recognizer，避免残留计时器把 intent 打到已卸载实例
onBeforeUnmount(() => {
  recognizer?.destroy();
  recognizer = null;
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
