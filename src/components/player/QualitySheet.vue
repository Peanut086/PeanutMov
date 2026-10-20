<script setup lang="ts">
/** 清晰度选择（HLS 多码率；无多码率时提示说明） */
import BottomSheet from '@/components/common/BottomSheet.vue';

defineProps<{
  modelValue: boolean;
  quality: string;
  /** 可选档位（不含 auto） */
  levels: string[];
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'select', quality: string): void;
}>();

function choose(quality: string): void {
  emit('select', quality);
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="清晰度"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <ul class="quality-list">
      <li>
        <button
          class="quality-item"
          :class="{ 'quality-item--active': quality === 'auto' }"
          type="button"
          @click="choose('auto')"
        >
          <span>自动</span>
          <span class="quality-item__hint">按网络与画面自适应</span>
          <span v-if="quality === 'auto'" class="quality-item__check">当前</span>
        </button>
      </li>
      <li v-for="level in levels" :key="level">
        <button
          class="quality-item"
          :class="{ 'quality-item--active': quality === level }"
          type="button"
          @click="choose(level)"
        >
          <span>{{ level }}</span>
          <span v-if="quality === level" class="quality-item__check">当前</span>
        </button>
      </li>
    </ul>

    <p v-if="levels.length === 0" class="quality-empty">
      当前线路只有单一清晰度。多码率 HLS 源可在此切换档位。
    </p>
  </BottomSheet>
</template>

<style scoped>
.quality-list {
  display: flex;
  flex-direction: column;
}

.quality-item {
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

.quality-item--active {
  color: var(--color-brand-text);
}

.quality-item__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.quality-item__check {
  margin-left: auto;
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.quality-empty {
  padding: var(--space-4) var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-align: center;
}
</style>
