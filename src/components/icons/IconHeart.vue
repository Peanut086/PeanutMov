<script setup lang="ts">
/**
 * 收藏心形：`filled` 为实心变体（已收藏态）。
 * 描边宽度按显示尺寸等重（24→1.6、20→1.8、16→2）。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ size?: number; filled?: boolean }>(),
  { size: 24, filled: false },
);

const strokeWidth = computed(() => (props.size >= 24 ? 1.6 : props.size >= 20 ? 1.8 : 2));
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path
      d="M12 20.3s-7.6-4.7-7.6-9.8a4.4 4.4 0 0 1 7.6-3.03A4.4 4.4 0 0 1 19.6 10.5c0 5.1-7.6 9.8-7.6 9.8Z"
    />
  </svg>
</template>
