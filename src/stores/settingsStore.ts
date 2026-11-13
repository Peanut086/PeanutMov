/**
 * 设置 Store（API-14）
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { settingsService } from '@/services/settingsService';
import { appEvents } from '@/services/events';
import { COMPLIANCE_VERSION } from '@/shared/constants';
import { toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type {
  AppErrorShape,
  AppSettings,
  BackupSettings,
  DeepPartial,
  NetdiskSettings,
} from '@/types';

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings | null>(null);
  const ready = ref(false);
  const error = ref<AppErrorShape | null>(null);

  const theme = computed(() => settings.value?.theme ?? 'system');
  const player = computed(() => settings.value?.player ?? null);
  const gesture = computed(() => settings.value?.gesture ?? null);
  const download = computed(() => settings.value?.download ?? null);
  const netdisk = computed((): NetdiskSettings => settings.value?.netdisk ?? { quality: 'auto', threadCount: 4 });
  /** EXT-05：备份增强设置（缺省时给关闭态兜底，避免页面读到 undefined） */
  const backup = computed(
    (): BackupSettings =>
      settings.value?.backup ?? {
        scheduleMode: 'off',
        scheduleHour: 3,
        scheduleWeekday: 1,
        retentionCount: 5,
        encryptionEnabled: false,
        encryptionSalt: null,
        encryptionVerifier: null,
        lastScheduledAt: null,
        lastBackupAt: null,
        lastError: null,
      },
  );

  let unsubscribe: (() => void) | null = null;
  let backupSchedulerBootstrapped = false;

  /** 彩蛋池总开关（缺省开）：NG 场记板 / 爆米花桶里程碑都受它 gate */
  const easterEggsEnabled = computed(() => settings.value?.easterEggsEnabled ?? true);

  /**
   * EXT-05：借 App 启动（`App.vue` 在 onMounted 调 `load()`）拉起备份调度器。
   *
   * 之所以放在这里：`main.ts` / `stores/bootstrap.ts` 不在本任务允许修改的文件范围内，
   * 而调度器必须"App 一启动就生效"才能补执行漏跑的定时备份。
   * 用动态 import + 捕获异常，调度器不可用不影响设置加载。
   */
  function bootstrapBackupScheduler(): void {
    if (backupSchedulerBootstrapped) return;
    backupSchedulerBootstrapped = true;
    void import('@/services/backupScheduler')
      .then((mod) => mod.startBackupScheduler())
      .catch((e: unknown) => {
        logger.warn('备份调度器启动失败（不影响设置与手动备份）', e);
      });
  }

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
      bootstrapBackupScheduler();
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

  /** EXT-05：局部更新备份设置（定时模式 / 保留数量等） */
  async function updateBackup(patch: Partial<BackupSettings>): Promise<void> {
    // `AppSettings.backup` 不参与 DeepPartial 展开，这里显式合并后整体写回
    await update({ backup: { ...backup.value, ...patch } });
  }

  async function acceptCompliance(): Promise<void> {
    await settingsService.acceptCompliance(COMPLIANCE_VERSION);
    await reload();
  }

  /**
   * 不阻塞交互的设置写入：调用方不等落盘，但失败必须出声。
   *
   * 页面上大量 `void settings.update(...)` 把拒绝吞掉了——滑块/开关看起来已经改好，
   * 实际什么都没存。这里统一走数据层 → Toast 的既有桥接通道（`bindAppToasts`）。
   */
  function updateNonBlocking(patch: DeepPartial<AppSettings>): void {
    void update(patch).catch((e: unknown) => {
      const shape = toErrorShape(e, 'E_DB');
      error.value = shape;
      appEvents.emit('toast', { text: shape.message, type: 'error' });
    });
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
    backup,
    easterEggsEnabled,
    load,
    update,
    updateBackup,
    updateNonBlocking,
    acceptCompliance,
    resetAllData,
    $dispose,
  };
});

export type SettingsStore = ReturnType<typeof useSettingsStore>;
