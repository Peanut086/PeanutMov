<script setup lang="ts">
/**
 * 双指捏合的画幅尺（G-A09）。
 *
 * 三档停在尺上的 0 / 50% / 100%，滑块跟着手指连续走，抬手后由 `usePinchResize`
 * 用弹簧把它甩到最近的停靠位。未被选中的两档保持可读但压暗，是为了让人知道
 * 「尺两头还有东西」，而不是只有中间这一格。
 *
 * 纯呈现层：不接 Pinia、不判断手势，`pointer-events: none`，因此不会吃掉任何触摸。
 */
import type { ResizeMode } from '@/types';
import { DISPLAY_MODE_OPTIONS, displayModeLabel } from '@/player/displayModes';
import { MODE_ANCHORS } from '@/player/PinchResizeRecognizer';

const props = defineProps<{
  /** 0~1 的画幅尺位置 */
  pos: number;
  /** 当前吸附到的档位 */
  mode: ResizeMode;
}>();
</script>

<template>
  <div class="pinch-hud" role="status" aria-live="polite">
    <p class="pinch-hud__title">画幅 · {{ displayModeLabel(props.mode) }}</p>
    <div class="pinch-hud__rail">
      <span
        v-for="item in DISPLAY_MODE_OPTIONS"
        :key="item.value"
        class="pinch-hud__notch"
        :class="{
          'pinch-hud__notch--on': item.value === props.mode,
          'pinch-hud__notch--left': MODE_ANCHORS[item.value] <= 0,
          'pinch-hud__notch--right': MODE_ANCHORS[item.value] >= 1,
        }"
        :style="{ left: `${MODE_ANCHORS[item.value] * 100}%` }"
      >
        {{ item.label }}
      </span>
      <i class="pinch-hud__marker" aria-hidden="true" :style="{ left: `${props.pos * 100}%` }" />
    </div>
    <p class="pinch-hud__hint">双指张合调节，松手吸附</p>
  </div>
</template>

<style scoped>
/* 与 .pl-hud 同一座岛：恒定暗色玻璃层，读播放器局部 token，不跟随浅色皮肤 */
.pinch-hud {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: calc(var(--z-hud) + 1);
  display: flex;
  flex-direction: column;
  gap: var(--s1);
  width: min(62vw, 320px);
  padding: var(--s3) var(--s4) var(--s4);
  border: 1px solid var(--glass-line);
  border-radius: var(--r-lg);
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: var(--blur-glass);
  -webkit-backdrop-filter: var(--blur-glass);
  transform: translate(-50%, -50%);
  pointer-events: none;
  animation: pinch-hud-in var(--d-fast) var(--ease-out);
}

.pinch-hud__title {
  margin: 0;
  font: var(--t-17);
  color: var(--brand);
  text-align: center;
}

.pinch-hud__rail {
  position: relative;
  height: var(--track-h);
  margin: var(--s4) var(--s5) var(--s5);
  border-radius: var(--r-pill);
  background: var(--ov-track);
}

.pinch-hud__notch {
  position: absolute;
  top: var(--s3);
  font: var(--t-12);
  color: var(--tx-3);
  white-space: nowrap;
  transform: translateX(-50%);
  transition: color var(--d-fast) var(--ease-out);
}

/* 尺端两档贴边对齐：居中的话标签有一半会被挤出尺外 */
.pinch-hud__notch--left {
  transform: none;
}

.pinch-hud__notch--right {
  transform: translateX(-100%);
}

.pinch-hud__notch--on {
  color: var(--ov-fill);
}

.pinch-hud__marker {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--brand);
  box-shadow: var(--sh-2);
  transform: translate(-50%, -50%);
}

.pinch-hud__hint {
  margin: 0;
  font: var(--t-12);
  color: var(--tx-3);
  text-align: center;
}

@keyframes pinch-hud-in {
  from {
    opacity: 0;
    transform: translate(-50%, -46%);
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%);
  }
}
</style>
