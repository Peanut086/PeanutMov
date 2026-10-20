<script setup lang="ts">
/**
 * 媒体元信息行（详情页/搜索结果复用）
 *
 * 形式：`2021 · 中国 · 剧情 · 8.2 分 · 45 分钟`，自动跳过空字段。
 */
import { computed } from 'vue';

import type { MediaItem } from '@/types';
import { formatDuration } from '@/shared/time';

import { mediaTypeLabel } from '@/components/common/format';

const props = withDefaults(
  defineProps<{
    item: MediaItem;
    /** 是否包含类型（默认包含） */
    withType?: boolean;
    /** 是否包含评分 */
    withRating?: boolean;
    /** 是否包含时长 */
    withDuration?: boolean;
  }>(),
  { withType: true, withRating: true, withDuration: true },
);

const parts = computed<string[]>(() => {
  const out: string[] = [];
  if (props.item.year !== null) out.push(String(props.item.year));
  if (props.withType) out.push(mediaTypeLabel(props.item.type));
  if (props.item.area) out.push(props.item.area);
  if (props.item.genres.length > 0) out.push(props.item.genres.slice(0, 2).join('/'));
  if (props.withRating && props.item.rating !== null) out.push(`${props.item.rating.toFixed(1)} 分`);
  if (props.withDuration && props.item.durationSec !== null) out.push(formatDuration(props.item.durationSec));
  return out;
});
</script>

<template>
  <p class="media-meta">
    <span v-for="(part, idx) in parts" :key="part + idx">
      <span v-if="idx > 0" class="media-meta__dot" aria-hidden="true">·</span>{{ part }}
    </span>
  </p>
</template>

<style scoped>
.media-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.media-meta__dot {
  margin-right: var(--space-1);
}
</style>
