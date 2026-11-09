<script setup lang="ts">
/**
 * 分类 Tab（设计规范 8.3 CategoryTabs）
 *
 * 横向滚动、隐藏滚动条、选中态 brand-soft 底 + brand-text 文字。
 * 首项固定为「全部」（categoryId = null）。
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

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
const indicatorRef = ref<HTMLElement | null>(null);

function choose(value: string | null): void {
  if (value === props.modelValue) return;
  emit('update:modelValue', value);
}

/** 选中项滚动进视野 + 滑块跟随 */
async function syncIndicator(): Promise<void> {
  const scroller = scrollerRef.value;
  const indicator = indicatorRef.value;
  if (!scroller || !indicator) return;
  const active = scroller.querySelector<HTMLElement>('[data-active="true"]');
  if (!active) return;
  // 滑块绝对定位于滚动容器内，offsetLeft 即相对于容器内容区的坐标，随滚动自然位移
  indicator.style.transform = `translateX(${active.offsetLeft}px)`;
  indicator.style.width = `${active.offsetWidth}px`;
  active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

watch(() => props.modelValue, () => { nextTick(syncIndicator); });
watch(() => props.categories, () => { nextTick(syncIndicator); });

// 窗口尺寸变化时重算（横竖屏切换 / 分屏）
let resizeRaf = 0;
function onResize(): void {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(syncIndicator);
}

onMounted(() => {
  nextTick(syncIndicator);
  window.addEventListener('resize', onResize);
});
onUnmounted(() => {
  window.removeEventListener('resize', onResize);
  cancelAnimationFrame(resizeRaf);
});
</script>

<template>
  <div ref="scrollerRef" class="category-tabs" role="tablist" aria-label="分类">
    <span ref="indicatorRef" class="category-tabs__indicator" aria-hidden="true" />
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
  position: relative;
  display: flex;
  gap: var(--space-2);
  height: 44px;
  padding: var(--space-1) var(--layout-page-padding-x);
  overflow-x: auto;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  scroll-snap-type: x proximity;
}

/* 滑块：琥珀金胶囊，跟随选中项平滑滑动 */
.category-tabs__indicator {
  position: absolute;
  top: var(--space-1);
  left: 0;
  height: 32px;
  border-radius: var(--radius-full);
  background-color: var(--color-brand-soft);
  border: 1px solid rgba(240, 168, 46, 0.4);
  pointer-events: none;
  transition: transform var(--duration-base) var(--ease-decelerate),
    width var(--duration-base) var(--ease-decelerate);
  will-change: transform, width;
}

.category-tabs::-webkit-scrollbar {
  display: none;
}

.category-tabs__item {
  flex: 0 0 auto;
  height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font: var(--font-weight-medium) 13px / 30px var(--font-family-base);
  scroll-snap-align: start;
  transition: var(--transition-color);
}

.category-tabs__item--active {
  background-color: transparent;
  border-color: transparent;
  color: var(--color-brand-text);
  font-weight: var(--font-weight-semibold);
}

.category-tabs__item:active {
  background-color: var(--color-overlay-press-strong);
}
</style>
