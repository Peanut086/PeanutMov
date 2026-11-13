<script setup lang="ts">
/**
 * Toast 宿主（设计规范 8.8）
 *
 * 订阅 `uiStore.toasts`，底部居中、最多 3 条、可点击关闭。
 * 进入 200ms 上移淡入、退出 150ms 加速淡出。
 * OPT-03：error 类型 Toast 触发 heavy 触觉反馈。
 */
import { storeToRefs } from 'pinia';
import { watch } from 'vue';

import { useUiStore } from '@/stores/uiStore';
import { useHaptic } from '@/composables/useHaptic';
import type { ToastMessage } from '@/types';

const ui = useUiStore();
const { toasts } = storeToRefs(ui);
const { haptic } = useHaptic();

function onAction(t: ToastMessage): void {
  if (t.action) {
    t.action.onClick();
    ui.dismiss(t.id);
  }
}

/** 监听新增 toast，基于 id 去重检测 error 类型并触发触觉反馈 */
const seenIds = new Set<string>();
watch(toasts, (newToasts) => {
  for (const t of newToasts) {
    if (!seenIds.has(t.id) && t.type === 'error') {
      haptic('heavy');
    }
    seenIds.add(t.id);
  }
  // 清理已不在队列中的 id
  const currentIds = new Set(newToasts.map((t) => t.id));
  for (const id of seenIds) {
    if (!currentIds.has(id)) seenIds.delete(id);
  }
}, { deep: true });

const iconPath: Record<'info' | 'success' | 'error', string> = {
  info: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM12 11v5.4M12 7.9v.2',
  success: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Zm-4 8.2 2.9 2.9 5.2-5.6',
  error: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM12 8v5M12 16h.01',
};
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast" tag="div" class="toast-host__list">
      <!-- 容器只能是 div：撤销按钮要能 Tab 到，而 button 里不能再套一个可聚焦控件 -->
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="`toast--${t.type}`"
        :role="t.type === 'error' ? 'alert' : 'status'"
        @click="ui.dismiss(t.id)"
      >
        <svg
          class="toast__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path :d="iconPath[t.type]" />
        </svg>
        <span class="toast__text">{{ t.text }}</span>
        <button
          v-if="t.action"
          class="toast__action"
          type="button"
          @click.stop="onAction(t)"
        >{{ t.action.label }}</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  left: 50%;
  /* 悬浮胶囊口径：胶囊高 + 底部间距 + 一点呼吸 */
  bottom: calc(
    var(--layout-tabbar-height) + var(--layout-tabbar-gap) + var(--safe-bottom) + var(--space-4)
  );
  z-index: var(--z-toast);
  width: min(88vw, 420px);
  transform: translateX(-50%);
  pointer-events: none;
}

.toast-host__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: center;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-card);
  background-color: var(--color-bg-glass-strong);
  -webkit-backdrop-filter: var(--blur-sheet);
  backdrop-filter: var(--blur-sheet);
  box-shadow: var(--shadow-3);
  border: 1px solid var(--color-border-glass);
  color: var(--color-text-primary);
  font: var(--font-weight-medium) 13px / 1.5 var(--font-family-base);
  text-align: left;
  pointer-events: auto;
  cursor: pointer;
}

.toast__icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  margin-top: 2px;
}

.toast--info .toast__icon {
  color: var(--color-info);
}

.toast--success .toast__icon {
  color: var(--color-success);
}

.toast--error .toast__icon {
  color: var(--color-danger);
}

.toast__text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  flex: 1;
}

.toast__action {
  flex: 0 0 auto;
  margin-left: var(--space-2);
  padding: var(--space-1) var(--space-2);
  font: var(--text-label-strong);
  color: var(--color-brand);
  background: transparent;
  border: 1px solid var(--color-brand);
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.toast__action:hover {
  background-color: rgba(var(--color-brand-rgb, 59, 130, 246), 0.1);
}

.toast__action:active {
  background-color: rgba(var(--color-brand-rgb, 59, 130, 246), 0.2);
}

.toast-enter-active {
  transition: transform var(--duration-base) var(--ease-decelerate),
    opacity var(--duration-base) var(--ease-decelerate);
}

.toast-leave-active {
  transition: transform var(--duration-fast) var(--ease-accelerate),
    opacity var(--duration-fast) var(--ease-accelerate);
}

.toast-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.toast-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

.toast-move {
  transition: transform var(--duration-base) var(--ease-standard);
}
</style>
