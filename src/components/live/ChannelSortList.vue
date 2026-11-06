<script setup lang="ts">
/**
 * EXT-06/FR-69：频道自定义排序列表（长按拖拽）
 *
 * - 长按 380ms 激活拖拽（移动端不误触发滚动；短按不改变顺序）
 * - 拖拽中按指针纵向位置重排，松手一次性提交（AC-167：一次保存 + 一条 toast 由父级负责）
 * - 频道数超过 CHANNEL_ORDER_MAX 时禁用拖拽，改为提示"频道过多，暂不支持排序"（AC-167）
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
  (e: 'reorder', keys: string[]): void;
}>();

const { haptic } = useHaptic();

const listRef = ref<HTMLElement | null>(null);
const local = ref<SortRow[]>([]);
const activeKey = ref<string | null>(null);
const pressing = ref(false);

const tooMany = computed(() => props.items.length > CHANNEL_ORDER_MAX);
const disabled = computed(() => props.busy || tooMany.value);

let pressTimer: ReturnType<typeof setTimeout> | null = null;
let pressStartY = 0;
let dragging = false;

watch(
  () => props.items,
  (next) => {
    if (activeKey.value) return; // 拖拽中不覆盖本地顺序
    local.value = next.slice();
  },
  { immediate: true },
);

function clearPressTimer(): void {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function indexAt(clientY: number): number {
  const nodes = listRef.value?.querySelectorAll<HTMLElement>('[data-row]');
  if (!nodes || nodes.length === 0) return -1;
  for (let i = 0; i < nodes.length; i += 1) {
    const rect = nodes[i]!.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return nodes.length - 1;
}

function autoScroll(clientY: number): void {
  const scroller = listRef.value?.closest<HTMLElement>('.sheet__body') ?? null;
  if (!scroller) return;
  const threshold = 72;
  if (clientY < threshold) scroller.scrollTop -= 10;
  else if (clientY > window.innerHeight - threshold) scroller.scrollTop += 10;
}

function onPointerMove(ev: PointerEvent): void {
  if (!dragging || !activeKey.value) return;
  const target = indexAt(ev.clientY);
  if (target < 0) return;
  const current = local.value.findIndex((row) => row.key === activeKey.value);
  if (current < 0 || current === target) {
    autoScroll(ev.clientY);
    return;
  }
  const next = local.value.slice();
  const [moved] = next.splice(current, 1);
  if (!moved) return;
  next.splice(target, 0, moved);
  local.value = next;
  autoScroll(ev.clientY);
}

function endDrag(commit: boolean): void {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointermove', onPressCancelMove);
  window.removeEventListener('pointerup', onPointerUp);
  window.removeEventListener('pointerup', cancelPress);
  window.removeEventListener('pointercancel', onPointerCancel);
  window.removeEventListener('pointercancel', cancelPress);
  clearPressTimer();
  const wasDragging = dragging;
  dragging = false;
  activeKey.value = null;
  pressing.value = false;
  if (wasDragging && commit) {
    haptic('light');
    emit(
      'reorder',
      local.value.map((row) => row.key),
    );
  }
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
  activeKey.value = key;
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
  }, 380);
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
  );
}

onBeforeUnmount(() => {
  clearPressTimer();
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
      频道过多（{{ items.length }}），暂不支持拖拽排序
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
          'sort-list__row--active': row.key === activeKey,
          'sort-list__row--pressing': pressing && row.key === activeKey,
        }"
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
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.sort-list__row--pressing {
  background-color: var(--color-bg-pressed);
}

.sort-list__row--active {
  background-color: var(--color-brand-soft);
  border-color: transparent;
  box-shadow: var(--shadow-2);
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
