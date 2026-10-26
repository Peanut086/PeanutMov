<script setup lang="ts">
/**
 * 分类 Tab（设计规范 8.3 CategoryTabs）
 *
 * 横向滚动、隐藏滚动条、选中态 brand-soft 底 + brand-text 文字。
 * 首项固定为「全部」（categoryId = null）。
 */
import { nextTick, ref, watch } from 'vue';

import type { Category } from '@/types';

const props = withDefaults(
  defineProps<{
    categories: Category[];
    modelValue: string | null;
    /** 是否包含「全部」项 */
    withAll?: boolean;
  }>(),
  { withAll: true },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string | null): void }>();

const scrollerRef = ref<HTMLElement | null>(null);

function choose(value: string | null): void {
  if (value === props.modelValue) return;
  emit('update:modelValue', value);
}

// 选中项滚动进视野（切换分类后保持 Tab 可见）
watch(
  () => props.modelValue,
  async () => {
    await nextTick();
    const scroller = scrollerRef.value;
    if (!scroller) return;
    const active = scroller.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  },
);
</script>

<template>
  <div ref="scrollerRef" class="category-tabs" role="tablist" aria-label="分类">
    <button
      v-if="withAll"
      class="category-tabs__item"
      :class="{ 'category-tabs__item--active': modelValue === null }"
      :data-active="modelValue === null ? 'true' : 'false'"
      type="button"
      role="tab"
      :aria-selected="modelValue === null"
      @click="choose(null)"
    >
      全部
    </button>
    <button
      v-for="cat in categories"
      :key="cat.id"
      class="category-tabs__item"
      :class="{ 'category-tabs__item--active': modelValue === cat.id }"
      :data-active="modelValue === cat.id ? 'true' : 'false'"
      type="button"
      role="tab"
      :aria-selected="modelValue === cat.id"
      @click="choose(cat.id)"
    >
      {{ cat.name }}
    </button>
  </div>
</template>

<style scoped>
.category-tabs {
  display: flex;
  gap: var(--space-2);
  height: 44px;
  padding: var(--space-1) var(--layout-page-padding-x);
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  scroll-snap-type: x proximity;
}

.category-tabs::-webkit-scrollbar {
  display: none;
}

.category-tabs__item {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  color: var(--color-text-secondary);
  font: var(--text-label-strong);
  scroll-snap-align: start;
  transition: var(--transition-color);
}

.category-tabs__item--active {
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font-weight: var(--font-weight-medium);
}

.category-tabs__item:active {
  background-color: var(--color-overlay-press-strong);
}
</style>
