<script setup lang="ts">
/**
 * 四态统一视图（技术方案 8.2）
 *
 * props：`state: LoadState`、`emptyText/emptyDesc`、`error`、`retryable`
 * 插槽：`#loading` / `#empty` / `#error`（提供任一插槽即覆盖默认渲染）
 *
 * 用法要点：`state === 'success'` 时应由父级显式 `v-if` 渲染真实内容，
 * 或把内容放到默认插槽——本组件在 success/idle/refreshing 时不渲染任何覆盖层，
 * 只渲染默认插槽，避免"加载完成但仍显示骨架"。
 */
import { computed } from 'vue';

import type { AppErrorShape, LoadState } from '@/types';

import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

const props = withDefaults(
  defineProps<{
    state: LoadState;
    emptyTitle?: string;
    emptyDesc?: string;
    emptyAction?: string;
    emptyVariant?: 'box' | 'search' | 'history' | 'favorite' | 'download' | 'source';
    error?: AppErrorShape | null;
    /** 错误态"返回"文案，为空不显示 */
    backText?: string;
    /** 离线文案，默认"离线模式，展示本地缓存" */
    offlineText?: string;
    /** 加载文案 */
    loadingText?: string;
  }>(),
  {
    emptyTitle: '暂无内容',
    emptyDesc: '',
    emptyAction: '',
    emptyVariant: 'box',
    error: null,
    backText: '',
    offlineText: '离线模式，展示本地缓存',
    loadingText: '加载中…',
  },
);

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'back'): void;
  (e: 'empty-action'): void;
}>();

const isBlocking = computed(
  () =>
    props.state === 'loading' ||
    props.state === 'empty' ||
    props.state === 'error' ||
    props.state === 'offline',
);

const showContent = computed(() => props.state === 'success' || props.state === 'idle' || props.state === 'refreshing');
</script>

<template>
  <div class="state-view" :data-state="state">
    <!-- 加载 -->
    <div v-if="state === 'loading'" class="state-view__panel" role="status" aria-live="polite">
      <slot name="loading">
        <LoadingSpinner :size="24" />
        <p class="state-view__text">{{ loadingText }}</p>
      </slot>
    </div>

    <!-- 空 -->
    <div v-else-if="state === 'empty'" class="state-view__panel">
      <slot name="empty">
        <EmptyState
          :title="emptyTitle"
          :description="emptyDesc"
          :action-text="emptyAction"
          :variant="emptyVariant"
          @action="emit('empty-action')"
        />
      </slot>
    </div>

    <!-- 错误 -->
    <div v-else-if="state === 'error'" class="state-view__panel">
      <slot name="error">
        <ErrorState :error="error" :back-text="backText" @retry="emit('retry')" @back="emit('back')" />
      </slot>
    </div>

    <!-- 离线且无缓存 -->
    <div v-else-if="state === 'offline'" class="state-view__panel">
      <slot name="error">
        <EmptyState
          variant="box"
          title="离线且无本地缓存"
          :description="offlineText"
          action-text="返回"
          @action="emit('back')"
        />
      </slot>
    </div>

    <!-- 成功 / 空闲 / 刷新中：渲染真实内容 -->
    <template v-else-if="showContent">
      <slot />
    </template>

    <span v-if="isBlocking" class="state-view__sr">当前状态：{{ state }}</span>
  </div>
</template>

<style scoped>
.state-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.state-view__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-height: 220px;
  padding: var(--space-6) 0;
}

.state-view__text {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.state-view__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
