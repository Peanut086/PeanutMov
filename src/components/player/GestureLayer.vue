<script setup lang="ts">
/**
 * 手势层（技术方案 9.3 / 设计规范 12.1）
 *
 * 只负责把 Pointer 事件转成 `GestureRecognizer` 的调用，并把 intent 抛给父级。
 * 位于控制条下层（z-index 更低），控制条按钮优先响应。
 *
 * 由于 recognizer 是纯类，本组件保持"薄"：无业务判断，便于调试与替换。
 */
import { ref } from 'vue';

import { usePlayerStore } from '@/stores/playerStore';
import { GestureRecognizer, type GestureIntent, type GestureContext } from '@/player/GestureRecognizer';
import { dimOpacityToBrightness } from '@/player/brightness';

const emit = defineEmits<{ (e: 'intent', intent: GestureIntent): void }>();

const props = withDefaults(
  defineProps<{
    /** 水平满屏拖动映射秒数 */
    seekMaxSec?: number;
    sensitivity?: 'low' | 'medium' | 'high';
  }>(),
  { seekMaxSec: 90, sensitivity: 'medium' },
);

const player = usePlayerStore();
const layerRef = ref<HTMLElement | null>(null);

let recognizer: GestureRecognizer | null = null;

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
      onIntent: (intent) => emit('intent', intent),
    });
  }
  return recognizer;
}

function onPointerDown(ev: PointerEvent): void {
  // 显式捕获：保证滑出层/跨到控制条时仍能收到 move/up，避免 sample 残留
  (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);
  ensureRecognizer().pointerDown({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY }, ctx());
}

function onPointerMove(ev: PointerEvent): void {
  ensureRecognizer().pointerMove({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY }, ctx());
}

function onPointerUp(ev: PointerEvent): void {
  (ev.currentTarget as HTMLElement | null)?.releasePointerCapture?.(ev.pointerId);
  ensureRecognizer().pointerUp({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY });
}

function onPointerCancel(ev: PointerEvent): void {
  ensureRecognizer().pointerCancel({ pointerId: ev.pointerId });
}

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
  />
</template>

<style scoped>
.gesture-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  touch-action: none;
  background: transparent;
}
</style>
