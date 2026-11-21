<script setup lang="ts">
/**
 * 色相条（G-B01）
 *
 * 一条 0°~360° 的连续色相尺：拖动或方向键选中心色，窗口（半角度 `window`）画成尺上的
 * 亮区，区外压暗。整条尺是一个 `role="slider"`，键盘可操作。
 *
 * 只做输入与呈现，不碰数据：命中判定在 `useHueWall`，页面把 `update:hue` 写回 ref。
 */
import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    /** 中心色相（0~360） */
    hue: number;
    /** 窗口半宽（度）；≥360 表示不收拢 */
    window: number;
    label?: string;
  }>(),
  { label: '色相' },
);

const emit = defineEmits<{ (e: 'update:hue', value: number): void }>();

const HUE_STOPS = [
  { hue: 0, name: '红' },
  { hue: 60, name: '黄' },
  { hue: 120, name: '绿' },
  { hue: 180, name: '青' },
  { hue: 240, name: '蓝' },
  { hue: 300, name: '品' },
];

interface Range {
  a: number;
  b: number;
}

const trackRef = ref<HTMLElement | null>(null);
const dragging = ref(false);

const full = computed(() => props.window >= 360);
const pct = (deg: number): string => `${(deg / 360) * 100}%`;

/** 窗口区间：跨过 0°/360° 边界时拆成两段——色相是环，但尺是直的 */
const windowRanges = computed<Range[]>(() => {
  if (full.value) return [];
  const from = props.hue - props.window;
  const to = props.hue + props.window;
  if (to <= 360 && from >= 0) return [{ a: from, b: to }];
  const parts: Range[] = [];
  if (from < 0) parts.push({ a: 0, b: Math.min(360, to) }, { a: from + 360, b: 360 });
  else parts.push({ a: from, b: 360 }, { a: 0, b: Math.min(360, to - 360) });
  return parts.filter((part) => part.b > part.a);
});

/** 压暗区 = 窗口在 [0,360) 上的补集 */
const dimRanges = computed<Range[]>(() => {
  if (full.value) return [];
  const sorted = [...windowRanges.value].sort((x, y) => x.a - y.a);
  const out: Range[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.a > cursor) out.push({ a: cursor, b: range.a });
    cursor = Math.max(cursor, range.b);
  }
  if (cursor < 360) out.push({ a: cursor, b: 360 });
  return out;
});

function setFromEvent(ev: PointerEvent): void {
  const el = trackRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
  emit('update:hue', (ratio * 360) % 360);
}

function onPointerDown(ev: PointerEvent): void {
  (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  dragging.value = true;
  setFromEvent(ev);
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging.value) return;
  setFromEvent(ev);
}

function onPointerUp(ev: PointerEvent): void {
  dragging.value = false;
  (ev.currentTarget as HTMLElement).releasePointerCapture?.(ev.pointerId);
}

function onKeydown(ev: KeyboardEvent): void {
  const step = ev.shiftKey ? 30 : 6;
  let next: number | null = null;
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') next = props.hue + step;
  else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') next = props.hue - step;
  else if (ev.key === 'Home') next = 0;
  else if (ev.key === 'End') next = 354;
  if (next === null) return;
  ev.preventDefault();
  emit('update:hue', ((next % 360) + 360) % 360);
}
</script>

<template>
  <div class="hue-spectrum">
    <div
      ref="trackRef"
      class="hue-spectrum__track"
      role="slider"
      tabindex="0"
      :aria-label="label"
      aria-valuemin="0"
      aria-valuemax="360"
      :aria-valuenow="Math.round(props.hue)"
      :aria-valuetext="`${Math.round(props.hue)} 度${full ? '（全部）' : ''}`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @keydown="onKeydown"
    >
      <span
        v-for="(range, index) in dimRanges"
        :key="`dim-${index}`"
        class="hue-spectrum__dim"
        aria-hidden="true"
        :style="{ left: pct(range.a), width: `${((range.b - range.a) / 360) * 100}%` }"
      />
      <span
        v-for="(range, index) in windowRanges"
        :key="`win-${index}`"
        class="hue-spectrum__window"
        aria-hidden="true"
        :style="{ left: pct(range.a), width: `${((range.b - range.a) / 360) * 100}%` }"
      />
      <span class="hue-spectrum__knob" aria-hidden="true" :style="{ left: pct(props.hue) }" />
    </div>
    <div class="hue-spectrum__scale" aria-hidden="true">
      <span v-for="stop in HUE_STOPS" :key="stop.hue" :style="{ left: pct(stop.hue) }">
        {{ stop.name }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.hue-spectrum {
  padding-bottom: 14px;
}

/* 44 高：既是命中区，也让彩虹真的看得清 */
.hue-spectrum__track {
  position: relative;
  height: 44px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: linear-gradient(
    90deg,
    hsl(0 78% 52%),
    hsl(30 78% 52%),
    hsl(60 78% 52%),
    hsl(90 78% 52%),
    hsl(120 78% 52%),
    hsl(150 78% 52%),
    hsl(180 78% 52%),
    hsl(210 78% 52%),
    hsl(240 78% 52%),
    hsl(270 78% 52%),
    hsl(300 78% 52%),
    hsl(330 78% 52%),
    hsl(360 78% 52%)
  );
  overflow: hidden;
  touch-action: none;
  cursor: ew-resize;
}

.hue-spectrum__track:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

.hue-spectrum__dim {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.52);
  pointer-events: none;
}

.hue-spectrum__window {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid rgba(255, 255, 255, 0.75);
  border-right: 1px solid rgba(255, 255, 255, 0.75);
  background: rgba(255, 255, 255, 0.18);
  pointer-events: none;
}

.hue-spectrum__knob {
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 12px;
  border-radius: var(--radius-full);
  background: #ffffff;
  box-shadow: var(--shadow-2);
  transform: translateX(-50%);
  pointer-events: none;
}

.hue-spectrum__scale {
  position: relative;
  height: 12px;
  margin-top: 4px;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.hue-spectrum__scale span {
  position: absolute;
  transform: translateX(-50%);
}
</style>
