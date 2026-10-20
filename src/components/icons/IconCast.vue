<script setup lang="ts">
/** 投屏图标：屏幕 + 无线波纹（系统投屏/分享入口）。 */
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
    <path d="M3.5 7.5V5.8a1.3 1.3 0 0 1 1.3-1.3h14.4a1.3 1.3 0 0 1 1.3 1.3v10.4a1.3 1.3 0 0 1-1.3 1.3h-5.4" />
    <path d="M3.5 12.6a6.4 6.4 0 0 1 6.4 6.4" />
    <path d="M3.5 16.4a2.6 2.6 0 0 1 2.6 2.6" />
    <circle cx="3.9" cy="19.9" r="0.9" fill="currentColor" stroke="none" />
  </svg>
</template>
