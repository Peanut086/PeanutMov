<script setup lang="ts">
/**
 * 收藏卡（页面蓝图 §9）
 *
 * 海报 + 片名 + 年份/类型；源已移除时显示 danger 标签（AC-35）。
 * 长按触发 Sheet（取消收藏 / 查看详情）。
 */
import type { FavoriteRecord } from '@/types';

import PosterImage from '@/components/common/PosterImage.vue';
import { IMG_W_CARD } from '@/shared/imageSize';
import { mediaTypeLabel } from '@/components/common/format';

const props = defineProps<{ item: FavoriteRecord }>();

const emit = defineEmits<{
  (e: 'select', item: FavoriteRecord): void;
  (e: 'longpress', item: FavoriteRecord): void;
}>();

let pressTimer: ReturnType<typeof setTimeout> | null = null;

function onPointerDown(): void {
  pressTimer = setTimeout(() => {
    pressTimer = null;
    emit('longpress', props.item);
  }, 500);
}

function cancelPress(): void {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function onClick(): void {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
    return;
  }
  emit('select', props.item);
}
</script>

<template>
  <button
    class="favorite-card"
    type="button"
    :aria-label="`${item.title}，${item.year ?? '未知年份'}，${mediaTypeLabel(item.type)}${item.sourceRemoved ? '，源已移除' : ''}`"
    @pointerdown="onPointerDown"
    @pointerup="cancelPress"
    @pointerleave="cancelPress"
    @pointercancel="cancelPress"
    @contextmenu.prevent
    @click="onClick"
  >
    <div class="favorite-card__frame">
      <PosterImage :src="item.posterUrl" :alt="item.title" :width-px="IMG_W_CARD" />
      <span v-if="item.sourceRemoved" class="favorite-card__warning">源已移除</span>
    </div>
    <span class="favorite-card__title clamp-2">{{ item.title }}</span>
    <span class="favorite-card__meta">
      {{ item.year ?? '未知年份' }} · {{ mediaTypeLabel(item.type) }}
    </span>
  </button>
</template>

<style scoped>
.favorite-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  text-align: left;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.favorite-card:active {
  transform: scale(0.985);
}

.favorite-card__frame {
  position: relative;
  border-radius: var(--radius-card);
  overflow: hidden;
  background-color: var(--color-bg-surface);
}

.favorite-card__warning {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  height: 20px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  background-color: var(--color-danger-soft);
  /* OPT-22: 去 backdrop-filter（低端 WebView 合成开销大） */
  color: var(--color-danger);
  font: var(--font-weight-semibold) 10.5px / 1 var(--font-family-number);
}

.favorite-card__title {
  font: var(--font-weight-semibold) 13px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.favorite-card__meta {
  font: var(--font-weight-regular) 11px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}
</style>
