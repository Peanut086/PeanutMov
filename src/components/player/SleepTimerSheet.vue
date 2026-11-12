<script setup lang="ts">
/**
 * 睡眠定时面板（B3）
 *
 * 分钟档按真实时间走（暂停也照算），另给一档「播完本集」——
 * 追剧睡前最常用的其实不是掐分钟，而是「这集看完就睡」。
 */
import BottomSheet from '@/components/common/BottomSheet.vue';
import { SLEEP_TIMER_MINUTES, type SleepTimerChoice } from '@/composables/useSleepTimer';

const props = defineProps<{
  modelValue: boolean;
  choice: SleepTimerChoice | null;
  /** 剩余秒数，用于在分钟档上显示倒计时 */
  remainingSec: number;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'minutes', minutes: number): void;
  (e: 'finishEpisode'): void;
  (e: 'cancel'): void;
}>();

function close(): void {
  emit('update:modelValue', false);
}

function remainingText(minutes: number): string {
  if (props.choice !== minutes || props.remainingSec <= 0) return '';
  const m = Math.floor(props.remainingSec / 60);
  const s = props.remainingSec % 60;
  return `剩余 ${m}:${String(s).padStart(2, '0')}`;
}
</script>

<template>
  <BottomSheet :model-value="modelValue" title="睡眠定时" @update:model-value="emit('update:modelValue', $event)">
    <p class="sleep-desc">到点自动暂停。分钟档按真实时间计算，暂停中也继续走。</p>

    <div class="sleep-grid">
      <button
        v-for="minutes in SLEEP_TIMER_MINUTES"
        :key="minutes"
        class="sleep-chip"
        :class="{ 'sleep-chip--active': choice === minutes }"
        type="button"
        @click="emit('minutes', minutes); close()"
      >
        <span class="sleep-chip__value">{{ minutes }}</span>
        <span class="sleep-chip__unit">分钟</span>
        <span v-if="remainingText(minutes)" class="sleep-chip__left">{{ remainingText(minutes) }}</span>
      </button>

      <button
        class="sleep-chip sleep-chip--wide"
        :class="{ 'sleep-chip--active': choice === 'episode' }"
        type="button"
        @click="emit('finishEpisode'); close()"
      >
        <span class="sleep-chip__value">播完本集</span>
        <span class="sleep-chip__unit">本集结束后停止，不再连播</span>
      </button>
    </div>

    <template #footer>
      <button class="btn btn--ghost btn--md sleep-off" type="button" :disabled="choice === null" @click="emit('cancel'); close()">
        关闭定时
      </button>
    </template>
  </BottomSheet>
</template>

<style scoped>
.sleep-desc {
  padding-bottom: var(--space-4);
  color: var(--color-text-secondary);
  font: var(--text-label);
}

.sleep-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
}

.sleep-chip {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 76px;
  padding: var(--space-2);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background-color: var(--color-bg-pressed);
  color: var(--color-text-primary);
  transition: border-color var(--duration-base) var(--ease-standard),
    background-color var(--duration-base) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}

.sleep-chip:active {
  transform: scale(0.96);
}

.sleep-chip--wide {
  grid-column: span 3;
  min-height: 64px;
}

.sleep-chip--active {
  border-color: var(--color-brand);
  background-color: color-mix(in srgb, var(--color-brand) 16%, transparent);
}

.sleep-chip__value {
  font: var(--text-title-3);
}

.sleep-chip--active .sleep-chip__value {
  color: var(--color-brand-text);
}

.sleep-chip__unit {
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.sleep-chip__left {
  color: var(--color-brand-text);
  font: var(--text-caption);
  font-variant-numeric: tabular-nums;
}

.sleep-off {
  width: 100%;
}

@media (prefers-reduced-motion: reduce) {
  .sleep-chip {
    transition: none;
  }

  .sleep-chip:active {
    transform: none;
  }
}
</style>