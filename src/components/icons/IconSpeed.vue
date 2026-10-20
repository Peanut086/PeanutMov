<script setup lang="ts">
/** 倍速图标：表盘 + 指针。 */
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
    <path d="M4.6 17.2a8.2 8.2 0 1 1 14.8 0" />
    <path d="M12 13.6 16 9.4" />
    <circle cx="12" cy="14.6" r="1.1" fill="currentColor" stroke="none" />
  </svg>
</template>
