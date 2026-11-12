<script setup lang="ts">
/**
 * 横屏屏幕锁（B4）
 *
 * 锁定态下铺一层全屏拦截片：所有手势/控件都不再响应，只有这枚胶囊能点。
 * 胶囊 3 秒自动隐去（由调用方控制 `revealed`），轻触画面任意处重新唤出——
 * 既防误触，又不会让人找不到解锁入口。
 */
import IconLock from '@/components/icons/IconLock.vue';

defineProps<{ locked: boolean; revealed: boolean }>();

const emit = defineEmits<{ (e: 'toggle'): void; (e: 'reveal'): void }>();
</script>

<template>
  <div
    v-if="locked"
    class="lock-shield"
    role="presentation"
    @pointerdown.stop
    @pointermove.stop
    @pointerup.stop
    @click.stop="emit('reveal')"
  />

  <Transition name="lock-pop">
    <button
      v-if="revealed"
      class="lock-pill"
      :class="{ 'lock-pill--locked': locked }"
      type="button"
      :aria-label="locked ? '解锁屏幕' : '锁定屏幕，防止误触'"
      :aria-pressed="locked"
      @pointerdown.stop
      @click.stop="emit('toggle')"
    >
      <IconLock :locked="locked" :size="18" />
      <span class="lock-pill__text">{{ locked ? '已锁定' : '锁屏' }}</span>
    </button>
  </Transition>
</template>

<style scoped>
.lock-shield {
  position: absolute;
  inset: 0;
  /* 高于舞台内所有浮层（手势引导 10 / 帮助 12 / 弹幕样式 20），锁定即全屏接管 */
  z-index: 30;
  /* 透明但吃事件：手势层已被移除，这里兜住所有落点 */
  background-color: transparent;
  touch-action: none;
}

.lock-pill {
  position: absolute;
  top: 50%;
  left: max(var(--space-4), var(--safe-left));
  z-index: 31;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 56px;
  min-height: 56px;
  padding: var(--space-2);
  transform: translateY(-50%);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border-strong);
  background-color: var(--color-bg-glass);
  backdrop-filter: blur(12px);
  color: var(--color-text-primary);
}

.lock-pill--locked {
  border-color: var(--color-brand);
  color: var(--color-brand-text);
}

.lock-pill__text {
  font: var(--text-caption);
}

.lock-pill:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

.lock-pop-enter-active,
.lock-pop-leave-active {
  transition: opacity var(--duration-base) var(--ease-standard),
    transform var(--duration-base) var(--ease-decelerate);
}

.lock-pop-enter-from,
.lock-pop-leave-to {
  opacity: 0;
  transform: translate(-8px, -50%);
}

@media (prefers-reduced-motion: reduce) {
  .lock-pop-enter-active,
  .lock-pop-leave-active {
    transition: none;
  }

  .lock-pop-enter-from,
  .lock-pop-leave-to {
    transform: translateY(-50%);
  }
}
</style>