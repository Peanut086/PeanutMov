<script setup lang="ts">
/**
 * 列表底部加载更多（设计规范 8.16）
 *
 * 三态：加载中（spinner + 文案）/ 没有更多 / 失败（可点击重试）。
 * 同时作为 IntersectionObserver 的 sentinel（监听自身可见性）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const props = withDefaults(
  defineProps<{
    loading?: boolean;
    hasMore?: boolean;
    failed?: boolean;
    /** 无更多时的文案（离线场景可替换） */
    noMoreText?: string;
    /** 是否启用滚动监听哨兵 */
    observe?: boolean;
  }>(),
  { loading: false, hasMore: true, failed: false, noMoreText: '没有更多了', observe: false },
);

const emit = defineEmits<{ (e: 'load-more'): void }>();

const rootRef = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | null = null;

function onMountedConnect(): void {
  if (!props.observe || typeof IntersectionObserver === 'undefined' || !rootRef.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && props.hasMore && !props.loading && !props.failed) {
        emit('load-more');
      }
    },
    { rootMargin: '0px 0px 300px 0px', threshold: 0 },
  );
  observer.observe(rootRef.value);
}

onMounted(onMountedConnect);

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div ref="rootRef" class="load-more" role="status" aria-live="polite">
    <template v-if="loading">
      <LoadingSpinner :size="16" label="加载中" />
      <span class="load-more__text">加载中…</span>
    </template>
    <button
      v-else-if="failed"
      class="load-more__retry"
      type="button"
      @click="emit('load-more')"
    >
      加载失败，点击重试
    </button>
    <!-- CHG-14：哨兵在视口内不再产生新的交集回调时，点击是手动兜底 -->
    <button v-else-if="hasMore" class="load-more__more" type="button" @click="emit('load-more')">
      上滑加载更多
    </button>
    <span v-else class="load-more__text">{{ noMoreText }}</span>
  </div>
</template>

<style scoped>
.load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 48px;
  padding: var(--space-2) 0;
}

.load-more__text {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.load-more__more {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  min-height: 44px;
  padding: 0 var(--space-3);
}

.load-more__retry {
  font: var(--text-caption);
  color: var(--color-brand-text);
  text-decoration: underline;
  text-underline-offset: 3px;
  min-height: 44px;
  padding: 0 var(--space-3);
}
</style>
