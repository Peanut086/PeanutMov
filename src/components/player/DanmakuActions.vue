<script setup lang="ts">
/**
 * 弹幕操作条（B-04）
 *
 * 挂在被点中那条弹幕的头顶：点赞 / 复制 / 定位。整条按弹幕实际矩形定位，
 * 靠近画面顶边时翻到下方，左右夹在画面内——不然半截会被裁掉。
 *
 * `:key="likeCount"` 让数字元素在点赞瞬间被替换，CSS 入场动画随之重播，
 * 不需要额外的定时器去摘 class。
 */
import { computed } from 'vue';

import { formatClock } from '@/shared/time';
import type { DanmakuPick } from '@/player/DanmakuOverlay';

const props = defineProps<{
  pick: DanmakuPick;
  liked: boolean;
  likeCount: number;
}>();

const emit = defineEmits<{
  (e: 'like'): void;
  (e: 'copy'): void;
  (e: 'locate'): void;
  (e: 'close'): void;
}>();

/** 头顶留白不足就翻到弹幕下方 */
const FLIP_TOP_PX = 56;

const rect = computed(() => props.pick.rect);
const placeBelow = computed(() => rect.value.top < FLIP_TOP_PX);
// 横向只交出矩形水平中点，「别越出画面」的夹取由 CSS 的 clamp 负责
const anchorStyle = computed<Record<string, string>>(() => ({
  '--anchor-x': `${Math.round(rect.value.left + rect.value.width / 2)}px`,
  top: `${Math.round(placeBelow.value ? rect.value.top + rect.value.height + 10 : rect.value.top - 10)}px`,
}));
</script>

<template>
  <div
    class="danmaku-actions"
    :class="{ 'danmaku-actions--below': placeBelow }"
    :style="anchorStyle"
    role="group"
    aria-label="弹幕操作"
  >
    <button
      class="danmaku-actions__btn danmaku-actions__btn--like"
      :class="{ 'is-liked': liked }"
      type="button"
      :aria-pressed="liked"
      @click="emit('like')"
    >
      <svg class="danmaku-actions__heart" viewBox="0 0 20 20" aria-hidden="true">
        <path
          d="M10 17.2 8.6 15.9C4.2 11.8 1.6 9.4 1.6 6.5 1.6 4.1 3.5 2.2 5.9 2.2c1.4 0 2.7.6 3.5 1.7.8-1.1 2.1-1.7 3.5-1.7 2.4 0 4.3 1.9 4.3 4.3 0 2.9-2.6 5.3-7 9.4L10 17.2Z"
          :fill="liked ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.4"
        />
      </svg>
      <span :key="likeCount" class="danmaku-actions__count">{{ likeCount }}</span>
    </button>

    <button class="danmaku-actions__btn" type="button" @click="emit('copy')">复制</button>
    <button class="danmaku-actions__btn" type="button" @click="emit('locate')">
      定位 {{ formatClock(pick.comment.time) }}
    </button>
    <button class="danmaku-actions__btn danmaku-actions__btn--close" type="button" aria-label="关闭" @click="emit('close')">
      ✕
    </button>
  </div>
</template>

<style scoped>
.danmaku-actions {
  position: absolute;
  /* 弹幕贴左/贴右时操作条也跟着贴边会被裁：横向至少留 104px */
  left: clamp(104px, var(--anchor-x), calc(100% - 104px));
  z-index: 7;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px var(--space-1);
  border-radius: var(--radius-pill);
  border: 1px solid rgba(255, 255, 255, 0.18);
  background-color: rgba(0, 0, 0, 0.78);
  backdrop-filter: var(--blur-player-hud);
  box-shadow: var(--shadow-2);
  color: #ffffff;
  white-space: nowrap;
  pointer-events: auto;
  transform: translateX(-50%) translateY(-100%);
  animation: danmaku-actions-in var(--duration-fast) var(--ease-decelerate);
}

.danmaku-actions--below {
  transform: translateX(-50%) translateY(0);
}

.danmaku-actions__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border-radius: var(--radius-pill);
  font: var(--text-caption);
  font-weight: 700;
  color: inherit;
}

.danmaku-actions__btn--close {
  color: var(--color-text-tertiary);
}

.danmaku-actions__btn--like.is-liked {
  color: #ff5f7e;
}

.danmaku-actions__heart {
  width: 15px;
  height: 15px;
  flex: 0 0 auto;
}

.danmaku-actions__count {
  font-family: var(--font-family-number);
  animation: like-pop var(--duration-base) var(--ease-decelerate);
}

@keyframes danmaku-actions-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes like-pop {
  0% {
    scale: 1;
  }
  40% {
    scale: 1.4;
  }
  100% {
    scale: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .danmaku-actions,
  .danmaku-actions__count {
    animation: none;
  }
}
</style>
