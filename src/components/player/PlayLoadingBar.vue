<script setup lang="ts">
/**
 * 播放加载进度（问题一）
 *
 * 只渲染「环 + 进度 + 阶段文案 + 已耗时」四件事；压暗底、层级与显隐都在
 * player-chrome.css 的 ⑦ `.pl-buf` 上，由 `.pl-shell[data-state]` 统一驱动。
 * 进度由父组件按阶段权重驱动，本组件不负责起停。
 */
defineProps<{
  progress: number;
  stageText: string;
  elapsed: number;
}>();

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, "0")}s`;
}
</script>

<template>
  <span class="pl-buf__ring" aria-hidden="true" />
  <span class="pl-buf__track" aria-hidden="true">
    <span
      class="pl-buf__fill"
      :style="{ width: `${Math.min(100, Math.max(0, progress)).toFixed(1)}%` }"
    />
  </span>
  <p class="pl-buf__text">{{ stageText }}</p>
  <p class="pl-buf__meta">{{ formatElapsed(elapsed) }}</p>
</template>
