/**
 * 文件系统封装（`@capacitor/filesystem` + Web 回退）
 *
 * Android：写入应用私有目录 `Directory.Data`，相对路径形如 `downloads/{mediaId}/{episodeId}.mp4`。
 * Web：无真实文件系统，sink 会走 `IdbBlobSink`（IndexedDB blobs 表），本模块仅提供
 *      "把 Blob 读成 ArrayBuffer / 释放对象 URL" 等辅助。
 *
 * 所有失败统一抛 `AppError`：文件不存在 → `E_FILE_MISSING`，配额 → `E_STORAGE_QUOTA`。
 */
import { Directory, Filesystem } from '@capacitor/filesystem';

import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';

export const FS_ROOT = 'downloads';

export interface FsStat {
  exists: boolean;
  size: number;
  mtime: number | null;
}

function mapFsError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (/not exist|no such file|ENOENT|File does not exist/i.test(message)) {
    return new AppError('E_FILE_MISSING', undefined, { detail: message, cause: e });
  }
  if (/quota|space|ENOSPC|No space left/i.test(message)) {
    return new AppError('E_STORAGE_QUOTA', undefined, { detail: message, cause: e });
  }
  return toAppError(e, 'E_FILE_MISSING');
}

/** 是否可用原生文件系统 */
export function isFsAvailable(): boolean {
  return isNative();
}

/** 绝对/相对路径归一化为 Filesystem 使用的相对路径 */
export function normalizeFsPath(path: string): string {
  return path.replace(/^\/+/, '');
}

/** 确保目录存在（原生端递归创建） */
export async function ensureDir(path: string): Promise<void> {
  if (!isNative()) return;
  try {
    await Filesystem.mkdir({
      path: normalizeFsPath(path),
      directory: Directory.Data,
      recursive: true,
    });
  } catch (e) {
    // 已存在会被插件报错，忽略即可
    const message = e instanceof Error ? e.message : String(e);
    if (/exist/i.test(message)) return;
    throw mapFsError(e);
  }
}

/** 写入文本（备份导出用） */
export async function writeTextFile(path: string, data: string): Promise<void> {
  try {
    await Filesystem.writeFile({
      path: normalizeFsPath(path),
      data,
      directory: Directory.Data,
      encoding: 'utf8' as never,
      recursive: true,
    });
  } catch (e) {
    throw mapFsError(e);
  }
}

/** 读取文本 */
export async function readTextFile(path: string): Promise<string> {
  try {
    const result = await Filesystem.readFile({
      path: normalizeFsPath(path),
      directory: Directory.Data,
      encoding: 'utf8' as never,
    });
    return typeof result.data === 'string' ? result.data : await result.data.text();
  } catch (e) {
    throw mapFsError(e);
  }
}

/** 追加二进制（下载分块落盘；`data` 为 base64） */
export async function appendBase64(path: string, base64: string): Promise<void> {
  try {
    await Filesystem.appendFile({
      path: normalizeFsPath(path),
      data: base64,
      directory: Directory.Data,
    });
  } catch (e) {
    throw mapFsError(e);
  }
}

/** 写入二进制（覆盖） */
export async function writeBase64(path: string, base64: string): Promise<void> {
  try {
    await Filesystem.writeFile({
      path: normalizeFsPath(path),
      data: base64,
      directory: Directory.Data,
      recursive: true,
    });
  } catch (e) {
    throw mapFsError(e);
  }
}

/** 删除文件；文件不存在视为成功（幂等） */
export async function deleteFile(path: string): Promise<void> {
  if (!path) return;
  try {
    await Filesystem.deleteFile({ path: normalizeFsPath(path), directory: Directory.Data });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/not exist|no such file|ENOENT/i.test(message)) return;
    logger.debug('删除文件失败', { path, message });
    throw mapFsError(e);
  }
}

/** 读取文件状态 */
export async function stat(path: string): Promise<FsStat> {
  try {
    const info = await Filesystem.stat({ path: normalizeFsPath(path), directory: Directory.Data });
    return { exists: true, size: info.size ?? 0, mtime: info.mtime ?? null };
  } catch (e) {
    const err = mapFsError(e);
    if (err.code === 'E_FILE_MISSING') return { exists: false, size: 0, mtime: null };
    throw err;
  }
}

/** 把本地文件转成 WebView 可播放的 URL（Android 走 convertFileSrc） */
/** 重命名/移动文件（.part → 最终路径） */
export async function renameFile(from: string, to: string): Promise<void> {
  try {
    await Filesystem.rename({
      from: normalizeFsPath(from),
      to: normalizeFsPath(to),
      directory: Directory.Data,
    });
  } catch (e) {
    throw mapFsError(e);
  }
}

/** 把本地文件转换成 WebView 可播放的 URL（Android 走 convertFileSrc） */
export async function toPlayableUrl(path: string): Promise<string> {
  const { Capacitor } = await import('@capacitor/core');
  const uri = await Filesystem.getUri({ path: normalizeFsPath(path), directory: Directory.Data });
  return Capacitor.convertFileSrc(uri.uri);
}

/** 本地文件的 MIME（按扩展名） */
export function mimeOfPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.webm')) return 'video/webm';
  if (lower.endsWith('.ts')) return 'video/mp2t';
  if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  return 'video/mp4';
}

/** ArrayBuffer → base64（分块写入 Filesystem 用） */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return typeof btoa === 'function' ? btoa(binary) : '';
}

/** Blob → ArrayBuffer（Web sink 读取） */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  return blob.arrayBuffer();
}
