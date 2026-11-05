<script setup lang="ts">
/**
 * 数据备份与恢复（页面蓝图 §14）
 *
 * 导出：是否包含凭据（勾选需二次确认）；Web 触发下载，Android 走 `exportToFile` + 系统分享。
 * 导入：选择 JSON → `backupService.parseBackup` 校验 → 预览计数 → 合并/覆盖（覆盖需二次确认）。
 *
 * 功能扩展-4：WebDAV 云备份
 * - 配置 WebDAV 服务器（坚果云/Nextcloud 等）
 * - 上传备份到云端
 * - 从云端下载并导入备份
 */
import { computed, onMounted, ref } from 'vue';

import type { BackupFile, BackupMode } from '@/types';
import type { WebDAVConfig, WebDAVFileEntry } from '@/services/webdavService';
import { formatDateStamp } from '@/shared/time';

import AppHeader from '@/components/layout/AppHeader.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { backupService, normalizeBackupFile } from '@/services/backupService';
import { WebDAVClient, validateWebDAVConfig } from '@/services/webdavService';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { isNative } from '@/shared/platform';
import { AppError, toErrorShape } from '@/shared/errors';
import { settingsService } from '@/services/settingsService';

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

// WebDAV 状态
const webdavConfig = ref<WebDAVConfig>({
  serverUrl: '',
  username: '',
  password: '',
  backupPath: '/PeanutMov/backups',
});
const webdavConnected = ref(false);
const webdavTesting = ref(false);
const webdavSaving = ref(false);
const webdavUploading = ref(false);
const webdavDownloading = ref(false);
const webdavFiles = ref<WebDAVFileEntry[]>([]);
const webdavLoadingFiles = ref(false);
const webdavClient = ref<WebDAVClient | null>(null);
const showWebdavConfig = ref(false);

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
      if (blob.size === 0) throw new AppError('E_INVALID_STATE', '备份内容为空，未生成文件');
      const ok = triggerDownload(blob, fileName);
      lastExportName.value = ok ? fileName : lastExportName.value;
      if (ok) toast.success(`已导出 ${fileName}（${formatBytes(blob.size)}）`);
      else toast.error('浏览器阻止了文件下载，请允许本站下载后重试');
    }
  } catch (e) {
    // 导出失败（DB 读取 / 序列化 / 下载被拒）必须可见，不能静默吞掉
    toast.error(`导出失败：${toErrorShape(e, 'E_DB').message}`);
  } finally {
    exporting.value = false;
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 触发真实文件下载（Web）。
 *
 * 要点（`/settings/backup` E2E 曾报「下载目录无 JSON」的排查结论）：
 * - Blob MIME 必须是 `application/json`（导出服务已保证），此处再兜底一次；
 * - `<a download>` 必须挂到文档里才会被浏览器接管，`display:none` 只是让它不可见；
 * - **不能立刻 `revokeObjectURL`**：下载是异步读取 Blob 的，过早回收可能得到空文件/中断，
 *   这里延后到 60s，且期间不移除节点；
 * - 返回是否真的触发了点击，失败时由调用方明确提示（不伪造成功）。
 *
 * 注：headless Chrome 落盘还取决于 CDP `Browser.setDownloadBehavior` 的 `browserContextId`
 * 作用域，与本函数无关（详见自测记录 BUG-05）。
 */
function triggerDownload(blob: Blob, fileName: string): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const payload =
    blob.type === 'application/json' ? blob : new Blob([blob], { type: 'application/json;charset=utf-8' });
  const href = URL.createObjectURL(payload);

  const a = document.createElement('a');
  a.href = href;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  try {
    document.body.appendChild(a);
    a.click();
  } catch {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(href);
    return false;
  }
  // 留在 DOM 中直到下载被浏览器接管（headless/慢磁盘下立刻移除会丢下载）
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(href);
  }, 60_000);
  return true;
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

// ========== WebDAV 云备份 ==========

/** 加载保存的 WebDAV 配置 */
async function loadWebDAVConfig(): Promise<void> {
  try {
    const settings = await settingsService.get();
    const webdav = settings.webdav;
    if (webdav?.serverUrl && webdav?.username) {
      webdavConfig.value = {
        serverUrl: webdav.serverUrl,
        username: webdav.username,
        password: webdav.password || '',
        backupPath: webdav.backupPath || '/PeanutMov/backups',
      };
      // 自动测试连接
      await testWebDAVConnection();
    }
  } catch {
    // 配置读取失败不影响本地备份功能
  }
}

/** 保存 WebDAV 配置 */
async function saveWebDAVConfig(): Promise<void> {
  if (webdavSaving.value) return;
  webdavSaving.value = true;
  try {
    await settingsService.update({
      webdav: {
        serverUrl: webdavConfig.value.serverUrl,
        username: webdavConfig.value.username,
        password: webdavConfig.value.password,
        backupPath: webdavConfig.value.backupPath,
      },
    });
    toast.success('WebDAV 配置已保存');
  } catch (e) {
    toast.error(`保存失败：${toErrorShape(e).message}`);
  } finally {
    webdavSaving.value = false;
  }
}

/** 测试 WebDAV 连接 */
async function testWebDAVConnection(): Promise<void> {
  if (webdavTesting.value) return;
  webdavTesting.value = true;
  try {
    const result = await validateWebDAVConfig(webdavConfig.value);
    if (result.valid) {
      webdavConnected.value = true;
      webdavClient.value = new WebDAVClient(webdavConfig.value);
      toast.success('WebDAV 连接成功');
    } else {
      webdavConnected.value = false;
      webdavClient.value = null;
      toast.error(result.error || '连接失败');
    }
  } catch (e) {
    webdavConnected.value = false;
    toast.error(`连接失败：${toErrorShape(e).message}`);
  } finally {
    webdavTesting.value = false;
  }
}

/** 上传备份到 WebDAV */
async function uploadToWebDAV(): Promise<void> {
  if (webdavUploading.value || !webdavClient.value) return;
  webdavUploading.value = true;
  try {
    // 确保远程目录存在
    await webdavClient.value.ensureDirectory(webdavConfig.value.backupPath);

    // 生成备份内容
    const blob = await backupService.exportData({ includeCredentials: includeCredentials.value });
    const fileName = `peanutmov-backup-${formatDateStamp()}.json`;
    const remotePath = `${webdavConfig.value.backupPath}/${fileName}`;

    // 上传
    await webdavClient.value.uploadFile(remotePath, blob, 'application/json');
    toast.success(`已上传到云端：${fileName}`);

    // 刷新文件列表
    await loadWebDAVFiles();
  } catch (e) {
    toast.error(`上传失败：${toErrorShape(e).message}`);
  } finally {
    webdavUploading.value = false;
  }
}

/** 加载 WebDAV 备份文件列表 */
async function loadWebDAVFiles(): Promise<void> {
  if (webdavLoadingFiles.value || !webdavClient.value) return;
  webdavLoadingFiles.value = true;
  try {
    const files = await webdavClient.value.listDirectory();
    webdavFiles.value = files
      .filter((f) => !f.isDirectory && f.name.endsWith('.json'))
      .sort((a, b) => b.lastModified - a.lastModified);
  } catch (e) {
    toast.error(`加载文件列表失败：${toErrorShape(e).message}`);
  } finally {
    webdavLoadingFiles.value = false;
  }
}

/** 从 WebDAV 下载并导入备份 */
async function downloadFromWebDAV(file: WebDAVFileEntry): Promise<void> {
  if (webdavDownloading.value || !webdavClient.value) return;

  const ok = await ui.confirm({
    title: '从云端导入？',
    message: `将下载 "${file.name}" 并按当前导入方式（${importMode.value === 'overwrite' ? '覆盖' : '合并'}）导入数据。`,
    confirmText: '下载并导入',
  });
  if (!ok) return;

  webdavDownloading.value = true;
  try {
    const blob = await webdavClient.value.downloadFile(`${webdavConfig.value.backupPath}/${file.name}`);
    const text = await blob.text();
    const raw = JSON.parse(text);
    const backupFile = normalizeBackupFile(raw);

    // 复用导入逻辑
    const report = await backupService.importData(backupFile, importMode.value);
    await Promise.all([sources.load(), favorites.load(), history.load()]);
    toast.success(
      `已导入 源${report.sources}/收藏${report.favorites}/历史${report.history}` +
        (report.settingsRestored ? '（含设置）' : ''),
    );
  } catch (e) {
    toast.error(`下载失败：${toErrorShape(e).message}`);
  } finally {
    webdavDownloading.value = false;
  }
}

/** 删除云端备份文件 */
async function deleteWebDAVFile(file: WebDAVFileEntry): Promise<void> {
  if (!webdavClient.value) return;

  const ok = await ui.confirm({
    title: '删除云端备份？',
    message: `将永久删除 "${file.name}"，此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;

  try {
    await webdavClient.value.deleteFile(`${webdavConfig.value.backupPath}/${file.name}`);
    toast.success('已删除');
    await loadWebDAVFiles();
  } catch (e) {
    toast.error(`删除失败：${toErrorShape(e).message}`);
  }
}

function formatWebDAVFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWebDAVFileDate(timestamp: number): string {
  if (!timestamp) return '未知';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

onMounted(() => {
  void loadWebDAVConfig();
});

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

      <!-- WebDAV 云备份 -->
      <section class="backup-section backup-webdav">
        <div class="backup-webdav__header">
          <h2 class="backup-section__title">WebDAV 云备份</h2>
          <span v-if="webdavConnected" class="backup-webdav__status backup-webdav__status--connected">
            已连接
          </span>
          <span v-else class="backup-webdav__status backup-webdav__status--disconnected">
            未连接
          </span>
        </div>
        <p class="backup-section__desc">
          将备份上传到 WebDAV 云盘（坚果云、Nextcloud 等），实现跨设备同步。
        </p>

        <!-- 配置折叠 -->
        <button
          class="backup-webdav__toggle"
          type="button"
          @click="showWebdavConfig = !showWebdavConfig"
        >
          <span>{{ showWebdavConfig ? '收起配置' : '展开 WebDAV' }}</span>
          <span class="backup-webdav__arrow" :class="{ 'backup-webdav__arrow--open': showWebdavConfig }">›</span>
        </button>

        <div v-if="showWebdavConfig" class="backup-webdav__config">
          <div class="backup-webdav__field">
            <label class="backup-webdav__label" for="webdav-server">服务器地址</label>
            <input
              id="webdav-server"
              v-model="webdavConfig.serverUrl"
              class="backup-webdav__input"
              type="url"
              placeholder="https://dav.jianguoyun.com/dav/"
              autocomplete="url"
            />
          </div>
          <div class="backup-webdav__field">
            <label class="backup-webdav__label" for="webdav-user">用户名</label>
            <input
              id="webdav-user"
              v-model="webdavConfig.username"
              class="backup-webdav__input"
              type="text"
              placeholder="your@email.com"
              autocomplete="username"
            />
          </div>
          <div class="backup-webdav__field">
            <label class="backup-webdav__label" for="webdav-pass">密码/应用密钥</label>
            <input
              id="webdav-pass"
              v-model="webdavConfig.password"
              class="backup-webdav__input"
              type="password"
              placeholder="••••••••"
              autocomplete="current-password"
            />
          </div>
          <div class="backup-webdav__field">
            <label class="backup-webdav__label" for="webdav-path">备份目录</label>
            <input
              id="webdav-path"
              v-model="webdavConfig.backupPath"
              class="backup-webdav__input"
              type="text"
              placeholder="/PeanutMov/backups"
            />
          </div>
          <div class="backup-webdav__actions">
            <button
              class="btn btn--secondary btn--md"
              type="button"
              :disabled="webdavTesting || !webdavConfig.serverUrl || !webdavConfig.username"
              @click="testWebDAVConnection"
            >
              <LoadingSpinner v-if="webdavTesting" :size="14" />
              {{ webdavTesting ? '测试中…' : '测试连接' }}
            </button>
            <button
              class="btn btn--primary btn--md"
              type="button"
              :disabled="webdavSaving"
              @click="saveWebDAVConfig"
            >
              {{ webdavSaving ? '保存…' : '保存配置' }}
            </button>
          </div>
        </div>

        <!-- 云端操作 -->
        <div v-if="webdavConnected" class="backup-webdav__cloud">
          <div class="backup-webdav__cloud-actions">
            <button
              class="btn btn--primary btn--md"
              type="button"
              :disabled="webdavUploading"
              @click="uploadToWebDAV"
            >
              <LoadingSpinner v-if="webdavUploading" :size="14" />
              {{ webdavUploading ? '上传中…' : '上传到云端' }}
            </button>
            <button
              class="btn btn--secondary btn--md"
              type="button"
              :disabled="webdavLoadingFiles"
              @click="loadWebDAVFiles"
            >
              刷新列表
            </button>
          </div>

          <!-- 云端文件列表 -->
          <div v-if="webdavLoadingFiles" class="backup-webdav__loading">
            <LoadingSpinner :size="16" />
            <span>加载云端备份…</span>
          </div>
          <div v-else-if="webdavFiles.length === 0" class="backup-webdav__empty">
            云端暂无备份文件
          </div>
          <ul v-else class="backup-webdav__file-list">
            <li v-for="file in webdavFiles" :key="file.href" class="backup-webdav__file">
              <div class="backup-webdav__file-info">
                <span class="backup-webdav__file-name">{{ file.name }}</span>
                <span class="backup-webdav__file-meta">
                  {{ formatWebDAVFileSize(file.size) }} · {{ formatWebDAVFileDate(file.lastModified) }}
                </span>
              </div>
              <div class="backup-webdav__file-actions">
                <button
                  class="btn btn--secondary btn--sm"
                  type="button"
                  :disabled="webdavDownloading"
                  @click="downloadFromWebDAV(file)"
                >
                  导入
                </button>
                <button
                  class="btn btn--ghost btn--sm backup-webdav__delete"
                  type="button"
                  @click="deleteWebDAVFile(file)"
                >
                  删除
                </button>
              </div>
            </li>
          </ul>
        </div>
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

/* ========== WebDAV 云备份 ========== */
.backup-webdav {
  margin-top: var(--space-6);
}

.backup-webdav__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.backup-webdav__status {
  font: var(--text-caption);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}

.backup-webdav__status--connected {
  background-color: rgba(40, 160, 80, 0.15);
  color: var(--color-success);
}

.backup-webdav__status--disconnected {
  background-color: var(--color-bg-skeleton);
  color: var(--color-text-tertiary);
}

.backup-webdav__toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 40px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  font: var(--text-label);
  color: var(--color-brand-text);
  margin-top: var(--space-2);
}

.backup-webdav__arrow {
  font-size: 16px;
  transition: transform var(--duration-fast);
}

.backup-webdav__arrow--open {
  transform: rotate(90deg);
}

.backup-webdav__config {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.backup-webdav__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.backup-webdav__label {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.backup-webdav__input {
  width: 100%;
  min-height: 40px;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-base);
  border: var(--border-default);
  font: var(--text-label);
  color: var(--color-text-primary);
}

.backup-webdav__input:focus {
  outline: none;
  border-color: var(--color-brand);
  box-shadow: 0 0 0 2px rgba(var(--color-brand-rgb, 40, 160, 80), 0.2);
}

.backup-webdav__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.backup-webdav__cloud {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.backup-webdav__cloud-actions {
  display: flex;
  gap: var(--space-3);
}

.backup-webdav__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.backup-webdav__empty {
  padding: var(--space-4);
  text-align: center;
  font: var(--text-label);
  color: var(--color-text-tertiary);
  background-color: var(--color-bg-surface);
  border-radius: var(--radius-md);
}

.backup-webdav__file-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: 0;
}

.backup-webdav__file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  background-color: var(--color-bg-surface);
  border-radius: var(--radius-md);
  border: var(--border-default);
}

.backup-webdav__file-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}

.backup-webdav__file-name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backup-webdav__file-meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.backup-webdav__file-actions {
  display: flex;
  gap: var(--space-2);
  flex: 0 0 auto;
}

.backup-webdav__delete {
  color: var(--color-danger);
}
</style>
