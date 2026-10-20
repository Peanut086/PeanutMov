<script setup lang="ts">
/**
 * 海报图（懒加载 + 失败占位）
 *
 * - `loading="lazy"` + `decoding="async"`，首屏外不请求（NFR-P02）
 * - 加载完成前显示骨架；失败切成占位图标（不显示破图）
 * - 容器固定 2:3 比例，CLS = 0
 */
import { computed, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    src: string | null | undefined;
    alt: string;
    /** 是否显示圆角（卡片外单独使用时可关） */
    rounded?: boolean;
    /** 骨架/占位时的高宽由父级容器决定 */
    eager?: boolean;
  }>(),
  { rounded: true, eager: false },
);

const failed = ref(false);
const loaded = ref(false);

watch(
  () => props.src,
  () => {
    failed.value = false;
    loaded.value = false;
  },
);

const showPlaceholder = computed(() => !props.src || failed.value);
const loadingAttr = computed(() => (props.eager ? 'eager' : 'lazy'));
</script>

<template>
  <div class="poster-image" :class="{ 'poster-image--rounded': rounded }">
    <div v-if="!loaded && !showPlaceholder" class="skeleton poster-image__skeleton" aria-hidden="true" />

    <img
      v-if="src && !failed"
      class="poster-image__img"
      :class="{ 'poster-image__img--loaded': loaded }"
      :src="src"
      :alt="alt"
      :loading="loadingAttr"
      decoding="async"
      @load="loaded = true"
      @error="failed = true"
    />

    <div v-if="showPlaceholder" class="poster-image__placeholder" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
        <rect x="4" y="4" width="16" height="16" rx="2.4" />
        <path d="m4.8 16.4 4.4-4.4 3.2 3.2 2.4-2.4 4.4 4.4" />
        <circle cx="9" cy="9" r="1.4" />
      </svg>
      <span class="poster-image__placeholder-text">无封面</span>
    </div>
  </div>
</template>

<style scoped>
.poster-image {
  position: relative;
  width: 100%;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background-color: var(--color-bg-skeleton);
}

.poster-image--rounded {
  border-radius: var(--radius-card);
}

.poster-image__skeleton {
  position: absolute;
  inset: 0;
  border-radius: inherit;
}

.poster-image__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-standard);
}

.poster-image__img--loaded {
  opacity: 1;
}

.poster-image__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: var(--color-text-tertiary);
  background-color: var(--color-bg-skeleton);
}

.poster-image__placeholder svg {
  width: 32px;
  height: 32px;
}

.poster-image__placeholder-text {
  font: var(--text-caption);
}

@media (prefers-reduced-motion: reduce) {
  .poster-image__img {
    transition: none;
  }
}
</style>
