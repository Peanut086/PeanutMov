<script setup lang="ts">
/**
 * 锁屏图标（B4）
 *
 * `locked` 变体锁梁闭合，未锁时锁梁抬起——一眼能分清当前是锁定还是可锁。
 */
withDefaults(defineProps<{ size?: number; locked?: boolean }>(), { size: 20, locked: false });
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
    <rect x="4.5" y="10.5" width="15" height="10" rx="2.2" />
    <path v-if="locked" d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" />
    <path v-else d="M8 10.5V7.6a4 4 0 0 1 7.6-1.7" />
    <circle cx="12" cy="15.5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
</template>