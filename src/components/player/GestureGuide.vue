<script setup lang="ts">
/**
 * 手势引导浮层（P1-1）
 *
 * 首次进入播放页时显示 5 个手势图标 + 说明，帮助用户快速上手。
 * 显示后写入 localStorage 标记，不再自动弹出。
 * 设置页可手动触发再次显示。
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';

const STORAGE_KEY = 'player-gesture-guide-shown';
const AUTO_DISMISS_MS = 5000;

const visible = ref(false);
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

function show(): void {
  visible.value = true;
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS);
}

function dismiss(): void {
  visible.value = false;
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // localStorage 不可用（隐私模式/配额满）不影响功能
  }
}

function onTap(): void {
  dismiss();
}

onMounted(() => {
  try {
    if (!localStorage.getItem(STORAGE_KEY)) {
      show();
    }
  } catch {
    // localStorage 不可用时默认显示一次
    show();
  }
});

// REV-12：组件卸载时清理 dismissTimer
onBeforeUnmount(() => {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
});

defineExpose({ show });
</script>

<template>
  <Transition name="guide">
    <div
      v-if="visible"
      class="gesture-guide"
      role="dialog"
      aria-label="手势操作说明"
      @click.stop="onTap"
    >
      <div class="gesture-guide__backdrop" aria-hidden="true" />
      <div class="gesture-guide__content">
        <h3 class="gesture-guide__title">手势操作</h3>
        <div class="gesture-guide__grid">
          <!-- 单击 -->
          <div class="gesture-guide__item">
            <div class="gesture-guide__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
              </svg>
            </div>
            <span class="gesture-guide__label">单击</span>
            <span class="gesture-guide__desc">显隐控制条</span>
          </div>

          <!-- 双击 -->
          <div class="gesture-guide__item">
            <div class="gesture-guide__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="9" cy="12" r="2.5" />
                <circle cx="15" cy="12" r="2.5" />
              </svg>
            </div>
            <span class="gesture-guide__label">双击</span>
            <span class="gesture-guide__desc">播放/暂停</span>
          </div>

          <!-- 水平拖动 -->
          <div class="gesture-guide__item">
            <div class="gesture-guide__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" />
              </svg>
            </div>
            <span class="gesture-guide__label">水平拖动</span>
            <span class="gesture-guide__desc">快进/快退</span>
          </div>

          <!-- 垂直拖动 -->
          <div class="gesture-guide__item">
            <div class="gesture-guide__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4" />
              </svg>
            </div>
            <span class="gesture-guide__label">垂直拖动</span>
            <span class="gesture-guide__desc">左亮度/右音量</span>
          </div>

          <!-- 长按 -->
          <div class="gesture-guide__item">
            <div class="gesture-guide__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v4l3 2" />
              </svg>
            </div>
            <span class="gesture-guide__label">长按</span>
            <span class="gesture-guide__desc">快速倍速播放</span>
          </div>
        </div>
        <!-- OPT-10：长按帮助提示 -->
        <p class="gesture-guide__long-press-hint">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4M12 8h.01" />
          </svg>
          长按屏幕 2 秒可随时查看手势帮助
        </p>
        <p class="gesture-guide__hint">点击任意处关闭</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.gesture-guide {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.gesture-guide__backdrop {
  position: absolute;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}

.gesture-guide__content {
  position: relative;
  max-width: 320px;
  padding: var(--space-5);
  border-radius: var(--radius-lg);
  background-color: rgba(30, 30, 30, 0.95);
  border: var(--border-default);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}

.gesture-guide__title {
  margin: 0 0 var(--space-4);
  font: var(--text-title-2);
  color: #ffffff;
  text-align: center;
}

.gesture-guide__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--space-4);
}

.gesture-guide__item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
}

.gesture-guide__icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background-color: rgba(255, 255, 255, 0.08);
  color: var(--color-brand);
}

.gesture-guide__icon svg {
  width: 28px;
  height: 28px;
}

.gesture-guide__label {
  font: var(--text-body-2);
  color: #ffffff;
  font-weight: 500;
}

.gesture-guide__desc {
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.6);
}

.gesture-guide__hint {
  margin: var(--space-4) 0 0;
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.4);
  text-align: center;
}

/* OPT-10：长按帮助提示 */
.gesture-guide__long-press-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: rgba(240, 168, 46, 0.08);
  border: 1px solid rgba(240, 168, 46, 0.2);
  font: var(--text-caption);
  color: var(--color-brand);
  text-align: center;
}

.gesture-guide__long-press-hint svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}

.guide-enter-active,
.guide-leave-active {
  transition: opacity var(--duration-normal) var(--ease-standard);
}

.guide-enter-from,
.guide-leave-to {
  opacity: 0;
}
</style>
