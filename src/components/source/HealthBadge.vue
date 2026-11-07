<script setup lang="ts">
/**
 * 源健康徽标（设计规范 8.16 HealthBadge / 技术方案 17.3）
 *
 * Tag sm + 8px 圆点。两种渲染模式：
 * 1. 传 `tier`（v1.2 / CHG-05）：按线路质量 6 档着色并显示延迟（如「极速 128ms」）；
 * 2. 不传 `tier`（既有调用）：按 `SourceHealth` 6 态映射，文案/色调与 v1.1 逐字一致。
 *
 * 档位 → 色调：fast=紫(--color-tier-fast)、good=绿、fair=黄、slow=灰、bad=红、unknown=中性。
 * 阈值与文案一律来自 `@/shared/healthTier`，本组件不重复实现分级。
 */
import { computed } from 'vue';

import type { SourceHealth } from '@/types';
import { HEALTH_TIER_LABELS } from '@/shared/healthTier';
import type { HealthTier } from '@/shared/healthTier';

type Tone = 'success' | 'danger' | 'info' | 'warning' | 'neutral' | 'fast';

const props = withDefaults(
  defineProps<{
    health: SourceHealth;
    /** 最近一次探测耗时（ms）；缺省视为未知（v1.2 / CHG-05） */
    latencyMs?: number | null;
    /** 线路质量档位；缺省时沿用 health 映射（v1.2 / CHG-05） */
    tier?: HealthTier;
    withText?: boolean;
  }>(),
  { latencyMs: null, tier: undefined, withText: true },
);

const MAP: Record<SourceHealth, { label: string; tone: Tone }> = {
  ok: { label: '正常', tone: 'success' },
  auth_failed: { label: '认证失败', tone: 'danger' },
  timeout: { label: '连接超时', tone: 'info' },
  unreachable: { label: '无法连接', tone: 'danger' },
  bad_config: { label: '配置有误', tone: 'warning' },
  empty: { label: '空壳', tone: 'warning' },
  unknown: { label: '未检测', tone: 'neutral' },
};

/** 档位 → 色调（17.3 表；slow 与 unknown 同为灰调，靠文字区分） */
const TIER_TONE: Record<HealthTier, Tone> = {
  fast: 'fast',
  good: 'success',
  fair: 'warning',
  slow: 'neutral',
  bad: 'danger',
  unknown: 'neutral',
};

/** 只有可用且拿到延迟的档位才追加毫秒数 */
const LATENCY_TIERS: ReadonlySet<HealthTier> = new Set<HealthTier>(['fast', 'good', 'fair', 'slow']);

const hasLatency = computed(
  () => typeof props.latencyMs === 'number' && Number.isFinite(props.latencyMs) && props.latencyMs >= 0,
);

const label = computed(() => {
  const tier = props.tier;
  if (tier === undefined) return MAP[props.health].label;
  // 「异常」对用户没有行动指引，保留具体故障文案（FR-47）
  if (tier === 'bad') return MAP[props.health].label;
  const base = HEALTH_TIER_LABELS[tier];
  if (!LATENCY_TIERS.has(tier) || !hasLatency.value) return base;
  return `${base} ${Math.round(props.latencyMs as number)}ms`;
});

const tone = computed<Tone>(() =>
  props.tier === undefined ? MAP[props.health].tone : TIER_TONE[props.tier],
);
</script>

<template>
  <span
    class="health-badge"
    :class="`health-badge--${tone}`"
    :data-tier="tier ?? null"
    :aria-label="label"
  >
    <span class="health-badge__dot" aria-hidden="true" />
    <span v-if="withText">{{ label }}</span>
    <span v-else class="health-badge__sr">{{ label }}</span>
  </span>
</template>

<style scoped>
.health-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 20px;
  padding: 0 6px;
  border-radius: var(--radius-sm);
  font: var(--text-caption);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
}

.health-badge__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background-color: currentColor;
}

.health-badge--success {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.health-badge--danger {
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
}

.health-badge--warning {
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
}

.health-badge--info {
  background-color: var(--color-info-soft);
  color: var(--color-info);
}

/* v1.2 / CHG-05：极速档紫（tokens.css 新增 --color-tier-fast*） */
.health-badge--fast {
  background-color: var(--color-tier-fast-soft);
  color: var(--color-tier-fast);
}

/* slow / unknown 同灰调；底色改用 --color-border，深色等价、浅色才正确 */
.health-badge--neutral {
  background-color: var(--color-border);
  color: var(--color-text-secondary);
}

.health-badge__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
