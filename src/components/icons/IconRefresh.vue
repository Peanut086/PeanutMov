<script setup lang="ts">
/** 刷新 / 重试图标。 */
withDefaults(defineProps<{ size?: number }>(), { size: 20 });
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M19.2 12a7.2 7.2 0 1 1-2.3-5.25" />
    <path d="M19.6 4.6v4.2h-4.2" />
  </svg>
</template>
