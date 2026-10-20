<script setup lang="ts">
/**
 * 右侧箭头：可旋转 90/180 表示展开/收起或上/下。
 * `direction` 只影响初始旋转，样式层仍用 transform。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{ size?: number; direction?: 'right' | 'down' | 'up' | 'left' }>(),
  { size: 16, direction: 'right' },
);

const rotation = computed(() => {
  switch (props.direction) {
    case 'down':
      return 90;
    case 'left':
      return 180;
    case 'up':
      return 270;
    default:
      return 0;
  }
});
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    :style="{ transform: `rotate(${rotation}deg)` }"
    aria-hidden="true"
    focusable="false"
  >
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </svg>
</template>
