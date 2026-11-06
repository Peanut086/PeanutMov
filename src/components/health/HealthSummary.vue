<script setup lang="ts">
/**
 * 健康中心汇总卡（EXT-01 / FR 汇总展示）
 *
 * 四宫格：总源数 / 健康 / 失败 / 未检测。数据口径来自
 * `healthCenterService.summarizeSources`（由 store 计算后传入，组件不重复统计）。
 *
 * 状态：
 * - 默认：四项计数 + 已禁用副标题
 * - 加载中：四个骨架块（保留栅格占位，避免内容跳动）
 * - 空数据：总数 0 时仍展示 0，并给出「尚未添加源」引导
 */
import { computed } from 'vue';

import type { HealthCenterSummary } from '@/services/healthCenterService';

const props = withDefaults(
  defineProps<{
    summary: HealthCenterSummary;
    loading?: boolean;
  }>(),
  { loading: false },
);

type SummaryTone = 'total' | 'healthy' | 'failed' | 'unknown';

interface SummaryItem {
  key: SummaryTone;
  label: string;
  value: number;
}

const items = computed<SummaryItem[]>(() => [
  { key: 'total', label: '总源数', value: props.summary.total },
  { key: 'healthy', label: '健康', value: props.summary.healthy },
  { key: 'failed', label: '失败', value: props.summary.failed },
  { key: 'unknown', label: '未检测', value: props.summary.unknown },
]);

const isEmpty = computed(() => props.summary.total === 0);
</script>

<template>
  <section class="health-summary" aria-label="健康汇总">
    <div v-if="loading" class="health-summary__grid" data-state="loading">
      <div v-for="item in items" :key="item.key" class="skeleton health-summary__skeleton" />
    </div>

    <template v-else>
      <dl class="health-summary__grid" data-state="default">
        <div v-for="item in items" :key="item.key" class="health-summary__tile">
          <dt class="health-summary__label">{{ item.label }}</dt>
          <dd class="health-summary__value" :class="`health-summary__value--${item.key}`">
            {{ item.value }}
          </dd>
        </div>
      </dl>
      <p class="health-summary__meta">
        <template v-if="isEmpty">尚未添加任何源，添加后可在此查看健康汇总</template>
        <template v-else>
          共 {{ summary.total }} 个源<template v-if="summary.disabled > 0">
            · 其中 {{ summary.disabled }} 个已禁用</template>
        </template>
      </p>
    </template>
  </section>
</template>

<style scoped>
.health-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.health-summary__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: 0;
  padding: 0;
}

@media (min-width: 600px) {
  .health-summary__grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.health-summary__tile {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.health-summary__skeleton {
  min-height: calc(var(--space-10) + var(--space-3));
  border-radius: var(--radius-card);
}

.health-summary__label {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.health-summary__value {
  margin: 0;
  font: var(--font-weight-semibold) var(--font-size-24) / var(--line-height-24) var(--font-family-number);
  color: var(--color-text-primary);
}

.health-summary__value--healthy {
  color: var(--color-success);
}

.health-summary__value--failed {
  color: var(--color-danger);
}

.health-summary__value--unknown {
  color: var(--color-text-secondary);
}

.health-summary__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
