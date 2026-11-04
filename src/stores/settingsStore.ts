/**
 * 设置 Store（API-14）
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { settingsService } from '@/services/settingsService';
import { appEvents } from '@/services/events';
import { COMPLIANCE_VERSION } from '@/shared/constants';
import { toErrorShape } from '@/shared/errors';
import type { AppErrorShape, AppSettings, DeepPartial } from '@/types';

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings | null>(null);
  const ready = ref(false);
  const error = ref<AppErrorShape | null>(null);

  const theme = computed(() => settings.value?.theme ?? 'dark');
  const player = computed(() => settings.value?.player ?? null);
  const gesture = computed(() => settings.value?.gesture ?? null);
  const download = computed(() => settings.value?.download ?? null);
  const netdisk = computed(() => settings.value?.netdisk ?? { quality: 'auto', threadCount: 4 });

  let unsubscribe: (() => void) | null = null;

  async function load(): Promise<void> {
    if (ready.value && settings.value) return;
    try {
      settings.value = await settingsService.get();
      ready.value = true;
      error.value = null;
      if (!unsubscribe) {
        unsubscribe = appEvents.on('settings:changed', () => {
          void reload();
        });
      }
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      ready.value = false;
    }
  }

  async function reload(): Promise<void> {
    try {
      settings.value = await settingsService.get();
      ready.value = true;
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
    }
  }

  async function update(patch: DeepPartial<AppSettings>): Promise<void> {
    settings.value = await settingsService.update(patch);
    ready.value = true;
    error.value = null;
  }

  async function acceptCompliance(): Promise<void> {
    await settingsService.acceptCompliance(COMPLIANCE_VERSION);
    await reload();
  }

  async function resetAllData(keepDemo: boolean): Promise<void> {
    await settingsService.resetAllData({ keepDemo });
    await reload();
  }

  function $dispose(): void {
    unsubscribe?.();
    unsubscribe = null;
  }

  return {
    settings,
    ready,
    error,
    theme,
    player,
    gesture,
    download,
    netdisk,
    load,
    update,
    acceptCompliance,
    resetAllData,
    $dispose,
  };
});

export type SettingsStore = ReturnType<typeof useSettingsStore>;
