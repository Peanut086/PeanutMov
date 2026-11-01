<script setup lang="ts">
/**
 * 源卡片（页面蓝图 §11）
 *
 * 名称 + 类型徽标 + 内置/警示角标 + 地址 + 健康状态 + 启用开关。
 * 点击卡片进编辑；长按/右侧 ⋯ 打开操作 Sheet（上移/下移/设默认/删除）。
 */
import { computed } from 'vue';

import type { Source, SourceType } from '@/types';
import type { HealthTier } from '@/shared/healthTier';
import { formatRelativeTime } from '@/shared/time';
import { isNative } from '@/shared/platform';

import HealthBadge from '@/components/source/HealthBadge.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';

const props = withDefaults(
  defineProps<{
    source: Source;
    /** 是否为默认源 */
    isDefault?: boolean;
    /** 是否健康检查中 */
    checking?: boolean;
    /** 线路质量档位（v1.2 / CHG-05；缺省时徽标回落到 health 映射） */
    tier?: HealthTier;
    /** 最近一次探测耗时（v1.2 / CHG-05） */
    latencyMs?: number | null;
  }>(),
  { isDefault: false, checking: false, tier: undefined, latencyMs: null },
);

const emit = defineEmits<{
  (e: 'select', source: Source): void;
  (e: 'toggle', source: Source, enabled: boolean): void;
  (e: 'menu', source: Source): void;
}>();

const TYPE_LABELS: Record<SourceType, string> = {
  demo: '演示',
  alist: 'AList',
  webdav: 'WebDAV',
  jellyfin: 'Jellyfin',
  site: '站点',
  spider: '爬虫',
  douban: '豆瓣',
};

const typeLabel = computed(() => TYPE_LABELS[props.source.type]);

/** 爬虫源只在 App 内可用（dex 无法在浏览器执行） */
const appOnly = computed(() => props.source.type === 'spider' && !isNative());

const address = computed(() => {
  if (props.source.type === 'demo') return '内置公开版权样片，无需配置';
  return props.source.baseUrl || '未填写地址';
});

const checkedText = computed(() => {
  if (props.source.healthCheckedAt === null) return '尚未检测';
  return formatRelativeTime(props.source.healthCheckedAt);
});
</script>

<template>
  <article class="source-card">
    <button class="source-card__main" type="button" @click="emit('select', source)">
      <div class="source-card__head">
        <span class="source-card__name truncate-1">{{ source.name }}</span>
        <span class="source-card__type">{{ typeLabel }}</span>
        <span v-if="source.builtin" class="source-card__flag">内置</span>
        <span v-if="isDefault" class="source-card__flag source-card__flag--brand">默认</span>
        <span v-if="source.warning" class="source-card__flag source-card__flag--warning" :title="source.warning">
          ⚠
        </span>
        <span v-if="appOnly" class="source-card__flag source-card__flag--brand">仅 App 可用</span>
      </div>

      <p class="source-card__url truncate-1">{{ address }}</p>

      <div class="source-card__status">
        <span v-if="checking" class="source-card__checking" aria-live="polite">
          <span class="source-card__spinner" aria-hidden="true" />
          检测中…
        </span>
        <template v-else>
          <HealthBadge :health="source.health" :tier="tier" :latency-ms="latencyMs" />
          <span class="source-card__checked">{{ checkedText }}</span>
        </template>
        <span v-if="!source.enabled" class="source-card__disabled">已禁用</span>
      </div>

      <p v-if="source.warning" class="source-card__warning-text">{{ source.warning }}</p>
    </button>

    <div class="source-card__actions">
      <ToggleSwitch
        :model-value="source.enabled"
        :label="`${source.name} 启用状态`"
        @update:model-value="emit('toggle', source, $event)"
      />
      <button
        class="source-card__menu"
        type="button"
        :aria-label="`${source.name} 更多操作`"
        @click="emit('menu', source)"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5.5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
    </div>
  </article>
</template>

<style scoped>
.source-card {
  display: flex;
  align-items: stretch;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.source-card__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  text-align: left;
}

.source-card__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.source-card__name {
  font: var(--font-weight-semibold) 13.5px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
  max-width: 100%;
}

.source-card__type {
  height: 20px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: 5px;
  background-color: var(--color-overlay-neutral);
  color: var(--color-text-secondary);
  font: var(--font-weight-semibold) 10.5px / 1 var(--font-family-number);
}

.source-card__flag {
  height: 20px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: 5px;
  background-color: var(--color-overlay-neutral);
  color: var(--color-text-tertiary);
  font: var(--font-weight-semibold) 10.5px / 1 var(--font-family-number);
}

.source-card__flag--brand {
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
}

.source-card__flag--warning {
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
}

.source-card__url {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.source-card__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-1);
  min-height: 20px;
}

.source-card__checked {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.source-card__disabled {
  font: var(--text-caption);
  color: var(--color-text-disabled);
}

.source-card__checking {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.source-card__spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--color-border-strong);
  border-top-color: var(--color-brand);
  animation: source-spin 800ms linear infinite;
}

@keyframes source-spin {
  to {
    transform: rotate(360deg);
  }
}

.source-card__warning-text {
  margin-top: var(--space-1);
  font: var(--text-caption);
  color: var(--color-warning);
}

.source-card__actions {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-2);
  padding-top: 2px;
}

.source-card__menu {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-tertiary);
}

.source-card__menu svg {
  width: 20px;
  height: 20px;
}
</style>
