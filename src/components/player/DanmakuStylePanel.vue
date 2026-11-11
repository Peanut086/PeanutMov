<script setup lang="ts">
/**
 * 弹幕样式实时调节面板（问题三）
 *
 * 非模态侧 dock 面板，不遮挡视频画面。所有滑块 @input 实时生效，
 * 持久化写入 350ms debounce，避免频繁写存储。
 */
import { computed, ref, watch } from 'vue';

import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import { useSettingsStore } from '@/stores/settingsStore';
import type { DanmakuSettings } from '@/types';

defineProps<{ open: boolean }>();

const settings = useSettingsStore();

const danmaku = computed<DanmakuSettings>(
  () =>
    settings.settings?.danmaku ?? {
      enabled: true,
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

/** 本地实时值（拖动过程中立即反映到画面） */
const local = ref<DanmakuSettings>({ ...danmaku.value });

watch(danmaku, (next) => {
  local.value = { ...next };
}, { deep: true });

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void settings.update({ danmaku: { ...local.value } });
    persistTimer = null;
  }, 350);
}

function updateField<K extends keyof DanmakuSettings>(key: K, value: DanmakuSettings[K]): void {
  (local.value as DanmakuSettings)[key] = value;
  schedulePersist();
}
</script>

<template>
  <Transition name="danmaku-panel">
    <div v-if="open" class="danmaku-style-panel" role="group" aria-label="弹幕样式调节">
      <div class="panel-header">
        <span class="panel-title">弹幕样式</span>
      </div>

      <div class="panel-body">
        <label class="panel-field">
          <span>字号 {{ local.fontSize }}px</span>
          <input
            type="range" min="10" max="36" step="1"
            :value="local.fontSize"
            @input="updateField('fontSize', Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <label class="panel-field">
          <span>透明度 {{ Math.round(local.opacity * 100) }}%</span>
          <input
            type="range" min="10" max="100" step="5"
            :value="Math.round(local.opacity * 100)"
            @input="updateField('opacity', Number(($event.target as HTMLInputElement).value) / 100)"
          />
        </label>

        <label class="panel-field">
          <span>速度 {{ local.speed.toFixed(1) }}x（越大越慢）</span>
          <input
            type="range" min="0.5" max="3" step="0.1"
            :value="local.speed"
            @input="updateField('speed', Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <label class="panel-field">
          <span>显示区域 {{ local.areaPercent }}%</span>
          <input
            type="range" min="10" max="100" step="5"
            :value="local.areaPercent"
            @input="updateField('areaPercent', Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <label class="panel-field">
          <span>底部安全区 {{ local.safeBottomPercent }}%</span>
          <input
            type="range" min="0" max="50" step="5"
            :value="local.safeBottomPercent"
            @input="updateField('safeBottomPercent', Number(($event.target as HTMLInputElement).value))"
          />
        </label>

        <div class="panel-divider" />

        <div class="panel-row">
          <span>加粗</span>
          <ToggleSwitch :model-value="local.bold" @update:model-value="updateField('bold', $event)" />
        </div>

        <div class="panel-row">
          <span>描边风格</span>
          <select
            class="panel-select"
            :value="local.strokeStyle"
            @change="updateField('strokeStyle', ($event.target as HTMLSelectElement).value as 'none' | 'shadow' | 'outline')"
          >
            <option value="none">无</option>
            <option value="shadow">阴影</option>
            <option value="outline">描边</option>
          </select>
        </div>

        <div class="panel-row">
          <span>密度</span>
          <select
            class="panel-select"
            :value="local.density"
            @change="updateField('density', ($event.target as HTMLSelectElement).value as 'sparse' | 'normal' | 'dense')"
          >
            <option value="sparse">稀疏</option>
            <option value="normal">正常</option>
            <option value="dense">密集</option>
          </select>
        </div>

        <div class="panel-divider" />

        <div class="panel-row">
          <span>合并重复弹幕</span>
          <ToggleSwitch :model-value="local.merge" @update:model-value="updateField('merge', $event)" />
        </div>

        <div class="panel-row">
          <span>过滤顶部弹幕</span>
          <ToggleSwitch :model-value="local.filterTop" @update:model-value="updateField('filterTop', $event)" />
        </div>

        <div class="panel-row">
          <span>过滤底部弹幕</span>
          <ToggleSwitch :model-value="local.filterBottom" @update:model-value="updateField('filterBottom', $event)" />
        </div>

        <div class="panel-divider" />

        <div class="panel-row">
          <span>点击弹幕互动</span>
          <ToggleSwitch :model-value="local.interactive" @update:model-value="updateField('interactive', $event)" />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.danmaku-style-panel {
  position: absolute;
  top: 60px;
  right: 12px;
  z-index: 20;
  width: 260px;
  max-height: calc(100% - 120px);
  overflow-y: auto;
  border-radius: 12px;
  background: rgba(20, 20, 20, 0.88);
  backdrop-filter: blur(12px);
  color: #fff;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  pointer-events: auto;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.panel-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.92);
}

.panel-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 14px 14px;
}

.panel-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.7);
}

.panel-field input[type="range"] {
  width: 100%;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  outline: none;
}

.panel-field input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-brand, #4fc3f7);
  cursor: pointer;
}

.panel-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.85);
  min-height: 28px;
}

.panel-select {
  padding: 2px 6px;
  font-size: 12px;
  color: #fff;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 4px;
  outline: none;
}

.panel-select option {
  background: #222;
  color: #fff;
}

.panel-divider {
  height: 1px;
  background: rgba(255, 255, 255, 0.08);
  margin: 2px 0;
}

.danmaku-panel-enter-active,
.danmaku-panel-leave-active {
  transition: opacity 200ms ease, transform 200ms ease;
}
.danmaku-panel-enter-from,
.danmaku-panel-leave-to {
  opacity: 0;
  transform: translateX(16px);
}

@media (max-width: 640px) {
  .danmaku-style-panel {
    top: auto;
    right: 8px;
    bottom: 80px;
    left: 8px;
    width: auto;
    max-height: 45vh;
  }
}
</style>
