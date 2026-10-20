<script setup lang="ts">
/**
 * 收藏卡（页面蓝图 §9）
 *
 * 海报 + 片名 + 年份/类型；源已移除时显示 danger 标签（AC-35）。
 * 长按触发 Sheet（取消收藏 / 查看详情）。
 */
import type { FavoriteRecord } from '@/types';

import PosterImage from '@/components/common/PosterImage.vue';
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
      <PosterImage :src="item.posterUrl" :alt="item.title" />
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
  gap: var(--space-1);
  width: 100%;
  min-width: 0;
  text-align: left;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.favorite-card:active {
  transform: scale(0.98);
}

.favorite-card__frame {
  position: relative;
  border-radius: var(--radius-card);
  overflow: hidden;
}

.favorite-card__warning {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  height: 20px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-sm);
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
  font: var(--text-caption);
  font-weight: var(--font-weight-medium);
}

.favorite-card__title {
  margin-top: var(--space-1);
  font: var(--text-label);
  color: var(--color-text-primary);
}

.favorite-card__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}
</style>
