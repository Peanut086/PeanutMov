<script setup lang="ts">
/**
 * 海报墙网格（设计规范 6.4）
 *
 * - 列数走 `--layout-grid-columns`（2/3/4 响应式），不写死列宽
 * - 2:3 海报、gap 12/16、行间距含标题区
 * - 骨架数量 = 首屏可见数量（默认 6）
 * - REV-11：条目超过 `VIRTUALIZE_MIN_ROWS` 行时启用窗口化渲染（见
 *   `useVirtualGrid`），把 DOM 节点数限制在视口附近；小列表仍全量渲染
 */
import { useTemplateRef } from 'vue';

import type { MediaItem } from '@/types';

import PosterCard from '@/components/media/PosterCard.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';
import { useVirtualGrid } from '@/components/media/useVirtualGrid';

const props = withDefaults(
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
    /** 关闭虚拟化（默认开启；测试与降级用） */
    virtual?: boolean;
  }>(),
  {
    loading: false,
    skeletonCount: 6,
    progressMap: () => ({}),
    downloadedIds: () => [],
    showMeta: true,
    virtual: true,
  },
);

const emit = defineEmits<{
  (e: 'select', item: MediaItem): void;
  (e: 'longpress', item: MediaItem): void;
}>();

const gridEl = useTemplateRef<HTMLElement>('grid');

const { visibleItems, active, padTop, padBottom } = useVirtualGrid(() => gridEl.value ?? null, {
  items: () => props.items,
  columns: () => 2,
  paddingX: () => 0,
  showMeta: () => props.showMeta,
  enabled: () => props.virtual,
});

function isDownloaded(id: string, list: string[]): boolean {
  return list.includes(id);
}
</script>

<template>
  <div ref="grid" class="poster-grid" role="list">
    <template v-if="loading && items.length === 0">
      <SkeletonPoster v-for="n in skeletonCount" :key="`sk-${n}`" />
    </template>

    <!-- 虚拟化：用绝对定位的内层网格撑开滚动高度，只渲染窗口内行 -->
    <template v-else-if="active">
      <div
        class="poster-grid__viewport"
        :style="{ height: `${padTop}px`, paddingBottom: `${padBottom}px` }"
      >
        <div class="poster-grid__inner">
          <div
            v-for="item in visibleItems"
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
      </div>
    </template>

    <template v-else>
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
    </template>
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

/*
 * 虚拟化模式：外层只负责占位（高度 = 上方 + 窗口 + 下方），
 * 内层才是真正的网格。二者列数/间距一致，视觉与非虚拟化无差别。
 */
.poster-grid__viewport {
  grid-column: 1 / -1;
  box-sizing: border-box;
}

.poster-grid__inner {
  display: grid;
  grid-template-columns: repeat(var(--layout-grid-columns), minmax(0, 1fr));
  column-gap: var(--layout-grid-gap);
  row-gap: var(--space-4);
}

@media (min-width: 600px) {
  .poster-grid {
    row-gap: var(--space-5);
  }

  .poster-grid__inner {
    row-gap: var(--space-5);
  }
}
</style>
