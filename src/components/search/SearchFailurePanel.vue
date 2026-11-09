<script setup lang="ts">
/**
 * 搜索失败源汇总面板（OPT-04）
 *
 * - 汇总：`N 个源搜索失败` + 原因聚类（如「33 源站已失效 · 5 规则脚本异常」）
 * - 折叠：逐源明细默认折叠，点击右侧箭头展开（`aria-expanded` / `aria-controls`）
 * - 重试：只重跑失败源，由父级调用 store `retryFailedSources()`（本组件不发请求）
 *
 * 只做展示与交互，不含分类逻辑：原因文案来自 `summarizeSearchFailures`
 * （`@/services/searchAggregate`，与失败分类唯一真源同源）。
 * 视觉值全部取自 `src/styles/tokens.css`，无硬编码颜色/尺寸。
 */
import { computed, ref, useId } from 'vue';

import IconChevron from '@/components/icons/IconChevron.vue';
import { summarizeSearchFailures } from '@/services/searchAggregate';
import type { AppErrorShape } from '@/types';

const props = withDefaults(
  defineProps<{
    /** 失败源列表（`searchFailed`）；为空时不渲染面板 */
    failures: ReadonlyArray<{ sourceId: string; error: AppErrorShape }>;
    /** 源 id → 显示名（缺省回落 id，保证异常数据也有可读行） */
    nameOf?: (sourceId: string) => string;
    /** 重试请求进行中 */
    retrying?: boolean;
    /** 整轮搜索进行中（此时重试会与主搜索抢同一批源） */
    busy?: boolean;
  }>(),
  {
    nameOf: (sourceId: string) => sourceId,
    retrying: false,
    busy: false,
  },
);

const emit = defineEmits<{ retry: [] }>();

// P0-1：keyword_ignored 不算"真失败"，从失败汇总中排除
const realFailures = computed(() =>
  props.failures.filter((f) => f.error.code !== 'E_KEYWORD_IGNORED'),
);
const keywordIgnoredCount = computed(() =>
  props.failures.filter((f) => f.error.code === 'E_KEYWORD_IGNORED').length,
);

const summary = computed(() => summarizeSearchFailures(realFailures.value));
const expanded = ref(false);
const listId = `search-failure-list-${useId()}`;

const toggleLabel = computed(() => (expanded.value ? '收起失败源明细' : '展开失败源明细'));
const retryLabel = computed(() => (props.retrying ? '重试中…' : '重试失败源'));

function toggle(): void {
  expanded.value = !expanded.value;
}

function onRetry(): void {
  if (props.retrying || props.busy) return;
  emit('retry');
}
</script>

<template>
  <section v-if="summary.total > 0 || keywordIgnoredCount > 0" class="fail-panel" aria-label="搜索失败源">
    <div class="fail-panel__head">
      <svg
        class="fail-panel__icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="M12 4.6 3.8 19.4h16.4L12 4.6Z" />
        <path d="M12 9.6v4M12 16.6v.2" />
      </svg>

      <div class="fail-panel__text" aria-live="polite">
        <p v-if="summary.total > 0" class="fail-panel__title">{{ summary.total }} 个源搜索失败</p>
        <p v-if="keywordIgnoredCount > 0" class="fail-panel__title fail-panel__title--muted">
          {{ keywordIgnoredCount }} 个源忽略了关键词（已过滤）
        </p>
        <p v-if="summary.text" class="fail-panel__reasons">{{ summary.text }}</p>
      </div>

      <button
        v-if="summary.total > 0"
        class="fail-panel__retry"
        type="button"
        :disabled="retrying || busy"
        @click="onRetry"
      >
        {{ retryLabel }}
      </button>

      <button
        class="fail-panel__toggle"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="listId"
        :aria-label="toggleLabel"
        @click="toggle"
      >
        <IconChevron :size="14" :direction="expanded ? 'up' : 'down'" />
      </button>
    </div>

    <!-- v-show：保持 aria-controls 指向的元素始终存在 -->
    <ul v-show="expanded" :id="listId" class="fail-panel__list">
      <li v-for="row in summary.rows" :key="row.sourceId" class="fail-panel__row">
        <p class="fail-panel__row-head">
          <span class="fail-panel__row-source">{{ nameOf(row.sourceId) }}</span>
          <span class="fail-panel__row-label">{{ row.label }}</span>
        </p>
        <p v-if="row.detail" class="fail-panel__row-detail">{{ row.detail }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.fail-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3) var(--space-1) var(--space-2);
  border-radius: var(--radius-md);
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
}

.fail-panel__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--touch-min);
}

.fail-panel__icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
}

.fail-panel__text {
  flex: 1 1 auto;
  min-width: 0;
}

.fail-panel__title {
  font: var(--text-label-strong);
  /* 标题用 primary 而非 warning：浅色主题下 warning 在 warning-soft 底上仅约 4.6:1，
     小字贴着 AA 下限；警示语义由琥珀色图标 + 实心重试按钮承担 */
  color: var(--color-text-primary);
}

.fail-panel__title--muted {
  color: var(--color-text-secondary);
  font-weight: var(--font-weight-normal);
}

.fail-panel__reasons {
  overflow: hidden;
  font: var(--text-caption);
  color: var(--color-text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fail-panel__retry {
  flex: 0 0 auto;
  min-height: var(--touch-min);
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  background-color: var(--color-warning);
  color: var(--color-text-on-brand);
  font: var(--text-caption);
  font-weight: var(--font-weight-semibold);
  transition: var(--transition-color);
}

.fail-panel__retry:active {
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
}

.fail-panel__retry:disabled {
  background-color: transparent;
  color: var(--color-text-disabled);
}

.fail-panel__toggle {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: var(--touch-min);
  height: var(--touch-min);
  border-radius: var(--radius-sm);
  color: var(--color-warning);
  transition: var(--transition-color);
}

.fail-panel__toggle:active {
  background-color: var(--color-overlay-press);
}

.fail-panel__list {
  display: flex;
  flex-direction: column;
  padding-bottom: var(--space-1);
}

.fail-panel__row {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) 0;
  border-top: var(--border-width-hairline) solid var(--color-divider);
}

.fail-panel__row-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.fail-panel__row-source {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font: var(--text-label-strong);
  color: var(--color-text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fail-panel__row-label {
  flex: 0 0 auto;
  font: var(--text-caption);
  /* 同上：12px warning 文字在浅色主题贴 AA 下限，改用 secondary */
  color: var(--color-text-secondary);
}

.fail-panel__row-detail {
  font: var(--text-caption);
  /* 不用 tertiary：12px 小字在 warning-soft 底上对比度不足 AA（约 3.6:1） */
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}
</style>
