<script setup lang="ts">
/**
 * 海报墙网格（设计规范 6.4）
 *
 * - 列数走 `--layout-grid-columns`（2/3/4 响应式），不写死列宽
 * - 2:3 海报、gap 12/16、行间距含标题区
 * - 骨架数量 = 首屏可见数量（默认 6）
 * - 滚动项 `content-visibility: auto` 降低离屏渲染成本（60fps 目标）
 */
import type { MediaItem } from '@/types';

import PosterCard from '@/components/media/PosterCard.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';

withDefaults(
  defineProps<{
    items: MediaItem[];
    loading?: boolean;
    /** 骨架数量 */
    skeletonCount?: number;
    /** 每项进度（mediaId → 0~1） */
    progressMap?: Record<string, number>;
    /** 已下载的 mediaId 集合 */
    downloadedIds?: string[];
    /** 是否显示副标题 */
    showMeta?: boolean;
  }>(),
  { loading: false, skeletonCount: 6, progressMap: () => ({}), downloadedIds: () => [], showMeta: true },
);

const emit = defineEmits<{
  (e: 'select', item: MediaItem): void;
  (e: 'longpress', item: MediaItem): void;
}>();

function isDownloaded(id: string, list: string[]): boolean {
  return list.includes(id);
}
</script>

<template>
  <div class="poster-grid" role="list">
    <template v-if="loading && items.length === 0">
      <SkeletonPoster v-for="n in skeletonCount" :key="`sk-${n}`" />
    </template>

    <div
      v-for="item in items"
      :key="item.id"
      class="poster-grid__cell"
      role="listitem"
    >
      <PosterCard
        :item="item"
        :progress="progressMap[item.id] ?? 0"
        :downloaded="item.isDemo ? false : isDownloaded(item.id, downloadedIds)"
        :demo="item.isDemo"
        :show-meta="showMeta"
        @select="emit('select', $event)"
        @longpress="emit('longpress', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.poster-grid {
  display: grid;
  grid-template-columns: repeat(var(--layout-grid-columns), minmax(0, 1fr));
  column-gap: var(--layout-grid-gap);
  row-gap: var(--space-4);
  padding-top: var(--space-3);
}

.poster-grid__cell {
  min-width: 0;
  content-visibility: auto;
  contain-intrinsic-size: 0 260px;
}

@media (min-width: 600px) {
  .poster-grid {
    row-gap: var(--space-5);
  }
}
</style>
