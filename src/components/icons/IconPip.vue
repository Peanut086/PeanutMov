<script setup lang="ts">
/**
 * 画中画（PiP）图标（OPT-06）
 *
 * 大矩形代表主画面，右下角小矩形代表浮窗。
 * `active` 变体：小矩形填充品牌色，表示当前已处于画中画。
 */
withDefaults(defineProps<{ size?: number; active?: boolean }>(), { size: 20, active: false });
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
    <!-- 主画面（大矩形） -->
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <!-- 画中画浮窗（右下小矩形） -->
    <rect
      x="13.5"
      y="12.5"
      width="7"
      height="5"
      rx="1"
      :fill="active ? 'currentColor' : 'none'"
    />
  </svg>
</template>
