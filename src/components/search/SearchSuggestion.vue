<script setup lang="ts">
/**
 * OPT-07：搜索建议下拉列表
 *
 * 展示在搜索框下方，显示匹配建议：
 * - 历史记录匹配（带时钟图标）
 * - 媒体库标题匹配（带影片图标）
 * - 热门搜索匹配（带火焰图标）
 *
 * 支持键盘导航（上下箭头选择，回车确认）。
 */
import type { SearchSuggestion } from '@/services/suggestService';

import IconChevron from '@/components/icons/IconChevron.vue';
import IconClose from '@/components/icons/IconClose.vue';

defineProps<{
  suggestions: SearchSuggestion[];
  activeIndex: number;
  keyword: string;
}>();

const emit = defineEmits<{
  (e: 'select', text: string): void;
  (e: 'delete', text: string): void;
}>();

function getSourceIcon(source: SearchSuggestion['source']): string {
  switch (source) {
    case 'history':
      return 'M12 8v4l3 2M12 4a8 8 0 1 0 8 8';
    case 'library':
      return 'M4 4h16v16H4zM4 8h16M8 4v16';
    case 'hot':
      return 'M12 2c-1 4-4 6-4 10a4 4 0 0 0 8 0c0-4-3-6-4-10z';
    default:
      return 'M12 4v16M4 12h16';
  }
}

function getSourceLabel(source: SearchSuggestion['source']): string {
  switch (source) {
    case 'history':
      return '历史';
    case 'library':
      return '本地';
    case 'hot':
      return '热门';
    default:
      return '';
  }
}

/**
 * 高亮匹配文本：将关键词在文本中标记为 <mark>
 */
function highlightText(text: string, keyword: string): string {
  if (!keyword.trim()) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const kw = escapeHtml(keyword.trim());
  const regex = new RegExp(`(${escapeRegex(kw)})`, 'gi');
  return escaped.replace(regex, '<mark class="suggestion-highlight">$1</mark>');
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
</script>

<template>
  <ul
    v-if="suggestions.length > 0"
    class="suggestion-list"
    role="listbox"
    :aria-label="`搜索建议，共 ${suggestions.length} 条`"
  >
    <li
      v-for="(item, idx) in suggestions"
      :key="`${item.source}-${item.text}`"
      class="suggestion-item"
      :class="{ 'suggestion-item--active': idx === activeIndex }"
      role="option"
      :aria-selected="idx === activeIndex"
    >
      <button
        class="suggestion-item__btn"
        type="button"
        @click="emit('select', item.text)"
      >
        <svg
          class="suggestion-item__icon"
          :class="`suggestion-item__icon--${item.source}`"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path :d="getSourceIcon(item.source)" />
        </svg>
        <span class="suggestion-item__text" v-html="highlightText(item.text, keyword)" />
        <span class="suggestion-item__tag" :class="`suggestion-item__tag--${item.source}`">
          {{ getSourceLabel(item.source) }}
        </span>
      </button>
      <button
        v-if="item.source === 'history'"
        class="suggestion-item__delete"
        type="button"
        :aria-label="`删除建议 ${item.text}`"
        @click.stop="emit('delete', item.text)"
      >
        <IconClose :size="12" />
      </button>
      <IconChevron
        v-else
        :size="14"
        class="suggestion-item__arrow"
      />
    </li>
  </ul>
</template>

<style scoped>
.suggestion-list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: var(--space-1) 0;
  list-style: none;
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-dropdown);
  max-height: 320px;
  overflow-y: auto;
}

.suggestion-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-3);
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.suggestion-item--active {
  background-color: var(--color-bg-pressed);
}

.suggestion-item__btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  text-align: left;
}

.suggestion-item__icon {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  color: var(--color-text-tertiary);
}

.suggestion-item__icon--history {
  color: var(--color-text-tertiary);
}

.suggestion-item__icon--library {
  color: var(--color-success);
}

.suggestion-item__icon--hot {
  color: var(--color-warning);
}

.suggestion-item__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--text-body);
  color: var(--color-text-primary);
}

:deep(.suggestion-highlight) {
  background-color: transparent;
  color: var(--color-brand-text);
  font-weight: 600;
}

.suggestion-item__tag {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font: var(--font-weight-medium) 10px / 1.2 var(--font-family-base);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.suggestion-item__tag--history {
  background-color: var(--color-bg-surface);
  color: var(--color-text-tertiary);
}

.suggestion-item__tag--library {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.suggestion-item__tag--hot {
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
}

.suggestion-item__delete {
  position: relative;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: transparent;
  border: none;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: var(--transition-color);
}

.suggestion-item__delete::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.suggestion-item__delete:active {
  background-color: var(--color-overlay-press);
  color: var(--color-text-primary);
}

.suggestion-item__arrow {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  opacity: 0.5;
  transform: rotate(-90deg);
}
</style>
