<script setup lang="ts">
/**
 * 搜索框（设计规范 8.2）
 *
 * 高 40、胶囊圆角、左侧放大镜、右侧清除；受控组件（v-model）。
 * 回车触发 search 事件；输入触发 update:modelValue（防抖由父级负责）。
 * OPT-07：支持建议下拉列表与键盘导航。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';

import IconClose from '@/components/icons/IconClose.vue';
import IconSearch from '@/components/icons/IconSearch.vue';
import { getHotSearchTags, type SearchSuggestion } from '@/services/suggestService';
import { prefersReducedMotion } from '@/composables/useSpring';
import SearchSuggestionList from '@/components/search/SearchSuggestion.vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    /** 只读时点击整体触发 click 事件（首页跳转用） */
    readonly?: boolean;
    /** OPT-07：搜索建议列表 */
    suggestions?: SearchSuggestion[];
  }>(),
  { placeholder: '搜索片名…', readonly: false, suggestions: () => [] },
);

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void;
  (e: 'search', v: string): void;
  (e: 'clear'): void;
  (e: 'focus'): void;
  (e: 'blur'): void;
  /** OPT-07：选中建议项 */
  (e: 'select-suggestion', v: string): void;
  /** OPT-07：删除历史建议 */
  (e: 'delete-suggestion', v: string): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const hasValue = computed(() => props.modelValue.length > 0);
const showSuggestions = ref(false);
const activeSuggestionIndex = ref(-1);

// REV-13：generation counter 防止旧 blur timeout 竞态
let blurGeneration = 0;

// P2：IME 输入法组合期间不触发逐键搜索（拼音/五笔等输入过程中每字母都会触发 input）
const composing = ref(false);

// M2 热词放映机：空闲且未聚焦时轮播真实热词；聚焦切换光束态
const focused = ref(false);
const hotWords = ref<string[]>(getHotSearchTags(6));
const phIndex = ref(0);
let phTimer: ReturnType<typeof setInterval> | null = null;

const carouselActive = computed(
  () =>
    !hasValue.value &&
    !focused.value &&
    !composing.value &&
    hotWords.value.length > 1 &&
    !prefersReducedMotion(),
);
const effectivePlaceholder = computed(() => (carouselActive.value ? '' : props.placeholder));

function stopCarousel(): void {
  if (phTimer) {
    clearInterval(phTimer);
    phTimer = null;
  }
}
function startCarousel(): void {
  stopCarousel();
  phTimer = setInterval(() => {
    phIndex.value = (phIndex.value + 1) % hotWords.value.length;
  }, 3000);
}
watch(
  carouselActive,
  (active) => {
    if (active) startCarousel();
    else stopCarousel();
  },
  { immediate: true },
);
onBeforeUnmount(stopCarousel);

function onCompositionStart(): void {
  composing.value = true;
}

function onCompositionEnd(ev: CompositionEvent): void {
  composing.value = false;
  // 组合结束时用最终值触发一次更新
  emit('update:modelValue', (ev.target as HTMLInputElement).value);
  activeSuggestionIndex.value = -1;
}

function onInput(ev: Event): void {
  // IME 组合中跳过——等 compositionend 再发
  if (composing.value) return;
  emit('update:modelValue', (ev.target as HTMLInputElement).value);
  activeSuggestionIndex.value = -1;
}

function onKeydown(ev: KeyboardEvent): void {
  // OPT-07：键盘导航建议列表
  if (props.suggestions.length > 0 && showSuggestions.value) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      activeSuggestionIndex.value = Math.min(
        activeSuggestionIndex.value + 1,
        props.suggestions.length - 1,
      );
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      activeSuggestionIndex.value = Math.max(activeSuggestionIndex.value - 1, -1);
      return;
    }
    if (ev.key === 'Enter' && activeSuggestionIndex.value >= 0) {
      ev.preventDefault();
      const selected = props.suggestions[activeSuggestionIndex.value];
      if (selected) {
        selectSuggestion(selected.text);
      }
      return;
    }
    if (ev.key === 'Escape') {
      showSuggestions.value = false;
      activeSuggestionIndex.value = -1;
      return;
    }
  }

  if (ev.key === 'Enter') {
    ev.preventDefault();
    emit('search', props.modelValue.trim());
    showSuggestions.value = false;
  }
  if (ev.key === 'Escape' && hasValue.value) {
    clear();
  }
}

function clear(): void {
  emit('update:modelValue', '');
  emit('clear');
  inputRef.value?.focus();
  showSuggestions.value = false;
  activeSuggestionIndex.value = -1;
}

function onFocus(): void {
  focused.value = true;
  if (props.suggestions.length > 0) {
    showSuggestions.value = true;
  }
  emit('focus');
}

function onBlur(): void {
  focused.value = false;
  // REV-13：使用 generation counter 让旧 setTimeout 回调自动失效
  const gen = ++blurGeneration;
  setTimeout(() => {
    if (gen === blurGeneration) {
      showSuggestions.value = false;
      activeSuggestionIndex.value = -1;
    }
  }, 200);
  emit('blur');
}

function selectSuggestion(text: string): void {
  emit('update:modelValue', text);
  emit('select-suggestion', text);
  showSuggestions.value = false;
  activeSuggestionIndex.value = -1;
  inputRef.value?.blur();
}

function deleteSuggestion(text: string): void {
  emit('delete-suggestion', text);
}
</script>

<template>
  <div class="search-bar-wrapper">
    <div class="search-bar" :class="{ 'search-bar--readonly': readonly, 'search-bar--focused': focused }">
      <IconSearch class="search-bar__icon" :size="16" />
      <input
        ref="inputRef"
        class="search-bar__input"
        type="search"
        enterkeyhint="search"
        :value="modelValue"
        :placeholder="effectivePlaceholder"
        :readonly="readonly"
        aria-label="搜索"
        aria-autocomplete="list"
        aria-controls="search-suggestions"
        :aria-activedescendant="activeSuggestionIndex >= 0 ? `suggestion-${activeSuggestionIndex}` : undefined"
        @input="onInput"
        @keydown="onKeydown"
        @focus="onFocus"
        @blur="onBlur"
        @compositionstart="onCompositionStart"
        @compositionend="onCompositionEnd"
      />
      <!-- M2：空闲热词轮播层（仅空闲未聚焦显示） -->
      <span v-if="carouselActive" class="search-bar__ph" aria-hidden="true">
        <span :key="phIndex" class="search-bar__ph-word">{{ hotWords[phIndex] }}</span>
      </span>
      <span class="search-bar__beam" aria-hidden="true" />
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
    <!-- OPT-07：建议下拉列表 -->
    <SearchSuggestionList
      v-if="showSuggestions && suggestions.length > 0"
      id="search-suggestions"
      class="search-bar__suggestions"
      :suggestions="suggestions"
      :active-index="activeSuggestionIndex"
      :keyword="modelValue"
      @select="selectSuggestion"
      @delete="deleteSuggestion"
    />
  </div>
</template>

<style scoped>
.search-bar-wrapper {
  position: relative;
  width: 100%;
}

.search-bar {
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 46px;
  padding: 0 var(--space-2) 0 14px;
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  transition: var(--transition-color), box-shadow var(--duration-base) var(--ease-standard);
}

/* M2：聚焦横向光束 sweep（300ms 一次） */
.search-bar__beam {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    100deg,
    transparent 0%,
    var(--color-brand-soft) 42%,
    var(--color-brand-soft) 50%,
    transparent 58%
  );
  transform: translateX(-100%);
  opacity: 0;
}

.search-bar--focused .search-bar__beam {
  animation: ph-beam 300ms var(--ease-standard);
}

@keyframes ph-beam {
  0% {
    transform: translateX(-100%);
    opacity: 1;
  }
  100% {
    transform: translateX(100%);
    opacity: 0;
  }
}

/* M2：空闲热词轮播层 */
.search-bar__ph {
  position: absolute;
  left: 38px;
  right: 40px;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  pointer-events: none;
  overflow: hidden;
  color: var(--color-text-tertiary);
  font: var(--text-label);
}

.search-bar__ph-word {
  display: block;
  animation: ph-in 200ms var(--ease-standard);
}

.search-bar__ph-word::before {
  content: '热词 · ';
  color: var(--color-brand-text);
}

@keyframes ph-in {
  from {
    transform: translateY(12px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.search-bar:focus-within {
  border-color: var(--color-brand);
  box-shadow: 0 0 0 3px var(--color-brand-soft);
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

.search-bar__suggestions {
  position: absolute;
  top: calc(100% + var(--space-1));
  left: 0;
  right: 0;
  z-index: var(--z-dropdown);
}

@media (prefers-reduced-motion: reduce) {
  .search-bar__beam,
  .search-bar__ph-word {
    animation: none;
  }
}
</style>
