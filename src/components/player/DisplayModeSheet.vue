<script setup lang="ts">
/**
 * 画面设置（P1 画面比例配置 + C-09 氛围光）
 *
 * 氛围光的开关与强度写回 `player` 设置；关闭后播放层不再挂光晕 canvas，取样定时器一并停止。
 */
import BottomSheet from '@/components/common/BottomSheet.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import type { ResizeMode } from '@/types';

const props = defineProps<{
  modelValue: boolean;
  mode: ResizeMode;
  ambilight: boolean;
  ambilightIntensity: number;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'select', mode: ResizeMode): void;
  (e: 'set-ambilight', value: boolean): void;
  (e: 'set-ambilight-intensity', value: number): void;
}>();

const MODES: Array<{ value: ResizeMode; label: string; hint: string }> = [
  { value: 'contain', label: '适应', hint: '完整显示，留黑边' },
  { value: 'cover', label: '铺满', hint: '裁剪边缘，不变形' },
  { value: 'fill', label: '拉伸', hint: '填满屏幕，会变形' },
];

function choose(mode: ResizeMode): void {
  emit('select', mode);
  emit('update:modelValue', false);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    title="画面"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="sheet-section">画面比例</p>
    <ul class="mode-list">
      <li v-for="item in MODES" :key="item.value">
        <button
          class="mode-item"
          :class="{ 'mode-item--active': mode === item.value }"
          type="button"
          @click="choose(item.value)"
        >
          <span>{{ item.label }}</span>
          <span class="mode-item__hint">{{ item.hint }}</span>
          <span v-if="mode === item.value" class="mode-item__check">当前</span>
        </button>
      </li>
    </ul>

    <p class="sheet-section">氛围光</p>
    <div class="ambilight-row">
      <span>画面氛围光</span>
      <ToggleSwitch
        :model-value="props.ambilight"
        @update:model-value="emit('set-ambilight', $event)"
      />
    </div>
    <label v-if="props.ambilight" class="ambilight-field">
      <span>强度 {{ props.ambilightIntensity }}%</span>
      <input
        type="range"
        min="0"
        max="100"
        step="5"
        :value="props.ambilightIntensity"
        @change="emit('set-ambilight-intensity', Number(($event.target as HTMLInputElement).value))"
      />
    </label>
    <p class="sheet-hint">取当前画面边缘主色为黑边补光；Web 引擎实时取样，原生引擎（ExoPlayer）拿不到画面时会自动关闭。</p>
  </BottomSheet>
</template>

<style scoped>
.sheet-section {
  margin-bottom: var(--space-1);
  padding: 0 var(--space-2);
  color: var(--color-text-tertiary);
  font: var(--text-label-strong);
}

.sheet-section:not(:first-child) {
  margin-top: var(--space-4);
}

.mode-list {
  display: flex;
  flex-direction: column;
}

.mode-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.mode-item--active {
  color: var(--color-brand-text);
}

.mode-item__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.mode-item__check {
  margin-left: auto;
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.ambilight-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  padding: 0 var(--space-2);
  color: var(--color-text-primary);
  font: var(--text-body);
}

.ambilight-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: 0 var(--space-2);
  color: var(--color-text-secondary);
  font: var(--text-caption);
}

.sheet-hint {
  padding: var(--space-2) var(--space-2) var(--space-4);
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}
</style>
