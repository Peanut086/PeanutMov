<script setup lang="ts">
/**
 * 底部弹层（设计规范 8.7）
 *
 * - 最大高 80vh，顶部圆角 20，elevated 底 + shadow-4
 * - 遮罩点击关闭；Esc 关闭；向下拖拽 > 96px 关闭
 * - role="dialog" aria-modal，打开时焦点移入、Tab 循环困在弹层内，关闭后还原焦点（REV-10）
 *
 * 拖拽手感优化：
 * - 松手未达阈值时平滑回弹（240ms 带微过冲）
 * - 遮罩透明度跟手（随拖拽距离渐隐）
 * - 拖拽关闭时从当前位置平滑下滑，不跳回 0
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';

import IconClose from '@/components/icons/IconClose.vue';
import { useHaptic } from '@/composables/useHaptic';

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

const { haptic } = useHaptic();

const panelRef = ref<HTMLElement | null>(null);
const dragOffset = ref(0);
/** 是否正在回弹动画中（松手未达阈值） */
const snapping = ref(false);
/** 是否正在拖拽关闭动画中（达到阈值后） */
const dragClosing = ref(false);
let startY = 0;
let startAt = 0;
let dragging = false;
/** 打开前持有焦点的元素，关闭时还原 */
let lastFocused: HTMLElement | null = null;

/** 遮罩透明度：随拖拽距离渐隐（最大拖拽距离按 300px 计算） */
const scrimOpacity = computed(() => {
  if (dragClosing.value) return 0;
  const maxOffset = 300;
  return Math.max(0, 1 - dragOffset.value / maxOffset);
});

/** 弹层 transform 样式 */
const sheetTransform = computed(() => {
  if (dragOffset.value > 0) return `translateY(${dragOffset.value}px)`;
  return undefined;
});

/** 弹层 transition 样式：拖拽中无过渡，回弹/关闭时有过渡 */
const sheetTransition = computed(() => {
  if (dragging) return 'none';
  if (snapping.value) return 'transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1)';
  if (dragClosing.value) return 'transform 200ms ease-in';
  return 'none';
});

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
  snapping.value = false;
  dragClosing.value = false;
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

  if (dragOffset.value > 96 || velocity > 0.5) {
    // 达到关闭阈值：从当前位置平滑下滑关闭
    dragClosing.value = true;
    dragOffset.value = window.innerHeight; // 滑出屏幕
    setTimeout(() => {
      close();
      dragClosing.value = false;
      dragOffset.value = 0;
    }, 200); // 与 sheetTransition 的关闭动画时长一致
  } else if (dragOffset.value > 0) {
    // 未达阈值：平滑回弹
    snapping.value = true;
    dragOffset.value = 0;
    setTimeout(() => {
      snapping.value = false;
    }, 240); // 与 sheetTransition 的回弹时长一致
  }
}

watch(
  () => props.modelValue,
  async (open) => {
    if (open) {
      haptic('light');
      lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.addEventListener('keydown', onKeydown, true);
      await nextTick();
      panelRef.value?.focus();
    } else {
      document.removeEventListener('keydown', onKeydown, true);
      lastFocused?.focus();
      lastFocused = null;
      // 重置拖拽状态
      dragOffset.value = 0;
      snapping.value = false;
      dragClosing.value = false;
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
      <div v-if="modelValue" class="sheet-layer" :class="{ 'sheet-layer--drag-closing': dragClosing }">
        <div
          class="sheet-layer__scrim"
          :style="{ opacity: scrimOpacity }"
          @click="onScrim"
        />
        <section
          ref="panelRef"
          class="sheet"
          role="dialog"
          aria-modal="true"
          :aria-label="title || '选项'"
          tabindex="-1"
          :style="{
            transform: sheetTransform,
            transition: sheetTransition,
          }"
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
  max-height: 82vh;
  border-radius: var(--radius-xl) var(--radius-xl) 0 0;
  background-color: var(--color-bg-surface);
  border-top: 1px solid var(--color-border-strong);
  box-shadow: var(--shadow-4);
  outline: none;
}

.sheet__handle-area {
  display: flex;
  justify-content: center;
  padding: var(--space-3) 0 var(--space-2);
  touch-action: none;
}

.sheet__handle {
  width: 38px;
  height: 4px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-handle);
}

.sheet__header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-2) 0 var(--layout-page-padding-x);
}

.sheet__title {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-title-3);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
}

.sheet__close {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
}

.sheet__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: var(--space-1) var(--layout-page-padding-x) calc(var(--space-5) + var(--safe-bottom));
}

.sheet__footer {
  flex: 0 0 auto;
  padding: var(--space-3) var(--layout-page-padding-x) calc(var(--space-4) + var(--safe-bottom));
  border-top: var(--border-default);
}

.sheet-enter-active .sheet {
  animation: sheet-up var(--duration-slow) var(--ease-decelerate);
}

.sheet-leave-active .sheet {
  animation: sheet-down var(--duration-base) var(--ease-accelerate);
}

/* 拖拽关闭时禁用 Transition 的 leave 动画，由 inline style 的 transition 接管 */
.sheet-layer--drag-closing .sheet {
  animation: none !important;
}

.sheet-layer--drag-closing.sheet-leave-active .sheet-layer__scrim {
  transition: none !important;
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
