<script setup lang="ts">
/**
 * 批量治理操作区（EXT-01 / FR 批量操作）
 *
 * 纯展示组件：只负责按钮、禁用态与进度文案，确认弹窗与结果提示由页面处理。
 * 三个动作：复检失败源 / 清理失败源（标记禁用）/ 恢复被禁用的源。
 *
 * 状态：
 * - 默认：三个按钮 + 目标数量
 * - 目标为 0：按钮禁用，并给出「当前没有可批量处理的源」说明
 * - 进行中：对应按钮显示进度并锁住其余按钮；复检额外提供取消
 */
import type { HealthCenterAction } from '@/stores/sourceStore';

import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

withDefaults(
  defineProps<{
    /** 可复检的失败源数量（仅启用中的失败源） */
    failedCount: number;
    /** 可清理的失败源数量（启用中的失败源，将被标记为禁用） */
    cleanupCount: number;
    /** 可恢复的已禁用源数量 */
    disabledCount: number;
    /** 进行中的动作；null 表示空闲 */
    busy?: HealthCenterAction | null;
    /** 复检进行中（含从其它入口触发的检测） */
    rechecking?: boolean;
    /** 进行中的进度文案 */
    progressText?: string;
  }>(),
  { busy: null, rechecking: false, progressText: '处理中…' },
);

const emit = defineEmits<{
  (e: 'recheck'): void;
  (e: 'cleanup'): void;
  (e: 'restore'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <section class="batch-actions" aria-labelledby="batch-actions-title">
    <div class="batch-actions__head">
      <h2 id="batch-actions-title" class="section-title">批量治理</h2>
      <span class="batch-actions__meta">同一时刻只执行一项</span>
    </div>

    <div class="batch-actions__list">
      <button
        class="btn btn--primary btn--md btn--block"
        type="button"
        :disabled="failedCount === 0 || busy !== null || rechecking"
        @click="emit('recheck')"
      >
        <LoadingSpinner v-if="busy === 'recheck'" :size="14" />
        {{ busy === 'recheck' ? progressText : `复检失败源（${failedCount}）` }}
      </button>

      <button
        v-if="rechecking"
        class="btn btn--ghost btn--md btn--block"
        type="button"
        @click="emit('cancel')"
      >
        取消复检
      </button>

      <button
        class="btn btn--secondary btn--md btn--block"
        type="button"
        :disabled="cleanupCount === 0 || busy !== null || rechecking"
        @click="emit('cleanup')"
      >
        <LoadingSpinner v-if="busy === 'cleanup'" :size="14" />
        {{ busy === 'cleanup' ? progressText : `清理失败源（${cleanupCount}）` }}
      </button>

      <button
        class="btn btn--secondary btn--md btn--block"
        type="button"
        :disabled="disabledCount === 0 || busy !== null || rechecking"
        @click="emit('restore')"
      >
        <LoadingSpinner v-if="busy === 'restore'" :size="14" />
        {{ busy === 'restore' ? progressText : `恢复已禁用源（${disabledCount}）` }}
      </button>
    </div>

    <p class="batch-actions__note">
      复检只覆盖启用中的失败源；已禁用的失败源需先恢复才会重新探测。清理只会标记为禁用，不删除源配置。
    </p>

    <p v-if="failedCount === 0 && cleanupCount === 0 && disabledCount === 0" class="batch-actions__empty">
      当前没有可批量处理的源。
    </p>
  </section>
</template>

<style scoped>
.batch-actions {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.batch-actions__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.batch-actions__meta {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.batch-actions__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.batch-actions__note {
  font: var(--text-caption);
  line-height: 1.65;
  color: var(--color-text-tertiary);
}

.batch-actions__empty {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}
</style>
