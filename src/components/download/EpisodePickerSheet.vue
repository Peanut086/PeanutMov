<script setup lang="ts">
/**
 * 选择集数下载（FR-61 批量选集 / FR-62 清晰度选择）
 *
 * 复用 BottomSheet + EpisodeChip 网格；底部固定操作条：全选 / 已选计数 / 开始下载。
 * 容量治理：`queueRemaining` 为队列剩余容量，超出部分置灰并给出原因（不静默丢弃）。
 * 清晰度：仅 HLS 源展示（最高 / 1080P / 720P），直链由 `lineQuality` 文案说明线路画质。
 */
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';

import type { Episode, HlsQuality } from '@/types';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useHaptic } from '@/composables/useHaptic';

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

/* ---------- E3：磁吸拖选 ----------
 * 状态机 idle → deciding → dragging。触屏按方向判定：横向主导进入拖选，
 * 纵向交回 sheet 原生滚动（touch-action: pan-y）；鼠标/笔任意方向均可拖选。
 * 每进入一个 chip 命中区 toggle 一次，pointerToggled 防同一 chip 重复 toggle。
 * 拖到滚动容器上下边缘时程序化自动滚动（不与原生 pan 冲突）。
 */
const { haptic } = useHaptic();
const gridEl = useTemplateRef<HTMLElement>('grid');
const dragging = ref(false);

let dragPointerId: number | null = null;
let dragTouch = false;
let decided = false;
let startX = 0;
let startY = 0;
let lastPointerY = 0;
let startEp: Episode | null = null;
let suppressClick = false;
let scrollParent: HTMLElement | null = null;
let autoScrollRaf = 0;
const pointerToggled = new Set<string>();

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = el?.parentElement ?? null;
  while (node) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

function chipFromPoint(x: number, y: number): Episode | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.picker-chip');
  const id = el?.dataset.epId;
  if (!id) return null;
  return sorted.value.find((e) => e.id === id) ?? null;
}

function dragToggle(ep: Episode | null): void {
  if (!ep || pointerToggled.has(ep.id) || isDisabled(ep)) return;
  pointerToggled.add(ep.id);
  toggle(ep);
  haptic('light');
}

function autoScrollLoop(): void {
  if (!dragging.value) {
    autoScrollRaf = 0;
    return;
  }
  const sc = scrollParent;
  if (sc) {
    const r = sc.getBoundingClientRect();
    const EDGE = 48;
    const SPEED = 9;
    if (lastPointerY < r.top + EDGE) sc.scrollTop -= SPEED;
    else if (lastPointerY > r.bottom - EDGE) sc.scrollTop += SPEED;
  }
  autoScrollRaf = requestAnimationFrame(autoScrollLoop);
}

function beginDrag(): void {
  dragging.value = true;
  decided = true;
  suppressClick = true;
  scrollParent = findScrollParent(gridEl.value);
  if (dragPointerId !== null) {
    try {
      gridEl.value?.setPointerCapture(dragPointerId);
    } catch {
      /* 捕获失败不影响命中检测 */
    }
  }
  haptic('light');
  dragToggle(startEp);
  if (autoScrollRaf === 0) autoScrollRaf = requestAnimationFrame(autoScrollLoop);
}

function endDrag(): void {
  if (autoScrollRaf !== 0) {
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = 0;
  }
  if (dragPointerId !== null) {
    try {
      gridEl.value?.releasePointerCapture(dragPointerId);
    } catch {
      /* 已释放 */
    }
  }
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  dragPointerId = null;
  dragging.value = false;
  decided = false;
  startEp = null;
  pointerToggled.clear();
}

function onDragMove(e: PointerEvent): void {
  if (e.pointerId !== dragPointerId) return;
  lastPointerY = e.clientY;
  if (!decided) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
    // 触屏纵向主导：放弃拖选，交回原生滚动
    if (dragTouch && Math.abs(dy) > Math.abs(dx)) {
      decided = true;
      endDrag();
      return;
    }
    beginDrag();
  }
  if (dragging.value) {
    e.preventDefault();
    dragToggle(chipFromPoint(e.clientX, e.clientY));
  }
}

function onDragEnd(e: PointerEvent): void {
  if (e.pointerId !== dragPointerId) return;
  endDrag();
}

function onChipPointerDown(e: PointerEvent, ep: Episode): void {
  if (dragPointerId !== null || !e.isPrimary) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (isDisabled(ep)) return;
  suppressClick = false;
  dragPointerId = e.pointerId;
  dragTouch = e.pointerType === 'touch';
  dragging.value = false;
  decided = false;
  startX = e.clientX;
  startY = e.clientY;
  lastPointerY = e.clientY;
  startEp = ep;
  pointerToggled.clear();
  window.addEventListener('pointermove', onDragMove, { passive: false });
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
}

/** 点按 / 键盘 Space·Enter：拖选刚结束时吞掉合成 click，避免重复 toggle */
function onChipClick(ep: Episode): void {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  toggle(ep);
}

onBeforeUnmount(() => {
  endDrag();
});
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

    <div ref="grid" class="picker-grid" :class="{ 'picker-grid--dragging': dragging }">
      <button
        v-for="ep in sorted"
        :key="ep.id"
        class="picker-chip"
        :class="{
          'picker-chip--selected': selected.includes(ep.id),
          'picker-chip--disabled': isDisabled(ep),
        }"
        type="button"
        :data-ep-id="ep.id"
        :disabled="isDisabled(ep)"
        :aria-pressed="selected.includes(ep.id)"
        :aria-label="`第 ${ep.number} 集${chipReason(ep)}`"
        @pointerdown="onChipPointerDown($event, ep)"
        @click="onChipClick(ep)"
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
  /* E3：纵向留给 sheet 原生滚动，横向拖选由指针状态机接管 */
  touch-action: pan-y;
  user-select: none;
  -webkit-user-select: none;
}

.picker-grid--dragging,
.picker-grid--dragging .picker-chip {
  cursor: grabbing;
}

.picker-chip {
  min-width: 56px;
  height: 40px;
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-surface);
  border: 1.5px solid transparent;
  color: var(--color-text-primary);
  font: var(--text-label-strong);
  touch-action: pan-y;
  transition: var(--transition-color);
}

.picker-chip--selected {
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  /* E3：选中态翻转 150ms（每次进入选中播一遍） */
  animation: chip-flip 150ms var(--ease-standard);
}

@keyframes chip-flip {
  0% {
    transform: perspective(220px) rotateX(0);
  }
  50% {
    transform: perspective(220px) rotateX(-82deg);
  }
  100% {
    transform: perspective(220px) rotateX(0);
  }
}

.picker-chip--disabled {
  color: var(--color-text-disabled);
  background-color: var(--color-overlay-subtle);
}

@media (prefers-reduced-motion: reduce) {
  .picker-chip--selected {
    animation: none;
  }
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
