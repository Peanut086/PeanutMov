<script setup lang="ts">
/**
 * 导入诊断汇总（EXT-08 / FR 导入诊断视图 & 存活源统计）
 *
 * 展示：写入成功 / 失败明细 / 跳过 / jar 不可达 四项计数、预估 vs 实际耗时、
 * 存活源统计（总数 / 存活 / 失败 / 存活率）与两个出口动作（导出报告、清理失败源）。
 *
 * 状态：
 * - 加载中：四宫格 + 两行骨架（保留栅格占位，避免内容跳动）
 * - 空数据（`result === null`）：未开始诊断的引导文案，不渲染计数
 * - 取消：保留已完成部分，计数区标注「已取消」
 * - 异常数据：计数非数字按 0 显示、存活率越界收敛到 0~100
 *
 * 组件只读展示，动作通过 `export` / `cleanup` 事件抛给页面（不直接调用 service）。
 */
import { computed } from 'vue';

import { formatBytes, formatDuration } from '@/services/ImportDiagnosticService';
import type { ImportDiagnosticResult } from '@/services/importService';

const props = withDefaults(
  defineProps<{
    result: ImportDiagnosticResult | null;
    loading?: boolean;
    /** 可清理的失败源数量（失败且启用）；0 时清理按钮置灰 */
    cleanupCount?: number;
    /** 清理进行中 */
    cleaning?: boolean;
  }>(),
  { loading: false, cleanupCount: 0, cleaning: false },
);

const emit = defineEmits<{ (e: 'export'): void; (e: 'cleanup'): void }>();

type TileTone = 'success' | 'failed' | 'skipped' | 'jar';

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const tiles = computed<{ key: TileTone; label: string; value: number }[]>(() => {
  const summary = props.result?.report.summary;
  return [
    { key: 'success', label: '写入成功', value: safeNumber(summary?.success) },
    { key: 'failed', label: '失败', value: safeNumber(summary?.failed) },
    { key: 'skipped', label: '跳过', value: safeNumber(summary?.skipped) },
    { key: 'jar', label: 'jar 不可达', value: safeNumber(summary?.jarDead) },
  ];
});

const canceled = computed(() => props.result?.status === 'canceled');
const finishedText = computed(() => {
  if (props.result === null) return '';
  const prefix = canceled.value ? '已取消（未写入）' : '诊断完成';
  return `${prefix} · 耗时 ${formatDuration(props.result.durationMs / 1000)}`;
});

const totalText = computed(() => {
  const total = safeNumber(props.result?.report.summary.total);
  return `订阅共 ${total} 个条目`;
});

const autoDisableText = computed(() => {
  const count = safeNumber(props.result?.autoDisabled);
  if (count <= 0) return '';
  return `连续失败 3 次的 ${count} 个源已自动禁用`;
});

const estimateText = computed(() => {
  const estimate = props.result?.estimate;
  if (!estimate) return '本次没有可下载的 jar（无需估算导入耗时）';
  const parts = [
    `预计下载 ${estimate.jarCount} 个 jar`,
    formatBytes(estimate.bytes),
    `约 ${formatDuration(estimate.seconds)}`,
  ];
  if (estimate.assumedCount > 0) parts.push(`其中 ${estimate.assumedCount} 个按默认体积估算`);
  return parts.join(' · ');
});

const actualText = computed(() => {
  const duration = safeNumber(props.result?.durationMs);
  return `实际耗时 ${formatDuration(duration / 1000)}`;
});

const alivePercent = computed(() => {
  const percent = safeNumber(props.result?.alive.alivePercent);
  return Math.min(100, Math.max(0, Math.round(percent)));
});

const aliveItems = computed<{ key: string; label: string; value: number }[]>(() => {
  const alive = props.result?.alive;
  return [
    { key: 'total', label: '源总数', value: safeNumber(alive?.total) },
    { key: 'alive', label: '存活', value: safeNumber(alive?.alive) },
    { key: 'failed', label: '失败', value: safeNumber(alive?.failed) },
  ];
});

const cleanupDisabled = computed(
  () => props.cleaning || props.cleanupCount <= 0 || props.result === null,
);
</script>

<template>
  <section class="import-summary" aria-labelledby="import-summary-title">
    <div class="import-summary__head">
      <h2 id="import-summary-title" class="section-title">导入汇总</h2>
      <span v-if="!loading && result" class="import-summary__meta">{{ finishedText }}</span>
    </div>

    <div v-if="loading" class="import-summary__skeletons" data-state="loading">
      <div class="skeleton import-summary__skeleton-tile" />
      <div class="skeleton import-summary__skeleton-tile" />
      <div class="skeleton import-summary__skeleton-tile" />
      <div class="skeleton import-summary__skeleton-tile" />
    </div>

    <p v-else-if="result === null" class="import-summary__empty" data-state="empty">
      完成一次诊断后，这里会展示写入结果、耗时与存活源统计。
    </p>

    <template v-else>
      <dl class="import-summary__grid" data-state="default">
        <div v-for="tile in tiles" :key="tile.key" class="import-summary__tile">
          <dt class="import-summary__label">{{ tile.label }}</dt>
          <dd class="import-summary__value" :class="`import-summary__value--${tile.key}`">
            {{ tile.value }}
          </dd>
        </div>
      </dl>

      <p class="import-summary__line">{{ totalText }}<template v-if="autoDisableText"> · {{ autoDisableText }}</template></p>

      <div class="import-summary__estimate">
        <p class="import-summary__line">{{ estimateText }}</p>
        <p class="import-summary__line import-summary__line--muted">{{ actualText }}</p>
      </div>

      <div class="import-summary__alive">
        <div class="import-summary__alive-head">
          <span class="import-summary__alive-title">存活源</span>
          <span class="import-summary__alive-percent">{{ alivePercent }}%</span>
        </div>
        <div class="import-summary__track">
          <div class="import-summary__bar" :style="{ width: `${alivePercent}%` }" />
        </div>
        <ul class="import-summary__alive-list">
          <li v-for="item in aliveItems" :key="item.key" class="import-summary__alive-item">
            <span class="import-summary__alive-label">{{ item.label }}</span>
            <span class="import-summary__alive-value">{{ item.value }}</span>
          </li>
        </ul>
      </div>

      <div class="import-summary__actions">
        <button
          class="btn btn--secondary btn--md import-summary__action"
          type="button"
          @click="emit('export')"
        >
          导出失败报告
        </button>
        <button
          class="btn btn--danger btn--md import-summary__action"
          type="button"
          :disabled="cleanupDisabled"
          @click="emit('cleanup')"
        >
          {{ cleaning ? '清理中…' : `清理失败源（${cleanupCount}）` }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.import-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.import-summary__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.import-summary__meta {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.import-summary__skeletons {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
}

@media (min-width: 600px) {
  .import-summary__skeletons {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.import-summary__skeleton-tile {
  min-height: calc(var(--space-10) + var(--space-3));
  border-radius: var(--radius-card);
}

.import-summary__empty {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.import-summary__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0;
}

@media (min-width: 600px) {
  .import-summary__grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.import-summary__tile {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.import-summary__label {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.import-summary__value {
  margin: 0;
  font: var(--font-weight-semibold) var(--font-size-24) / var(--line-height-24) var(--font-family-number);
  color: var(--color-text-primary);
}

.import-summary__value--success {
  color: var(--color-success);
}

.import-summary__value--failed {
  color: var(--color-danger);
}

.import-summary__value--jar {
  color: var(--color-warning);
}

.import-summary__line {
  font: var(--text-caption);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.import-summary__line--muted {
  color: var(--color-text-tertiary);
}

.import-summary__estimate {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
}

.import-summary__alive {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.import-summary__alive-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.import-summary__alive-title {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.import-summary__alive-percent {
  font: var(--font-weight-semibold) var(--font-size-14) / var(--line-height-14) var(--font-family-number);
  color: var(--color-success);
}

.import-summary__track {
  height: var(--space-1);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-pressed);
  overflow: hidden;
}

.import-summary__bar {
  height: 100%;
  border-radius: var(--radius-full);
  background-color: var(--color-success);
  transition: width var(--duration-base) var(--ease-standard);
}

.import-summary__alive-list {
  display: flex;
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.import-summary__alive-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.import-summary__alive-label {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.import-summary__alive-value {
  font: var(--font-weight-semibold) var(--font-size-16) / var(--line-height-16) var(--font-family-number);
  color: var(--color-text-primary);
}

.import-summary__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.import-summary__action {
  flex: 1 1 auto;
}
</style>
