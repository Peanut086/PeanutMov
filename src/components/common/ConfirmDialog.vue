<script setup lang="ts">
/**
 * 通用确认对话框（设计规范 8.9）
 *
 * 由 `uiStore.confirm()` 驱动：`await confirm({...})` 返回 boolean。
 * 遮罩点击**不关闭**（防误触）；Esc 视为取消；危险操作初始焦点在"取消"。
 */
import { nextTick, ref, watch } from 'vue';

import { useUiStore } from '@/stores/uiStore';

const ui = useUiStore();
const cancelRef = ref<HTMLButtonElement | null>(null);

watch(
  () => ui.confirmState,
  async (state) => {
    if (!state) return;
    await nextTick();
    cancelRef.value?.focus();
  },
);

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') {
    ev.stopPropagation();
    ui.resolveConfirm(false);
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="ui.confirmState" class="dialog-layer" @keydown="onKeydown">
        <div class="dialog-layer__scrim" />
        <div
          class="dialog"
          role="alertdialog"
          aria-modal="true"
          :aria-label="ui.confirmState.title"
        >
          <h2 class="dialog__title">{{ ui.confirmState.title }}</h2>
          <p v-if="ui.confirmState.message" class="dialog__message">
            {{ ui.confirmState.message }}
          </p>
          <div class="dialog__actions">
            <button
              ref="cancelRef"
              class="btn btn--secondary btn--md dialog__btn"
              type="button"
              @click="ui.resolveConfirm(false)"
            >
              {{ ui.confirmState.cancelText }}
            </button>
            <button
              class="btn btn--md dialog__btn"
              :class="ui.confirmState.danger ? 'btn--danger' : 'btn--primary'"
              type="button"
              @click="ui.resolveConfirm(true)"
            >
              {{ ui.confirmState.confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dialog-layer {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
}

.dialog-layer__scrim {
  position: absolute;
  inset: 0;
  background-color: var(--color-bg-overlay);
}

.dialog {
  position: relative;
  width: min(88vw, 360px);
  padding: var(--space-6) var(--space-5) var(--space-4);
  border-radius: var(--radius-xl);
  background-color: var(--color-bg-elevated);
  box-shadow: var(--shadow-4);
}

.dialog__title {
  font: var(--text-title-2);
  color: var(--color-text-primary);
  text-align: center;
}

.dialog__message {
  margin-top: var(--space-2);
  font: var(--text-label);
  color: var(--color-text-secondary);
  text-align: center;
  line-height: 1.6;
  white-space: pre-line;
}

.dialog__actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-top: var(--space-5);
}

.dialog__btn {
  min-height: 44px;
  width: 100%;
}

.dialog-enter-active {
  transition: opacity var(--duration-base) var(--ease-decelerate);
}

.dialog-leave-active {
  transition: opacity var(--duration-fast) var(--ease-accelerate);
}

.dialog-enter-from,
.dialog-leave-to {
  opacity: 0;
}

.dialog-enter-active .dialog {
  animation: dialog-pop var(--duration-base) var(--ease-decelerate);
}

@keyframes dialog-pop {
  from {
    transform: scale(0.96);
  }
  to {
    transform: scale(1);
  }
}
</style>
