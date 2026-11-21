<script setup lang="ts">
/**
 * 播放画面层（技术方案 9.2 / 设计规范 6.6）
 *
 * 结构：黑底画布 + 视频容器（由 PlayerController 注入）+ 亮度遮罩 + 字幕叠加层。
 * 字幕由 SubtitleManager 计算文本后传入，**不使用浏览器原生字幕渲染**。
 *
 * 遮罩只是亮度的其中一种落点：原生直接调窗口背光时，遮罩必须保持全透明，
 * 否则两层一起压，HUD 上的百分比就和眼睛看到的对不上了。
 *
 * C-09 氛围光：光晕层画在视频**之下**，视频自身的黑底改为透明后，竖屏上下那两条
 * 16:9 信箱黑边就变成随剧情呼吸的光。取样失败时整层移除，播放链路零影响。
 */
import { computed, useTemplateRef, watch } from 'vue';

import type { SubtitleSettings } from '@/types';

import { brightnessToDimOpacity } from '@/player/brightness';
import { SUBTITLE_SIZE_CLASS } from '@/player/constants';
import { useAmbilight, type AmbilightBlockReason } from '@/composables/useAmbilight';

const props = withDefaults(
  defineProps<{
    /** 字幕文本（含换行） */
    subtitleText: string;
    subtitle: SubtitleSettings;
    /** 画面亮度 0~100 */
    brightness: number;
    /** 是否用遮罩表达亮度（Web / 原生能力缺失）；false 时遮罩恒透明 */
    mask: boolean;
    /** 是否横屏/全屏布局 */
    immersive?: boolean;
    /** 氛围光开关（C-09） */
    ambilightEnabled?: boolean;
    /** 氛围光强度 0~100 */
    ambilightIntensity?: number;
    /** 当前是否原生引擎：原生 surface 在 WebView 之下，DOM 里不会有 video */
    nativeEngine?: boolean;
  }>(),
  { immersive: false, ambilightEnabled: false, ambilightIntensity: 85, nativeEngine: false },
);

const emit = defineEmits<{ (e: 'ambilight-blocked', reason: AmbilightBlockReason): void }>();

const subtitleClasses = computed(() => [
  'subtitle-overlay',
  SUBTITLE_SIZE_CLASS[props.subtitle.size],
  {
    'subtitle-overlay--yellow': props.subtitle.color === 'yellow',
    'subtitle-overlay--no-bg': props.subtitle.background === 'none',
  },
]);

/** 遮罩不透明度：0~0.8（设计规范 2.7：最多压到 80%，保留 20% 亮度）；背光模式下恒为 0 */
const dimOpacity = computed(() => (props.mask ? brightnessToDimOpacity(props.brightness) : 0));

const hostEl = useTemplateRef<HTMLElement>('host');
const glowEl = useTemplateRef<HTMLCanvasElement>('glow');
const ambilightOn = computed(() => props.ambilightEnabled);
const ambilightLevel = computed(() => props.ambilightIntensity);
const { blocked } = useAmbilight({
  host: hostEl,
  canvas: glowEl,
  enabled: ambilightOn,
  intensity: ambilightLevel,
  native: computed(() => props.nativeEngine),
});
watch(blocked, (reason) => {
  if (reason) emit('ambilight-blocked', reason);
});
</script>

<template>
  <div
    class="player-surface"
    :class="{
      'player-surface--immersive': immersive,
      'player-surface--ambilight': ambilightEnabled,
    }"
  >
    <!-- 氛围光：画在视频之下，只有信箱区透出来（视频底色由 CSS 改为透明） -->
    <canvas
      v-if="ambilightEnabled"
      ref="glow"
      class="player-surface__ambilight"
      data-ambilight-canvas
      aria-hidden="true"
    />

    <!-- 视频容器：PlayerController.mount 挂到这里 -->
    <div ref="host" class="player-surface__host" data-player-host />

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

/*
 * 氛围光层：DOM 里排在视频容器之前，靠绘制顺序自然落到画面之下。
 * blur 是合成层里的滤镜，逐帧只改画布内容、不改这个属性。
 */
.player-surface__ambilight {
  position: absolute;
  /* 向外溢出一点：黑边不只是被染色，光要推到屏幕边缘才有"溢出机身"的感觉 */
  inset: -6%;
  filter: blur(34px) saturate(1.45);
  opacity: 0.9;
  pointer-events: none;
  transition: opacity var(--duration-slow) var(--ease-standard);
}

/* 视频底色透明：光晕只在信箱区透出，画面本体不受影响 */
.player-surface--ambilight :deep(video) {
  background-color: transparent;
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
