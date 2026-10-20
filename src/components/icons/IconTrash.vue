<script setup lang="ts">
/** 删除图标：垃圾桶。 */
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
    <path d="M4.8 6.8h14.4" />
    <path d="M9.4 4.4h5.2" />
    <path d="M6.6 6.8 7.5 19a1.4 1.4 0 0 0 1.4 1.3h6.2a1.4 1.4 0 0 0 1.4-1.3l.9-12.2" />
    <path d="M10.2 10.4v6M13.8 10.4v6" />
  </svg>
</template>
