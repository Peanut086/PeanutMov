<script setup lang="ts">
/**
 * 弹幕设置面板（v1.7 / CHG-22）
 *
 * 设置项：开关 / 字号 / 透明度 / 速度 / 显示区域 / 合并程度 / 底部安全区。
 * 写回 `settingsStore.update({ danmaku })`；关闭开关后渲染层即时清空。
 */
import { computed } from 'vue';

import BottomSheet from '@/components/common/BottomSheet.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { useSettingsStore } from '@/stores/settingsStore';
import type { DanmakuSettings } from '@/types';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();

const settings = useSettingsStore();

const danmaku = computed<DanmakuSettings>(
  () =>
    settings.settings?.danmaku ?? {
      enabled: false,
      fontSize: 16,
      opacity: 0.8,
      speed: 1,
      areaPercent: 50,
      merge: true,
      safeBottomPercent: 15,
      bold: false,
      strokeStyle: 'shadow',
      density: 'normal',
      filterTop: false,
      filterBottom: false,
      interactive: true,
    },
);

function patch(part: Partial<DanmakuSettings>): void {
  settings.updateNonBlocking({ danmaku: { ...danmaku.value, ...part } });
}
</script>

<template>
  <BottomSheet :model-value="props.open" title="弹幕设置" @update:model-value="emit('update:open', $event)">
    <div class="danmaku-sheet">
      <div class="danmaku-sheet__row">
        <span>开启弹幕（只读展示，不发送）</span>
        <ToggleSwitch :model-value="danmaku.enabled" @update:model-value="patch({ enabled: $event })" />
      </div>

      <label class="danmaku-sheet__field">
        <span>字号 {{ danmaku.fontSize }}px</span>
        <input
          type="range"
          min="10"
          max="36"
          step="1"
          :value="danmaku.fontSize"
          @change="patch({ fontSize: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>不透明度 {{ Math.round(danmaku.opacity * 100) }}%</span>
        <input
          type="range"
          min="0.1"
          max="1"
          step="0.1"
          :value="danmaku.opacity"
          @change="patch({ opacity: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>速度 {{ danmaku.speed.toFixed(1) }}x（越大越慢）</span>
        <input
          type="range"
          min="0.5"
          max="3"
          step="0.5"
          :value="danmaku.speed"
          @change="patch({ speed: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>显示区域 {{ danmaku.areaPercent }}%</span>
        <input
          type="range"
          min="10"
          max="100"
          step="5"
          :value="danmaku.areaPercent"
          @change="patch({ areaPercent: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <label class="danmaku-sheet__field">
        <span>底部安全区 {{ danmaku.safeBottomPercent }}%（避让字幕）</span>
        <input
          type="range"
          min="0"
          max="50"
          step="5"
          :value="danmaku.safeBottomPercent"
          @change="patch({ safeBottomPercent: Number(($event.target as HTMLInputElement).value) })"
        />
      </label>

      <div class="danmaku-sheet__row">
        <span>合并重复弹幕</span>
        <ToggleSwitch :model-value="danmaku.merge" @update:model-value="patch({ merge: $event })" />
      </div>

      <p class="field__hint">弹幕由第三方弹幕库按「片名 + 年份 + 集号」自动匹配；关闭开关后不会发起任何弹幕请求。</p>
    </div>
  </BottomSheet>
</template>

<style scoped>
.danmaku-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-4);
}

.danmaku-sheet__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  font: var(--text-body);
  color: var(--color-text-primary);
}

.danmaku-sheet__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-secondary);
}
</style>
