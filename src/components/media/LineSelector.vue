<script setup lang="ts">
/**
 * 线路选择器（详情页 / 播放页）
 *
 * 形态：SegmentedControl（≤4 条线路）或 BottomSheet 列表（>4 条）。
 * 切换后保持当前集号（AC-31 的 UI 侧保证）。
 */
import { computed, ref } from 'vue';

import type { PlayLine } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';

const props = defineProps<{
  lines: PlayLine[];
  modelValue: string | null;
}>();

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const sheetOpen = ref(false);

const useSegmented = computed(() => props.lines.length > 0 && props.lines.length <= 4);

const options = computed(() =>
  props.lines.map((l) => ({
    value: l.id,
    label: l.quality ? `${l.name}` : l.name,
  })),
);

const currentName = computed(() => {
  const line = props.lines.find((l) => l.id === props.modelValue);
  return line?.name ?? '默认线路';
});

function choose(id: string): void {
  if (id === props.modelValue) return;
  emit('update:modelValue', id);
}

function chooseFromSheet(id: string): void {
  choose(id);
  sheetOpen.value = false;
}
</script>

<template>
  <div class="line-selector">
    <template v-if="lines.length === 0">
      <span class="line-selector__empty">暂无线路</span>
    </template>

    <SegmentedControl
      v-else-if="useSegmented"
      :model-value="modelValue ?? lines[0]!.id"
      :options="options"
      label="播放线路"
      @update:model-value="choose"
    />

    <button v-else class="line-selector__trigger" type="button" @click="sheetOpen = true">
      <span class="line-selector__label">线路</span>
      <span class="line-selector__value">{{ currentName }}</span>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="m6 9.5 6 6 6-6" />
      </svg>
    </button>

    <BottomSheet v-model="sheetOpen" title="选择线路">
      <ul class="line-list">
        <li v-for="line in lines" :key="line.id">
          <button
            class="line-list__item"
            :class="{ 'line-list__item--active': line.id === modelValue }"
            type="button"
            @click="chooseFromSheet(line.id)"
          >
            <span class="line-list__name">{{ line.name }}</span>
            <span v-if="line.quality" class="line-list__quality">{{ line.quality }}</span>
            <span v-if="line.id === modelValue" class="line-list__current">当前</span>
          </button>
        </li>
      </ul>
    </BottomSheet>
  </div>
</template>

<style scoped>
.line-selector {
  display: inline-flex;
  align-items: center;
}

.line-selector__empty {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.line-selector__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--text-label-strong);
}

.line-selector__trigger svg {
  width: 16px;
  height: 16px;
}

.line-selector__label {
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

.line-selector__value {
  color: var(--color-brand-text);
}

.line-list {
  display: flex;
  flex-direction: column;
}

.line-list__item {
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

.line-list__item--active {
  color: var(--color-brand-text);
}

.line-list__name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.line-list__quality {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.line-list__current {
  font: var(--text-caption);
  color: var(--color-brand-text);
}
</style>
