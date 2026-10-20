<script setup lang="ts">
/** 倍速选择（播放器） */
import type { PlaybackRate } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import { RATE_OPTIONS } from '@/player/constants';

defineProps<{ modelValue: boolean; rate: PlaybackRate }>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'select', rate: PlaybackRate): void;
}>();

function choose(rate: PlaybackRate): void {
  emit('select', rate);
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="播放速度"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <ul class="rate-list">
      <li v-for="option in RATE_OPTIONS" :key="option">
        <button
          class="rate-list__item"
          :class="{ 'rate-list__item--active': option === rate }"
          type="button"
          @click="choose(option)"
        >
          <span>{{ option }}x</span>
          <span v-if="option === 1" class="rate-list__hint">正常</span>
          <span v-if="option === rate" class="rate-list__check">当前</span>
        </button>
      </li>
    </ul>
  </BottomSheet>
</template>

<style scoped>
.rate-list {
  display: flex;
  flex-direction: column;
}

.rate-list__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.rate-list__item--active {
  color: var(--color-brand-text);
}

.rate-list__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.rate-list__check {
  margin-left: auto;
  font: var(--text-caption);
  color: var(--color-brand-text);
}
</style>
