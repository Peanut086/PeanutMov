<script setup lang="ts">
/**
 * 批次分组头（FR-61 / AC-144 / AC-145）
 *
 * 展示"已完成 n/总数"，并提供两个批量动作：
 * - 重试本批失败项（仅 failed，按集号升序，由 `downloadService.retryBatch` 执行）
 * - 删除本批已完成（仅 completed，文件与记录）
 * 动作本身由父级调用 store，本组件只发事件，避免组件内做业务。
 */
import { computed } from 'vue';

import type { BatchProgress } from '@/services/downloadBatch';

const props = withDefaults(
  defineProps<{
    progress: BatchProgress;
    /** 批次副标题（媒体标题 / 时间） */
    label?: string;
    /** 操作进行中（禁用按钮） */
    busy?: boolean;
  }>(),
  { label: '', busy: false },
);

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'delete-completed'): void;
}>();

const percent = computed(() => {
  const { completed, total } = props.progress;
  if (total <= 0) return 0;
  return Math.round((completed / total) * 100);
});

const doneText = computed(() => `已完成 ${props.progress.completed}/${props.progress.total}`);

const canRetry = computed(() => props.progress.failed > 0 && !props.busy);
const canDelete = computed(() => props.progress.completed > 0 && !props.busy);

const allDone = computed(
  () => props.progress.total > 0 && props.progress.completed === props.progress.total,
);
</script>

<template>
  <section class="batch" role="group" :aria-label="`批次 ${doneText}`">
    <div class="batch__head">
      <span class="batch__title truncate-1">{{ label || '本批下载' }}</span>
      <span class="batch__count" :class="{ 'batch__count--done': allDone }">{{ doneText }}</span>
    </div>

    <div class="batch__track" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
      <div class="batch__fill" :style="{ width: `${percent}%` }" />
    </div>

    <div class="batch__meta">
      <span v-if="progress.active > 0" class="batch__chip">下载中 {{ progress.active }}</span>
      <span v-if="progress.failed > 0" class="batch__chip batch__chip--danger">失败 {{ progress.failed }}</span>
      <span v-if="progress.canceled > 0" class="batch__chip">已取消 {{ progress.canceled }}</span>
      <span v-if="progress.failed === 0 && progress.active === 0" class="batch__chip">无失败项</span>
    </div>

    <div class="batch__actions">
      <button
        class="batch__btn"
        type="button"
        :disabled="!canRetry"
        @click="emit('retry')"
      >
        重试本批失败项
      </button>
      <button
        class="batch__btn"
        type="button"
        :disabled="!canDelete"
        @click="emit('delete-completed')"
      >
        删除本批已完成
      </button>
    </div>
  </section>
</template>

<style scoped>
.batch {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: 1px solid var(--color-border);
}

.batch__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.batch__title {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.batch__count {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.batch__count--done {
  color: var(--color-success);
}

.batch__track {
  height: 4px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-track);
  overflow: hidden;
}

.batch__fill {
  height: 100%;
  border-radius: var(--radius-full);
  background-color: var(--color-brand);
  transition: width var(--duration-base) var(--ease-standard);
}

.batch__meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.batch__chip {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.batch__chip--danger {
  color: var(--color-danger);
}

.batch__actions {
  display: flex;
  gap: var(--space-2);
}

.batch__btn {
  flex: 1 1 0;
  min-height: 36px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-elevated);
  color: var(--color-text-primary);
  font: var(--text-button-sm);
  transition: var(--transition-color);
}

.batch__btn:disabled {
  color: var(--color-text-disabled);
  background-color: var(--color-overlay-subtle);
}
</style>
