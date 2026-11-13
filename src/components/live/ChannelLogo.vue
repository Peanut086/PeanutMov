<script setup lang="ts">
/**
 * 频道台标（C1）
 *
 * `tvg-logo` 从解析器一路带到这里却从没画出来过。台标是直播列表最强的识别物——
 * 一眼扫过去比读字快得多，所以列表每行都给它留了位置。
 *
 * 三层降级，任何一层都不留破图：
 * 有图 → 懒加载显示；加载失败 / 无图 → 频道字号牌（CCTV-13 取「13」，湖南卫视取「湖」）；
 * 号牌底色按频道名散列取自广播色板，整屏看过去是可分辨的色块而不是灰盒子。
 */
import { computed, ref, watch } from 'vue';

import { sizedImage } from '@/shared/imageSize';

const props = withDefaults(
  defineProps<{ src: string | null; name: string; size?: number }>(),
  { size: 28 },
);

const failed = ref(false);
const loaded = ref(false);

watch(
  () => props.src,
  () => {
    failed.value = false;
    loaded.value = false;
  },
);

/**
 * 台标是全站唯一「显示尺寸已知」的图：`size` 就是 CSS px，乘上 DPR 就是目标设备像素
 * （`object-fit: contain` 的方框，宽度方向刚好用满）。IPTV 的 `tvg-logo` 常有
 * 512~1024px 的原图，缩进 26px 的格子纯属浪费。
 */
const logoSrc = computed(() => {
  const dpr = typeof window === 'undefined' ? 2 : window.devicePixelRatio || 2;
  return sizedImage(props.src, Math.round(props.size * dpr));
});

const showImage = computed(() => !!logoSrc.value && !failed.value);

/** 频道号优先：同一套 CCTV 里「1」「5」「13」比清一色的「C」有用得多 */
const badgeText = computed(() => {
  const name = props.name.trim();
  const digits = name.match(/\d{1,3}/);
  if (digits) return digits[0];
  return Array.from(name)[0]?.toUpperCase() ?? '?';
});

/** 广播色板：8 支高饱和色，按名字散列取，同名永远同色 */
const BROADCAST_HUES = [38, 352, 208, 158, 272, 16, 186, 232];

const badgeStyle = computed(() => {
  let hash = 0;
  for (let i = 0; i < props.name.length; i += 1) {
    hash = (hash * 31 + props.name.charCodeAt(i)) % 100_000;
  }
  const hue = BROADCAST_HUES[hash % BROADCAST_HUES.length];
  return {
    backgroundColor: `hsl(${hue}, 58%, 26%)`,
    color: `hsl(${hue}, 90%, 76%)`,
    borderColor: `hsla(${hue}, 62%, 40%, 0.55)`,
  };
});
</script>

<template>
  <span
    class="channel-logo"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  >
    <!-- 号牌常驻打底：图还在路上时先看到频道号，加载完再淡入覆盖，不留空灰盒 -->
    <span class="channel-logo__badge" :style="badgeStyle">
      {{ badgeText }}
    </span>
    <img
      v-if="showImage"
      class="channel-logo__img"
      :class="{ 'channel-logo__img--loaded': loaded }"
      :src="logoSrc!"
      alt=""
      loading="lazy"
      decoding="async"
      @load="loaded = true"
      @error="failed = true"
    />
  </span>
</template>

<style scoped>
.channel-logo {
  position: relative;
  flex: 0 0 auto;
  display: block;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background-color: var(--color-bg-pressed);
}

.channel-logo__img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* 台标多为透明底方图，contain 才不会被裁掉边 */
  object-fit: contain;
  opacity: 0;
  transition: opacity var(--duration-base) var(--ease-standard);
}

.channel-logo__img--loaded {
  opacity: 1;
  /* 透明底台标不能透出后面的号牌，加载完就用自己的底板盖住 */
  background-color: var(--color-bg-pressed);
}

.channel-logo__badge {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid;
  border-radius: inherit;
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

@media (prefers-reduced-motion: reduce) {
  .channel-logo__img {
    transition: none;
  }
}
</style>