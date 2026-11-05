<script setup lang="ts">
/**
 * 继续观看横滑区（页面蓝图 §2，设计规范 6.5）
 *
 * 两种模式：
 * - 默认：卡片宽 112（海报 112×168），竖排海报 + 标题 + 剩余时间
 * - compact：水平条 72px 高，缩略图 + 标题 + 进度条，更紧凑
 *
 * 右上角移除按钮（命中区 ≥44）；整卡点击进播放页续播。
 */
import type { HistoryRecord } from '@/types';
import { formatRemaining } from '@/shared/time';

import PosterImage from '@/components/common/PosterImage.vue';

withDefaults(defineProps<{ items: HistoryRecord[]; compact?: boolean }>(), {
  compact: false,
});

const emit = defineEmits<{
  (e: 'select', record: HistoryRecord): void;
  (e: 'remove', record: HistoryRecord): void;
}>();
</script>

<template>
  <!-- compact 模式：水平条列表 -->
  <div v-if="compact" class="continue-compact" role="list">
    <div
      v-for="rec in items"
      :key="rec.id"
      class="continue-compact__item"
      role="listitem"
    >
      <button
        class="continue-compact__main"
        type="button"
        :aria-label="`继续观看 ${rec.title}${rec.episodeNumber ? ` 第 ${rec.episodeNumber} 集` : ''}`"
        @click="emit('select', rec)"
      >
        <div class="continue-compact__thumb">
          <PosterImage :src="rec.posterUrl" :alt="rec.title" />
        </div>
        <div class="continue-compact__info">
          <span class="continue-compact__title truncate-1">
            {{ rec.episodeNumber !== null ? `第 ${rec.episodeNumber} 集` : rec.title }}
          </span>
          <span class="continue-compact__meta">{{ formatRemaining(rec.positionSec, rec.durationSec) }}</span>
          <div
            class="continue-compact__progress"
            role="progressbar"
            :aria-valuenow="Math.round(rec.progress * 100)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span
              class="continue-compact__progress-fill"
              :style="{ width: `${Math.max(2, Math.round(rec.progress * 100))}%` }"
            />
          </div>
        </div>
      </button>
      <button
        class="continue-compact__remove"
        type="button"
        :aria-label="`从继续观看移除 ${rec.title}`"
        @click.stop="emit('remove', rec)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  </div>

  <!-- 默认模式：竖排卡片横滑 -->
  <div v-else class="continue-row" role="list">
    <div
      v-for="rec in items"
      :key="rec.id"
      class="continue-card"
      role="listitem"
    >
      <button
        class="continue-card__main"
        type="button"
        :aria-label="`继续观看 ${rec.title}${rec.episodeNumber ? ` 第 ${rec.episodeNumber} 集` : ''}`"
        @click="emit('select', rec)"
      >
        <div class="continue-card__poster">
          <PosterImage :src="rec.posterUrl" :alt="rec.title" />
          <span class="continue-card__scrim" aria-hidden="true" />
          <div
            class="continue-card__progress"
            role="progressbar"
            :aria-valuenow="Math.round(rec.progress * 100)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <span
              class="continue-card__progress-fill"
              :style="{ width: `${Math.max(2, Math.round(rec.progress * 100))}%` }"
            />
          </div>
        </div>
        <span class="continue-card__title truncate-1">
          {{ rec.episodeNumber !== null ? `第 ${rec.episodeNumber} 集` : rec.title }}
        </span>
        <span class="continue-card__meta">{{ formatRemaining(rec.positionSec, rec.durationSec) }}</span>
      </button>

      <button
        class="continue-card__remove"
        type="button"
        :aria-label="`从继续观看移除 ${rec.title}`"
        @click.stop="emit('remove', rec)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* ========== 默认模式（竖排卡片横滑） ========== */
.continue-row {
  display: flex;
  gap: var(--space-3);
  overflow-x: auto;
  scrollbar-width: none;
  padding-right: calc(var(--layout-page-padding-x) - var(--space-3));
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
}

.continue-row::-webkit-scrollbar {
  display: none;
}

.continue-card {
  position: relative;
  flex: 0 0 auto;
  width: 112px;
  scroll-snap-align: start;
}

.continue-card__main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  width: 100%;
  text-align: left;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.continue-card__main:active {
  transform: scale(0.98);
}

.continue-card__poster {
  position: relative;
  border-radius: var(--radius-card);
  overflow: hidden;
}

.continue-card__scrim {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40%;
  background: var(--gradient-bottom-fade);
  opacity: 0.4;
  pointer-events: none;
}

.continue-card__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background-color: rgba(255, 255, 255, 0.24);
}

.continue-card__progress-fill {
  display: block;
  height: 100%;
  background-color: var(--color-brand);
}

.continue-card__title {
  font: var(--font-weight-semibold) 13px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.continue-card__meta {
  font: var(--font-weight-regular) 11px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.continue-card__remove {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: rgba(0, 0, 0, 0.58);
  color: #ffffff;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}

.continue-card__remove::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.continue-card__remove svg {
  width: 14px;
  height: 14px;
}

/* ========== Compact 模式（水平条） ========== */
.continue-compact {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.continue-compact__item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 72px;
  padding: var(--space-2);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.continue-compact__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.continue-compact__main:active {
  transform: scale(0.985);
}

.continue-compact__thumb {
  flex: 0 0 auto;
  width: 48px;
  height: 68px;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.continue-compact__thumb :deep(.poster-image) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.continue-compact__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.continue-compact__title {
  font: var(--font-weight-semibold) 13px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.continue-compact__meta {
  font: var(--font-weight-regular) 11px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.continue-compact__progress {
  margin-top: var(--space-1);
  height: 3px;
  border-radius: 2px;
  background-color: var(--color-overlay-track);
}

.continue-compact__progress-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background-color: var(--color-brand);
}

.continue-compact__remove {
  position: relative;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-hover);
  color: var(--color-text-tertiary);
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.continue-compact__remove:active {
  background-color: var(--color-overlay-press);
}

.continue-compact__remove::after {
  content: '';
  position: absolute;
  inset: -6px;
}

.continue-compact__remove svg {
  width: 14px;
  height: 14px;
}
</style>
