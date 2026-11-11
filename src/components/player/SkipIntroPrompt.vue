<script setup lang="ts">
/**
 * 跳过片头 / 片尾胶囊（B-06）
 *
 * 落在画面右下角，复用连播提示那套环形倒计时视觉语言：
 * - `auto` 为真：环随 countdown 收圈，收满即放行（由 composable 触发 skip）
 * - `auto` 为假：设置里关了自动跳，只留文字与「跳过」入口
 *
 * 外层容器 `pointer-events: none`，只有胶囊本身可点——否则会吃掉整块画面的手势。
 */
import CountdownRing from '@/components/common/CountdownRing.vue';

withDefaults(
  defineProps<{
    zone: 'intro' | 'credits';
    /** 剩余秒数；0 表示不倒计时 */
    countdown?: number;
    /** 总秒数（环一圈代表多久） */
    total?: number;
    /** 是否倒计时到点自动跳 */
    auto?: boolean;
  }>(),
  { countdown: 0, total: 3, auto: true },
);

const emit = defineEmits<{
  (e: 'skip'): void;
  (e: 'dismiss'): void;
}>();

const LABEL: Record<'intro' | 'credits', string> = { intro: '跳过片头', credits: '跳过片尾' };
</script>

<template>
  <div class="skip-prompt">
    <div class="skip-prompt__pill" :class="{ 'skip-prompt__pill--still': !auto }" role="status" aria-live="polite">
      <span v-if="auto && countdown > 0" class="skip-prompt__ring">
        <CountdownRing :countdown="countdown" :total="total" />
      </span>
      <button class="skip-prompt__text" type="button" @click="emit('skip')">
        {{ LABEL[zone] }} →
      </button>
      <button class="skip-prompt__close" type="button" aria-label="本集不再提示" @click.stop="emit('dismiss')">
        ✕
      </button>
    </div>
  </div>
</template>

<style scoped>
.skip-prompt {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  /* 左右下都要避开安全区与进度条区域 */
  padding: var(--space-3) calc(var(--space-4) + var(--safe-right))
    calc(var(--space-9) + var(--safe-bottom)) var(--space-4);
  pointer-events: none;
}

.skip-prompt__pill {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border-radius: var(--radius-pill);
  background-color: rgba(0, 0, 0, 0.72);
  border: 1px solid rgba(240, 168, 46, 0.4);
  backdrop-filter: var(--blur-player-hud);
  box-shadow: var(--shadow-2);
  color: #ffffff;
  pointer-events: auto;
  animation: skip-prompt-in var(--duration-base) var(--ease-decelerate);
}

.skip-prompt__ring {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
}

.skip-prompt__text {
  font: var(--text-caption);
  font-weight: 700;
  color: inherit;
  white-space: nowrap;
}

.skip-prompt__close {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  border-radius: var(--radius-pill);
  color: var(--color-text-tertiary);
  background-color: rgba(255, 255, 255, 0.08);
  font-size: 11px;
  line-height: 1;
}

@keyframes skip-prompt-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .skip-prompt__pill {
    animation: none;
  }
}
</style>
