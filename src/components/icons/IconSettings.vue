<script setup lang="ts">
/** 设置图标：滑杆式（比齿轮更贴合"播放/外观/数据"分组语义）。 */
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
    <path d="M4 7.5h6M14 7.5h6M4 16.5h10M18 16.5h2" />
    <circle cx="12" cy="7.5" r="2.1" />
    <circle cx="16" cy="16.5" r="2.1" />
  </svg>
</template>
