<script setup lang="ts">
/**
 * 播放图标（唯一允许实心填充的图标）
 * 规格：viewBox 24、currentColor、24px 时描边 1.6（描边仅用于柔化填充边缘）。
 */
withDefaults(defineProps<{ size?: number }>(), { size: 24 });
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    stroke-width="1.2"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M8.2 5.4a.9.9 0 0 1 1.37-.77l9.05 6.6a.9.9 0 0 1 0 1.54l-9.05 6.6a.9.9 0 0 1-1.37-.77Z" />
  </svg>
</template>
