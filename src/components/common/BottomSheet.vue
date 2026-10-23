<script setup lang="ts">
/**
 * 底部弹层（设计规范 8.7）
 *
 * - 最大高 80vh，顶部圆角 20，elevated 底 + shadow-4
 * - 遮罩点击关闭；Esc 关闭；向下拖拽 > 96px 关闭
 * - role="dialog" aria-modal，打开时焦点移入、Tab 循环困在弹层内，关闭后还原焦点（REV-10）
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

import IconClose from '@/components/icons/IconClose.vue';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    title?: string;
    /** 是否显示右上角关闭按钮 */
    closable?: boolean;
  }>(),
  { title: '', closable: true },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void }>();

const panelRef = ref<HTMLElement | null>(null);
const dragOffset = ref(0);
let startY = 0;
let startAt = 0;
let dragging = false;
/** 打开前持有焦点的元素，关闭时还原 */
let lastFocused: HTMLElement | null = null;

function close(): void {
  emit('update:modelValue', false);
}

function onScrim(): void {
  close();
}

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && props.modelValue) {
    ev.stopPropagation();
    close();
    return;
  }
  if (ev.key !== 'Tab' || !panelRef.value) return;
  // 焦点陷阱：Tab 在弹层内循环，不落到背景内容（REV-10）
  const panel = panelRef.value;
  const items = focusableIn(panel);
  const active = document.activeElement as HTMLElement | null;
  if (items.length === 0) {
    ev.preventDefault();
    panel.focus();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const inside = active !== null && panel.contains(active);
  if (ev.shiftKey) {
    if (!inside || active === first) {
      ev.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    ev.preventDefault();
    first.focus();
  }
}

function onPointerDown(ev: PointerEvent): void {
  // 只从把手/标题区开始拖拽，避免与内容滚动冲突
  dragging = true;
  startY = ev.clientY;
  startAt = Date.now();
  dragOffset.value = 0;
  (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging) return;
  const dy = ev.clientY - startY;
  dragOffset.value = Math.max(0, dy);
}

function onPointerUp(ev: PointerEvent): void {
  if (!dragging) return;
  dragging = false;
  const dy = ev.clientY - startY;
  const elapsed = Math.max(1, Date.now() - startAt);
  const velocity = Math.max(0, dy) / elapsed;
  if (dragOffset.value > 96 || velocity > 0.5) close();
  dragOffset.value = 0;
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener('keydown', onKeydown, true);
      await nextTick();
      panelRef.value?.focus();
    } else {
      document.removeEventListener('keydown', onKeydown, true);
      lastFocused?.focus();
      lastFocused = null;
    }
  },
);

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
  lastFocused?.focus();
  lastFocused = null;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="modelValue" class="sheet-layer">
        <div class="sheet-layer__scrim" @click="onScrim" />
        <section
          ref="panelRef"
          class="sheet"
          role="dialog"
          aria-modal="true"
          :aria-label="title || '选项'"
          tabindex="-1"
          :style="{ transform: dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined }"
        >
          <div
            class="sheet__handle-area"
            @pointerdown="onPointerDown"
            @pointermove="onPointerMove"
            @pointerup="onPointerUp"
            @pointercancel="onPointerUp"
          >
            <span class="sheet__handle" aria-hidden="true" />
          </div>

          <header v-if="title || closable" class="sheet__header">
            <h2 class="sheet__title truncate-1">{{ title }}</h2>
            <button
              v-if="closable"
              class="sheet__close"
              type="button"
              aria-label="关闭"
              @click="close"
            >
              <IconClose :size="20" />
            </button>
          </header>

          <div class="sheet__body">
            <slot />
          </div>

          <div v-if="$slots.footer" class="sheet__footer">
            <slot name="footer" />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet-layer {
  position: fixed;
  inset: 0;
  z-index: var(--z-sheet);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.sheet-layer__scrim {
  position: absolute;
  inset: 0;
  background-color: var(--color-bg-overlay);
}

.sheet {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  background-color: var(--color-bg-elevated);
  box-shadow: var(--shadow-4);
  outline: none;
}

.sheet__handle-area {
  display: flex;
  justify-content: center;
  padding: var(--space-2) 0 var(--space-1);
  touch-action: none;
}

.sheet__handle {
  width: 36px;
  height: 4px;
  border-radius: var(--radius-full);
  background-color: rgba(255, 255, 255, 0.24);
}

.sheet__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 52px;
  padding: 0 var(--space-2) 0 var(--space-4);
}

.sheet__title {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.sheet__close {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
}

.sheet__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0 var(--space-4) calc(var(--space-4) + var(--safe-bottom));
}

.sheet__footer {
  flex: 0 0 auto;
  padding: var(--space-3) var(--space-4) calc(var(--space-4) + var(--safe-bottom));
  border-top: var(--border-default);
}

.sheet-enter-active .sheet {
  animation: sheet-up var(--duration-slow) var(--ease-decelerate);
}

.sheet-leave-active .sheet {
  animation: sheet-down var(--duration-base) var(--ease-accelerate);
}

.sheet-enter-active .sheet-layer__scrim,
.sheet-leave-active .sheet-layer__scrim {
  transition: opacity var(--duration-slow) var(--ease-standard);
}

.sheet-enter-from .sheet-layer__scrim,
.sheet-leave-to .sheet-layer__scrim {
  opacity: 0;
}

@keyframes sheet-up {
  from {
    transform: translateY(100%);
  }
  to {
    transform: none;
  }
}

@keyframes sheet-down {
  from {
    transform: none;
  }
  to {
    transform: translateY(100%);
  }
}
</style>
