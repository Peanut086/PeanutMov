<script setup lang="ts">
/**
 * 导入预览列表（页面蓝图 §13）
 *
 * 每行：勾选框 + 名称 + 类型 + 校验结果（✓ / 重复 / ⚠ 警示 / ✕ 无效原因）。
 * 仅 `valid` 且未重复选项可勾选（重复项按策略处理，默认勾选）。
 */
import type { ImportPreviewEntry, SourceType } from '@/types';

const props = defineProps<{
  entries: ImportPreviewEntry[];
  /** 已选 key 集合 */
  selectedKeys: string[];
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: 'toggle', key: string, selected: boolean): void }>();

const TYPE_LABELS: Record<SourceType | 'unknown', string> = {
  demo: '演示',
  alist: 'AList',
  webdav: 'WebDAV',
  jellyfin: 'Jellyfin',
  site: '站点',
  unknown: '未知',
};

function toggle(entry: ImportPreviewEntry): void {
  if (!entry.valid || props.disabled) return;
  const selected = props.selectedKeys.includes(entry.key);
  emit('toggle', entry.key, !selected);
}

function isSelected(entry: ImportPreviewEntry): boolean {
  return props.selectedKeys.includes(entry.key);
}

function statusOf(entry: ImportPreviewEntry): { text: string; tone: 'ok' | 'warn' | 'error' | 'dup' } {
  if (!entry.valid) {
    const error = entry.issues.find((i) => i.level === 'error');
    return { text: error?.message ?? '配置无效', tone: 'error' };
  }
  if (entry.duplicateOf) return { text: '已存在', tone: 'dup' };
  if (entry.warning) return { text: '警示', tone: 'warn' };
  return { text: '可导入', tone: 'ok' };
}
</script>

<template>
  <ul class="import-list">
    <li v-for="entry in entries" :key="entry.key">
      <div
        class="import-row"
        :class="{ 'import-row--invalid': !entry.valid, 'import-row--selected': isSelected(entry) }"
      >
        <button
          class="import-row__check"
          type="button"
          :disabled="!entry.valid || disabled"
          role="checkbox"
          :aria-checked="isSelected(entry)"
          :aria-label="`选择导入 ${entry.name || entry.key}`"
          @click="toggle(entry)"
        >
          <span class="import-row__box" :class="{ 'import-row__box--on': isSelected(entry) }">
            <svg
              v-if="isSelected(entry)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.6"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="m5 12.5 4.5 4.5L19 6.8" />
            </svg>
          </span>
        </button>

        <div class="import-row__body">
          <div class="import-row__head">
            <span class="import-row__name truncate-1">{{ entry.name || '（未命名）' }}</span>
            <span class="import-row__type">{{ TYPE_LABELS[entry.type] }}</span>
            <span class="import-row__status" :class="`import-row__status--${statusOf(entry).tone}`">
              {{ statusOf(entry).text }}
            </span>
          </div>
          <p class="import-row__url truncate-1">{{ entry.baseUrl || '无地址' }}</p>
          <p v-if="entry.warning" class="import-row__warning">⚠ {{ entry.warning }}</p>
          <p v-if="!entry.valid" class="import-row__reason">
            {{ entry.issues.find((i) => i.level === 'error')?.message ?? '配置无效，已跳过' }}
          </p>
        </div>
      </div>
    </li>
  </ul>
</template>

<style scoped>
.import-list {
  display: flex;
  flex-direction: column;
}

.import-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-height: 64px;
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-divider);
}

.import-row--invalid {
  opacity: 0.72;
}

.import-row__check {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: calc(var(--space-2) * -1);
}

.import-row__box {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1.5px solid var(--color-border-strong);
  color: var(--color-text-on-brand);
}

.import-row__box--on {
  background-color: var(--color-brand);
  border-color: var(--color-brand);
  color: var(--color-text-on-brand);
}

.import-row__box svg {
  width: 14px;
  height: 14px;
}

.import-row__body {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.import-row__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.import-row__name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
  max-width: 100%;
}

.import-row__type {
  height: 20px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
  background-color: rgba(255, 255, 255, 0.08);
  color: var(--color-text-secondary);
  font: var(--text-caption);
}

.import-row__status {
  font: var(--text-caption);
  font-weight: var(--font-weight-medium);
}

.import-row__status--ok {
  color: var(--color-success);
}

.import-row__status--warn {
  color: var(--color-warning);
}

.import-row__status--error {
  color: var(--color-danger);
}

.import-row__status--dup {
  color: var(--color-info);
}

.import-row__url {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.import-row__warning {
  font: var(--text-caption);
  color: var(--color-warning);
}

.import-row__reason {
  font: var(--text-caption);
  color: var(--color-danger);
}
</style>
