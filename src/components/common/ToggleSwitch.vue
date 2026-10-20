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
.switch {
  position: relative;
  flex: 0 0 auto;
  width: 44px;
  height: 24px;
  border-radius: var(--radius-full);
  background-color: rgba(255, 255, 255, 0.16);
  transition: background-color var(--duration-base) var(--ease-standard);
}

/* 命中区 44×44（不改变轨道视觉尺寸） */
.switch::after {
  content: '';
  position: absolute;
  inset: -10px 0;
}

.switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-full);
  background-color: var(--color-text-primary);
  transition: transform var(--duration-base) var(--ease-standard);
}

.switch--on {
  background-color: var(--color-brand);
}

.switch--on .switch__thumb {
  transform: translateX(20px);
  background-color: #ffffff;
}

.switch--disabled {
  background-color: rgba(255, 255, 255, 0.08);
}

.switch--disabled .switch__thumb {
  background-color: var(--color-text-disabled);
}

.switch:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus);
}
</style>
