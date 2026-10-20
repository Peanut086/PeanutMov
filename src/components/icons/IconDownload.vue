<script setup lang="ts">
/** 下载图标：向下箭头 + 底部托盘；`done` 时绘制完成勾。 */
import { computed } from 'vue';

const props = withDefaults(defineProps<{ size?: number; done?: boolean }>(), {
  size: 20,
  done: false,
});

const strokeWidth = computed(() => (props.size >= 24 ? 1.6 : props.size >= 20 ? 1.8 : 2));
</script>

<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <template v-if="done">
      <path d="M5 4.8h9.5L19 9.3V19.2H5z" />
      <path d="m8.8 13.6 2.3 2.3 4.2-4.4" />
    </template>
    <template v-else>
      <path d="M12 3.5v11.2" />
      <path d="m7.8 10.6 4.2 4.2 4.2-4.2" />
      <path d="M4.5 19.5h15" />
    </template>
  </svg>
</template>
