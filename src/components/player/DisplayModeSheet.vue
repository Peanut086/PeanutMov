<script setup lang="ts">
/** 画面比例选择（P1 画面比例配置） */
import BottomSheet from '@/components/common/BottomSheet.vue';
import type { ResizeMode } from '@/types';

defineProps<{
  modelValue: boolean;
  mode: ResizeMode;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'select', mode: ResizeMode): void;
}>();

const MODES: Array<{ value: ResizeMode; label: string; hint: string }> = [
  { value: 'contain', label: '适应', hint: '完整显示，留黑边' },
  { value: 'cover', label: '铺满', hint: '裁剪边缘，不变形' },
  { value: 'fill', label: '拉伸', hint: '填满屏幕，会变形' },
];

function choose(mode: ResizeMode): void {
  emit('select', mode);
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="画面比例"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <ul class="mode-list">
      <li v-for="item in MODES" :key="item.value">
        <button
          class="mode-item"
          :class="{ 'mode-item--active': mode === item.value }"
          type="button"
          @click="choose(item.value)"
        >
          <span>{{ item.label }}</span>
          <span class="mode-item__hint">{{ item.hint }}</span>
          <span v-if="mode === item.value" class="mode-item__check">当前</span>
        </button>
      </li>
    </ul>
  </BottomSheet>
</template>

<style scoped>
.mode-list {
  display: flex;
  flex-direction: column;
}

.mode-item {
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

.mode-item--active {
  color: var(--color-brand-text);
}

.mode-item__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.mode-item__check {
  margin-left: auto;
  font: var(--text-caption);
  color: var(--color-brand-text);
}
</style>
