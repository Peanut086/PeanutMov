<script setup lang="ts">
/**
 * 继续观看横滑区（页面蓝图 §2，设计规范 6.5）
 *
 * 卡片宽 132（海报 132×198），右侧 12 间距；右侧不内缩让末张"露出边缘"暗示可滑。
 * 右上角 28×28 移除按钮（命中区 44）；整卡点击进播放页续播。
 */
import type { HistoryRecord } from '@/types';
import { formatRemaining } from '@/shared/time';

import PosterImage from '@/components/common/PosterImage.vue';

defineProps<{ items: HistoryRecord[] }>();

const emit = defineEmits<{
  (e: 'select', record: HistoryRecord): void;
  (e: 'remove', record: HistoryRecord): void;
}>();
</script>

<template>
  <div class="continue-row" role="list">
    <div v-for="rec in items" :key="rec.id" class="continue-card" role="listitem">
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
  width: 132px;
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
  margin-top: var(--space-1);
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.continue-card__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.continue-card__remove {
  position: absolute;
  top: var(--space-1);
  right: var(--space-1);
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: rgba(0, 0, 0, 0.55);
  color: #ffffff;
  backdrop-filter: blur(4px);
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
</style>
