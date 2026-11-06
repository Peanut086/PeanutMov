<script setup lang="ts">
/**
 * EXT-06/FR-69：频道自定义排序列表（长按拖拽）
 *
 * - 长按 500ms 激活拖拽（移动端不误触发滚动；短按不改变顺序，REV-24）
 * - REV-25：拖拽中**不改写数组**，只维护 `dragKey` + `targetIndex`；
 *   rAF 内仅更新被拖行与相邻行的 `transform`，松手一次性提交顺序（AC-167）
 * - 频道数超过 CHANNEL_ORDER_MAX 时禁用拖拽，改为提示「当前分组频道过多（n），请先按分组筛选」（AC-167）
 * - 提供 ↑ / ↓ 按钮作为键盘与无障碍的等价操作
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import { CHANNEL_ORDER_MAX } from '@/shared/constants';
import { useHaptic } from '@/composables/useHaptic';

interface SortRow {
  key: string;
  name: string;
}

const props = withDefaults(
  defineProps<{
    items: SortRow[];
    /** 外部忙碌（保存中）时禁止再次拖拽 */
    busy?: boolean;
    /** 空态文案 */
    emptyText?: string;
  }>(),
  { busy: false, emptyText: '该分组暂无频道' },
);

const emit = defineEmits<{
  /**
   * `origin` 区分提交来源（REV-34）：
   * - `drag`：长按拖拽松手，一次操作即为最终结果，调用方应立即提示
   * - `button`：↑ / ↓ 可连点，调用方应合并提示（防 toast 刷屏）
   */
  (e: 'reorder', keys: string[], origin: 'drag' | 'button'): void;
}>();

const { haptic } = useHaptic();

const listRef = ref<HTMLElement | null>(null);
const local = ref<SortRow[]>([]);
/** 正在拖拽的行（key）；非拖拽态为 null */
const dragKey = ref<string | null>(null);
/** 拖拽落点索引（相对当前 local 顺序） */
const targetIndex = ref<number>(-1);
/** 拖拽起点索引 */
const originIndex = ref<number>(-1);
const pressing = ref(false);

const tooMany = computed(() => props.items.length > CHANNEL_ORDER_MAX);
const disabled = computed(() => props.busy || tooMany.value);

let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressStartY = 0;
let dragging = false;
let rafId: number | null = null;
let pendingClientY = 0;
/** 拖拽开始时一次性测量的几何（首行 top / 行步长），移动过程中不再读取 DOM */
let dragTop = 0;
let dragStep = 0;

watch(
  () => props.items,
  (next) => {
    if (dragKey.value) return; // 拖拽中不覆盖本地顺序
    local.value = next.slice();
  },
  { immediate: true },
);

/** 行步长（行高 + 行间距）；行间距取列表的 `row-gap`，避免硬编码像素 */
function rowStepOf(listEl: HTMLElement, firstRect: DOMRect, secondRect: DOMRect | null): number {
  if (secondRect) {
    const step = secondRect.top - firstRect.top;
    if (step > 0) return step;
  }
  const gap = Number.parseFloat(getComputedStyle(listEl).rowGap || '0');
  return firstRect.height + (Number.isFinite(gap) ? gap : 0);
}

/** 测量拖拽几何（仅一次；happy-dom 等无布局环境返回 0，移动将被忽略） */
function measureDragGeometry(): void {
  dragTop = 0;
  dragStep = 0;
  const listEl = listRef.value;
  if (!listEl) return;
  const nodes = Array.from(listEl.querySelectorAll<HTMLElement>('[data-row]'));
  if (nodes.length === 0) return;
  const first = nodes[0]!.getBoundingClientRect();
  const second = nodes[1]?.getBoundingClientRect() ?? null;
  dragTop = first.top;
  dragStep = rowStepOf(listEl, first, second);
}

/** 指针 y → 目标索引（基于拖拽前的一次性测量，不再逐帧 getBoundingClientRect） */
function targetIndexAt(clientY: number): number {
  if (dragStep <= 0) return -1;
  const raw = Math.floor((clientY - dragTop) / dragStep);
  return Math.max(0, Math.min(local.value.length - 1, raw));
}

function autoScroll(clientY: number): void {
  const scroller = listRef.value?.closest<HTMLElement>('.sheet__body') ?? null;
  if (!scroller) return;
  const threshold = 72;
  if (clientY < threshold) scroller.scrollTop -= 10;
  else if (clientY > window.innerHeight - threshold) scroller.scrollTop += 10;
}

function clearPressTimer(): void {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function cancelRaf(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging || !dragKey.value) return;
  pendingClientY = ev.clientY;
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    if (!dragging) return;
    const next = targetIndexAt(pendingClientY);
    if (next >= 0 && next !== targetIndex.value) targetIndex.value = next;
    autoScroll(pendingClientY);
  });
}

/** 行位移：被拖行跟随落点，落点与起点之间的相邻行整体让位一格（REV-25） */
function rowTransform(idx: number): string | undefined {
  if (!dragging || originIndex.value < 0 || targetIndex.value < 0 || dragStep <= 0) return undefined;
  const origin = originIndex.value;
  const target = targetIndex.value;
  if (idx === origin) {
    const delta = target - origin;
    return delta === 0 ? undefined : `translateY(${delta * dragStep}px)`;
  }
  if (origin < target && idx > origin && idx <= target) return `translateY(${-dragStep}px)`;
  if (origin > target && idx >= target && idx < origin) return `translateY(${dragStep}px)`;
  return undefined;
}

function endDrag(commit: boolean): void {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointermove', onPressCancelMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointerup', cancelPress);
  window.removeEventListener('pointercancel', onPointerCancel);
  window.removeEventListener('pointercancel', cancelPress);
  clearPressTimer();
  cancelRaf();
  const wasDragging = dragging;
  const from = originIndex.value;
  const to = targetIndex.value;
  dragging = false;
  dragKey.value = null;
  originIndex.value = -1;
  targetIndex.value = -1;
  pressing.value = false;
  if (!wasDragging || !commit || from < 0 || to < 0 || from === to) return;
  const next = local.value.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) return;
  next.splice(to, 0, moved);
  local.value = next;
  haptic('light');
  // 松手只发一次 reorder（AC-167）
  emit(
    'reorder',
    next.map((row) => row.key),
    'drag',
  );
}

function onPointerUp(): void {
  endDrag(true);
}

function onPointerCancel(): void {
  endDrag(false);
}

function beginDrag(key: string): void {
  if (disabled.value) return;
  window.removeEventListener('pointermove', onPressCancelMove);
  const index = local.value.findIndex((row) => row.key === key);
  if (index < 0) return;
  measureDragGeometry();
  dragKey.value = key;
  originIndex.value = index;
  targetIndex.value = index;
  dragging = true;
  haptic('medium');
  window.removeEventListener('pointerup', cancelPress);
  window.removeEventListener('pointercancel', cancelPress);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerCancel);
}

function cancelPress(): void {
  clearPressTimer();
  pressing.value = false;
  if (!dragging) {
    window.removeEventListener('pointerup', cancelPress);
    window.removeEventListener('pointercancel', cancelPress);
    window.removeEventListener('pointermove', onPressCancelMove);
  }
}

function onRowPointerDown(ev: PointerEvent, row: SortRow): void {
  if (disabled.value) return;
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  pressStartY = ev.clientY;
  pressing.value = true;
  clearPressTimer();
  pressTimer = setTimeout(() => {
    pressTimer = null;
    beginDrag(row.key);
  }, 500);
  window.addEventListener('pointerup', cancelPress);
  window.addEventListener('pointercancel', cancelPress);
  window.addEventListener('pointermove', onPressCancelMove);
}

/** 长按未成立就移动超过 8px → 视为滚动，取消长按 */
function onPressCancelMove(ev: PointerEvent): void {
  if (dragging) {
    window.removeEventListener('pointermove', onPressCancelMove);
    return;
  }
  if (Math.abs(ev.clientY - pressStartY) > 8) {
    clearPressTimer();
    pressing.value = false;
    window.removeEventListener('pointermove', onPressCancelMove);
  }
}

function moveBy(key: string, delta: number): void {
  if (disabled.value) return;
  const from = local.value.findIndex((row) => row.key === key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= local.value.length) return;
  const next = local.value.slice();
  const [moved] = next.splice(from, 1);
  if (!moved) return;
  next.splice(to, 0, moved);
  local.value = next;
  haptic('light');
  emit(
    'reorder',
    next.map((row) => row.key),
    'button',
  );
}

onBeforeUnmount(() => {
  clearPressTimer();
  cancelRaf();
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointermove', onPressCancelMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointerup', cancelPress);
  window.removeEventListener('pointercancel', onPointerCancel);
  window.removeEventListener('pointercancel', cancelPress);
});
</script>

<template>
  <div class="sort-list">
    <p v-if="tooMany" class="sort-list__warn" role="status">
      当前分组频道过多（{{ items.length }}），请先按分组筛选
    </p>
    <p v-else class="sort-list__hint">长按频道后拖动排序，松手即保存</p>

    <p v-if="local.length === 0" class="sort-list__empty">{{ emptyText }}</p>

    <ul v-else ref="listRef" class="sort-list__items">
      <li
        v-for="(row, idx) in local"
        :key="row.key"
        data-row
        class="sort-list__row"
        :class="{
          'sort-list__row--active': row.key === dragKey,
          'sort-list__row--pressing': pressing && row.key === dragKey,
        }"
        :style="{ transform: rowTransform(idx) }"
        @pointerdown="onRowPointerDown($event, row)"
      >
        <span class="sort-list__handle" aria-hidden="true">⋮⋮</span>
        <span class="sort-list__name truncate-1">{{ row.name }}</span>
        <span class="sort-list__index">{{ idx + 1 }}</span>
        <button
          class="sort-list__btn"
          type="button"
          :disabled="disabled || idx === 0"
          :aria-label="`上移 ${row.name}`"
          @click.stop="moveBy(row.key, -1)"
        >
          ↑
        </button>
        <button
          class="sort-list__btn"
          type="button"
          :disabled="disabled || idx === local.length - 1"
          :aria-label="`下移 ${row.name}`"
          @click.stop="moveBy(row.key, 1)"
        >
          ↓
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.sort-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sort-list__hint,
.sort-list__warn {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.sort-list__warn {
  color: var(--color-warning);
}

.sort-list__empty {
  padding: var(--space-6) 0;
  text-align: center;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.sort-list__items {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  list-style: none;
  margin: 0;
  padding: 0;
}

.sort-list__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-body);
  touch-action: pan-y;
  user-select: none;
  transition:
    background-color var(--duration-fast) var(--ease-standard),
    transform var(--duration-fast) var(--ease-standard);
}

/* REV-25：被拖行不做 transform 过渡，避免跟随手指时延迟 */
.sort-list__row--active {
  background-color: var(--color-brand-soft);
  border-color: transparent;
  box-shadow: var(--shadow-2);
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.sort-list__row--pressing {
  background-color: var(--color-bg-pressed);
}

.sort-list__handle {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font: var(--text-caption);
  letter-spacing: -2px;
}

.sort-list__name {
  flex: 1 1 auto;
  min-width: 0;
}

.sort-list__index {
  flex: 0 0 auto;
  min-width: 20px;
  text-align: right;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-number);
}

.sort-list__btn {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: 15px;
}

.sort-list__btn:disabled {
  color: var(--color-text-disabled);
}
</style>
