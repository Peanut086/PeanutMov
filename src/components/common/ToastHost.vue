<script setup lang="ts">
/**
 * Toast 宿主（设计规范 8.8）
 *
 * 订阅 `uiStore.toasts`，底部居中、最多 3 条、可点击关闭。
 * 进入 200ms 上移淡入、退出 150ms 加速淡出。
 */
import { storeToRefs } from 'pinia';

import { useUiStore } from '@/stores/uiStore';

const ui = useUiStore();
const { toasts } = storeToRefs(ui);

const iconPath: Record<'info' | 'success' | 'error', string> = {
  info: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM12 11v5.4M12 7.9v.2',
  success: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8Zm-4 8.2 2.9 2.9 5.2-5.6',
  error: 'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8ZM12 8v5M12 16h.01',
};
</script>

<template>
  <div class="toast-host" role="status" aria-live="polite" aria-atomic="false">
    <TransitionGroup name="toast" tag="div" class="toast-host__list">
      <button
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="`toast--${t.type}`"
        type="button"
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
      </button>
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
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
