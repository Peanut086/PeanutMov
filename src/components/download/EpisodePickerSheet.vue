<script setup lang="ts">
/**
 * 选择集数下载（FR-61 批量选集 / FR-62 清晰度选择）
 *
 * 复用 BottomSheet + EpisodeChip 网格；底部固定操作条：全选 / 已选计数 / 开始下载。
 * 容量治理：`queueRemaining` 为队列剩余容量，超出部分置灰并给出原因（不静默丢弃）。
 * 清晰度：仅 HLS 源展示（最高 / 1080P / 720P），直链由 `lineQuality` 文案说明线路画质。
 */
import { computed, ref, watch } from 'vue';

import type { Episode, HlsQuality } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const QUALITY_OPTIONS: Array<{ value: HlsQuality; label: string }> = [
  { value: 'max', label: '最高' },
  { value: '1080p', label: '1080P' },
  { value: '720p', label: '720P' },
];

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    episodes: Episode[];
    title?: string;
    /** 已下载的剧集 id（置灰） */
    downloadedIds?: string[];
    /** 下载中（禁用按钮） */
    loading?: boolean;
    /** 队列剩余容量；null 表示未知（不做容量限制） */
    queueRemaining?: number | null;
    /** 单批上限（默认 50，见 DOWNLOAD_BATCH_MAX） */
    maxSelect?: number;
    /** 是否展示清晰度选择（仅 HLS 源为 true） */
    showQuality?: boolean;
    /** 当前清晰度（HLS 源默认 max） */
    quality?: HlsQuality;
    /** 直链线路画质文案（HLS 源不传） */
    lineQuality?: string | null;
  }>(),
  {
    title: '选择集数',
    downloadedIds: () => [],
    loading: false,
    queueRemaining: null,
    maxSelect: 50,
    showQuality: false,
    quality: 'max',
    lineQuality: null,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'update:quality', v: HlsQuality): void;
  (e: 'confirm', episodeIds: string[], quality: HlsQuality): void;
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

/** 本次可选上限：单批上限与队列剩余容量取小 */
const selectLimit = computed(() => {
  const remaining =
    props.queueRemaining === null ? props.maxSelect : Math.max(0, props.queueRemaining);
  return Math.min(props.maxSelect, remaining);
});

const reachableCount = computed(() =>
  Math.min(availableIds.value.length, Math.max(0, selectLimit.value)),
);

const allSelected = computed(
  () =>
    reachableCount.value > 0 &&
    availableIds.value.slice(0, reachableCount.value).every((id) => selected.value.includes(id)),
);

const canSelectMore = computed(() => selected.value.length < selectLimit.value);

const footerHint = computed(() => {
  if (props.queueRemaining !== null && props.queueRemaining <= 0) {
    return '队列已满，请先清理下载队列';
  }
  if (selected.value.length >= props.maxSelect) {
    return `单批最多 ${props.maxSelect} 集，可分批下载`;
  }
  if (!canSelectMore.value) {
    return '已达队列剩余容量';
  }
  return '';
});

function isDownloaded(ep: Episode): boolean {
  return props.downloadedIds.includes(ep.id);
}

/** 超出容量 / 单批上限（未下载且未选中的集） */
function isOverLimit(ep: Episode): boolean {
  return !isDownloaded(ep) && !selected.value.includes(ep.id) && !canSelectMore.value;
}

function isDisabled(ep: Episode): boolean {
  return isDownloaded(ep) || isOverLimit(ep);
}

function chipReason(ep: Episode): string {
  if (isDownloaded(ep)) return '，已下载';
  if (isOverLimit(ep)) return `，已达本次上限（${selectLimit.value} 集）`;
  return '';
}

function toggle(ep: Episode): void {
  if (isDisabled(ep)) return;
  selected.value = selected.value.includes(ep.id)
    ? selected.value.filter((id) => id !== ep.id)
    : [...selected.value, ep.id];
}

function toggleAll(): void {
  if (allSelected.value) {
    selected.value = [];
    return;
  }
  selected.value = availableIds.value.slice(0, reachableCount.value);
}

function setQuality(value: HlsQuality): void {
  if (props.quality !== value) emit('update:quality', value);
}

function confirm(): void {
  if (selected.value.length === 0 || props.loading) return;
  emit('confirm', [...selected.value], props.quality);
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
      <button
        class="picker-head__all"
        type="button"
        :disabled="reachableCount === 0"
        @click="toggleAll"
      >
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
    </div>

    <div v-if="showQuality" class="picker-quality" role="radiogroup" aria-label="清晰度">
      <span class="picker-quality__label">清晰度</span>
      <div class="picker-quality__options">
        <button
          v-for="opt in QUALITY_OPTIONS"
          :key="opt.value"
          class="picker-quality__chip"
          :class="{ 'picker-quality__chip--active': quality === opt.value }"
          type="button"
          role="radio"
          :aria-checked="quality === opt.value"
          @click="setQuality(opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>
    <div v-else-if="lineQuality" class="picker-quality picker-quality--static">
      <span class="picker-quality__label">线路画质</span>
      <span class="picker-quality__value">{{ lineQuality }}</span>
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
        :aria-label="`第 ${ep.number} 集${chipReason(ep)}`"
        @click="toggle(ep)"
      >
        {{ ep.number }}
      </button>
    </div>

    <template #footer>
      <div class="picker-actions">
        <div class="picker-actions__meta">
          <span class="picker-actions__count">
            已选 {{ selected.length }} 集 / 可再选 {{ Math.max(0, selectLimit - selected.length) }} 集
          </span>
          <span
            class="picker-actions__capacity"
            :class="{ 'picker-actions__capacity--warn': queueRemaining !== null && queueRemaining <= 0 }"
          >
            {{ queueRemaining === null ? `单批上限 ${maxSelect} 集` : `队列剩余容量 ${queueRemaining} 集` }}
          </span>
          <span v-if="footerHint" class="picker-actions__hint">{{ footerHint }}</span>
        </div>
        <button
          class="btn btn--primary btn--md picker-actions__btn"
          type="button"
          :disabled="selected.length === 0 || loading"
          @click="confirm"
        >
          <LoadingSpinner v-if="loading" :size="16" />
          {{ loading ? '预检中…' : '开始下载' }}
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

.picker-head__all:disabled {
  color: var(--color-text-disabled);
}

.picker-quality {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
}

.picker-quality__label {
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.picker-quality__options {
  display: flex;
  flex: 1 1 auto;
  gap: var(--space-2);
}

.picker-quality__chip {
  flex: 1 1 0;
  min-height: 36px;
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-surface);
  border: 1.5px solid transparent;
  color: var(--color-text-secondary);
  font: var(--text-button-sm);
  transition: var(--transition-color);
}

.picker-quality__chip--active {
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
}

.picker-quality__value {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
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

.picker-actions__meta {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.picker-actions__count {
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.picker-actions__capacity {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.picker-actions__capacity--warn {
  color: var(--color-danger);
}

.picker-actions__hint {
  font: var(--text-caption);
  color: var(--color-warning);
}

.picker-actions__btn {
  min-width: 140px;
  flex: 0 0 auto;
}
</style>
