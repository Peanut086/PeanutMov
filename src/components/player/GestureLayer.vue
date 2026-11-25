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
 *
 * G-A09：`pinch` 打开后，第二指落下即进入捏合会话——会话内单指手势先撤销干净，
 * 之后落下的手指只交给 `PinchResizeRecognizer`（不再起新的单指样本）。但
 * `pointerup`/`pointercancel` 两个识别器都要收到：捏合只管两指间距的几何，
 * 手势归属仍由单指识别器裁决，否则被跟踪的那根手指离开时没人收尾长按倍速。
 * 关掉该 prop 时，本层的分发与升级前一致。`pinch-start-mode` 只告诉识别器尺从哪一档起手，
 * 本层不据此做任何判断。
 */
import { ref, onBeforeUnmount } from 'vue';

import { usePlayerStore } from '@/stores/playerStore';
import { GestureRecognizer, type GestureIntent, type GestureContext } from '@/player/GestureRecognizer';
import { PinchResizeRecognizer } from '@/player/PinchResizeRecognizer';
import { clampBrightness } from '@/player/brightness';
import type { ResizeMode } from '@/types';

const emit = defineEmits<{
  (e: 'intent', intent: GestureIntent): void;
  /** 按下瞬间：父级用它刷新可能已被实体音量键改动的基准值 */
  (e: 'pointer-down'): void;
  (e: 'pinch-sample', pos: number, mode: ResizeMode): void;
  (e: 'pinch-end', mode: ResizeMode | null, pos: number, reason: 'up' | 'cancel'): void;
}>();

const props = withDefaults(
  defineProps<{
    /** 水平满屏拖动映射秒数 */
    seekMaxSec?: number;
    /** 定位不可靠时取消水平拖动，不影响音量/亮度 */
    seekEnabled?: boolean;
    sensitivity?: 'low' | 'medium' | 'high';
    /** OPT-10：是否启用触摸光晕反馈 */
    touchGlow?: boolean;
    /** 允许把「按住不动」升级为手势帮助 */
    longPressHelpEnabled?: boolean;
    /** G-A09：是否启用双指捏合切画幅 */
    pinch?: boolean;
    /** G-A09：捏合尺的起手档位 */
    pinchStartMode?: ResizeMode;
  }>(),
  {
    seekMaxSec: 90,
    seekEnabled: true,
    sensitivity: 'medium',
    touchGlow: true,
    longPressHelpEnabled: false,
    pinch: false,
    pinchStartMode: 'contain',
  },
);

const player = usePlayerStore();
const layerRef = ref<HTMLElement | null>(null);

let recognizer: GestureRecognizer | null = null;
let pinch: PinchResizeRecognizer | null = null;

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
    seekEnabled: props.seekEnabled,
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

function ensurePinch(): PinchResizeRecognizer {
  if (!pinch) {
    pinch = new PinchResizeRecognizer(
      {
        onSample: (pos, mode) => emit('pinch-sample', pos, mode),
        onEnd: (mode, pos, reason) => emit('pinch-end', mode, pos, reason),
      },
      () => props.pinchStartMode,
    );
  }
  return pinch;
}

/**
 * 捏合接管画面：在飞的单指手势必须撤销干净。
 *
 * 用 `pointerCancel` 而不是直接丢弃样本——它会把长按倍速收尾、把在飞的 seek 派发成
 * `seek-cancel`，否则第二指落下后倍速会一直挂着，或抬手时补一次莫名其妙的跳转。
 */
function abandonSinglePointerGestures(): void {
  recognizer?.cancelAll();
  touchGlowVisible.value = false;
}

function onPointerDown(ev: PointerEvent): void {
  // 显式捕获：保证滑出层/跨到控制条时仍能收到 move/up，避免 sample 残留
  (ev.currentTarget as HTMLElement | null)?.setPointerCapture?.(ev.pointerId);

  if (props.pinch) {
    const p = ensurePinch();
    // 会话中追加的手指：既不参与捏合几何（基准仍是最初两指），也不再喂给单指识别器
    if (p.inSession) return;
    // 会话刚由本指建立：单指手势已经撤销干净，本指也必须留在这里，
    // 否则它自己会再起一份长按计时器，把捏合按成"按住不动=2 倍速"。
    if (p.pointerDown(ev.pointerId, ev.clientX, ev.clientY)) {
      abandonSinglePointerGestures();
      return;
    }
  }

  // 先通知父级校准基准：系统音量在按下前一刻仍可能被实体按键改动
  emit('pointer-down');
  ensureRecognizer().pointerDown(
    { pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY, isPrimary: ev.isPrimary },
    ctx(),
  );

  // OPT-10：触摸光晕
  if (props.touchGlow) {
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    touchGlowX.value = ev.clientX - rect.left;
    touchGlowY.value = ev.clientY - rect.top;
    touchGlowVisible.value = true;
  }
}

function onPointerMove(ev: PointerEvent): void {
  if (props.pinch && ensurePinch().pointerMove(ev.pointerId, ev.clientX, ev.clientY)) return;
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
  // 抬手/取消必须先交单指识别器：捏合只拥有两指间距的几何，不拥有手势所有权。
  // 早先是"捏合认领了就 return"，于是被跟踪的那根手指的 pointerup 永远送不到，
  // 在飞的长按倍速与提示就挂成 60 分钟，识别器也再不收新手指（画面点什么都没人应答）。
  ensureRecognizer().pointerUp({ pointerId: ev.pointerId, clientX: ev.clientX, clientY: ev.clientY });
  touchGlowVisible.value = false;
  if (props.pinch) ensurePinch().pointerUp(ev.pointerId);
}

function onPointerCancel(ev: PointerEvent): void {
  ensureRecognizer().pointerCancel({ pointerId: ev.pointerId });
  touchGlowVisible.value = false;
  if (props.pinch) ensurePinch().pointerCancel(ev.pointerId);
}

// REV-12：卸载时销毁 recognizer，避免残留计时器把 intent 打到已卸载实例
onBeforeUnmount(() => {
  recognizer?.destroy();
  recognizer = null;
  // 会话还没收尾就被拆掉（锁屏把本层 v-if 掉、切页）：通知上层还原画面并收起画幅尺
  if (pinch?.inSession) emit('pinch-end', null, 0, 'cancel');
  pinch?.reset();
  pinch = null;
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
