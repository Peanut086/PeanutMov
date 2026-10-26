<script setup lang="ts">
/**
 * 选择集数下载（设计规范 8.16 EpisodePickerSheet）
 *
 * 复用 BottomSheet + EpisodeChip 网格；底部固定操作条：全选 / 已选计数 / 开始下载。
 */
import { computed, ref, watch } from 'vue';

import type { Episode } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    episodes: Episode[];
    title?: string;
    /** 已下载的剧集 id（置灰） */
    downloadedIds?: string[];
    /** 下载中（禁用按钮） */
    loading?: boolean;
  }>(),
  { title: '选择集数', downloadedIds: () => [], loading: false },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'confirm', episodeIds: string[]): void;
}>();

const selected = ref<string[]>([]);

watch(
  () => props.modelValue,
  (open) => {
    if (open) selected.value = [];
  },
);

const sorted = computed(() => [...props.episodes].sort((a, b) => a.number - b.number));

const availableIds = computed(() =>
  sorted.value.filter((ep) => !props.downloadedIds.includes(ep.id)).map((ep) => ep.id),
);

const allSelected = computed(
  () => availableIds.value.length > 0 && availableIds.value.every((id) => selected.value.includes(id)),
);

function isDisabled(ep: Episode): boolean {
  return props.downloadedIds.includes(ep.id);
}

function toggle(ep: Episode): void {
  if (isDisabled(ep)) return;
  selected.value = selected.value.includes(ep.id)
    ? selected.value.filter((id) => id !== ep.id)
    : [...selected.value, ep.id];
}

function toggleAll(): void {
  selected.value = allSelected.value ? [] : [...availableIds.value];
}

function confirm(): void {
  if (selected.value.length === 0 || props.loading) return;
  emit('confirm', [...selected.value]);
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    :title="title"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="picker-head">
      <span class="picker-head__hint">共 {{ episodes.length }} 集，已下载 {{ downloadedIds.length }} 集</span>
      <button class="picker-head__all" type="button" @click="toggleAll">
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
    </div>

    <div class="picker-grid">
      <button
        v-for="ep in sorted"
        :key="ep.id"
        class="picker-chip"
        :class="{
          'picker-chip--selected': selected.includes(ep.id),
          'picker-chip--disabled': isDisabled(ep),
        }"
        type="button"
        :disabled="isDisabled(ep)"
        :aria-pressed="selected.includes(ep.id)"
        :aria-label="`第 ${ep.number} 集${isDisabled(ep) ? '，已下载' : ''}`"
        @click="toggle(ep)"
      >
        {{ ep.number }}
      </button>
    </div>

    <template #footer>
      <div class="picker-actions">
        <span class="picker-actions__count">已选 {{ selected.length }} 集</span>
        <button
          class="btn btn--primary btn--md picker-actions__btn"
          type="button"
          :disabled="selected.length === 0 || loading"
          @click="confirm"
        >
          <LoadingSpinner v-if="loading" :size="16" />
          {{ loading ? '加入中…' : '开始下载' }}
        </button>
      </div>
    </template>
  </BottomSheet>
</template>

<style scoped>
.picker-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding-bottom: var(--space-3);
}

.picker-head__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.picker-head__all {
  min-height: 32px;
  padding: 0 var(--space-2);
  color: var(--color-brand-text);
  font: var(--text-button-sm);
}

.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(56px, 1fr));
  gap: var(--space-2);
}

.picker-chip {
  min-width: 56px;
  height: 40px;
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-surface);
  border: 1.5px solid transparent;
  color: var(--color-text-primary);
  font: var(--text-label-strong);
  transition: var(--transition-color);
}

.picker-chip--selected {
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
}

.picker-chip--disabled {
  color: var(--color-text-disabled);
  background-color: var(--color-overlay-subtle);
}

.picker-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.picker-actions__count {
  flex: 1 1 auto;
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.picker-actions__btn {
  min-width: 140px;
}
</style>
