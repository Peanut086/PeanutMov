<script setup lang="ts">
/**
 * 历史列表行（页面蓝图 §8，设计规范 8.6 ListRow）
 *
 * 行高 88：前导海报 48×72 + 片名/集号 + 进度条 + 相对时间；右侧 ⋯ 操作。
 */
import type { HistoryRecord } from '@/types';
import { formatClock, formatRelativeTime, formatProgress } from '@/shared/time';

import PosterImage from '@/components/common/PosterImage.vue';
import { toPercent } from '@/components/common/format';

withDefaults(
  defineProps<{
    record: HistoryRecord;
    /** 源已被删除 */
    sourceRemoved?: boolean;
  }>(),
  { sourceRemoved: false },
);

const emit = defineEmits<{
  /** `origin` 供父级做封面共享元素转场（点击的整行按钮） */
  (e: 'select', record: HistoryRecord, origin?: HTMLElement): void;
  (e: 'menu', record: HistoryRecord): void;
}>();
</script>

<template>
  <div class="history-row">
    <button class="history-row__main" type="button" @click="emit('select', record, $event.currentTarget as HTMLElement)">
      <span class="history-row__poster">
        <PosterImage :src="record.posterUrl" :alt="record.title" />
      </span>

      <span class="history-row__body">
        <span class="history-row__title truncate-1">{{ record.title }}</span>
        <span class="history-row__sub truncate-1">
          <template v-if="record.episodeNumber !== null">第 {{ record.episodeNumber }} 集 · </template>
          看到 {{ formatClock(record.positionSec) }}
          <template v-if="sourceRemoved"> · 源已移除</template>
        </span>

        <span
          class="history-row__progress"
          role="progressbar"
          :aria-valuenow="toPercent(record.progress)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="`已观看 ${formatProgress(record.progress)}`"
        >
          <span
            class="history-row__progress-fill"
            :style="{ width: `${Math.max(2, toPercent(record.progress))}%` }"
          />
        </span>

        <span class="history-row__time">{{ formatRelativeTime(record.updatedAt) }}</span>
      </span>
    </button>

    <button
      class="history-row__menu"
      type="button"
      aria-label="更多操作"
      @click.stop="emit('menu', record)"
    >
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5.5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="18.5" cy="12" r="1.6" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.history-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  border-bottom: 1px solid var(--color-divider);
}

.history-row__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1 1 auto;
  min-width: 0;
  min-height: 82px;
  padding: var(--space-3) 0;
  text-align: left;
  border-radius: var(--radius-md);
}

.history-row__main:active {
  background-color: var(--color-overlay-subtle);
}

.history-row__poster {
  flex: 0 0 auto;
  width: 46px;
  border-radius: 9px;
  overflow: hidden;
}

.history-row__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 auto;
  min-width: 0;
}

.history-row__title {
  font: var(--font-weight-semibold) 14px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.history-row__sub {
  font: var(--font-weight-regular) 11.5px / 1.4 var(--font-family-base);
  color: var(--color-text-tertiary);
}

.history-row__progress {
  display: block;
  height: 3px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-track);
  overflow: hidden;
  margin-top: var(--space-1);
}

.history-row__progress-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background-color: var(--color-brand);
}

.history-row__time {
  font: var(--font-weight-regular) 11px / 1.4 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.history-row__menu {
  flex: 0 0 auto;
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-tertiary);
}

.history-row__menu svg {
  width: 20px;
  height: 20px;
}
</style>
