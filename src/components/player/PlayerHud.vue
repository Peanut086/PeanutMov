<script setup lang="ts">
/**
 * 手势浮层（设计规范「player-hud」）
 *
 * 显示：快进/后退目标时间、音量百分比、亮度百分比、长按倍速提示。
 * 仅做展示，pointer-events: none。
 */
import { computed } from 'vue';

import { formatClock } from '@/shared/time';

export type HudKind = 'seek' | 'volume' | 'brightness' | 'rate' | null;

const props = withDefaults(
  defineProps<{
    kind: HudKind;
    /** seek: 目标秒数；volume/brightness: 0~100；rate: 倍速 */
    value?: number;
    /** seek: 相对秒数（正=快进） */
    deltaSec?: number;
    rate?: number;
  }>(),
  { value: 0, deltaSec: 0, rate: 2 },
);

const title = computed(() => {
  switch (props.kind) {
    case 'seek':
      return props.deltaSec >= 0 ? '快进' : '后退';
    case 'volume':
      return props.value <= 0 ? '已静音' : '音量';
    case 'brightness':
      return props.value <= 0 ? '最低亮度' : '亮度';
    case 'rate':
      return `${props.rate}x 快进中`;
    default:
      return '';
  }
});

const mainText = computed(() => {
  switch (props.kind) {
    case 'seek':
      return formatClock(props.value);
    case 'volume':
    case 'brightness':
      return `${Math.round(props.value)}%`;
    default:
      return '';
  }
});

const subText = computed(() => {
  if (props.kind !== 'seek') return '';
  const abs = Math.abs(Math.round(props.deltaSec));
  return `${props.deltaSec >= 0 ? '+' : '-'}${abs}s`;
});

const barPercent = computed(() => {
  if (props.kind === 'volume' || props.kind === 'brightness') return Math.min(100, Math.max(0, props.value));
  return 0;
});
</script>

<template>
  <Transition name="hud">
    <div v-if="kind" class="player-hud" role="status" aria-live="polite">
      <!-- 图标 -->
      <svg
        v-if="kind === 'volume'"
        class="player-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4Z" />
        <path v-if="value > 0" d="M15.4 9a4.2 4.2 0 0 1 0 6" />
        <path v-if="value > 50" d="M18 6.6a7.6 7.6 0 0 1 0 10.8" />
        <path v-if="value <= 0" d="m15.5 9.5 4 5M19.5 9.5l-4 5" />
      </svg>
      <svg
        v-else-if="kind === 'brightness'"
        class="player-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="3.6" />
        <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5" />
      </svg>
      <svg
        v-else-if="kind === 'seek'"
        class="player-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path :d="deltaSec >= 0 ? 'M4 12h14M13 7l5 5-5 5' : 'M20 12H6M11 7l-5 5 5 5'" />
      </svg>
      <svg
        v-else
        class="player-hud__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="m6 5 8 7-8 7z" />
        <path d="m14 5 8 7-8 7z" />
      </svg>

      <span class="player-hud__title">{{ title }}</span>
      <span v-if="mainText" class="player-hud__value">{{ mainText }}</span>
      <span v-if="subText" class="player-hud__sub">{{ subText }}</span>

      <span v-if="kind === 'volume' || kind === 'brightness'" class="player-hud__bar" aria-hidden="true">
        <span class="player-hud__bar-fill" :style="{ width: `${barPercent}%` }" />
      </span>
    </div>
  </Transition>
</template>

<style scoped>
.player-hud {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  min-width: 120px;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background-color: rgba(0, 0, 0, 0.62);
  border: var(--border-default);
  backdrop-filter: var(--blur-player-hud);
  -webkit-backdrop-filter: var(--blur-player-hud);
  color: #ffffff;
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.player-hud__icon {
  width: 24px;
  height: 24px;
  margin-bottom: 2px;
}

.player-hud__title {
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.72);
}

.player-hud__value {
  font: var(--text-title-3);
  font-family: var(--font-family-number);
  color: #ffffff;
}

.player-hud__sub {
  font: var(--text-caption);
  font-family: var(--font-family-number);
  color: var(--color-brand-strong);
}

.player-hud__bar {
  display: block;
  width: 88px;
  height: 4px;
  margin-top: var(--space-1);
  border-radius: var(--radius-full);
  background-color: rgba(255, 255, 255, 0.24);
  overflow: hidden;
}

.player-hud__bar-fill {
  display: block;
  height: 100%;
  background-color: var(--color-brand);
}

.hud-enter-active,
.hud-leave-active {
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.hud-enter-from,
.hud-leave-to {
  opacity: 0;
}
</style>
