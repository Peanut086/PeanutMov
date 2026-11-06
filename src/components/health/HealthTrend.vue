<script setup lang="ts">
/**
 * 7 日健康趋势（EXT-01 / FR 健康趋势）
 *
 * 柱状图：横轴固定最近 7 天（含今天），纵轴为当日健康率百分比。
 * 数据口径来自 `healthCenterService.buildTrendSeries`（缺失日补 0 并标记未采集）。
 *
 * 状态：
 * - 默认：7 根柱 + 百分比 + 日期轴
 * - 空数据（全部未采集）：轴保留，柱位显示「—」并给出说明
 * - 加载中：柱图区域骨架块
 * - 异常数据：超出 7 天只取最后 7 个点；百分比越界按 0~100 收敛
 */
import { computed } from 'vue';

import type { HealthTrendPoint } from '@/services/healthCenterService';

const props = withDefaults(
  defineProps<{
    points: HealthTrendPoint[];
    loading?: boolean;
  }>(),
  { loading: false },
);

/** 恒定 7 个槽位：超出部分截掉旧数据，避免柱宽被压缩 */
const visiblePoints = computed(() => props.points.slice(-7));

const recordedCount = computed(() => visiblePoints.value.filter((point) => point.recorded).length);

const hasData = computed(() => recordedCount.value > 0);

const isEmptyData = computed(() => !props.loading && !hasData.value);

const chartLabel = computed(() => {
  const parts = visiblePoints.value.map((point) =>
    point.recorded ? `${point.label} ${point.healthRate}%` : `${point.label} 无数据`,
  );
  return `最近 7 天健康率：${parts.join('，')}`;
});

/** 柱高：数据驱动（0% 时留 4% 的可见底线，配色会随低健康率转为告警色） */
function barHeight(point: HealthTrendPoint): string {
  if (!point.recorded) return '0%';
  const rate = Number.isFinite(point.healthRate) ? point.healthRate : 0;
  return `${Math.min(100, Math.max(4, rate))}%`;
}

/** 健康率 → 语义色调：≥80% 成功、≥50% 警告、其余危险 */
function barTone(point: HealthTrendPoint): 'success' | 'warning' | 'danger' {
  const rate = Number.isFinite(point.healthRate) ? point.healthRate : 0;
  if (rate >= 80) return 'success';
  if (rate >= 50) return 'warning';
  return 'danger';
}
</script>

<template>
  <section class="health-trend" aria-labelledby="health-trend-title">
    <div class="health-trend__head">
      <h2 id="health-trend-title" class="section-title">健康趋势</h2>
      <span class="health-trend__meta">最近 7 天 · 已采集 {{ recordedCount }}/7 天</span>
    </div>

    <div v-if="loading" class="skeleton health-trend__skeleton" data-state="loading" />

    <template v-else>
      <p v-if="isEmptyData" class="health-trend__empty" data-state="empty">
        暂无历史趋势：本机还没有健康快照，今天起每天进入本页会记录一次健康率。
      </p>

      <div class="health-trend__chart" role="img" :aria-label="chartLabel">
        <div
          v-for="(point, index) in visiblePoints"
          :key="point.date"
          class="health-trend__col"
          :class="{ 'health-trend__col--empty': !point.recorded }"
        >
          <span class="health-trend__rate">
            {{ point.recorded ? `${point.healthRate}%` : '—' }}
          </span>
          <div class="health-trend__track">
            <div
              v-if="point.recorded"
              class="health-trend__bar"
              :class="`health-trend__bar--${barTone(point)}`"
              :style="{ height: barHeight(point) }"
            />
          </div>
          <span
            class="health-trend__axis"
            :class="{ 'health-trend__axis--today': index === visiblePoints.length - 1 }"
          >
            {{ point.label }}
          </span>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.health-trend {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.health-trend__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.health-trend__meta {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.health-trend__skeleton {
  min-height: calc(var(--space-10) + var(--space-6));
  border-radius: var(--radius-sm);
}

.health-trend__empty {
  font: var(--text-caption);
  line-height: 1.65;
  color: var(--color-text-tertiary);
}

.health-trend__chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--space-2);
  align-items: end;
}

.health-trend__col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.health-trend__rate {
  font: var(--font-weight-medium) var(--font-size-12) / var(--line-height-12) var(--font-family-number);
  color: var(--color-text-secondary);
  white-space: nowrap;
}

.health-trend__col--empty .health-trend__rate {
  color: var(--color-text-disabled);
}

.health-trend__track {
  display: flex;
  align-items: flex-end;
  width: 100%;
  height: var(--space-10);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-pressed);
  overflow: hidden;
}

.health-trend__bar {
  width: 100%;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  background-color: var(--color-border-strong);
  transition: height var(--duration-base) var(--ease-standard);
}

.health-trend__bar--success {
  background-color: var(--color-success);
}

.health-trend__bar--warning {
  background-color: var(--color-warning);
}

.health-trend__bar--danger {
  background-color: var(--color-danger);
}

.health-trend__axis {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  white-space: nowrap;
}

.health-trend__axis--today {
  color: var(--color-text-secondary);
  font-weight: var(--font-weight-medium);
}
</style>
