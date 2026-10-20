<script setup lang="ts">
/**
 * 进度条（设计规范 8.12 SeekBar）
 *
 * - 轨道 3px → 拖动/悬停 5px；滑块 12px → 16px
 * - 命中区 44px（透明包裹层）
 * - 拖动中只更新本地预览值，松手才 `seek`（AC-43：误差 ≤2s）
 * - `role="slider"` + aria-valuetext
 */
import { computed, ref } from 'vue';

import { formatClock } from '@/shared/time';

const props = withDefaults(
  defineProps<{
    currentTime: number;
    duration: number;
    /** 已缓冲到的秒数 */
    buffered?: number;
    /** 是否禁用（loading/error） */
    disabled?: boolean;
  }>(),
  { buffered: 0, disabled: false },
);

const emit = defineEmits<{
  (e: 'seek', sec: number): void;
  (e: 'seeking', sec: number): void;
}>();

const trackRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
const previewSec = ref(0);

const safeDuration = computed(() => (Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 0));
const displaySec = computed(() => (dragging.value ? previewSec.value : clamp(props.currentTime, 0, safeDuration.value)));

const percent = computed(() =>
  safeDuration.value > 0 ? clamp((displaySec.value / safeDuration.value) * 100, 0, 100) : 0,
);
const bufferedPercent = computed(() =>
  safeDuration.value > 0 ? clamp((props.buffered / safeDuration.value) * 100, 0, 100) : 0,
);

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

function positionToSec(clientX: number): number {
  const el = trackRef.value;
  if (!el || safeDuration.value <= 0) return 0;
  const rect = el.getBoundingClientRect();
  const ratio = rect.width > 0 ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0;
  return ratio * safeDuration.value;
}

function onPointerDown(ev: PointerEvent): void {
  if (props.disabled || safeDuration.value <= 0) return;
  dragging.value = true;
  previewSec.value = positionToSec(ev.clientX);
  emit('seeking', previewSec.value);
  (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging.value) return;
  previewSec.value = positionToSec(ev.clientX);
  emit('seeking', previewSec.value);
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  const target = positionToSec(ev.clientX);
  previewSec.value = target;
  emit('seek', target);
}

function onKeydown(ev: KeyboardEvent): void {
  if (props.disabled) return;
  const step = ev.shiftKey ? 30 : 10;
  if (ev.key === 'ArrowLeft') {
    ev.preventDefault();
    emit('seek', clamp(props.currentTime - step, 0, safeDuration.value));
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault();
    emit('seek', clamp(props.currentTime + step, 0, safeDuration.value));
  } else if (ev.key === 'Home') {
    ev.preventDefault();
    emit('seek', 0);
  } else if (ev.key === 'End') {
    ev.preventDefault();
    emit('seek', safeDuration.value);
  }
}

const ariaText = computed(() => `${formatClock(displaySec.value)} / ${formatClock(safeDuration.value)}`);
</script>

<template>
  <div class="seekbar" :class="{ 'seekbar--dragging': dragging, 'seekbar--disabled': disabled }">
    <div
      ref="trackRef"
      class="seekbar__hit"
      role="slider"
      tabindex="0"
      :aria-valuemin="0"
      :aria-valuemax="Math.round(safeDuration)"
      :aria-valuenow="Math.round(displaySec)"
      :aria-valuetext="ariaText"
      aria-label="播放进度"
      :aria-disabled="disabled"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    >
      <div class="seekbar__track">
        <div class="seekbar__buffered" :style="{ width: `${bufferedPercent}%` }" />
        <div class="seekbar__played" :style="{ width: `${percent}%` }" />
      </div>
      <div class="seekbar__thumb" :style="{ left: `${percent}%` }" />
    </div>

    <div class="seekbar__times">
      <span class="seekbar__time">{{ formatClock(displaySec) }}</span>
      <span class="seekbar__time">{{ formatClock(safeDuration) }}</span>
    </div>
  </div>
</template>

<style scoped>
.seekbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
}

.seekbar__hit {
  position: relative;
  display: flex;
  align-items: center;
  height: 44px;
  cursor: pointer;
  touch-action: none;
}

.seekbar--disabled .seekbar__hit {
  cursor: default;
  opacity: 0.6;
}

.seekbar__track {
  position: relative;
  width: 100%;
  height: 3px;
  border-radius: var(--radius-full);
  background-color: rgba(255, 255, 255, 0.24);
  transition: height var(--duration-fast) var(--ease-standard);
}

.seekbar--dragging .seekbar__track,
.seekbar__hit:hover .seekbar__track {
  height: 5px;
}

.seekbar__buffered {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background-color: rgba(255, 255, 255, 0.4);
}

.seekbar__played {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background-color: var(--color-brand);
}

.seekbar__thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  border-radius: 50%;
  background-color: var(--color-brand);
  transform: translateY(-50%);
  transition: width var(--duration-fast) var(--ease-standard), height var(--duration-fast) var(--ease-standard);
  pointer-events: none;
}

.seekbar--dragging .seekbar__thumb {
  width: 16px;
  height: 16px;
  margin-left: -8px;
}

.seekbar__times {
  display: flex;
  justify-content: space-between;
  padding: 0 2px;
}

.seekbar__time {
  font: var(--text-caption);
  font-family: var(--font-family-number);
  color: rgba(255, 255, 255, 0.86);
}

.seekbar__hit:focus-visible {
  outline: 2px solid var(--color-brand);
  outline-offset: 4px;
  border-radius: var(--radius-sm);
}
</style>
