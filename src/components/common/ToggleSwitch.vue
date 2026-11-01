<script setup lang="ts">
/**
 * 开关（设计规范 8.13）
 *
 * 轨道 44×24、滑块 20×20；开启态品牌色；命中区扩到 44×44。
 * `role="switch"` + `aria-checked`。
 */
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

function toggle(): void {
  if (props.disabled) return;
  const next = !props.modelValue;
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
    <span class="switch__thumb" />
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

.switch__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  background-color: var(--color-text-secondary);
  transition: transform var(--duration-base) var(--ease-standard),
    background-color var(--duration-base) var(--ease-standard);
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
</style>
