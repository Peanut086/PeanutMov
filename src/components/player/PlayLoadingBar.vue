<script setup lang="ts">
/**
 * 播放加载进度条（问题一）
 *
 * 在 loading 遮罩中显示：点阵加载动效 + 进度条 + 阶段文案 + 已耗时秒数。
 * 进度由父组件按阶段权重驱动，本组件只负责渲染。
 */
import AiImageGeneration from '@/components/leibox/ai-generating/AiImageGeneration.vue';

defineProps<{
  progress: number;
  stageText: string;
  elapsed: number;
}>();

function formatElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}
</script>

<template>
  <div class="play-loading" role="status" aria-live="polite">
    <div class="play-loading__dots">
      <AiImageGeneration :options="{ height: 120, title: stageText }" />
    </div>
    <div class="play-loading__bar-track">
      <div
        class="play-loading__bar-fill"
        :style="{ width: `${Math.min(100, Math.max(0, progress)).toFixed(1)}%` }"
      />
    </div>
    <p class="play-loading__meta">{{ formatElapsed(elapsed) }}</p>
  </div>
</template>>

<style scoped>
.play-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  width: 100%;
  max-width: 280px;
  padding: 20px 24px;
  border-radius: 14px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  color: #fff;
}

.play-loading__dots {
  width: 120px;
  height: 120px;
  overflow: hidden;
  transform: scale(0.285);
  transform-origin: top left;
  margin-bottom: -86px;
}

.play-loading__bar-track {
  width: 100%;
  height: 3px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.15);
  overflow: hidden;
}

.play-loading__bar-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--color-brand, #F0A82E);
  transition: width 300ms ease-out;
}

.play-loading__meta {
  margin: 0;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.55);
  font-variant-numeric: tabular-nums;
}

@media (prefers-reduced-motion: reduce) {
  .play-loading__bar-fill { transition-duration: 600ms; }
}
</style>
