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
 *
 * EXT-05 phase1：定时备份 + 版本保留 + 加密备份
 * - 定时：off/daily/weekly + 整点小时，静默执行；App 未运行时由原生提醒 + 下次启动补执行
 * - 保留：最近 N 份（1-20），`backup_YYYYMMDD_HHmmss.json|.enc`，超出自动清理（本机/云端分别保留）
 * - 加密：AES-256-GCM + PBKDF2，密码不落盘；恢复 `.enc` 备份需重新输入密码
 * - 既有的手动导出 / 导入 / WebDAV 上传逻辑保持原样，新功能只新增区块
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';

import type { BackupFile, BackupImportReport, BackupMode, BackupRecord, BackupSettings } from '@/types';
import type { WebDAVConfig, WebDAVFileEntry } from '@/services/webdavService';
import { formatDateStamp, formatRelativeTime } from '@/shared/time';

import AppHeader from '@/components/layout/AppHeader.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import BackupScheduleSettings from '@/components/backup/BackupScheduleSettings.vue';
import BackupEncryptionSettings from '@/components/backup/BackupEncryptionSettings.vue';
import {
  backupService,
  disableBackupEncryption,
  ensureBackupEncryptionKey,
  normalizeBackupFile,
  setupBackupEncryption,
} from '@/services/backupService';
import { describeNextRun, startBackupScheduler } from '@/services/backupScheduler';
import { WebDAVClient, validateWebDAVConfig } from '@/services/webdavService';
import { appEvents } from '@/services/events';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { isNative } from '@/shared/platform';
import { AppError, toErrorShape } from '@/shared/errors';
import { settingsService } from '@/services/settingsService';

const sources = useSourceStore();
const favorites = useFavoriteStore();
const history = useHistoryStore();
const settings = useSettingsStore();
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

// ========== EXT-05：定时 / 版本保留 / 加密 ==========
const backupSettings = computed((): BackupSettings => settings.backup);

/** 每分钟推进一次"下次定时备份"的相对时间（interval 在 onUnmounted 清理） */
const nowTick = ref(Date.now());
const nextRunText = computed(() => describeNextRun(backupSettings.value, nowTick.value));

/** 本机是否缓存了派生密钥（决定定时加密备份能否无人值守） */
const keyReady = ref(false);
/** 受管理备份列表（本机 + 云端） */
const records = ref<BackupRecord[]>([]);
const listLoading = ref(false);
const listError = ref<string | null>(null);
const scheduleBusy = ref(false);
const encryptionBusy = ref(false);
/** 正在执行的备份目标（null = 空闲） */
const backingUp = ref<'local' | 'webdav' | null>(null);
const deletingId = ref<string | null>(null);
const restoringId = ref<string | null>(null);
/** 正在恢复的记录（非空时展示恢复面板） */
const restoreTarget = ref<BackupRecord | null>(null);
const restorePassword = ref('');
const restoreError = ref<string | null>(null);

let tickTimer: ReturnType<typeof setInterval> | null = null;
let unsubscribeSettings: (() => void) | null = null;

const lastBackupText = computed(() => {
  const at = backupSettings.value.lastBackupAt;
  if (typeof at !== 'number' || at <= 0) return '从未备份';
  return `${formatRelativeTime(at, nowTick.value)}（${formatBackupTime(at)}）`;
});

const previewCounts = computed(() => {
  const b = parsed.value;
  if (!b) return null;
  return {
    sources: b.sources.length,
    favorites: b.favorites.length,
    history: b.history.length,
    downloads: b.downloads.length,
    lives: b.lives.length,
    epgSources: b.epgSources.length,
    channelPrefs: b.channelPrefs.length,
    reminders: b.reminders.length,
    settings: b.settings !== null,
    schemaVersion: b.schemaVersion,
    exportedAt: b.exportedAt,
  };
});

/** 导入/恢复结果文案：直播域为 0 时不占位，避免旧备份显示一串 0 */
function reportText(report: BackupImportReport, prefix: string): string {
  const live = [
    report.lives > 0 ? `直播源${report.lives}` : '',
    report.epgSources > 0 ? `EPG源${report.epgSources}` : '',
    report.channelPrefs > 0 ? `频道分组${report.channelPrefs}` : '',
    report.reminders > 0 ? `提醒${report.reminders}` : '',
  ].filter(Boolean);
  return (
    `${prefix} 源${report.sources}/收藏${report.favorites}/历史${report.history}` +
    (live.length > 0 ? `/${live.join('/')}` : '') +
    (report.settingsRestored ? '（含设置）' : '')
  );
}

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
    toast.success(reportText(report, '已导入'));
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
    toast.success(reportText(report, '已导入'));
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

// ========== EXT-05：定时备份 / 版本保留 / 加密 ==========

function formatBackupTime(timestamp: number): string {
  if (!timestamp) return '未知时间';
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 加载受管理备份列表（空列表属正常态，由模板展示空状态） */
async function loadManagedBackups(): Promise<void> {
  listLoading.value = true;
  listError.value = null;
  try {
    records.value = await backupService.listBackups();
  } catch (e) {
    listError.value = toErrorShape(e, 'E_DB').message;
  } finally {
    listLoading.value = false;
  }
}

/** 探测本机派生密钥是否存在（读失败按"未就绪"处理，不阻断页面） */
async function refreshKeyReady(): Promise<void> {
  try {
    keyReady.value = (await ensureBackupEncryptionKey()) !== null;
  } catch {
    keyReady.value = false;
  }
}

/** 定时设置变更：落盘 → 重排原生提醒 → 刷新"下次备份"文案 */
async function onScheduleChange(patch: Partial<BackupSettings>): Promise<void> {
  if (scheduleBusy.value) return;
  scheduleBusy.value = true;
  try {
    // 局部更新基于"当前完整备份设置"合并，未加载时先补齐，避免把默认值写回去
    if (!settings.ready) await settings.load();
    await settings.updateBackup(patch);
    nowTick.value = Date.now();
    // startBackupScheduler 幂等；设置变化后由调度器重算原生提醒时间
    await startBackupScheduler();
    toast.success('定时备份设置已保存');
  } catch (e) {
    toast.error(`保存定时设置失败：${toErrorShape(e).message}`);
  } finally {
    scheduleBusy.value = false;
  }
}

async function onEncryptionEnable(password: string): Promise<void> {
  if (encryptionBusy.value) return;
  encryptionBusy.value = true;
  try {
    await setupBackupEncryption(password);
    keyReady.value = true;
    toast.success('已启用加密备份，之后生成的备份为 .enc 文件');
  } catch (e) {
    toast.error(`启用加密失败：${toErrorShape(e).message}`);
  } finally {
    encryptionBusy.value = false;
  }
}

async function onEncryptionChange(password: string): Promise<void> {
  if (encryptionBusy.value) return;
  encryptionBusy.value = true;
  try {
    await setupBackupEncryption(password);
    keyReady.value = true;
    toast.success('加密密码已更新，旧 .enc 备份仍需原密码恢复');
  } catch (e) {
    toast.error(`修改密码失败：${toErrorShape(e).message}`);
  } finally {
    encryptionBusy.value = false;
  }
}

async function onEncryptionDisable(): Promise<void> {
  if (encryptionBusy.value) return;
  const ok = await ui.confirm({
    title: '关闭加密备份？',
    message: '关闭后新备份为未加密 JSON；已生成的 .enc 备份仍可用原密码恢复。',
    confirmText: '关闭加密',
    danger: true,
  });
  if (!ok) return;
  encryptionBusy.value = true;
  try {
    await disableBackupEncryption();
    keyReady.value = false;
    toast.success('已关闭加密备份');
  } catch (e) {
    toast.error(`关闭加密失败：${toErrorShape(e).message}`);
  } finally {
    encryptionBusy.value = false;
  }
}

/** 立即执行一次受管理备份（本机 / 云端），失败只提示不阻断页面 */
async function runManagedBackup(target: 'local' | 'webdav'): Promise<void> {
  if (backingUp.value) return;
  if (target === 'webdav' && !webdavConnected.value) {
    toast.error('请先连接 WebDAV 云盘');
    return;
  }
  backingUp.value = target;
  try {
    const result = await backupService.runBackup({
      source: 'manual',
      includeCredentials: includeCredentials.value,
      local: target === 'local',
      webdav: target === 'webdav',
    });
    const prunedText = result.pruned.length > 0 ? `，已清理 ${result.pruned.length} 个旧版本` : '';
    toast.success(`备份完成（${result.encrypted ? '已加密' : '未加密'}）${prunedText}`);
    await loadManagedBackups();
  } catch (e) {
    toast.error(`备份失败：${toErrorShape(e).message}`);
  } finally {
    backingUp.value = null;
  }
}

function startRestore(record: BackupRecord): void {
  restoreError.value = null;
  restorePassword.value = '';
  restoreTarget.value = record;
}

function cancelRestore(): void {
  restoreTarget.value = null;
  restorePassword.value = '';
  restoreError.value = null;
}

async function confirmRestore(): Promise<void> {
  const record = restoreTarget.value;
  if (!record || restoringId.value) return;
  const mode = importMode.value;
  if (mode === 'overwrite') {
    const ok = await ui.confirm({
      title: '覆盖现有数据？',
      message: '覆盖模式会先删除现有源、收藏与历史，再导入该备份内容。',
      confirmText: '覆盖恢复',
      danger: true,
    });
    if (!ok) return;
  }
  restoringId.value = record.id;
  restoreError.value = null;
  try {
    const report = await backupService.restoreBackup(record.id, {
      password: record.encrypted ? restorePassword.value.trim() : undefined,
      mode,
    });
    await Promise.all([sources.load(), favorites.load(), history.load()]);
    toast.success(reportText(report, `已从 ${record.fileName} 恢复`));
    cancelRestore();
  } catch (e) {
    // 加密备份密码错误等失败原因留在面板内明确提示，不清空上下文
    const message = toErrorShape(e).message;
    restoreError.value = message;
    toast.error(`恢复失败：${message}`);
  } finally {
    restoringId.value = null;
  }
}

async function onDeleteBackup(record: BackupRecord): Promise<void> {
  if (deletingId.value) return;
  const ok = await ui.confirm({
    title: '删除备份？',
    message: `将永久删除 ${record.fileName}（${record.location === 'webdav' ? '云端' : '本机'}），此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  deletingId.value = record.id;
  try {
    await backupService.deleteBackup(record.id);
    toast.success('已删除备份');
    await loadManagedBackups();
  } catch (e) {
    toast.error(`删除失败：${toErrorShape(e).message}`);
  } finally {
    deletingId.value = null;
  }
}

onMounted(() => {
  void loadWebDAVConfig();
  // 直接进入备份页（刷新/深链）时设置可能尚未加载，这里补齐
  void settings.load();
  void loadManagedBackups();
  void refreshKeyReady();
  // App 未运行期间的漏跑在启动/回到前台时补执行；失败不影响页面
  void startBackupScheduler().catch(() => undefined);
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 60_000);
  // 定时备份 / 改设置后同步刷新列表与密钥状态
  unsubscribeSettings = appEvents.on('settings:changed', () => {
    void refreshKeyReady();
    void loadManagedBackups();
  });
});

onUnmounted(() => {
  // 只清理本页面的定时器与订阅；调度器是 App 级单例（由 settingsStore 启动），
  // 在此停止会漏掉后台定时备份，因此不调用 stopBackupScheduler。
  if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  unsubscribeSettings?.();
  unsubscribeSettings = null;
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
          <p
            v-if="previewCounts.lives + previewCounts.epgSources + previewCounts.channelPrefs + previewCounts.reminders > 0"
            class="backup-preview__line"
          >
            直播源 {{ previewCounts.lives }} · EPG 源 {{ previewCounts.epgSources }} · 频道分组
            {{ previewCounts.channelPrefs }} · 节目提醒 {{ previewCounts.reminders }}
          </p>
          <p v-else class="backup-preview__sub">该备份不含直播域数据（旧版本导出）</p>
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

      <!-- EXT-05：定时备份 + 版本保留 -->
      <section class="backup-section backup-auto">
        <h2 class="backup-section__title">自动备份</h2>
        <p class="backup-section__desc">
          到点后静默执行，不弹窗打断操作；App 未运行时会在下次打开时补执行。超出保留数量的旧版本自动清理。
        </p>

        <BackupScheduleSettings
          :settings="backupSettings"
          :next-run-text="nextRunText"
          :last-error="backupSettings.lastError"
          :busy="scheduleBusy"
          @change="onScheduleChange"
        />

        <p class="backup-hint">上次备份：{{ lastBackupText }}</p>

        <div class="backup-auto__actions">
          <button
            class="btn btn--primary btn--md"
            type="button"
            :disabled="backingUp !== null"
            @click="runManagedBackup('local')"
          >
            <LoadingSpinner v-if="backingUp === 'local'" :size="14" />
            {{ backingUp === 'local' ? '备份中…' : '立即备份到本机' }}
          </button>
          <button
            class="btn btn--secondary btn--md"
            type="button"
            :disabled="backingUp !== null || !webdavConnected"
            @click="runManagedBackup('webdav')"
          >
            <LoadingSpinner v-if="backingUp === 'webdav'" :size="14" />
            {{ backingUp === 'webdav' ? '上传中…' : '备份到云端' }}
          </button>
        </div>
        <p class="backup-hint">
          文件名格式 backup_YYYYMMDD_HHmmss.json，开启加密后扩展名为 .enc；本机与云端分别保留最近
          {{ backupSettings.retentionCount }} 份。
        </p>
      </section>

      <!-- EXT-05：加密备份 -->
      <section class="backup-section backup-encrypt">
        <h2 class="backup-section__title">加密备份</h2>
        <p class="backup-section__desc">
          使用 AES-256-GCM 加密备份内容，密钥由密码经 PBKDF2 派生；密码不会保存，忘记密码将无法恢复加密备份。
        </p>
        <BackupEncryptionSettings
          :settings="backupSettings"
          :key-ready="keyReady"
          :busy="encryptionBusy"
          @enable="onEncryptionEnable"
          @change-password="onEncryptionChange"
          @disable="onEncryptionDisable"
        />
      </section>

      <!-- EXT-05：备份版本列表 -->
      <section class="backup-section backup-versions">
        <div class="backup-versions__header">
          <h2 class="backup-section__title">备份版本</h2>
          <button
            class="btn btn--ghost btn--sm"
            type="button"
            :disabled="listLoading"
            @click="loadManagedBackups"
          >
            刷新
          </button>
        </div>
        <p class="backup-section__desc">按时间倒序排列，包含本机与云端备份。</p>

        <div v-if="listLoading" class="backup-versions__hint">
          <LoadingSpinner :size="16" />
          <span>加载备份列表…</span>
        </div>
        <p v-else-if="listError" class="backup-error" role="alert">
          {{ listError }}
          <button class="btn btn--ghost btn--sm" type="button" @click="loadManagedBackups">重试</button>
        </p>
        <div v-else-if="records.length === 0" class="backup-versions__empty">
          暂无备份版本，点击上方「立即备份到本机」生成第一份。
        </div>
        <ul v-else class="backup-versions__list">
          <li v-for="record in records" :key="record.id" class="backup-version">
            <div class="backup-version__main">
              <div class="backup-version__title">
                <span class="backup-version__name">{{ record.fileName }}</span>
                <span
                  v-if="record.encrypted"
                  class="backup-version__lock"
                  role="img"
                  aria-label="已加密"
                  title="已加密（.enc）"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="5" y="10.5" width="14" height="9.5" rx="2" />
                    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
                  </svg>
                </span>
              </div>
              <span class="backup-version__meta">
                {{ formatBackupTime(record.timestamp) }} · {{ formatBytes(record.size) }} ·
                {{ record.source === 'scheduled' ? '定时' : '手动' }} ·
                {{ record.location === 'webdav' ? '云端' : '本机' }}
              </span>
            </div>
            <div class="backup-version__actions">
              <button
                class="btn btn--secondary btn--sm"
                type="button"
                :disabled="restoringId !== null"
                @click="startRestore(record)"
              >
                恢复
              </button>
              <button
                class="btn btn--ghost btn--sm backup-version__delete"
                type="button"
                :disabled="deletingId !== null"
                @click="onDeleteBackup(record)"
              >
                {{ deletingId === record.id ? '删除中…' : '删除' }}
              </button>
            </div>
          </li>
        </ul>

        <!-- 恢复面板（加密备份需输入密码） -->
        <form v-if="restoreTarget" class="backup-restore" @submit.prevent="confirmRestore">
          <h3 class="backup-restore__title">恢复 {{ restoreTarget.fileName }}</h3>
          <p class="backup-restore__desc">
            将按「{{ importMode === 'overwrite' ? '覆盖' : '合并' }}」方式导入（导入方式在上方「导入」中切换）。
          </p>
          <label v-if="restoreTarget.encrypted" class="backup-restore__field">
            <span class="backup-restore__label">备份密码</span>
            <input
              v-model="restorePassword"
              class="backup-restore__input"
              type="password"
              autocomplete="off"
              placeholder="输入该备份的加密密码"
            />
          </label>
          <p v-if="restoreError" class="backup-error" role="alert">{{ restoreError }}</p>
          <div class="backup-restore__actions">
            <button
              class="btn btn--ghost btn--md"
              type="button"
              :disabled="restoringId !== null"
              @click="cancelRestore"
            >
              取消
            </button>
            <button
              class="btn btn--primary btn--md"
              type="submit"
              :disabled="restoringId !== null || (restoreTarget.encrypted && restorePassword.length === 0)"
            >
              <LoadingSpinner v-if="restoringId !== null" :size="14" />
              {{ restoringId !== null ? '正在恢复…' : '确认恢复' }}
            </button>
          </div>
        </form>
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

/* ========== EXT-05：自动备份 / 加密 / 版本列表 ========== */
.backup-auto__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.backup-versions__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.backup-versions__hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.backup-versions__empty {
  padding: var(--space-4);
  text-align: center;
  font: var(--text-label);
  color: var(--color-text-tertiary);
  background-color: var(--color-bg-surface);
  border-radius: var(--radius-md);
  border: var(--border-default);
}

.backup-versions__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
  padding: 0;
  margin: 0;
}

.backup-version {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3);
  background-color: var(--color-bg-surface);
  border-radius: var(--radius-md);
  border: var(--border-default);
}

.backup-version__main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
  flex: 1 1 auto;
}

.backup-version__title {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  min-width: 0;
}

.backup-version__name {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backup-version__lock {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--color-brand);
}

.backup-version__lock svg {
  width: 1em;
  height: 1em;
}

.backup-version__meta {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.backup-version__actions {
  display: flex;
  gap: var(--space-2);
  flex: 0 0 auto;
}

.backup-version__delete {
  color: var(--color-danger);
}

.backup-restore {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
  border: var(--border-default);
}

.backup-restore__title {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
  word-break: break-all;
}

.backup-restore__desc {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.backup-restore__field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.backup-restore__label {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.backup-restore__input {
  width: 100%;
  min-height: var(--touch-min);
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-base);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-label);
}

.backup-restore__input:focus-visible {
  outline: none;
  border-color: var(--color-brand);
  box-shadow: var(--shadow-focus);
}

.backup-restore__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
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
