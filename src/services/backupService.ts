/**
 * 备份服务（API-13）
 *
 * - 导出：`schemaVersion = 2`，默认脱敏 `auth.password` / `auth.token`；
 * - 导入：校验 `schemaVersion`（缺失/过高 → `E_VERSION_UNSUPPORTED`），
 *   单事务写 sources/favorites/history + 直播域四表（可选 settings），失败全回滚。
 *
 * 直播域（v2）：`lives` / `epgSources` / `channelPrefs` / `reminders` 一并备份——
 * 这四张表是换机后最难手工重建的数据（订阅地址、分组排序、节目提醒）。
 * v1 备份不含这些字段，归一化为空数组后按"只导入携带的表"处理。
 * `epgSources` 的内置源在 overwrite 下**不清空**：它由 DB 迁移一次性种入，
 * 清掉后迁移不会重跑，EPG 会永久失去默认源。
 *
 * `downloads`（FR-40 / CHG-04）：备份**包含下载任务元数据**，但不含视频文件与
 * blob 内容，且剔除 `sink`/`filePath`/`blobKey` 三个"指向本机存储"的字段
 * （`BackupFile.downloads` 的 `Omit<...>` 即此意）。导入时**不恢复**下载任务：
 * 元数据脱离了视频文件与源缓存后无法续传，恢复只会造出死任务；`BackupImportReport.downloads`
 * 仅表示"备份文件中携带的下载任务条数"，UI 不展示为"已恢复"。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES } from '@/db/schema';
import { channelPrefsRepo } from '@/db/repositories/channelPrefsRepo';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { liveRepo } from '@/db/repositories/liveRepo';
import { reminderRepo } from '@/db/repositories/reminderRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { reminderService } from '@/services/reminderService';
import { settingsService } from '@/services/settingsService';
import {
  base64ToBytes,
  bytesToBase64,
  createVerifier,
  decryptBackupText,
  deriveKey,
  exportKeyToBase64,
  generateSalt,
  importKeyFromBase64,
  encryptBackupText,
  validatePassword,
  verifyPassword,
} from '@/services/backupEncryption';
import { WebDAVClient } from '@/services/webdavService';
import { appEvents } from '@/services/events';
import { APP_VERSION, BACKUP_SCHEMA_VERSION, HISTORY_MAX } from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { formatDateStamp } from '@/shared/time';
import { Share } from '@capacitor/share';
import { isNative } from '@/shared/platform';
import { deleteFile, readTextFile, writeTextFile } from '@/native/fs';
import type {
  BackupFile,
  BackupImportReport,
  BackupMode,
  BackupRecord,
  BackupSettings,
  BackupSource,
  ChannelPrefs,
  DownloadTask,
  EpgSource,
  FavoriteRecord,
  HistoryRecord,
  LiveRecord,
  Reminder,
  Source,
} from '@/types';

export interface BackupService {
  exportData(opts: { includeCredentials: boolean }): Promise<Blob>;
  exportToFile(opts: { includeCredentials: boolean; fileName?: string }): Promise<{ path: string | null; fileName: string }>;
  parseBackup(file: File): Promise<BackupFile>;
  importData(backup: BackupFile, mode: BackupMode): Promise<BackupImportReport>;
  /** EXT-05：备份版本列表（按时间倒序） */
  listBackups(): Promise<BackupRecord[]>;
  /** EXT-05：执行一次受管理备份（含加密、版本保留） */
  runBackup(opts: RunBackupOptions): Promise<RunBackupResult>;
  /** EXT-05：删除某条备份（文件 + 索引） */
  deleteBackup(recordId: string): Promise<void>;
  /** EXT-05：读取备份原文（本地 / WebDAV），加密文件返回外壳 JSON */
  readBackupText(record: BackupRecord): Promise<string>;
  /** EXT-05：恢复某条备份（加密文件必须提供密码） */
  restoreBackup(recordId: string, opts: { password?: string; mode: BackupMode }): Promise<BackupImportReport>;
}

/* ================= EXT-05 phase1：版本保留 / 定时 / 加密 ================= */

/** 受管理备份目录（原生文件系统 Data 目录下） */
export const BACKUP_DIR = 'backups';
/** 备份索引（kv） */
export const BACKUP_INDEX_KV_KEY = 'backup-index';
/** Web 端备份正文（kv，无原生文件系统时使用） */
export const BACKUP_FILE_KV_PREFIX = 'backup-file:';
/** 本机派生密钥缓存（kv；只存 PBKDF2 派生密钥，**不存密码明文**） */
export const BACKUP_KEY_KV_KEY = 'backup-encryption-key';

export const BACKUP_RETENTION_DEFAULT = 5;
export const BACKUP_RETENTION_MIN = 1;
export const BACKUP_RETENTION_MAX = 20;
/** 受管理备份文件名：`backup_YYYYMMDD_HHmmss.json|.enc` */
export const MANAGED_BACKUP_NAME = /^backup_\d{8}_\d{6}\.(json|enc)$/;

export interface RunBackupOptions {
  /** 手动 / 定时 */
  source: BackupSource;
  /** 是否包含明文凭据（与既有导出语义一致，默认否） */
  includeCredentials?: boolean;
  /** 写本机（默认 true） */
  local?: boolean;
  /** 上传 WebDAV（默认 false；需已配置） */
  webdav?: boolean;
  /** 测试注入的时间戳 */
  now?: number;
}

export interface RunBackupResult {
  records: BackupRecord[];
  /** 被版本保留清掉的记录 */
  pruned: BackupRecord[];
  encrypted: boolean;
}

export function defaultBackupSettings(): BackupSettings {
  return {
    scheduleMode: 'off',
    scheduleHour: 3,
    scheduleWeekday: 1,
    retentionCount: BACKUP_RETENTION_DEFAULT,
    encryptionEnabled: false,
    encryptionSalt: null,
    encryptionVerifier: null,
    lastScheduledAt: null,
    lastBackupAt: null,
    lastError: null,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 生成受管理备份文件名（本地时区） */
export function backupFileNameOf(timestamp: number, encrypted: boolean): string {
  const d = new Date(timestamp);
  const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `backup_${date}_${time}.${encrypted ? 'enc' : 'json'}`;
}

/** 从文件名反解时间戳；非受管理文件名返回 null */
export function timestampFromBackupName(name: string): number | null {
  const match = /^backup_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.(json|enc)$/.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ts = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** 是否受管理命名（版本保留只清理这类文件，绝不碰旧的手动导出文件） */
export function isManagedBackupName(name: string): boolean {
  return MANAGED_BACKUP_NAME.test(name);
}

/**
 * 版本保留计算（纯函数）：同位置按时间倒序保留最近 `keep` 条，其余进入 `removed`。
 * `keep` 越界时收敛到 [1, 20]。
 */
export function pruneBackupRecords(
  records: BackupRecord[],
  keep: number,
  location?: BackupRecord['location'],
): { kept: BackupRecord[]; removed: BackupRecord[] } {
  const limit = Math.min(
    BACKUP_RETENTION_MAX,
    Math.max(BACKUP_RETENTION_MIN, Math.floor(Number(keep) || BACKUP_RETENTION_DEFAULT)),
  );
  const scoped = location ? records.filter((r) => r.location === location) : records;
  const sorted = [...scoped].sort((a, b) => b.timestamp - a.timestamp);
  const keptIds = new Set(sorted.slice(0, limit).map((r) => r.id));
  const kept: BackupRecord[] = [];
  const removed: BackupRecord[] = [];
  for (const record of records) {
    if (location && record.location !== location) {
      kept.push(record);
      continue;
    }
    if (keptIds.has(record.id)) kept.push(record);
    else removed.push(record);
  }
  return { kept, removed };
}

function normalizeRecord(value: unknown): BackupRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['path'] !== 'string') return null;
  if (typeof value['timestamp'] !== 'number' || !Number.isFinite(value['timestamp'])) return null;
  const source: BackupSource = value['source'] === 'scheduled' ? 'scheduled' : 'manual';
  const location: BackupRecord['location'] = value['location'] === 'webdav' ? 'webdav' : 'local';
  return {
    id: value['id'],
    timestamp: value['timestamp'],
    size: typeof value['size'] === 'number' && Number.isFinite(value['size']) ? value['size'] : 0,
    source,
    encrypted: Boolean(value['encrypted']),
    path: value['path'],
    location,
    fileName:
      typeof value['fileName'] === 'string'
        ? value['fileName']
        : value['path'].split('/').pop() ?? value['path'],
  };
}

let indexQueue: Promise<unknown> = Promise.resolve();

/** 串行化备份索引读改写，避免手动与定时备份同时落库互相覆盖 */
function withIndexLock<T>(task: () => Promise<T>): Promise<T> {
  const run = indexQueue.then(task, task);
  indexQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readIndex(): Promise<BackupRecord[]> {
  const raw = await kvRepo.get<unknown>(BACKUP_INDEX_KV_KEY);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeRecord)
    .filter((value): value is BackupRecord => value !== null)
    .sort((a, b) => b.timestamp - a.timestamp);
}

async function writeIndex(records: BackupRecord[]): Promise<void> {
  const sorted = [...records].sort((a, b) => b.timestamp - a.timestamp);
  await kvRepo.set(BACKUP_INDEX_KV_KEY, sorted);
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function localKvKeyOf(record: BackupRecord): string {
  return `${BACKUP_FILE_KV_PREFIX}${record.id}`;
}

/* ---------- 加密密钥缓存（不落密码明文） ---------- */

let cachedKey: CryptoKey | null = null;

/** 取本机缓存的加密密钥（没有则返回 null） */
export async function ensureBackupEncryptionKey(): Promise<CryptoKey | null> {
  if (cachedKey) return cachedKey;
  const stored = await kvRepo.get<string>(BACKUP_KEY_KV_KEY);
  if (typeof stored !== 'string' || stored.length === 0) return null;
  try {
    cachedKey = await importKeyFromBase64(stored);
    return cachedKey;
  } catch (e) {
    logger.warn('备份加密密钥缓存读取失败', e);
    return null;
  }
}

/**
 * 局部更新备份设置。
 *
 * `AppSettings.backup` 在 `DeepPartial` 下不展开（字段含 `null` 联合），故这里显式
 * "读当前 → 合并 → 整体写回"，避免把 `Partial<BackupSettings>` 直接塞进 update。
 */
async function updateBackupSettings(patch: Partial<BackupSettings>): Promise<BackupSettings> {
  const current = (await settingsService.get()).backup ?? defaultBackupSettings();
  const next: BackupSettings = { ...current, ...patch };
  await settingsService.update({ backup: next });
  return next;
}

/** 设置/变更加密密码：派生密钥 → 缓存 → 落 salt + 校验块（密码本身不落盘） */
export async function setupBackupEncryption(password: string): Promise<void> {
  validatePassword(password);
  const salt = generateSalt();
  const key = await deriveKey(password, salt, undefined, true);
  const [verifier, keyB64] = await Promise.all([createVerifier(key), exportKeyToBase64(key)]);
  await kvRepo.set(BACKUP_KEY_KV_KEY, keyB64);
  cachedKey = key;
  await updateBackupSettings({
    encryptionEnabled: true,
    encryptionSalt: bytesToBase64(salt),
    encryptionVerifier: verifier,
  });
}

/** 关闭加密：清缓存与 salt/校验块（已生成的 .enc 文件仍可用原密码恢复） */
export async function disableBackupEncryption(): Promise<void> {
  cachedKey = null;
  await kvRepo.delete(BACKUP_KEY_KV_KEY);
  await updateBackupSettings({ encryptionEnabled: false, encryptionSalt: null, encryptionVerifier: null });
}

/** 校验输入的密码是否与已保存的加密设置一致 */
export async function verifyBackupEncryptionPassword(password: string): Promise<boolean> {
  const settings = await settingsService.get();
  const backup = settings.backup ?? defaultBackupSettings();
  if (!backup.encryptionSalt || !backup.encryptionVerifier) return false;
  return verifyPassword(password, backup.encryptionSalt, backup.encryptionVerifier);
}

/** 测试辅助：清空内存中的密钥缓存 */
export function __resetBackupKeyCache(): void {
  cachedKey = null;
}

/* ---------- 存储读写（本地 / WebDAV） ---------- */

function requireWebdavClient(settings: Awaited<ReturnType<typeof settingsService.get>>): WebDAVClient {  const webdav = settings.webdav;
  if (!webdav || !webdav.serverUrl || !webdav.username || !webdav.password) {
    throw new AppError('E_INVALID_STATE', '尚未配置 WebDAV，无法使用云端备份');
  }
  return new WebDAVClient({
    serverUrl: webdav.serverUrl,
    username: webdav.username,
    password: webdav.password,
    backupPath: webdav.backupPath || '/PeanutMov/backups',
  });
}

async function persistLocal(record: BackupRecord, text: string): Promise<void> {
  if (isNative()) {
    await writeTextFile(record.path, text);
    return;
  }
  // Web：无原生文件系统，正文留在 kv（仍在 IndexedDB 内，语义与"本机备份"一致）
  await kvRepo.set(localKvKeyOf(record), text);
}

async function removeLocal(record: BackupRecord): Promise<void> {
  if (isNative()) {
    await deleteFile(record.path);
    return;
  }
  await kvRepo.delete(localKvKeyOf(record));
}

/**
 * 执行一次受管理备份（EXT-05）。
 *
 * 顺序：收集载荷 →（可选）加密 → 写本机 / 上传 WebDAV → 更新索引 →
 * 按 `retentionCount` 清理旧版本（按位置分别保留）。任一步失败都抛错，
 * 不写半条索引记录（失败信息由调用方决定是否落到 `lastError`）。
 */
async function runBackupImpl(opts: RunBackupOptions): Promise<RunBackupResult> {
  const settings = await settingsService.get();
  const backupSettings = settings.backup ?? defaultBackupSettings();
  const timestamp = opts.now ?? Date.now();
  const encrypted = Boolean(backupSettings.encryptionEnabled);

  let text = JSON.stringify(await collectBackup(Boolean(opts.includeCredentials)), null, 2);
  if (encrypted) {
    const key = await ensureBackupEncryptionKey();
    if (!key) throw new AppError('E_INVALID_STATE', '加密密钥不可用，请重新设置备份密码');
    text = await encryptBackupText(text, {
      key,
      salt: backupSettings.encryptionSalt ? saltOf(backupSettings.encryptionSalt) : undefined,
    });
  }

  const fileName = backupFileNameOf(timestamp, encrypted);
  const size = byteLength(text);
  const recordBase = {
    id: `${timestamp}-${opts.source}-${encrypted ? 'enc' : 'json'}`,
    timestamp,
    size,
    source: opts.source,
    encrypted,
  } as const;

  const created: BackupRecord[] = [];
  const wantLocal = opts.local !== false;
  const wantWebdav = opts.webdav === true;

  if (wantLocal) {
    const record: BackupRecord = {
      ...recordBase,
      path: `${BACKUP_DIR}/${fileName}`,
      location: 'local',
      fileName,
    };
    await persistLocal(record, text);
    created.push(record);
  }

  if (wantWebdav) {
    const client = requireWebdavClient(settings);
    const remoteDir = settings.webdav?.backupPath || '/PeanutMov/backups';
    const remotePath = `${remoteDir.replace(/\/+$/, '')}/${fileName}`;
    await client.ensureDirectory(remoteDir);
    await client.uploadFile(remotePath, text, 'application/json');
    created.push({
      ...recordBase,
      path: remotePath,
      location: 'webdav',
      fileName,
    });
  }

  const pruned = await withIndexLock(async () => {
    let index = await readIndex();
    index = [...created, ...index.filter((r) => !created.some((c) => c.id === r.id))];
    const removed: BackupRecord[] = [];
    for (const location of ['local', 'webdav'] as const) {
      const result = pruneBackupRecords(index, backupSettings.retentionCount, location);
      index = result.kept;
      removed.push(...result.removed);
    }
    await writeIndex(index);
    return removed;
  });

  // 清理动作是"尽力而为"：单个文件删除失败不阻断本次备份成功
  for (const record of pruned) {
    try {
      if (record.location === 'local') await removeLocal(record);
      else await requireWebdavClient(settings).deleteFile(record.path);
    } catch (e) {
      logger.warn('旧版本备份清理失败', { path: record.path, error: String(e) });
    }
  }

  const patch: Partial<BackupSettings> = { lastBackupAt: timestamp, lastError: null };
  if (opts.source === 'scheduled') patch.lastScheduledAt = timestamp;
  await updateBackupSettings(patch);

  return { records: created, pruned, encrypted };
}

/** settings 里存的 salt 是 base64；坏数据不应让备份整体失败（回落到新随机 salt） */
function saltOf(value: string): Uint8Array {
  try {
    return base64ToBytes(value);
  } catch {
    return generateSalt();
  }
}


function redactSource(source: Source): Source {
  return {
    ...source,
    auth: {
      ...source.auth,
      password: null,
      token: null,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** 凭据类 header / query 参数名（导出脱敏时命中即剔除） */
const SENSITIVE_META_KEY = /authorization|cookie|token|api[-_]?key|secret|password|passwd/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_META_KEY.test(key)) continue; // 整条丢弃，不写空值占位
    out[key] = value;
  }
  return out;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_META_KEY.test(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : raw;
  } catch {
    return raw; // 非绝对 URL（相对路径/自定义 scheme）原样保留
  }
}

/**
 * 下载任务 → 备份元数据。
 *
 * - 剔除 `sink`/`filePath`/`blobKey`（指向本机存储，换机无意义且可能泄漏路径）；
 * - `includeCredentials=false` 时额外剔除凭据类 header 与 URL query（播放直链常带 token）。
 */
function toDownloadMeta(task: DownloadTask, includeCredentials: boolean): BackupDownloadMeta {
  // 解构 + rest 即"按黑名单剔除"：三个本机存储字段被丢掉，其余全属元数据
  const { sink, filePath, blobKey, ...meta } = task;
  void sink;
  void filePath;
  void blobKey;
  return {
    ...meta,
    // 瞬时速度对备份无意义（导入不恢复任务），统一落 0，避免把运行时噪声写进文件
    speedBps: 0,
    url: includeCredentials ? meta.url : redactUrl(meta.url),
    headers: includeCredentials ? meta.headers : redactHeaders(meta.headers ?? {}),
  };
}

/**
 * 校验备份里的下载任务元数据。
 *
 * 只保留可识别的条目；并**强制**剔除 `sink`/`filePath`/`blobKey`——即使备份文件被
 * 人为塞入这些字段也不会被采纳（它们指向导出机器的本地存储，恢复后必然失效）。
 */
function validateDownloadMeta(value: unknown): BackupDownloadMeta | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['episodeId'] !== 'string') return null;
  if (typeof value['mediaId'] !== 'string' || typeof value['url'] !== 'string') return null;
  const { sink, filePath, blobKey, ...rest } = value;
  void sink;
  void filePath;
  void blobKey;
  return {
    ...(rest as unknown as BackupDownloadMeta),
    sourceId: typeof rest['sourceId'] === 'string' ? rest['sourceId'] : '',
    title: typeof rest['title'] === 'string' ? rest['title'] : '未命名',
    headers: isRecord(rest['headers']) ? (rest['headers'] as Record<string, string>) : {},
    downloadedBytes: typeof rest['downloadedBytes'] === 'number' ? rest['downloadedBytes'] : 0,
    speedBps: 0,
    totalBytes: typeof rest['totalBytes'] === 'number' ? rest['totalBytes'] : null,
    createdAt: typeof rest['createdAt'] === 'number' ? rest['createdAt'] : Date.now(),
    updatedAt: typeof rest['updatedAt'] === 'number' ? rest['updatedAt'] : Date.now(),
    completedAt: typeof rest['completedAt'] === 'number' ? rest['completedAt'] : null,
  };
}

function validateSource(value: unknown): Source | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['name'] !== 'string') return null;
  if (typeof value['type'] !== 'string') return null;
  const auth = isRecord(value['auth']) ? value['auth'] : {};
  return {
    ...(value as unknown as Source),
    key: typeof value['key'] === 'string' ? value['key'] : value['id'],
    enabled: value['enabled'] !== false,
    builtin: Boolean(value['builtin']),
    sort: typeof value['sort'] === 'number' ? value['sort'] : 0,
    baseUrl: typeof value['baseUrl'] === 'string' ? value['baseUrl'] : '',
    pathPrefix: typeof value['pathPrefix'] === 'string' ? value['pathPrefix'] : null,
    auth: {
      mode: auth['mode'] === 'basic' || auth['mode'] === 'token' ? auth['mode'] : 'none',
      username: typeof auth['username'] === 'string' ? auth['username'] : null,
      password: typeof auth['password'] === 'string' ? auth['password'] : null,
      token: typeof auth['token'] === 'string' ? auth['token'] : null,
    },
    headers: isRecord(value['headers']) ? (value['headers'] as Record<string, string>) : {},
    ext: isRecord(value['ext']) ? (value['ext'] as Record<string, unknown>) : null,
    subscriptionId: typeof value['subscriptionId'] === 'string' ? value['subscriptionId'] : null,
    warning: typeof value['warning'] === 'string' ? value['warning'] : null,
    health: typeof value['health'] === 'string' ? (value['health'] as Source['health']) : 'unknown',
    healthCheckedAt: typeof value['healthCheckedAt'] === 'number' ? value['healthCheckedAt'] : null,
    lastErrorCode: null,
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

function validateFavorite(value: unknown): FavoriteRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['sourceId'] !== 'string') return null;
  if (typeof value['mediaId'] !== 'string' || typeof value['title'] !== 'string') return null;
  return {
    ...(value as unknown as FavoriteRecord),
    posterUrl: typeof value['posterUrl'] === 'string' ? value['posterUrl'] : null,
    type: typeof value['type'] === 'string' ? (value['type'] as FavoriteRecord['type']) : 'other',
    year: typeof value['year'] === 'number' ? value['year'] : null,
    sourceRemoved: Boolean(value['sourceRemoved']),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
  };
}

function validateHistory(value: unknown): HistoryRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['sourceId'] !== 'string') return null;
  if (typeof value['mediaId'] !== 'string') return null;
  const durationSec = typeof value['durationSec'] === 'number' ? value['durationSec'] : 0;
  if (durationSec <= 0) return null;
  const positionSec = typeof value['positionSec'] === 'number' ? value['positionSec'] : 0;
  return {
    ...(value as unknown as HistoryRecord),
    episodeId: typeof value['episodeId'] === 'string' ? value['episodeId'] : null,
    episodeNumber: typeof value['episodeNumber'] === 'number' ? value['episodeNumber'] : null,
    title: typeof value['title'] === 'string' ? value['title'] : '未命名',
    posterUrl: typeof value['posterUrl'] === 'string' ? value['posterUrl'] : null,
    positionSec,
    durationSec,
    progress: typeof value['progress'] === 'number' ? value['progress'] : positionSec / durationSec,
    finished: Boolean(value['finished']),
    totalEpisodes: typeof value['totalEpisodes'] === 'number' ? value['totalEpisodes'] : null,
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

/* ---------- 直播域校验（备份 v2） ---------- */

const LIVE_FORMATS = ['m3u', 'txt', 'auto'] as const;
const EPG_PROTOCOLS = ['auto', 'diyp', 'xmltv'] as const;
const EPG_MATCH_MODES = ['auto', 'channel-name', 'xmltv-id'] as const;
const REMINDER_STATES = ['scheduled', 'firing', 'fired', 'missed', 'cancelled'] as const;
const REMINDER_LEADS = [0, 5, 10, 15, 30] as const;

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function validateLive(value: unknown): LiveRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['url'] !== 'string') return null;
  const catchup = isRecord(value['catchup']) ? value['catchup'] : null;
  return {
    id: value['id'],
    name: typeof value['name'] === 'string' ? value['name'] : '未命名直播源',
    url: value['url'],
    format: pick(value['format'], LIVE_FORMATS, 'auto'),
    channelCount: typeof value['channelCount'] === 'number' ? value['channelCount'] : null,
    subscriptionId: typeof value['subscriptionId'] === 'string' ? value['subscriptionId'] : null,
    ...(catchup
      ? {
          catchup: {
            enabled: Boolean(catchup['enabled']),
            template: typeof catchup['template'] === 'string' ? catchup['template'] : '',
            days: typeof catchup['days'] === 'number' ? catchup['days'] : 1,
          },
        }
      : {}),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

function validateEpgSource(value: unknown): EpgSource | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['endpoint'] !== 'string') return null;
  return {
    id: value['id'],
    name: typeof value['name'] === 'string' ? value['name'] : '未命名 EPG 源',
    endpoint: value['endpoint'],
    protocol: pick(value['protocol'], EPG_PROTOCOLS, 'auto'),
    matchMode: pick(value['matchMode'], EPG_MATCH_MODES, 'auto'),
    priority: typeof value['priority'] === 'number' ? value['priority'] : 1,
    enabled: value['enabled'] !== false,
    builtin: Boolean(value['builtin']),
    lastProbeAt: typeof value['lastProbeAt'] === 'number' ? value['lastProbeAt'] : null,
    lastError: typeof value['lastError'] === 'string' ? value['lastError'] : null,
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

function validateChannelPrefs(value: unknown): ChannelPrefs | null {
  if (!isRecord(value)) return null;
  if (typeof value['liveSourceId'] !== 'string') return null;
  const groups = asArray<unknown>(value['groups']).filter(
    (group): group is ChannelPrefs['groups'][number] =>
      isRecord(group) && typeof group['id'] === 'string' && typeof group['name'] === 'string',
  );
  return {
    liveSourceId: value['liveSourceId'],
    groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      order: typeof group.order === 'number' ? group.order : 0,
      createdAt: typeof group.createdAt === 'number' ? group.createdAt : Date.now(),
    })),
    assignments: isRecord(value['assignments']) ? (value['assignments'] as Record<string, string>) : {},
    orders: isRecord(value['orders']) ? (value['orders'] as Record<string, string[]>) : {},
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

function validateReminder(value: unknown): Reminder | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['liveSourceId'] !== 'string') return null;
  if (typeof value['channelKey'] !== 'string') return null;
  const startAt = typeof value['startAt'] === 'number' ? value['startAt'] : null;
  const notifyAt = typeof value['notifyAt'] === 'number' ? value['notifyAt'] : null;
  if (startAt === null || notifyAt === null) return null;
  return {
    id: value['id'],
    liveSourceId: value['liveSourceId'],
    epgSourceId: typeof value['epgSourceId'] === 'string' ? value['epgSourceId'] : null,
    channelKey: value['channelKey'],
    channelName: typeof value['channelName'] === 'string' ? value['channelName'] : '',
    programmeKey: typeof value['programmeKey'] === 'string' ? value['programmeKey'] : '',
    programmeTitle: typeof value['programmeTitle'] === 'string' ? value['programmeTitle'] : '未命名节目',
    startAt,
    endAt: typeof value['endAt'] === 'number' ? value['endAt'] : startAt,
    leadMinutes: pick(value['leadMinutes'], REMINDER_LEADS, 0),
    notifyAt,
    // 已触发/已取消的终态原样保留，避免换机后重复提醒；过期项由 reconcile 判 missed
    state: pick(value['state'], REMINDER_STATES, 'scheduled'),
    nativeId: typeof value['nativeId'] === 'number' ? value['nativeId'] : 0,
    lastError: null,
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

/** 校验并规范化备份文件结构（不发 IO） */
export function normalizeBackupFile(raw: unknown): BackupFile {
  if (!isRecord(raw)) {
    throw new AppError('E_PARSE', '备份文件格式不支持');
  }
  const schemaVersion = raw['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) {
    throw new AppError('E_VERSION_UNSUPPORTED', '备份文件缺少版本信息');
  }
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new AppError('E_VERSION_UNSUPPORTED', '备份版本不支持，请升级 App');
  }
  if (!Array.isArray(raw['sources']) && !Array.isArray(raw['favorites']) && !Array.isArray(raw['history'])) {
    throw new AppError('E_PARSE', '备份文件格式不支持');
  }

  return {
    schemaVersion,
    appVersion: typeof raw['appVersion'] === 'string' ? raw['appVersion'] : '未知版本',
    exportedAt: typeof raw['exportedAt'] === 'number' ? raw['exportedAt'] : Date.now(),
    sources: asArray<unknown>(raw['sources'])
      .map(validateSource)
      .filter((value): value is Source => value !== null),
    favorites: asArray<unknown>(raw['favorites'])
      .map(validateFavorite)
      .filter((value): value is FavoriteRecord => value !== null),
    history: asArray<unknown>(raw['history'])
      .map(validateHistory)
      .filter((value): value is HistoryRecord => value !== null),
    settings: isRecord(raw['settings']) ? (raw['settings'] as unknown as BackupFile['settings']) : null,
    downloads: asArray<unknown>(raw['downloads'])
      .map(validateDownloadMeta)
      .filter((value): value is BackupDownloadMeta => value !== null),
    lives: asArray<unknown>(raw['lives'])
      .map(validateLive)
      .filter((value): value is LiveRecord => value !== null),
    epgSources: asArray<unknown>(raw['epgSources'])
      .map(validateEpgSource)
      .filter((value): value is EpgSource => value !== null),
    channelPrefs: asArray<unknown>(raw['channelPrefs'])
      .map(validateChannelPrefs)
      .filter((value): value is ChannelPrefs => value !== null),
    reminders: asArray<unknown>(raw['reminders'])
      .map(validateReminder)
      .filter((value): value is Reminder => value !== null),
  };
}

/**
 * 生成备份载荷。
 *
 * 下载任务只导出**元数据**（FR-40："下载任务元数据…不含视频文件与 Blob"）：
 * 从 `downloads` 表读全量任务，剥离 `sink`/`filePath`/`blobKey` 后写入；
 * 不读 `blobs` 表，故备份体积与已下载视频大小无关。
 */
async function collectBackup(includeCredentials: boolean): Promise<BackupFile> {
  const [sources, favorites, history, settings, downloads, lives, epgSources, channelPrefs, reminders] =
    await Promise.all([
      sourceRepo.list(),
      favoriteRepo.listByCreated(),
      historyRepo.listAll(HISTORY_MAX),
      settingsService.get(),
      downloadRepo.listAll(),
      liveRepo.list(),
      epgSourceRepo.list(),
      channelPrefsRepo.list(),
      reminderRepo.list(),
    ]);

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    sources: includeCredentials ? sources : sources.map(redactSource),
    favorites,
    history,
    settings,
    downloads: downloads.map((task) => toDownloadMeta(task, includeCredentials)),
    // 直播源地址常带 token，与下载直链同一套脱敏口径
    lives: includeCredentials ? lives : lives.map((live) => ({ ...live, url: redactUrl(live.url) })),
    epgSources: includeCredentials
      ? epgSources
      : epgSources.map((source) => ({ ...source, endpoint: redactUrl(source.endpoint) })),
    channelPrefs,
    reminders,
  };
}

export const backupService: BackupService = {
  async exportData(opts: { includeCredentials: boolean }): Promise<Blob> {
    const payload = await collectBackup(opts.includeCredentials);
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  },

  async exportToFile(opts: {
    includeCredentials: boolean;
    fileName?: string;
  }): Promise<{ path: string | null; fileName: string }> {
    const fileName = opts.fileName ?? `peanutmov-backup-${formatDateStamp()}.json`;
    const blob = await this.exportData({ includeCredentials: opts.includeCredentials });
    const text = await blob.text();

    if (!isNative()) {
      return { path: null, fileName };
    }

    const path = `backup/${fileName}`;
    try {
      await writeTextFile(path, text);
      const { Capacitor } = await import('@capacitor/core');
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const uri = await Filesystem.getUri({ path, directory: Directory.Data });
      await Share.share({ title: 'PeanutMov 备份', url: Capacitor.convertFileSrc(uri.uri) });
      return { path, fileName };
    } catch (e) {
      logger.warn('备份导出到文件失败', e);
      throw toAppError(e, 'E_FILE_MISSING');
    }
  },

  async parseBackup(file: File): Promise<BackupFile> {
    if (file.size === 0) throw new AppError('E_INVALID_INPUT', '备份文件为空');
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      throw new AppError('E_PARSE', undefined, { detail: '无法读取备份文件', cause: e });
    }
    if (text.trim().length === 0) throw new AppError('E_INVALID_INPUT', '备份文件为空');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new AppError('E_PARSE', '备份文件格式不支持', { cause: e });
    }
    return normalizeBackupFile(raw);
  },

  async importData(backup: BackupFile, mode: BackupMode): Promise<BackupImportReport> {
    const normalized = normalizeBackupFile(backup);
    const now = Date.now();

    const sources = normalized.sources.map((source) => ({
      ...source,
      updatedAt: now,
    }));
    const favorites = normalized.favorites.map((record) => ({ ...record }));
    const history = normalized.history.slice(0, HISTORY_MAX).map((record) => ({ ...record }));

    try {
      await withTx(
        ['sources', 'favorites', 'history', 'lives', 'epgSources', 'channelPrefs', 'reminders'],
        'readwrite',
        async (tx) => {
          if (mode === 'overwrite') {
            await tx.objectStore('sources').clear();
            await favoriteRepo.clear(tx);
            await historyRepo.clear(tx);
            await tx.objectStore(STORE_NAMES.lives).clear();
            await tx.objectStore(STORE_NAMES.channelPrefs).clear();
            await tx.objectStore(STORE_NAMES.reminders).clear();
            // 内置 EPG 源由 DB 迁移一次性种入，清空后不会重建 → 只清用户源
            const epgStore = tx.objectStore(STORE_NAMES.epgSources);
            const existingEpg = await epgStore.getAll();
            for (const record of existingEpg) {
              if (!record.builtin) await epgStore.delete(record.id);
            }
          }
          const sourceStore = tx.objectStore('sources');
          for (const source of sources) await sourceStore.put(source);
          await favoriteRepo.saveMany(favorites, tx);
          // 必须传 tx：historyRepo 自开事务会让外层事务在 await 期间自动提交（REV-01）
          await historyRepo.saveMany(history, tx);

          // 直播域四表同样只走外层 tx，禁止调用会自开事务的 repo 方法
          const liveStore = tx.objectStore(STORE_NAMES.lives);
          for (const record of normalized.lives) await liveStore.put(record);
          const epgStore = tx.objectStore(STORE_NAMES.epgSources);
          for (const record of normalized.epgSources) await epgStore.put(record);
          const prefsStore = tx.objectStore(STORE_NAMES.channelPrefs);
          for (const record of normalized.channelPrefs) await prefsStore.put(record);
          const reminderStore = tx.objectStore(STORE_NAMES.reminders);
          for (const record of normalized.reminders) await reminderStore.put(record);
        },
      );
    } catch (e) {
      throw toAppError(e, 'E_DB');
    }

    let settingsRestored = false;
    if (normalized.settings) {
      try {
        await settingsService.update({
          theme: normalized.settings.theme,
          hideDemoContent: normalized.settings.hideDemoContent,
          player: normalized.settings.player,
          gesture: normalized.settings.gesture,
          download: normalized.settings.download,
          searchHistory: normalized.settings.searchHistory,
          complianceVersion: normalized.settings.complianceVersion,
          complianceAcceptedAt: normalized.settings.complianceAcceptedAt,
        });
        settingsRestored = true;
      } catch (e) {
        logger.warn('备份设置恢复失败（不影响数据导入）', e);
      }
    }

    appEvents.emit('sources:changed', { reason: 'import' });
    appEvents.emit('favorites:changed', { id: null });
    appEvents.emit('history:changed', { id: null });

    const liveTouched =
      normalized.lives.length +
        normalized.epgSources.length +
        normalized.channelPrefs.length +
        normalized.reminders.length >
      0;
    if (liveTouched) {
      appEvents.emit('live:changed', { reason: 'import' });
      // 提醒的原生排期属于导出设备，导入后必须重新对账才会真正生效。
      // 失败不影响数据导入（Web 端恒 unsupported）。
      void reminderService.reconcile().catch((e) => {
        logger.warn('导入后节目提醒对账失败', e);
      });
    }

    return {
      sources: sources.length,
      favorites: favorites.length,
      history: history.length,
      downloads: normalized.downloads.length,
      lives: normalized.lives.length,
      epgSources: normalized.epgSources.length,
      channelPrefs: normalized.channelPrefs.length,
      reminders: normalized.reminders.length,
      settingsRestored,
    };
  },

  /* ---------- EXT-05 phase1 ---------- */

  async listBackups(): Promise<BackupRecord[]> {
    return readIndex();
  },

  async runBackup(opts: RunBackupOptions): Promise<RunBackupResult> {
    try {
      return await runBackupImpl(opts);
    } catch (e) {
      // 定时备份失败必须留痕（UI 展示"上次失败"），但不阻断用户操作
      if (opts.source === 'scheduled') {
        const message = toAppError(e).message;
        try {
          await updateBackupSettings({ lastError: message });
        } catch (persistError) {
          logger.warn('记录定时备份失败信息失败', persistError);
        }
      }
      throw toAppError(e);
    }
  },

  async deleteBackup(recordId: string): Promise<void> {
    const settings = await settingsService.get();
    const removed = await withIndexLock(async () => {
      const index = await readIndex();
      const target = index.find((r) => r.id === recordId) ?? null;
      if (!target) return null;
      await writeIndex(index.filter((r) => r.id !== recordId));
      return target;
    });
    if (!removed) return;
    if (removed.location === 'local') {
      await removeLocal(removed);
      return;
    }
    await requireWebdavClient(settings).deleteFile(removed.path);
  },

  async readBackupText(record: BackupRecord): Promise<string> {
    if (record.location === 'webdav') {
      const settings = await settingsService.get();
      const blob = await requireWebdavClient(settings).downloadFile(record.path);
      return blob.text();
    }
    if (isNative()) return readTextFile(record.path);
    const text = await kvRepo.get<string>(localKvKeyOf(record));
    if (typeof text !== 'string' || text.length === 0) {
      throw new AppError('E_FILE_MISSING', '本机备份内容已丢失，请重新备份');
    }
    return text;
  },

  async restoreBackup(
    recordId: string,
    opts: { password?: string; mode: BackupMode },
  ): Promise<BackupImportReport> {
    const index = await readIndex();
    const record = index.find((r) => r.id === recordId);
    if (!record) throw new AppError('E_NOT_FOUND', '备份记录不存在，请刷新列表');
    let text = await this.readBackupText(record);
    if (record.encrypted) {
      if (!opts.password) throw new AppError('E_INVALID_INPUT', '请输入备份密码');
      text = await decryptBackupText(text, opts.password);
    }
    if (text.trim().length === 0) throw new AppError('E_INVALID_INPUT', '备份文件为空');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new AppError('E_PARSE', '备份文件格式不支持', { cause: e });
    }
    return this.importData(normalizeBackupFile(raw), opts.mode);
  },
};

export type { BackupService as BackupServiceContract };

/** 备份预览用（UI 展示"源 N / 收藏 N / 历史 N"） */
export function summarizeBackup(backup: BackupFile): {
  sources: number;
  favorites: number;
  history: number;
  downloads: number;
  lives: number;
  epgSources: number;
  channelPrefs: number;
  reminders: number;
  exportedAt: number;
} {
  return {
    sources: backup.sources.length,
    favorites: backup.favorites.length,
    history: backup.history.length,
    downloads: backup.downloads.length,
    lives: backup.lives.length,
    epgSources: backup.epgSources.length,
    channelPrefs: backup.channelPrefs.length,
    reminders: backup.reminders.length,
    exportedAt: backup.exportedAt,
  };
}

/** 下载任务元数据（备份不含 video 文件与 Blob，仅保留任务记录） */
export type BackupDownloadMeta = Omit<DownloadTask, 'sink' | 'filePath' | 'blobKey'>;
