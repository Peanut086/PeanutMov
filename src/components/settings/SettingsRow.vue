<script setup lang="ts">
/**
 * 设置行（设计规范 8.6 ListRow）
 *
 * 结构：`[前导图标] [标题 + 副标题] [尾部值 + 箭头 / 开关]`
 * 行本身可点（导航），尾部 switch 独立拦截点击。
 * 开关型行传入 `switchValue`（boolean），此时点击整行不导航。
 */
import { computed } from 'vue';

import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import IconChevron from '@/components/icons/IconChevron.vue';

const props = withDefaults(
  defineProps<{
    label: string;
    /** 右侧值文字（如"深色"、"1.0x"） */
    value?: string;
    /** 副标题 */
    description?: string;
    /** 是否显示右侧箭头 */
    chevron?: boolean;
    /** 危险项（删除/清空） */
    danger?: boolean;
    disabled?: boolean;
    /** 传入 boolean 即为开关行 */
    switchValue?: boolean;
  }>(),
  { value: '', description: '', chevron: false, danger: false, disabled: false, switchValue: undefined },
);

const emit = defineEmits<{
  (e: 'click'): void;
  (e: 'update:switchValue', v: boolean): void;
}>();

const showSwitch = computed(() => typeof props.switchValue === 'boolean');

function onClick(): void {
  if (props.disabled || showSwitch.value) return;
  emit('click');
}
</script>

<template>
  <div class="settings-row" :class="{ 'settings-row--disabled': disabled }">
    <button
      class="settings-row__main"
      type="button"
      :disabled="disabled"
      @click="onClick"
    >
      <span v-if="$slots.icon" class="settings-row__icon">
        <slot name="icon" />
      </span>

      <span class="settings-row__texts">
        <span class="settings-row__label" :class="{ 'settings-row__label--danger': danger }">
          {{ label }}
        </span>
        <span v-if="description" class="settings-row__desc">{{ description }}</span>
      </span>

      <span v-if="value" class="settings-row__value">{{ value }}</span>
      <IconChevron v-if="chevron" :size="16" class="settings-row__chevron" />
      <slot name="tail" />
    </button>

    <ToggleSwitch
      v-if="showSwitch"
      class="settings-row__switch"
      :model-value="switchValue === true"
      :disabled="disabled"
      :label="label"
      @update:model-value="emit('update:switchValue', $event)"
    />
  </div>
</template>

<style scoped>
.settings-row {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--color-divider);
}

.settings-row:last-child {
  border-bottom: none;
}

.settings-row__main {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 1 1 auto;
  min-width: 0;
  min-height: 56px;
  padding: var(--space-3) var(--space-4);
  text-align: left;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.settings-row__main:active:not(:disabled) {
  background-color: var(--color-overlay-press);
}

.settings-row--disabled {
  opacity: 0.6;
}

.settings-row__icon {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--color-text-secondary);
}

.settings-row__texts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
}

.settings-row__label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.settings-row__label--danger {
  color: var(--color-danger);
}

.settings-row__desc {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.settings-row__value {
  flex: 0 0 auto;
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.settings-row__chevron {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
}

.settings-row__switch {
  margin-right: var(--space-4);
}
</style>
