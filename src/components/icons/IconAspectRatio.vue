<script setup lang="ts">
/** 画面比例图标：带四向箭头的方框，表示拉伸/缩放 */
withDefaults(defineProps<{ size?: number }>(), { size: 24 });
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <rect x="5" y="5" width="14" height="14" rx="1" />
    <path d="M2 12h3M19 12h3M12 2v3M12 19v3" />
  </svg>
</template>
