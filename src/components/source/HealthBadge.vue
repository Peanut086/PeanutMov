<script setup lang="ts">
/**
 * 源健康徽标（设计规范 8.16 HealthBadge）
 *
 * Tag sm + 8px 圆点；ok=success、auth_failed=unreachable=danger、
 * timeout=info、bad_config=warning、unknown=neutral。
 */
import { computed } from 'vue';

import type { SourceHealth } from '@/types';

const props = withDefaults(defineProps<{ health: SourceHealth; withText?: boolean }>(), {
  withText: true,
});

const MAP: Record<SourceHealth, { label: string; tone: 'success' | 'danger' | 'info' | 'warning' | 'neutral' }> = {
  ok: { label: '正常', tone: 'success' },
  auth_failed: { label: '认证失败', tone: 'danger' },
  timeout: { label: '连接超时', tone: 'info' },
  unreachable: { label: '无法连接', tone: 'danger' },
  bad_config: { label: '配置有误', tone: 'warning' },
  unknown: { label: '未检测', tone: 'neutral' },
};

const view = computed(() => MAP[props.health]);
</script>

<template>
  <span class="health-badge" :class="`health-badge--${view.tone}`">
    <span class="health-badge__dot" aria-hidden="true" />
    <span v-if="withText">{{ view.label }}</span>
    <span v-else class="health-badge__sr">{{ view.label }}</span>
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

.health-badge--neutral {
  background-color: rgba(255, 255, 255, 0.08);
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
