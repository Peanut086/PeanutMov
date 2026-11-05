<script setup lang="ts">
/**
 * 播放画面层（技术方案 9.2 / 设计规范 6.6）
 *
 * 结构：黑底画布 + 视频容器（由 PlayerController 注入）+ 亮度遮罩 + 字幕叠加层。
 * 字幕由 SubtitleManager 计算文本后传入，**不使用浏览器原生字幕渲染**。
 */
import { computed } from 'vue';

import type { SubtitleSettings } from '@/types';

import { brightnessToDimOpacity } from '@/player/brightness';
import { SUBTITLE_SIZE_CLASS } from '@/player/constants';

const props = withDefaults(
  defineProps<{
    /** 字幕文本（含换行） */
    subtitleText: string;
    subtitle: SubtitleSettings;
    /** 亮度 0~100（100 = 无遮罩） */
    dim: number;
    /** 是否横屏/全屏布局 */
    immersive?: boolean;
  }>(),
  { immersive: false },
);

const subtitleClasses = computed(() => [
  'subtitle-overlay',
  SUBTITLE_SIZE_CLASS[props.subtitle.size],
  {
    'subtitle-overlay--yellow': props.subtitle.color === 'yellow',
    'subtitle-overlay--no-bg': props.subtitle.background === 'none',
  },
]);

/** 遮罩不透明度：0~0.8（设计规范 2.7：最多压到 80%，保留 20% 亮度） */
const dimOpacity = computed(() => brightnessToDimOpacity(props.dim));
</script>

<template>
  <div class="player-surface" :class="{ 'player-surface--immersive': immersive }">
    <!-- 视频容器：PlayerController.mount 挂到这里 -->
    <div class="player-surface__host" data-player-host />

    <!-- 亮度遮罩：仅手势改亮度时可见，不拦截事件 -->
    <div
      class="player-surface__dim"
      data-dim-layer
      :style="{ opacity: String(dimOpacity) }"
      aria-hidden="true"
    />

    <!-- 字幕叠加层 -->
    <div v-if="subtitleText" :class="subtitleClasses" aria-live="off">
      <span>{{ subtitleText }}</span>
    </div>

    <slot />
  </div>
</template>

<style scoped>
.player-surface {
  position: relative;
  width: 100%;
  height: 100%;
  background-color: var(--color-bg-sunken);
  overflow: hidden;
}

.player-surface__host {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.player-surface__host :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background-color: #000;
}

.player-surface__dim {
  position: absolute;
  inset: 0;
  background-color: #000;
  pointer-events: none;
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.player-surface--immersive .subtitle-overlay {
  bottom: calc(var(--space-8) + var(--safe-bottom));
  left: max(12%, var(--safe-left));
  right: max(12%, var(--safe-right));
}
</style>
