<script setup lang="ts">
/** 字幕图标：对话气泡 + 两条文字线。 */
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
    <rect x="3.5" y="5" width="17" height="12" rx="2.4" />
    <path d="M7.5 9.6h4.2M7.5 13h9M14.6 9.6h1.9" />
    <path d="M8 17v2.4l3-2.4" />
  </svg>
</template>
