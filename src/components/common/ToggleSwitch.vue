<script setup lang="ts">
/**
 * 开关（设计规范 8.13）
 *
 * 轨道 44×24、滑块 20×20；开启态品牌色；命中区扩到 44×44。
 * `role="switch"` + `aria-checked`。
 * M3 片门拨杆：滑块弹簧过冲 + 轨道扫光 + ✓/· 图标交叉淡入 + 触感。
 */
import { useHaptic } from '@/composables/useHaptic';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    disabled?: boolean;
    /** 无障碍标签（无可见文字时必须提供） */
    label?: string;
  }>(),
  { disabled: false, label: '' },
);

const emit = defineEmits<{ (e: 'update:modelValue', v: boolean): void; (e: 'change', v: boolean): void }>();

const { haptic } = useHaptic();

function toggle(): void {
  if (props.disabled) return;
  const next = !props.modelValue;
  haptic('light');
  emit('update:modelValue', next);
  emit('change', next);
}
</script>

<template>
  <button
    class="switch"
    :class="{ 'switch--on': modelValue, 'switch--disabled': disabled }"
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label || undefined"
    :disabled="disabled"
    @click.stop="toggle"
  >
    <span class="switch__thumb">
      <span class="switch__icon switch__icon--on" aria-hidden="true">✓</span>
      <span class="switch__icon switch__icon--off" aria-hidden="true">·</span>
    </span>
  </button>
</template>

<style scoped>
/* v2：46×28 轨道 + 20 滑块，开启态用品牌色轨道 + 深色滑块 */
.switch {
  position: relative;
  flex: 0 0 auto;
  width: 46px;
  height: 28px;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-pressed);
  border: 1px solid var(--color-border-strong);
  transition: background-color var(--duration-base) var(--ease-standard),
    border-color var(--duration-base) var(--ease-standard);
}

/* 命中区 44×44（不改变轨道视觉尺寸） */
.switch::after {
  content: '';
  position: absolute;
  inset: -8px 0;
}

/* M3：开启态品牌渐变扫光（background-position 100%→0，220ms） */
.switch::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(100deg, var(--color-brand) 0%, var(--color-brand-strong) 40%, var(--color-brand) 80%);
  background-size: 220% 100%;
  background-position: 100% 0;
  opacity: 0;
  transition: background-position 220ms var(--ease-standard), opacity var(--duration-fast) var(--ease-standard);
  pointer-events: none;
}

.switch--on::before {
  opacity: 1;
  background-position: 0 0;
}

.switch__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  background-color: var(--color-text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  /* M3：弹簧过冲曲线（ζ≈0.67 观感，过冲约 6%） */
  transition: transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color var(--duration-base) var(--ease-standard);
}

/* M3：✓/· 状态图标交叉淡入 */
.switch__icon {
  position: absolute;
  font-size: 12px;
  line-height: 1;
  font-weight: var(--font-weight-bold);
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.switch__icon--on {
  color: var(--color-brand);
  opacity: 0;
}

.switch__icon--off {
  color: var(--color-bg-pressed);
  opacity: 1;
}

.switch--on .switch__icon--on {
  opacity: 1;
}

.switch--on .switch__icon--off {
  opacity: 0;
}

.switch--on {
  background-color: var(--color-brand);
  border-color: transparent;
}

.switch--on .switch__thumb {
  transform: translateX(18px);
  background-color: var(--color-brand-ink);
}

.switch--disabled {
  background-color: var(--color-overlay-press-strong);
  border-color: transparent;
}

.switch--disabled .switch__thumb {
  background-color: var(--color-text-disabled);
}

.switch:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}

@media (prefers-reduced-motion: reduce) {
  .switch__thumb,
  .switch__icon,
  .switch::before {
    transition: none;
  }
}
</style>
