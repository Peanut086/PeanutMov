<script setup lang="ts">
/**
 * 失败原因分布（EXT-01 / FR 失败分布）
 *
 * 按 timeout / unreachable / bad_config / auth_failed 四类聚合，
 * 数据口径来自 `healthCenterService.failureDistributionOf`（只含计数 > 0 的原因，按数量降序）。
 *
 * 状态：
 * - 默认：原因 + 数量 + 占比条 + 处置建议
 * - 空数据（无失败源）：成功态提示，不渲染空条
 * - 加载中：两行骨架
 * - 异常数据：占比越界按 0~100 收敛，避免进度条溢出容器
 */
import { computed } from 'vue';

import type { FailureBucket, FailureReason } from '@/services/healthCenterService';

const props = withDefaults(
  defineProps<{
    buckets: FailureBucket[];
    /** 失败源总数（用于标题右侧汇总） */
    failedTotal: number;
    loading?: boolean;
  }>(),
  { loading: false },
);

const isEmpty = computed(() => props.buckets.length === 0);

function barWidth(bucket: FailureBucket): string {
  const percent = Number.isFinite(bucket.percent) ? bucket.percent : 0;
  return `${Math.min(100, Math.max(0, percent))}%`;
}

function reasonClass(reason: FailureReason): string {
  return `failure-dist__bar--${reason}`;
}
</script>

<template>
  <section class="failure-dist" aria-labelledby="failure-dist-title">
    <div class="failure-dist__head">
      <h2 id="failure-dist-title" class="section-title">失败原因分布</h2>
      <span class="failure-dist__meta">共 {{ failedTotal }} 个失败源</span>
    </div>

    <div v-if="loading" class="failure-dist__skeletons" data-state="loading">
      <div class="skeleton failure-dist__skeleton" />
      <div class="skeleton failure-dist__skeleton" />
    </div>

    <p v-else-if="isEmpty" class="failure-dist__empty" data-state="empty">
      当前没有被判定为失败的源。
    </p>

    <ul v-else class="failure-dist__list" data-state="default">
      <li v-for="bucket in buckets" :key="bucket.reason" class="failure-dist__row">
        <div class="failure-dist__row-head">
          <span class="failure-dist__label">{{ bucket.label }}</span>
          <span class="failure-dist__count">{{ bucket.count }} 个 · {{ bucket.percent }}%</span>
        </div>
        <div class="failure-dist__track">
          <div
            class="failure-dist__bar"
            :class="reasonClass(bucket.reason)"
            :style="{ width: barWidth(bucket) }"
          />
        </div>
        <p class="failure-dist__hint">{{ bucket.hint }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.failure-dist {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.failure-dist__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.failure-dist__meta {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.failure-dist__skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.failure-dist__skeleton {
  min-height: calc(var(--space-7) + var(--space-2));
  border-radius: var(--radius-sm);
}

.failure-dist__empty {
  font: var(--text-caption);
  color: var(--color-success);
}

.failure-dist__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.failure-dist__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.failure-dist__row-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.failure-dist__label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.failure-dist__count {
  flex: 0 0 auto;
  font: var(--font-weight-regular) var(--font-size-12) / var(--line-height-12) var(--font-family-number);
  color: var(--color-text-secondary);
}

.failure-dist__track {
  height: var(--space-1);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-pressed);
  overflow: hidden;
}

.failure-dist__bar {
  height: 100%;
  border-radius: var(--radius-full);
  background-color: var(--color-text-tertiary);
  transition: width var(--duration-base) var(--ease-standard);
}

.failure-dist__bar--timeout {
  background-color: var(--color-info);
}

.failure-dist__bar--unreachable {
  background-color: var(--color-danger);
}

.failure-dist__bar--bad_config {
  background-color: var(--color-warning);
}

.failure-dist__bar--auth_failed {
  background-color: var(--color-danger);
}

.failure-dist__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
