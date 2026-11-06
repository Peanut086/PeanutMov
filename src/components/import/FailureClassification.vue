<script setup lang="ts">
/**
 * 失败分类与明细（EXT-08 / FR 失败分类导出）
 *
 * 两部分：
 * ① 分类聚合：原因 + 数量 + 占比条 + 处置建议（口径来自 `bucketFailures`）；
 * ② 逐条明细：名称、原因、订阅地址 / jar 地址、错误码、可读明细、重试建议。
 *
 * 状态：
 * - 加载中：两行骨架
 * - 空数据（无失败条目）：成功态文案，不渲染空条
 * - 数据超限：默认最多渲染 `maxVisible` 条，超出部分折叠为「展开全部」按钮
 * - 异常数据：占比越界收敛 0~100；缺失字段以「—」占位，不渲染空白行
 *
 * 组件只读展示，导出动作通过 `export` 事件抛给页面。
 */
import { computed, ref, watch } from 'vue';

import { FAILURE_CATEGORY_META } from '@/services/ImportDiagnosticService';
import type { FailureBucket, ImportFailureItem } from '@/services/ImportDiagnosticService';

const props = withDefaults(
  defineProps<{
    buckets: FailureBucket[];
    failures: ImportFailureItem[];
    loading?: boolean;
    /** 明细默认最多渲染条数（避免长列表一次性铺满） */
    maxVisible?: number;
  }>(),
  { loading: false, maxVisible: 10 },
);

const emit = defineEmits<{ (e: 'export'): void }>();

const expanded = ref(false);
/** 失败条目变化时收起，避免「展开」状态串到下一次诊断 */
watch(
  () => props.failures,
  () => {
    expanded.value = false;
  },
);

const total = computed(() => props.failures.length);
const isEmpty = computed(() => !props.loading && total.value === 0);
const hiddenCount = computed(() => Math.max(0, total.value - props.maxVisible));
const visibleItems = computed(() =>
  expanded.value ? props.failures : props.failures.slice(0, props.maxVisible),
);

function barWidth(bucket: FailureBucket): string {
  const percent = Number.isFinite(bucket.percent) ? bucket.percent : 0;
  return `${Math.min(100, Math.max(0, percent))}%`;
}

function reasonClass(reason: string): string {
  return `failure-class__bar--${reason}`;
}

/** 标签色调：四档语义色，未知原因落到中性灰 */
function tagClass(reason: ImportFailureItem['reason']): string {
  switch (reason) {
    case 'jar_unreachable':
    case 'unreachable':
    case 'auth_failed':
      return 'failure-class__tag--danger';
    case 'jar_missing':
    case 'bad_config':
      return 'failure-class__tag--warning';
    case 'timeout':
      return 'failure-class__tag--info';
    default:
      return 'failure-class__tag--muted';
  }
}

function displayOf(value: string | null | undefined): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : '—';
}

function retryText(item: ImportFailureItem): string {
  return item.retryable ? '可重试' : '不建议重试';
}

function hintOf(item: ImportFailureItem): string {
  return item.suggestion || FAILURE_CATEGORY_META[item.reason]?.hint || '—';
}
</script>

<template>
  <section class="failure-class" aria-labelledby="failure-class-title">
    <div class="failure-class__head">
      <h2 id="failure-class-title" class="section-title">失败分类</h2>
      <div class="failure-class__head-right">
        <span class="failure-class__meta">共 {{ total }} 条</span>
        <button
          v-if="total > 0"
          class="btn btn--ghost btn--sm"
          type="button"
          @click="emit('export')"
        >
          导出 JSON
        </button>
      </div>
    </div>

    <div v-if="loading" class="failure-class__skeletons" data-state="loading">
      <div class="skeleton failure-class__skeleton" />
      <div class="skeleton failure-class__skeleton" />
    </div>

    <p v-else-if="isEmpty" class="failure-class__empty" data-state="empty">
      本次导入没有失败条目，所有写入的源都可正常访问。
    </p>

    <template v-else>
      <ul class="failure-class__buckets" data-state="default">
        <li v-for="bucket in buckets" :key="bucket.reason" class="failure-class__bucket">
          <div class="failure-class__bucket-head">
            <span class="failure-class__bucket-label">{{ bucket.label }}</span>
            <span class="failure-class__bucket-count">{{ bucket.count }} 条 · {{ bucket.percent }}%</span>
          </div>
          <div class="failure-class__track">
            <div
              class="failure-class__bar"
              :class="reasonClass(bucket.reason)"
              :style="{ width: barWidth(bucket) }"
            />
          </div>
          <p class="failure-class__bucket-hint">{{ bucket.hint }}</p>
        </li>
      </ul>

      <ul class="failure-class__list">
        <li v-for="(item, index) in visibleItems" :key="`${item.key}-${index}`" class="failure-class__item">
          <div class="failure-class__item-head">
            <span class="failure-class__item-name truncate-1">{{ displayOf(item.name) }}</span>
            <span class="failure-class__tag" :class="tagClass(item.reason)">
              {{ FAILURE_CATEGORY_META[item.reason]?.label ?? item.label }}
            </span>
          </div>
          <p class="failure-class__row">
            <span class="failure-class__key">订阅地址</span>
            <span class="failure-class__value truncate-1">{{ displayOf(item.baseUrl) }}</span>
          </p>
          <p v-if="item.jarUrl" class="failure-class__row">
            <span class="failure-class__key">jar 地址</span>
            <span class="failure-class__value truncate-1">{{ item.jarUrl }}</span>
          </p>
          <p class="failure-class__row">
            <span class="failure-class__key">错误码</span>
            <span class="failure-class__value">{{ displayOf(item.errorCode) }}</span>
          </p>
          <p class="failure-class__row">
            <span class="failure-class__key">明细</span>
            <span class="failure-class__value">{{ displayOf(item.detail) }}</span>
          </p>
          <p class="failure-class__suggestion">
            {{ hintOf(item) }}（{{ retryText(item) }}）
          </p>
        </li>
      </ul>

      <button
        v-if="hiddenCount > 0"
        class="btn btn--ghost btn--sm failure-class__more"
        type="button"
        @click="expanded = !expanded"
      >
        {{ expanded ? '收起明细' : `展开全部 ${total} 条` }}
      </button>
    </template>
  </section>
</template>

<style scoped>
.failure-class {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.failure-class__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.failure-class__head-right {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}

.failure-class__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.failure-class__skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.failure-class__skeleton {
  min-height: calc(var(--space-7) + var(--space-2));
  border-radius: var(--radius-sm);
}

.failure-class__empty {
  font: var(--text-caption);
  color: var(--color-success);
}

.failure-class__buckets {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  list-style: none;
}

.failure-class__bucket {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.failure-class__bucket-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.failure-class__bucket-label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.failure-class__bucket-count {
  flex: 0 0 auto;
  font: var(--font-weight-regular) var(--font-size-12) / var(--line-height-12) var(--font-family-number);
  color: var(--color-text-secondary);
}

.failure-class__track {
  height: var(--space-1);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-pressed);
  overflow: hidden;
}

.failure-class__bar {
  height: 100%;
  border-radius: var(--radius-full);
  background-color: var(--color-text-tertiary);
  transition: width var(--duration-base) var(--ease-standard);
}

.failure-class__bar--jar_missing {
  background-color: var(--color-warning);
}

.failure-class__bar--jar_unreachable {
  background-color: var(--color-danger);
}

.failure-class__bar--timeout {
  background-color: var(--color-info);
}

.failure-class__bar--unreachable {
  background-color: var(--color-danger);
}

.failure-class__bar--bad_config {
  background-color: var(--color-warning);
}

.failure-class__bar--auth_failed {
  background-color: var(--color-danger);
}

.failure-class__bar--invalid_config {
  background-color: var(--color-text-secondary);
}

.failure-class__bar--duplicate {
  background-color: var(--color-text-tertiary);
}

.failure-class__bar--unknown {
  background-color: var(--color-text-tertiary);
}

.failure-class__bucket-hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.failure-class__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.failure-class__item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.failure-class__item-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.failure-class__item-name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.failure-class__tag {
  flex: 0 0 auto;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font: var(--text-caption);
  color: var(--color-text-secondary);
  background-color: var(--color-bg-pressed);
  line-height: var(--line-height-16);
}

.failure-class__tag--danger {
  color: var(--color-danger);
  background-color: var(--color-danger-soft);
}

.failure-class__tag--warning {
  color: var(--color-warning);
  background-color: var(--color-warning-soft);
}

.failure-class__tag--info {
  color: var(--color-info);
  background-color: var(--color-info-soft);
}

.failure-class__tag--muted {
  color: var(--color-text-secondary);
  background-color: var(--color-bg-pressed);
}

.failure-class__row {
  display: flex;
  gap: var(--space-2);
  font: var(--text-caption);
  line-height: 1.6;
}

.failure-class__key {
  flex: 0 0 auto;
  width: var(--space-10);
  color: var(--color-text-tertiary);
}

.failure-class__value {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--color-text-secondary);
  word-break: break-all;
}

.failure-class__suggestion {
  margin-top: var(--space-1);
  font: var(--text-caption);
  line-height: 1.6;
  color: var(--color-text-primary);
}

.failure-class__more {
  align-self: center;
}
</style>
