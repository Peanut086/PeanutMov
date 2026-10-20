<script setup lang="ts">
/**
 * 加载指示器（设计规范 8.10）
 *
 * 24px 圆环，2px 描边，品牌色亮弧，800ms 旋转一周。
 * 纯 CSS，不依赖任何图片或字体。
 */
withDefaults(
  defineProps<{
    size?: number;
    /** 无障碍标签，默认"加载中" */
    label?: string;
  }>(),
  { size: 24, label: '加载中' },
);
</script>

<template>
  <span
    class="spinner"
    role="status"
    :aria-label="label"
    :style="{ width: `${size}px`, height: `${size}px` }"
  />
</template>

<style scoped>
.spinner {
  display: inline-block;
  flex: 0 0 auto;
  border-radius: 50%;
  border: 2px solid var(--color-border-strong);
  border-top-color: var(--color-brand);
  animation: spinner-rotate 800ms linear infinite;
}

@keyframes spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 1600ms;
  }
}
</style>
