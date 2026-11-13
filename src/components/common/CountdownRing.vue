<script setup lang="ts">
/**
 * 环形倒计时（B-06 从 NextEpisodePrompt 抽出，连播提示与跳过片头共用一套视觉语言）
 *
 * `r = 15` → 周长 `2πr ≈ 94.2`，dasharray 与 dashoffset 都以此为准；改半径必须同步改这个常量。
 * 过渡固定 1s linear：外层每秒把 countdown 减 1，环就匀速收掉一格。
 */
import { computed } from 'vue';

const CIRCUMFERENCE = 94.2;

const props = withDefaults(
  defineProps<{
    /** 剩余秒数 */
    countdown: number;
    /** 总秒数（决定一圈代表多久） */
    total?: number;
    /** 描边色，默认跟随品牌色 */
    stroke?: string;
    /** 即时跟随（无 1s 过渡）：下拉进度环逐帧跟手，不能用秒级过渡 */
    instant?: boolean;
  }>(),
  { total: 3, stroke: 'var(--color-brand)', instant: false },
);

const dashOffset = computed(() => {
  const ratio = props.total > 0 ? Math.min(1, Math.max(0, props.countdown / props.total)) : 0;
  return CIRCUMFERENCE * (1 - ratio);
});
</script>

<template>
  <svg class="countdown-ring" viewBox="0 0 36 36" aria-hidden="true">
    <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3" />
    <circle
      cx="18"
      cy="18"
      r="15"
      fill="none"
      :stroke="stroke"
      stroke-width="3"
      stroke-linecap="round"
      :stroke-dasharray="CIRCUMFERENCE"
      :stroke-dashoffset="dashOffset"
      transform="rotate(-90 18 18)"
      class="countdown-ring__fill"
      :class="{ 'countdown-ring__fill--instant': instant }"
    />
  </svg>
</template>

<style scoped>
.countdown-ring {
  display: block;
  width: 100%;
  height: 100%;
}

.countdown-ring__fill {
  transition: stroke-dashoffset 1s linear;
}

.countdown-ring__fill--instant {
  transition: none;
}
</style>
