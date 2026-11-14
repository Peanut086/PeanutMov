<script setup lang="ts">
/**
 * OPT-10：手势帮助浮层
 *
 * 显示所有手势操作的图示与说明，手动关闭。
 * 触发入口有两个，弹出策略不同（见 `player/gestureHelpPolicy`）：
 * - 暂停时长按 3 秒自动呼出：同一会话内最多 1 次，之后进入冷却
 * - 「更多 → 手势说明」：用户主动行为，始终可弹
 * 与 GestureGuide 的区别：GestureGuide 首次进入自动显示，5 秒后自动消失。
 */
withDefaults(
  defineProps<{
    visible: boolean;
  }>(),
  { visible: false },
);

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function onClose(): void {
  emit('close');
}
</script>

<template>
  <Transition name="help-overlay">
    <div
      v-if="visible"
      class="gesture-help-overlay"
      role="dialog"
      aria-label="手势帮助"
      @click.stop="onClose"
    >
      <div class="gesture-help-overlay__backdrop" aria-hidden="true" />
      <div class="gesture-help-overlay__content" @click.stop>
        <div class="gesture-help-overlay__header">
          <h3 class="gesture-help-overlay__title">手势操作指南</h3>
          <button
            class="gesture-help-overlay__close"
            type="button"
            aria-label="关闭"
            @click="onClose"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="gesture-help-overlay__list">
          <!-- 单击 -->
          <div class="gesture-help-item">
            <div class="gesture-help-item__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
              </svg>
            </div>
            <div class="gesture-help-item__text">
              <span class="gesture-help-item__label">单击屏幕</span>
              <span class="gesture-help-item__desc">显示或隐藏控制条</span>
            </div>
          </div>

          <!-- 双击 -->
          <div class="gesture-help-item">
            <div class="gesture-help-item__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="9" cy="12" r="2.5" />
                <circle cx="15" cy="12" r="2.5" />
              </svg>
            </div>
            <div class="gesture-help-item__text">
              <span class="gesture-help-item__label">双击屏幕</span>
              <span class="gesture-help-item__desc">播放或暂停</span>
            </div>
          </div>

          <!-- 水平拖动 -->
          <div class="gesture-help-item">
            <div class="gesture-help-item__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" />
              </svg>
            </div>
            <div class="gesture-help-item__text">
              <span class="gesture-help-item__label">水平拖动</span>
              <span class="gesture-help-item__desc">快进或快退（最长 {{ 90 }} 秒）</span>
            </div>
          </div>

          <!-- 垂直拖动 -->
          <div class="gesture-help-item">
            <div class="gesture-help-item__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4" />
              </svg>
            </div>
            <div class="gesture-help-item__text">
              <span class="gesture-help-item__label">垂直拖动</span>
              <span class="gesture-help-item__desc">左侧调节亮度，右侧调节音量</span>
            </div>
          </div>

          <!-- 长按 -->
          <div class="gesture-help-item">
            <div class="gesture-help-item__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="8" />
                <path d="M12 8v4l3 2" />
              </svg>
            </div>
            <div class="gesture-help-item__text">
              <span class="gesture-help-item__label">长按屏幕</span>
              <span class="gesture-help-item__desc">快速倍速播放（松开恢复）</span>
            </div>
          </div>

          <!-- 长按帮助（元手势） -->
          <div class="gesture-help-item gesture-help-item--meta">
            <div class="gesture-help-item__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
              </svg>
            </div>
            <div class="gesture-help-item__text">
              <span class="gesture-help-item__label">暂停时长按 3 秒</span>
              <span class="gesture-help-item__desc">呼出本帮助面板，也可用「更多 → 手势说明」</span>
            </div>
          </div>
        </div>

        <p class="gesture-help-overlay__hint">点击空白处或关闭按钮退出</p>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.gesture-help-overlay {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: auto;
}

.gesture-help-overlay__backdrop {
  position: absolute;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(6px);
}

.gesture-help-overlay__content {
  position: relative;
  width: calc(100% - 48px);
  max-width: 360px;
  max-height: 80vh;
  padding: var(--space-5);
  border-radius: var(--radius-lg);
  background-color: rgba(28, 28, 28, 0.98);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
  overflow-y: auto;
}

.gesture-help-overlay__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.gesture-help-overlay__title {
  margin: 0;
  font: var(--text-title-2);
  color: #ffffff;
}

.gesture-help-overlay__close {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: rgba(255, 255, 255, 0.08);
  border: none;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  transition: var(--transition-color);
}

.gesture-help-overlay__close:active {
  background-color: rgba(255, 255, 255, 0.16);
}

.gesture-help-overlay__close svg {
  width: 16px;
  height: 16px;
}

.gesture-help-overlay__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.gesture-help-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2);
  border-radius: var(--radius-md);
  background-color: rgba(255, 255, 255, 0.04);
}

.gesture-help-item--meta {
  background-color: rgba(240, 168, 46, 0.08);
  border: 1px solid rgba(240, 168, 46, 0.2);
}

.gesture-help-item__icon {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background-color: rgba(255, 255, 255, 0.08);
  color: var(--color-brand);
}

.gesture-help-item--meta .gesture-help-item__icon {
  background-color: rgba(240, 168, 46, 0.16);
}

.gesture-help-item__icon svg {
  width: 22px;
  height: 22px;
}

.gesture-help-item__text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.gesture-help-item__label {
  font: var(--text-body-strong);
  color: #ffffff;
}

.gesture-help-item__desc {
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.6);
}

.gesture-help-overlay__hint {
  margin: var(--space-4) 0 0;
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.4);
  text-align: center;
}

.help-overlay-enter-active,
.help-overlay-leave-active {
  transition: opacity var(--duration-normal) var(--ease-standard);
}

.help-overlay-enter-from,
.help-overlay-leave-to {
  opacity: 0;
}
</style>
