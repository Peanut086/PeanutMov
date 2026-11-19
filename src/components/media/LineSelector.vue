<script setup lang="ts">
/**
 * 线路选择器（详情页 / 播放页）
 *
 * 形态：SegmentedControl（≤4 条线路）或 BottomSheet 列表（>4 条）。
 * 切换后保持当前集号（AC-31 的 UI 侧保证）。
 * 批次1：新增线路健康状态点 + 推荐徽章。
 * P1-4：健康状态补上**文字**口径（可播 / 不可用 + 探测耗时），并把「当前线路不可用」
 *       提到收起态——只有一枚色点时，用户看不出 27 条里哪条是死的。
 */
import { computed, ref } from 'vue';

import type { PlayLine } from '@/types';
import type { LineHealthStatus } from '@/services/lineHealthService';

import BottomSheet from '@/components/common/BottomSheet.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';

const props = defineProps<{
  lines: PlayLine[];
  modelValue: string | null;
  /** 批次1：每条线路的健康状态（key=lineId） */
  lineStatuses?: Map<string, LineHealthStatus>;
  /** 批次1：推荐的线路 ID */
  recommendedLineId?: string | null;
  /** P1-4：最近一次探测耗时（ms），仅在状态已知时展示 */
  lineLatencies?: Map<string, number | null>;
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

function statusClass(lineId: string): string {
  switch (statusOf(lineId)) {
    case 'ok':
      return 'line-status--ok';
    case 'fail':
      return 'line-status--fail';
    default:
      return 'line-status--unknown';
  }
}

function isRecommended(lineId: string): boolean {
  return props.recommendedLineId === lineId;
}

function statusOf(lineId: string): LineHealthStatus {
  return props.lineStatuses?.get(lineId) ?? 'unknown';
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** P1-4：文字化的可用性 + 探测耗时；未探测过的线路留白，不假装知道 */
function metaLabel(lineId: string): string {
  const status = statusOf(lineId);
  if (status === 'fail') return '不可用';
  if (status !== 'ok') return '';
  const ms = props.lineLatencies?.get(lineId) ?? null;
  return ms && ms > 0 ? `可播 · ${formatLatency(ms)}` : '可播';
}

const currentLineIsDead = computed(() => statusOf(props.modelValue ?? '') === 'fail');
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
      <span v-if="currentLineIsDead" class="line-selector__warn">不可用</span>
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
            <span :class="['line-list__status', statusClass(line.id)]" aria-hidden="true"></span>
            <span class="line-list__name">{{ line.name }}</span>
            <span v-if="line.quality" class="line-list__quality">{{ line.quality }}</span>
            <span
              v-if="metaLabel(line.id)"
              :class="['line-list__meta', statusOf(line.id) === 'fail' ? 'line-list__meta--fail' : 'line-list__meta--ok']"
              >{{ metaLabel(line.id) }}</span
            >
            <span v-if="isRecommended(line.id)" class="line-list__recommended">推荐</span>
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
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 30px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font: var(--font-weight-medium) 12px / 1 var(--font-family-base);
}

/* 视觉高度 30，命中区扩到 44（规范 §12.1） */
.line-selector__trigger::after {
  content: '';
  position: absolute;
  inset: -7px -4px;
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

/* P1-4：可用性文字口径（色点不足以传达「这条线路是死的」） */
.line-list__meta {
  font: var(--text-caption);
  flex-shrink: 0;
}

.line-list__meta--ok {
  color: var(--color-success, #10b981);
}

.line-list__meta--fail {
  color: var(--color-error, #ef4444);
}

.line-selector__warn {
  color: var(--color-error, #ef4444);
}

.line-list__current {
  font: var(--text-caption);
  color: var(--color-brand-text);
}

/* 批次1：线路健康状态点 */
.line-list__status {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.line-list__status.line-status--ok {
  background-color: var(--color-success, #10b981);
}

.line-list__status.line-status--fail {
  background-color: var(--color-error, #ef4444);
}

.line-list__status.line-status--unknown {
  background-color: var(--color-text-tertiary, #9ca3af);
}

/* 批次1：推荐徽章 */
.line-list__recommended {
  font: var(--text-caption);
  color: var(--color-brand-text);
  background-color: var(--color-brand-bg, rgba(59, 130, 246, 0.1));
  padding: 2px 6px;
  border-radius: 4px;
  margin-left: auto;
}
</style>
