<script setup lang="ts">
/**
 * 搜索框（设计规范 8.2）
 *
 * 高 40、胶囊圆角、左侧放大镜、右侧清除；受控组件（v-model）。
 * 回车触发 search 事件；输入触发 update:modelValue（防抖由父级负责）。
 */
import { computed, ref } from 'vue';

import IconClose from '@/components/icons/IconClose.vue';
import IconSearch from '@/components/icons/IconSearch.vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    /** 是否自动聚焦（搜索页） */
    autofocus?: boolean;
    /** 只读时点击整体触发 click 事件（首页跳转用） */
    readonly?: boolean;
  }>(),
  { placeholder: '搜索片名…', autofocus: false, readonly: false },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'search', v: string): void;
  (e: 'clear'): void;
  (e: 'focus'): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const hasValue = computed(() => props.modelValue.length > 0);

function onInput(ev: Event): void {
  emit('update:modelValue', (ev.target as HTMLInputElement).value);
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    emit('search', props.modelValue.trim());
  }
  if (ev.key === 'Escape' && hasValue.value) {
    clear();
  }
}

function clear(): void {
  emit('update:modelValue', '');
  emit('clear');
  inputRef.value?.focus();
}

function focus(): void {
  inputRef.value?.focus();
}

defineExpose({ focus });
</script>

<template>
  <div class="search-bar" :class="{ 'search-bar--readonly': readonly }">
    <IconSearch class="search-bar__icon" :size="16" />
    <input
      ref="inputRef"
      class="search-bar__input"
      type="search"
      enterkeyhint="search"
      :value="modelValue"
      :placeholder="placeholder"
      :autofocus="autofocus && !readonly"
      :readonly="readonly"
      aria-label="搜索"
      @input="onInput"
      @keydown="onKeydown"
      @focus="emit('focus')"
    />
    <button
      v-if="hasValue && !readonly"
      class="search-bar__clear"
      type="button"
      aria-label="清除搜索内容"
      @click="clear"
    >
      <IconClose :size="14" />
    </button>
  </div>
</template>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 46px;
  padding: 0 var(--space-2) 0 var(--space-4);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  transition: var(--transition-color), box-shadow var(--duration-fast) var(--ease-standard);
}

.search-bar:focus-within {
  border-color: var(--color-brand);
  box-shadow: var(--shadow-focus);
}

.search-bar__icon {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  transition: var(--transition-color);
}

.search-bar:focus-within .search-bar__icon {
  color: var(--color-brand);
}

.search-bar__input {
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  outline: none;
  color: var(--color-text-primary);
  font-size: var(--font-size-16);
}

.search-bar__input::placeholder {
  color: var(--color-text-tertiary);
  font: var(--text-label);
}

.search-bar__input::-webkit-search-cancel-button {
  display: none;
}

.search-bar__clear {
  position: relative;
  flex: 0 0 auto;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-control);
  color: var(--color-text-secondary);
}

/* 命中区扩到 44×44 */
.search-bar__clear::after {
  content: '';
  position: absolute;
  inset: -10px;
}

.search-bar--readonly {
  cursor: pointer;
}

.search-bar--readonly .search-bar__input {
  cursor: pointer;
  pointer-events: none;
}
</style>
