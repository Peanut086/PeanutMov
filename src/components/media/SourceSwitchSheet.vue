<script setup lang="ts">
/**
 * 来源切换弹层（详情页 / 搜索页共用）
 *
 * 展示当前来源与候选来源列表，支持：
 * - 当前源固定第一行（不可重复点击）；
 * - 每个候选显示源名、健康状态、可播状态、集数；
 * - 推荐候选标记（非当前、第一个可播）；
 * - 底部「搜索更多来源」按钮（按需联网补充）。
 */
import { computed } from 'vue';

import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import IconChevron from '@/components/icons/IconChevron.vue';
import type { SourceCandidate } from '@/components/media/sourceCandidates';
import { healthLabel, playabilityLabel } from '@/components/media/sourceCandidates';

const props = defineProps<{
  modelValue: boolean;
  title: string;
  candidates: SourceCandidate[];
  loading?: boolean;
  searching?: boolean;
  canSearchMore?: boolean;
  searchError?: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'select', candidate: SourceCandidate): void;
  (e: 'search-more'): void;
}>();

const isOpen = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

function selectCandidate(candidate: SourceCandidate): void {
  if (candidate.isCurrent) return;
  emit('select', candidate);
}

function playabilityDotClass(status: SourceCandidate['playability']): string {
  switch (status) {
    case 'playable':
      return 'play-dot--playable';
    case 'verifying':
      return 'play-dot--verifying';
    case 'empty':
      return 'play-dot--empty';
    case 'error':
      return 'play-dot--error';
    default:
      return '';
  }
}
</script>

<template>
  <BottomSheet v-model="isOpen" :title="title">
    <div class="source-switch-sheet">
      <!-- 加载态 -->
      <div v-if="loading" class="source-switch-sheet__loading">
        <LoadingSpinner :size="24" />
        <span>加载候选来源…</span>
      </div>

      <!-- 候选列表 -->
      <ul v-else-if="candidates.length > 0" class="source-switch-list">
        <li
          v-for="candidate in candidates"
          :key="candidate.mediaId"
          class="source-switch-item"
          :class="{
            'source-switch-item--current': candidate.isCurrent,
            'source-switch-item--recommended': candidate.recommended,
          }"
        >
          <button
            class="source-switch-item__btn"
            type="button"
            :disabled="candidate.isCurrent"
            @click="selectCandidate(candidate)"
          >
            <span class="source-switch-item__main">
              <span class="source-switch-item__name">
                {{ candidate.sourceName }}
                <span
                  v-if="playabilityLabel(candidate.playability) !== '未检测'"
                  class="play-dot"
                  :class="playabilityDotClass(candidate.playability)"
                  :aria-label="playabilityLabel(candidate.playability)"
                />
              </span>
              <span class="source-switch-item__meta">
                <span class="source-switch-item__health">{{ healthLabel(candidate.health) }}</span>
                <span v-if="candidate.episodeCount !== null" class="source-switch-item__episodes">
                  · {{ candidate.episodeCount >= 100 ? '连载中' : `全${candidate.episodeCount}集` }}
                </span>
              </span>
            </span>
            <span v-if="candidate.isCurrent" class="source-switch-item__badge source-switch-item__badge--current">
              当前
            </span>
            <span v-else-if="candidate.recommended" class="source-switch-item__badge source-switch-item__badge--recommended">
              推荐
            </span>
            <IconChevron v-if="!candidate.isCurrent" :size="16" class="source-switch-item__arrow" />
          </button>
        </li>
      </ul>

      <!-- 空态 -->
      <div v-else class="source-switch-sheet__empty">
        <p>没找到其它来源</p>
        <p v-if="searchError" class="source-switch-sheet__error">{{ searchError }}</p>
      </div>

      <!-- 搜索更多 -->
      <div v-if="canSearchMore" class="source-switch-sheet__actions">
        <button
          class="source-switch-sheet__search-btn"
          type="button"
          :disabled="searching"
          @click="emit('search-more')"
        >
          <LoadingSpinner v-if="searching" :size="16" />
          <span>{{ searching ? '正在搜索…' : '搜索更多来源' }}</span>
        </button>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
.source-switch-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.source-switch-sheet__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  color: var(--color-text-secondary);
  font: var(--text-body);
}

.source-switch-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.source-switch-item {
  border-bottom: 1px solid var(--color-divider);
}

.source-switch-item:last-child {
  border-bottom: none;
}

.source-switch-item__btn {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-height: 56px;
  padding: var(--space-3) var(--space-4);
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background-color var(--duration-fast);
}

.source-switch-item__btn:disabled {
  cursor: default;
}

.source-switch-item__btn:not(:disabled):active {
  background-color: var(--color-bg-pressed);
}

.source-switch-item__main {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.source-switch-item__name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.source-switch-item__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.source-switch-item__badge {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  font: var(--font-weight-semibold) 10px / 1.2 var(--font-family-base);
}

.source-switch-item__badge--current {
  background-color: var(--color-success-soft);
  color: var(--color-success);
}

.source-switch-item__badge--recommended {
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
}

.source-switch-item__arrow {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  transform: rotate(90deg);
}

.source-switch-sheet__empty {
  padding: var(--space-6);
  text-align: center;
  color: var(--color-text-secondary);
  font: var(--text-body);
}

.source-switch-sheet__error {
  margin-top: var(--space-2);
  color: var(--color-danger);
  font: var(--text-caption);
}

.source-switch-sheet__actions {
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-divider);
}

.source-switch-sheet__search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  padding: var(--space-3);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font: var(--text-label);
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.source-switch-sheet__search-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.source-switch-sheet__search-btn:not(:disabled):active {
  background-color: var(--color-bg-pressed);
}

/* 可播性徽章（与 SearchView 保持一致） */
.play-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
}

.play-dot--playable {
  background-color: var(--color-success, #34c759);
  box-shadow: 0 0 0 2px rgba(52, 199, 89, 0.18);
}

.play-dot--verifying {
  background-color: var(--color-warning, #f0a830);
  animation: play-dot-pulse 1.2s ease-in-out infinite;
}

.play-dot--empty {
  background-color: var(--color-text-tertiary);
}

.play-dot--error {
  background-color: var(--color-danger, #ff3b30);
}

@keyframes play-dot-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
