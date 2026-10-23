<script setup lang="ts">
/**
 * 自动连播提示 / 回前台续播浮层（页面蓝图 §6.5）
 *
 * 两种模式：
 * - `mode="auto-next"`：播放结束后的倒计时「即将播放第 N 集」+ 取消
 * - `mode="resume"`：切后台回来后「已暂停」+ 继续播放 / 退出
 */
withDefaults(
  defineProps<{
    mode: 'auto-next' | 'resume';
    /** 倒计时秒数（auto-next） */
    countdown?: number;
    /** 下一集标签，如「第 4 集」 */
    nextLabel?: string;
  }>(),
  { countdown: 0, nextLabel: '' },
);

const emit = defineEmits<{
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();
</script>

<template>
  <div class="next-prompt" role="dialog" aria-modal="false">
    <div class="next-prompt__card">
      <template v-if="mode === 'auto-next'">
        <p class="next-prompt__title" role="status" aria-live="polite">
          即将播放{{ nextLabel || '下一集' }}
          <span class="next-prompt__count">{{ countdown }}</span>
        </p>
        <div class="next-prompt__ring" aria-hidden="true">
          <svg viewBox="0 0 36 36">
            <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="3" />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="var(--color-brand)"
              stroke-width="3"
              stroke-linecap="round"
              :stroke-dasharray="94.2"
              :stroke-dashoffset="94.2 - (94.2 * countdown) / 3"
              transform="rotate(-90 18 18)"
              class="next-prompt__ring-fill"
            />
          </svg>
        </div>
        <div class="next-prompt__actions">
          <button class="btn btn--primary btn--sm" type="button" @click="emit('confirm')">
            立即播放
          </button>
          <button class="btn btn--ghost btn--sm" type="button" @click="emit('cancel')">取消</button>
        </div>
      </template>

      <template v-else>
        <p class="next-prompt__title">已暂停播放</p>
        <p class="next-prompt__desc">App 回到后台时已自动暂停并保存进度。</p>
        <div class="next-prompt__actions">
          <button class="btn btn--primary btn--sm" type="button" @click="emit('confirm')">
            继续播放
          </button>
          <button class="btn btn--ghost btn--sm" type="button" @click="emit('cancel')">退出</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.next-prompt {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: var(--space-4) calc(var(--space-4) + var(--safe-right))
    calc(var(--space-8) + var(--safe-bottom)) var(--space-4);
  pointer-events: none;
}

.next-prompt__card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: min(78vw, 320px);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: rgba(0, 0, 0, 0.72);
  border: var(--border-default);
  backdrop-filter: var(--blur-player-hud);
  color: #ffffff;
  pointer-events: auto;
}

.next-prompt__title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font: var(--text-body-strong);
}

.next-prompt__count {
  font: var(--text-title-3);
  font-family: var(--font-family-number);
  color: var(--color-brand-strong);
}

.next-prompt__desc {
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.72);
}

.next-prompt__ring {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  width: 36px;
  height: 36px;
}

.next-prompt__ring-fill {
  transition: stroke-dashoffset 1s linear;
}

.next-prompt__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-1);
}
</style>
