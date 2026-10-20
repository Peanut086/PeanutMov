<script setup lang="ts">
/**
 * 分段选择器（设计规范 8.3）
 *
 * 2–4 项互斥；容器 36 高、内边距 3，选中块 elevated + shadow-1。
 * 只做背景色过渡（无滑块位移），降低实现复杂度。
 */
export interface SegmentedOption {
  value: string;
  label: string;
  disabled?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: SegmentedOption[];
    /** 无障碍组标签 */
    label?: string;
    /** 是否等分宽度（默认自适应） */
    block?: boolean;
  }>(),
  { label: '选项', block: false },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

function choose(opt: SegmentedOption): void {
  if (opt.disabled || opt.value === props.modelValue) return;
  emit('update:modelValue', opt.value);
}
</script>

<template>
  <div class="segmented" :class="{ 'segmented--block': block }" role="group" :aria-label="label">
    <button
      v-for="opt in options"
      :key="opt.value"
      class="segmented__item"
      :class="{ 'segmented__item--active': opt.value === modelValue }"
      type="button"
      role="radio"
      :aria-checked="opt.value === modelValue"
      :disabled="opt.disabled"
      @click="choose(opt)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.segmented {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 36px;
  padding: 3px;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-sunken);
}

.segmented--block {
  display: flex;
  width: 100%;
}

.segmented--block .segmented__item {
  flex: 1 1 0;
  min-width: 0;
}

.segmented__item {
  min-width: 72px;
  height: 30px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  font: var(--text-label-strong);
  font-family: var(--font-family-base);
  font-size: var(--font-size-14);
  font-weight: var(--font-weight-medium);
  line-height: 30px;
  transition: var(--transition-color);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.segmented__item--active {
  background-color: var(--color-bg-elevated);
  box-shadow: var(--shadow-1);
  color: var(--color-text-primary);
}

.segmented__item:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}
</style>
