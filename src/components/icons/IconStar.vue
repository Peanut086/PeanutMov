<script setup lang="ts">
/**
 * 星标图标（评分展示用）
 * 规格：viewBox 24、currentColor、实心填充。
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
    aria-hidden="true"
    focusable="false"
  >
    <path d="M12 2.4l2.95 6.03 6.6.96-4.78 4.7 1.13 6.6L12 17.77l-5.9 3.02 1.13-6.6L2.45 9.39l6.6-.96L12 2.4z" />
  </svg>
</template>
