/**
 * 下载落地（API-09 落盘策略，FR-33）
 *
 * 两种实现：
 * - `NativeFsSink`：Capacitor Filesystem 写入应用私有目录 `downloads/{mediaId}/{episodeId}.{ext}`；
 * - `IdbBlobSink`：Web 端把分块收进内存，完成后写 IndexedDB `blobs` 表（避免半截 Blob 残留）。
 *
 * 统一接口：`begin(totalBytes)` → 多次 `write(chunk)` → `finish()` / `abort()`。
 * 失败时 `abort()` 必须清理临时数据（AC-76：不残留半截 Blob）。
 */
import { blobRepo } from '@/db/repositories/blobRepo';
import { AppError } from '@/shared/errors';
import { extensionOf } from '@/shared/id';
import { logger } from '@/shared/logger';
import { arrayBufferToBase64, FS_ROOT, deleteFile, ensureDir, writeBase64, appendBase64 } from '@/native/fs';
import type { DownloadSinkKind, DownloadTask } from '@/types';

export interface SinkInit {
  task: DownloadTask;
  /** 已下载字节（续传起点） */
  startBytes: number;
}

export interface DownloadSink {
  readonly kind: DownloadSinkKind;
  /** 开始写入；返回后 `write` 可被调用 */
  begin(init: SinkInit): Promise<void>;
  /** 追加一块数据 */
  write(chunk: Uint8Array): Promise<void>;
  /** 完成：返回记录值（文件路径或 blob key） */
  finish(): Promise<{ filePath: string | null; blobKey: string | null; size: number }>;
  /** 放弃：清理临时数据 */
  abort(): Promise<void>;
}

/** Android 相对路径：`downloads/{mediaId}/{episodeId}.{ext}` */
export function nativeFilePathOf(task: DownloadTask): string {
  const mediaSegment = sanitizeSegment(task.mediaId);
  const episodeSegment = sanitizeSegment(task.episodeId);
  const ext = extensionOf(task.url, task.format);
  return `${FS_ROOT}/${mediaSegment}/${episodeSegment}.${ext}`;
}

/** 去掉文件名里的非法字符（ID 已含 `:` 与 `~`） */
function sanitizeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_');
}

/* =========================================================
 * Android：Filesystem
 * =======================================================*/

export class NativeFsSink implements DownloadSink {
  readonly kind: DownloadSinkKind = 'filesystem';
  private filePath = '';
  private written = 0;
  private started = false;

  async begin(init: SinkInit): Promise<void> {
    this.filePath = nativeFilePathOf(init.task);
    this.written = 0;
    const dir = this.filePath.slice(0, this.filePath.lastIndexOf('/'));
    await ensureDir(dir);
    if (init.startBytes > 0 && init.task.resumable) {
      // 续传：保留已有文件，继续 append
      this.written = init.startBytes;
    } else {
      // 从 0 开始：先清空可能存在的残留
      await deleteFile(this.filePath);
      await writeBase64(this.filePath, '');
    }
    this.started = true;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.started) throw new AppError('E_INVALID_STATE', 'sink 未初始化');
    if (chunk.byteLength === 0) return;
    const base64 = arrayBufferToBase64(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    await appendBase64(this.filePath, base64);
    this.written += chunk.byteLength;
  }

  async finish(): Promise<{ filePath: string | null; blobKey: string | null; size: number }> {
    this.started = false;
    return { filePath: this.filePath, blobKey: null, size: this.written };
  }

  async abort(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    try {
      await deleteFile(this.filePath);
    } catch (e) {
      logger.warn('清理未完成文件失败', { path: this.filePath, error: e });
    }
  }
}

/* =========================================================
 * Web：内存收集 → IndexedDB blobs
 * =======================================================*/

/** 单块上限保护：超过 512MB 直接抛配额错误（Web 端不建议大文件） */
const WEB_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export class IdbBlobSink implements DownloadSink {
  readonly kind: DownloadSinkKind = 'idb-blob';
  private chunks: Blob[] = [];
  private size = 0;
  private blobKey = '';
  private mime = 'video/mp4';
  private started = false;

  async begin(init: SinkInit): Promise<void> {
    this.chunks = [];
    this.size = 0;
    this.blobKey = init.task.id;
    this.mime = mimeOfTask(init.task);
    this.started = true;
    // 续传起点由引擎重新请求 Range 后从 0 拼装（Web 端不保留半截 Blob）
    void init.startBytes;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.started) throw new AppError('E_INVALID_STATE', 'sink 未初始化');
    if (chunk.byteLength === 0) return;
    this.size += chunk.byteLength;
    if (this.size > WEB_MAX_BYTES) {
      throw new AppError('E_STORAGE_QUOTA', '文件超出浏览器环境建议上限，请改用 App 下载');
    }
    // 复制一份，避免上游复用底层 ArrayBuffer
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    this.chunks.push(new Blob([copy], { type: this.mime }));
  }

  async finish(): Promise<{ filePath: string | null; blobKey: string | null; size: number }> {
    const blob = new Blob(this.chunks, { type: this.mime });
    try {
      await blobRepo.put({
        key: this.blobKey,
        blob,
        size: this.size,
        mime: this.mime,
        createdAt: Date.now(),
      });
    } catch (e) {
      // 配额不足：不残留半截数据（AC-76）
      this.chunks = [];
      this.size = 0;
      if (e instanceof AppError) throw e;
      throw new AppError('E_STORAGE_QUOTA', undefined, { detail: String(e), cause: e });
    }
    this.chunks = [];
    this.started = false;
    return { filePath: null, blobKey: this.blobKey, size: this.size };
  }

  async abort(): Promise<void> {
    this.chunks = [];
    this.size = 0;
    this.started = false;
    try {
      await blobRepo.delete(this.blobKey);
    } catch {
      // 未写入时忽略
    }
  }

  /** 当前内存占用（测试断言用） */
  get bufferedBytes(): number {
    return this.size;
  }
}

export function mimeOfTask(task: DownloadTask): string {
  switch (task.format) {
    case 'webm':
      return 'video/webm';
    case 'ts':
      return 'video/mp2t';
    case 'hls':
      return 'application/vnd.apple.mpegurl';
    case 'mp4':
    default:
      return 'video/mp4';
  }
}

/** 按平台创建 sink（Android → Filesystem；Web → IDB Blob） */
export function createSink(kind: DownloadSinkKind): DownloadSink {
  return kind === 'filesystem' ? new NativeFsSink() : new IdbBlobSink();
}

/** Web 端读取已保存的 Blob（离线播放用） */
export async function readBlob(key: string): Promise<Blob | null> {
  const record = await blobRepo.get(key);
  return record?.blob ?? null;
}
