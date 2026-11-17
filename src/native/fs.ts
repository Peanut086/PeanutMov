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

import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';

export const FS_ROOT = 'downloads';

export interface FsStat {
  exists: boolean;
  size: number;
  mtime: number | null;
}

/**
 * 插件异常的 `code` 与 `message`。
 *
 * Capacitor 7 的 Filesystem 在 Android 侧 reject 的是 `{code, message}` 普通对象
 * （`OS-PLUG-FILE-00NN`），不是 Error 实例；对它取 `message` 或 `String(e)` 只会得到
 * 空串 / `[object Object]`，于是所有正则判断全部落空，任何一次写盘抖动都被兜底成
 * `E_FILE_MISSING`，用户看到的就是一句假话「本地文件不可用，请重新下载」。
 */
function describeRejection(e: unknown): { code: string; message: string } {
  if (e instanceof Error) return { code: '', message: e.message };
  if (e && typeof e === 'object') {
    const raw = e as { code?: unknown; message?: unknown };
    return { code: String(raw.code ?? ''), message: String(raw.message ?? '') };
  }
  return { code: '', message: typeof e === 'string' ? e : '' };
}

/** 目录/文件已存在（OS-PLUG-FILE-0010 覆盖 mkdir 与 rename 两种「已存在」） */
function isAlreadyExists({ code, message }: { code: string; message: string }): boolean {
  // 「does not exist」里也含 "exist"：不排除掉就会把缺失当成已存在，rename 会去删目标、
  // mkdir 会把真故障咽成成功。
  if (isDoesNotExist({ code, message })) return false;
  return code === 'OS-PLUG-FILE-0010' || /already exist|cannot be overwritten|exists/i.test(message);
}

/** 目标不存在（OS-PLUG-FILE-0008） */
function isDoesNotExist({ code, message }: { code: string; message: string }): boolean {
  return code === 'OS-PLUG-FILE-0008' || /does not exist|not exist|no such file|ENOENT|not found/i.test(message);
}

function isQuota({ code, message }: { code: string; message: string }): boolean {
  return /quota|space|ENOSPC|No space left/i.test(`${code} ${message}`);
}

function mapFsError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const info = describeRejection(e);
  if (isDoesNotExist(info)) return new AppError('E_FILE_MISSING', undefined, { detail: info.message, cause: e });
  if (isQuota(info)) return new AppError('E_STORAGE_QUOTA', undefined, { detail: info.message, cause: e });
  // 归不了类的文件系统故障（权限、插件未实现、已存在……）不能谎报成"文件不可用"：
  // 判成可重试的 E_UNKNOWN，交给上层的重试/续传，而不是把用户推向「重新下载」。
  return new AppError('E_UNKNOWN', undefined, {
    detail: info.message || info.code || (e instanceof Error ? e.message : String(e)),
    cause: e,
  });
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
    if (isAlreadyExists(describeRejection(e))) return;
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
    const info = describeRejection(e);
    if (isDoesNotExist(info)) return;
    logger.debug('删除文件失败', { path, code: info.code, message: info.message });
    throw mapFsError(e);
  }
}

/** 读取文件状态 */
export async function stat(path: string): Promise<FsStat> {
  try {
    const info = await Filesystem.stat({ path: normalizeFsPath(path), directory: Directory.Data });
    return { exists: true, size: info.size ?? 0, mtime: info.mtime ?? null };
  } catch (e) {
    const info = describeRejection(e);
    // 只有"确实不存在"才算 exists:false。配额/权限这类故障必须原样抛出去：
    // 把它们咽成"文件不存在"，下载侧会从头重下、播放侧会报「本地文件不可用」，真因全被藏掉。
    if (isDoesNotExist(info)) return { exists: false, size: 0, mtime: null };
    throw mapFsError(e);
  }
}

/** 把本地文件转成 WebView 可播放的 URL（Android 走 convertFileSrc） */
/** 重命名/移动文件（.part → 最终路径） */
export async function renameFile(from: string, to: string): Promise<void> {
  const args = {
    from: normalizeFsPath(from),
    to: normalizeFsPath(to),
    directory: Directory.Data,
  };
  try {
    await Filesystem.rename(args);
  } catch (e) {
    /**
     * Android 的 rename 不覆盖已存在的目标，直接回 OS-PLUG-FILE-0010。
     * 下载侧要的语义是"用 .part 替换最终文件"，而残留的最终文件恰恰是常态
     * （上次会话已 rename、任务被判失败后重下、进度回写没落库……）。
     * 不先清掉旧产物，「完成」这一步就永远失败，用户看到的是假的「本地文件不可用」。
     */
    if (!isAlreadyExists(describeRejection(e))) throw mapFsError(e);
    await deleteFile(to);
    try {
      await Filesystem.rename(args);
    } catch (retryErr) {
      throw mapFsError(retryErr);
    }
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
