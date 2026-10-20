<script setup lang="ts">
/** 勾选图标：已看 / 已选。 */
withDefaults(defineProps<{ size?: number }>(), { size: 16 });
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m5 12.8 4.3 4.3L19 6.6" />
  </svg>
</template>
