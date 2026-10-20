<script setup lang="ts">
/**
 * 数据备份与恢复（页面蓝图 §14）
 *
 * 导出：是否包含凭据（勾选需二次确认）；Web 触发下载，Android 走 `exportToFile` + 系统分享。
 * 导入：选择 JSON → `backupService.parseBackup` 校验 → 预览计数 → 合并/覆盖（覆盖需二次确认）。
 */
import { computed, ref } from 'vue';

import type { BackupFile, BackupMode } from '@/types';
import { formatDateStamp } from '@/shared/time';

import AppHeader from '@/components/layout/AppHeader.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { backupService } from '@/services/backupService';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { isNative } from '@/shared/platform';
import { toErrorShape } from '@/shared/errors';

const sources = useSourceStore();
const favorites = useFavoriteStore();
const history = useHistoryStore();
const toast = useToast();
const ui = useUiStore();

const includeCredentials = ref(false);
const exporting = ref(false);
const importing = ref(false);
const importMode = ref<BackupMode>('merge');
const fileInputRef = ref<HTMLInputElement | null>(null);
const selectedFile = ref<File | null>(null);
const parsed = ref<BackupFile | null>(null);
const parseError = ref<string | null>(null);
const parsing = ref(false);
const lastExportName = ref<string | null>(null);

const modeOptions = [
  { value: 'merge', label: '合并' },
  { value: 'overwrite', label: '覆盖' },
];

const previewCounts = computed(() => {
  const b = parsed.value;
  if (!b) return null;
  return {
    sources: b.sources.length,
    favorites: b.favorites.length,
    history: b.history.length,
    downloads: b.downloads.length,
    settings: b.settings !== null,
    schemaVersion: b.schemaVersion,
    exportedAt: b.exportedAt,
  };
});

async function onToggleCredentials(next: boolean): Promise<void> {
  if (!next) {
    includeCredentials.value = false;
    return;
  }
  const ok = await ui.confirm({
    title: '包含密码与 Token？',
    message: '勾选后凭据会以明文写入备份文件，请妥善保管，不要上传到公共位置。',
    confirmText: '仍然包含',
    danger: true,
  });
  includeCredentials.value = ok;
}

async function exportBackup(): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
  const fileName = `peanutmov-backup-${formatDateStamp()}.json`;
  try {
    if (isNative()) {
      // Android：写入 App 数据目录后调起系统分享（API-13 exportToFile）
      const result = await backupService.exportToFile({
        includeCredentials: includeCredentials.value,
        fileName,
      });
      lastExportName.value = result.fileName;
      toast.success(`已导出 ${result.fileName}`);
    } else {
      const blob = await backupService.exportData({ includeCredentials: includeCredentials.value });
      lastExportName.value = fileName;
      triggerDownload(blob, fileName);
      toast.success(`已导出 ${fileName}`);
    }
  } catch (e) {
    toast.error(toErrorShape(e, 'E_DB').message);
  } finally {
    exporting.value = false;
  }
}

function triggerDownload(blob: Blob, fileName: string): void {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // 无 DOM 下载能力（部分 WebView）：退化为提示用户使用 App 导出
    toast.info('当前环境不支持直接下载，请在 Android App 内导出');
  }
}

function openFilePicker(): void {
  fileInputRef.value?.click();
}

async function onFileChange(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;

  parseError.value = null;
  parsed.value = null;
  selectedFile.value = file;
  parsing.value = true;
  try {
    if (!/\.json$/i.test(file.name)) {
      parseError.value = '备份文件格式不支持（仅支持 .json）';
      return;
    }
    // backupService.parseBackup 负责空文件/非 JSON/不支持的 schemaVersion（E_VERSION_UNSUPPORTED）
    parsed.value = await backupService.parseBackup(file);
  } catch (e) {
    parseError.value = toErrorShape(e, 'E_PARSE').message;
  } finally {
    parsing.value = false;
  }
}

async function startImport(): Promise<void> {
  if (!parsed.value) return;
  if (importMode.value === 'overwrite') {
    const ok = await ui.confirm({
      title: '覆盖现有数据？',
      message: `将删除现有的 ${sources.sources.length} 个源、${favorites.items.length} 条收藏、${history.items.length} 条历史，然后导入备份内容。`,
      confirmText: '覆盖导入',
      danger: true,
    });
    if (!ok) return;
  }
  importing.value = true;
  try {
    const report = await backupService.importData(parsed.value, importMode.value);
    // 导入后刷新相关 Store（sourceStore/historyStore/favoriteStore 也订阅了事件，这里显式刷新保证 UI 立刻反映）
    await Promise.all([sources.load(), favorites.load(), history.load()]);
    toast.success(
      `已导入 源${report.sources}/收藏${report.favorites}/历史${report.history}` +
        (report.settingsRestored ? '（含设置）' : ''),
    );
    parsed.value = null;
    selectedFile.value = null;
  } catch (e) {
    toast.error(`导入失败，未导入任何数据：${toErrorShape(e, 'E_DB').message}`);
  } finally {
    importing.value = false;
  }
}

</script>

<template>
  <main class="backup-page" data-route="backup">
    <AppHeader title="数据备份与恢复" back />

    <div class="backup-body">
      <section class="backup-section">
        <h2 class="backup-section__title">导出</h2>
        <p class="backup-section__desc">
          将源配置、收藏、历史、设置与下载任务元数据导出为 JSON 文件（不含视频文件）。
        </p>

        <div class="backup-toggle">
          <div class="backup-toggle__texts">
            <span class="backup-toggle__label">包含密码与 Token</span>
            <span class="backup-toggle__warn">勾选后凭据将以明文写入备份文件</span>
          </div>
          <ToggleSwitch
            :model-value="includeCredentials"
            label="包含密码与 Token"
            @update:model-value="onToggleCredentials"
          />
        </div>

        <button class="btn btn--primary btn--lg" type="button" :disabled="exporting" @click="exportBackup">
          <LoadingSpinner v-if="exporting" :size="16" />
          {{ exporting ? '正在导出…' : '导出备份文件' }}
        </button>
        <p v-if="lastExportName" class="backup-hint">已导出：{{ lastExportName }}</p>
      </section>

      <section class="backup-section">
        <h2 class="backup-section__title">导入</h2>

        <button class="backup-dropzone" type="button" :disabled="parsing" @click="openFilePicker">
          <LoadingSpinner v-if="parsing" :size="20" />
          <template v-else>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M6 3.6h8l4 4v12.8H6z" />
              <path d="M14 3.6v4h4" />
              <path d="M12 16v-5M9.5 13.5 12 11l2.5 2.5" />
            </svg>
            <span>选择备份 JSON 文件</span>
            <span class="backup-dropzone__hint">仅支持本 App 导出的备份文件</span>
          </template>
        </button>
        <input
          ref="fileInputRef"
          class="backup-file-input"
          type="file"
          accept=".json,application/json"
          @change="onFileChange"
        />

        <p v-if="selectedFile" class="backup-hint">已选择：{{ selectedFile.name }}</p>
        <p v-if="parseError" class="backup-error" role="alert">{{ parseError }}</p>

        <div v-if="previewCounts" class="backup-preview">
          <p class="backup-preview__line">
            源 {{ previewCounts.sources }} · 收藏 {{ previewCounts.favorites }} · 历史
            {{ previewCounts.history }} · 下载 {{ previewCounts.downloads }}
          </p>
          <p class="backup-preview__sub">
            schemaVersion {{ previewCounts.schemaVersion }} ·
            导出于 {{ previewCounts.exportedAt ? new Date(previewCounts.exportedAt).toLocaleString('zh-CN') : '未知时间' }}
          </p>
        </div>

        <div class="backup-mode">
          <span class="backup-mode__label">导入方式</span>
          <SegmentedControl
            :model-value="importMode"
            :options="modeOptions"
            label="导入方式"
            @update:model-value="importMode = $event === 'overwrite' ? 'overwrite' : 'merge'"
          />
        </div>

        <button
          class="btn btn--primary btn--lg"
          type="button"
          :disabled="!parsed || importing"
          @click="startImport"
        >
          <LoadingSpinner v-if="importing" :size="16" />
          {{ importing ? '正在导入…' : '开始导入' }}
        </button>
      </section>

      <section class="backup-notes">
        <h2 class="backup-section__title">说明</h2>
        <ul class="backup-notes__list">
          <li>备份不含视频文件与下载内容，仅含任务元数据。</li>
          <li>覆盖模式会删除现有源、收藏与历史，操作前建议先导出一次。</li>
          <li>备份文件保存在本机，不上传服务器。</li>
        </ul>
      </section>
    </div>
  </main>
</template>

<style scoped>
.backup-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.backup-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.backup-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-4);
}

.backup-section + .backup-section {
  margin-top: var(--space-5);
  border-top: var(--border-default);
}

.backup-section__title {
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.backup-section__desc {
  font: var(--text-label);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.backup-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  min-height: 56px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.backup-toggle__texts {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.backup-toggle__label {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.backup-toggle__warn {
  font: var(--text-caption);
  color: var(--color-warning);
}

.backup-hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.backup-error {
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
  font: var(--text-label);
}

.backup-dropzone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: 120px;
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  border: 1.5px dashed var(--color-border-strong);
  background-color: var(--color-bg-surface);
  color: var(--color-text-primary);
  font: var(--text-label-strong);
}

.backup-dropzone svg {
  width: 28px;
  height: 28px;
  color: var(--color-text-tertiary);
  margin-bottom: var(--space-1);
}

.backup-dropzone__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.backup-file-input {
  display: none;
}

.backup-preview {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.backup-preview__line {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.backup-preview__sub {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.backup-mode {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.backup-mode__label {
  font: var(--text-label-strong);
  color: var(--color-text-secondary);
}

.backup-notes {
  margin-top: var(--space-6);
  padding-top: var(--space-4);
  border-top: var(--border-default);
}

.backup-notes__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-left: var(--space-4);
  list-style: disc;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}
</style>
