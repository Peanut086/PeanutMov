/**
 * 下载落地（API-09 落盘策略，FR-33）
 *
 * 两种实现：
 * - `NativeFsSink`：Capacitor Filesystem 写入应用私有目录 `downloads/{mediaId}/{episodeId}.{ext}`；
 *   写入过程中使用 `.part` 临时文件，完成后原子 rename 到最终路径；
 * - `IdbBlobSink`：Web 端把分块收进内存，完成后写 IndexedDB `blobs` 表（避免半截 Blob 残留）。
 *
 * 统一接口：`begin(totalBytes)` → 多次 `write(chunk)` → `finish()` / `suspend()` / `abort()`。
 * - `finish()`：完成，返回记录值；
 * - `suspend()`：暂停，保留已写入数据（.part 文件或内存 chunks）供续传；
 * - `abort()`：取消，清理所有临时数据（AC-76：不残留半截 Blob）。
 */
import { blobRepo } from '@/db/repositories/blobRepo';
import { AppError } from '@/shared/errors';
import { DOWNLOAD_WEB_SIZE_WARN_BYTES } from '@/shared/constants';
import { downloadRateLimiter } from '@/services/downloadRateLimiter';
import { extensionOf } from '@/shared/id';
import { logger } from '@/shared/logger';
import {
  arrayBufferToBase64,
  FS_ROOT,
  deleteFile,
  ensureDir,
  renameFile,
  stat,
  writeBase64,
  appendBase64,
} from '@/native/fs';
import type { DownloadSinkKind, DownloadTask } from '@/types';

export interface SinkInit {
  task: DownloadTask;
  /** 已下载字节（续传起点；Web 端会被忽略，始终从 0 开始） */
  startBytes: number;
}

export interface BeginResult {
  /** 实际可用的续传起点（可能与 DB 记录不一致，以文件实际大小为准） */
  actualStartBytes: number;
}

export interface DownloadSink {
  readonly kind: DownloadSinkKind;
  /** 开始写入；返回实际续传起点 */
  begin(init: SinkInit): Promise<BeginResult>;
  /** 追加一块数据 */
  write(chunk: Uint8Array): Promise<void>;
  /** 完成：返回记录值（文件路径或 blob key） */
  finish(): Promise<{ filePath: string | null; blobKey: string | null; size: number }>;
  /** 暂停：保留已写入数据供续传 */
  suspend(): Promise<void>;
  /** 放弃：清理临时数据 */
  abort(): Promise<void>;
}

/** Android 最终文件路径：`downloads/{mediaId}/{episodeId}.{ext}` */
export function nativeFilePathOf(task: DownloadTask): string {
  const mediaSegment = sanitizeSegment(task.mediaId);
  const episodeSegment = sanitizeSegment(task.episodeId);
  const ext = extensionOf(task.url, task.format);
  return `${FS_ROOT}/${mediaSegment}/${episodeSegment}.${ext}`;
}

/** Android 临时路径：最终路径 + `.part` */
export function nativePartPathOf(task: DownloadTask): string {
  return `${nativeFilePathOf(task)}.part`;
}

/** 去掉文件名里的非法字符（ID 已含 `:` 与 `~`） */
function sanitizeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_');
}

/* =========================================================
 * Android：Filesystem
 * =======================================================*/

/** P1-1: 写盘合并缓冲阈值（512KB）。小于此值的 write 先攒在内存，达到后一次性落盘，减少桥接调用次数。 */
const WRITE_BUFFER_LIMIT = 512 * 1024;

export class NativeFsSink implements DownloadSink {
  readonly kind: DownloadSinkKind = 'filesystem';
  private filePath = '';
  private partPath = '';
  private written = 0;
  private started = false;
  // EXT-04/FR-63：限速统计需要 taskId（额度是全局池，这里只用于速率归属）
  private taskId = '';
  // P1-1: 滑动窗口写盘缓冲
  private writeBuffer: Uint8Array[] = [];
  private writeBufferSize = 0;

  async begin(init: SinkInit): Promise<BeginResult> {
    this.filePath = nativeFilePathOf(init.task);
    this.partPath = nativePartPathOf(init.task);
    this.taskId = init.task.id;
    const dir = this.filePath.slice(0, this.filePath.lastIndexOf('/'));
    await ensureDir(dir);

    // 检查 .part 文件实际大小（以文件为准，不信 DB）
    const partStat = await stat(this.partPath);
    const actualSize = partStat.exists ? partStat.size : 0;

    if (init.startBytes > 0 && init.task.resumable && actualSize > 0) {
      // 续传：保留 .part 文件
      if (actualSize < init.startBytes) {
        // 文件比 DB 记录小（异常中断）：以文件为准，引擎会重新对齐 Range
        logger.warn('.part 文件小于 DB 记录，以文件为准', {
          partPath: this.partPath,
          actualSize,
          dbBytes: init.startBytes,
        });
      }
      this.written = actualSize;
    } else {
      // 从 0 开始：清空残留
      await deleteFile(this.partPath);
      await writeBase64(this.partPath, '');
      this.written = 0;
    }

    this.writeBuffer = [];
    this.writeBufferSize = 0;
    this.started = true;
    return { actualStartBytes: this.written };
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.started) throw new AppError('E_INVALID_STATE', 'sink 未初始化');
    if (chunk.byteLength === 0) return;

    // EXT-04/FR-63（D-03）：写盘前消费全局令牌桶额度——直链与 HLS 分片都经此处，
    // 一处生效即可覆盖两条 JS 路径；`unlimited` 档位直接返回，零开销。
    await downloadRateLimiter.consume(chunk.byteLength, this.taskId);

    // P1-1: 先拷贝进缓冲区，减少 base64 转换和桥接调用次数
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    this.writeBuffer.push(copy);
    this.writeBufferSize += chunk.byteLength;

    if (this.writeBufferSize >= WRITE_BUFFER_LIMIT) {
      await this.flushBuffer();
    }
  }

  /** P1-1: 把缓冲区中的数据合并后一次性写入磁盘 */
  private async flushBuffer(): Promise<void> {
    if (this.writeBufferSize === 0) return;

    // 合并所有缓冲块为一块连续内存
    const merged = new Uint8Array(this.writeBufferSize);
    let offset = 0;
    for (const buf of this.writeBuffer) {
      merged.set(buf, offset);
      offset += buf.byteLength;
    }
    this.writeBuffer = [];
    this.writeBufferSize = 0;

    const base64 = arrayBufferToBase64(merged.buffer);
    await appendBase64(this.partPath, base64);
    this.written += merged.byteLength;
  }

  async finish(): Promise<{ filePath: string | null; blobKey: string | null; size: number }> {
    if (!this.started) {
      return { filePath: null, blobKey: null, size: 0 };
    }
    this.started = false;

    // P1-1: 刷出剩余缓冲
    await this.flushBuffer();

    // 原子 rename：.part → 最终路径
    try {
      await renameFile(this.partPath, this.filePath);
    } catch (e) {
      logger.error('rename .part 失败', { from: this.partPath, to: this.filePath, error: e });
      // 已经归类的原因（配额/权限/……）不许洗成「本地文件不可用」：
      // 那句话会把用户推向"重新下载一遍"，而下一次 rename 仍会因同一个原因失败。
      if (e instanceof AppError && e.code !== 'E_FILE_MISSING') throw e;
      throw new AppError('E_FILE_MISSING', '下载完成但重命名失败', {
        detail: `from=${this.partPath}, to=${this.filePath}, error=${String(e)}`,
        cause: e,
      });
    }

    return { filePath: this.filePath, blobKey: null, size: this.written };
  }

  async suspend(): Promise<void> {
    // P1-1: 暂停前刷出缓冲，确保数据落盘可供续传
    if (this.started) {
      await this.flushBuffer();
    }
    this.started = false;
  }

  async abort(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.writeBuffer = [];
    this.writeBufferSize = 0;
    try {
      await deleteFile(this.partPath);
    } catch (e) {
      logger.warn('清理 .part 文件失败', { path: this.partPath, error: e });
    }
  }
}

/* =========================================================
 * Web：内存收集 → IndexedDB blobs
 * =======================================================*/

/**
 * Web 端单文件硬上限：与 FR-33 / AC-76 的 1GB 提示阈值**保持一致**（REV-07）。
 *
 * 三层阈值统一为 1GB：
 * - 引擎在拿到 `Content-Length` 后、写入任何分片前前置拒绝（见 `downloadEngine`）；
 * - sink 层同一阈值兜底（服务端未给 Content-Length 的流式响应）；
 * - `downloadService.needsAppForLargeFile()` 供已知体积的 UI 入口提前提示。
 */
const WEB_MAX_BYTES = DOWNLOAD_WEB_SIZE_WARN_BYTES;

export class IdbBlobSink implements DownloadSink {
  readonly kind: DownloadSinkKind = 'idb-blob';
  private chunks: Blob[] = [];
  private size = 0;
  private blobKey = '';
  private mime = 'video/mp4';
  private started = false;
  private taskId = '';

  async begin(init: SinkInit): Promise<BeginResult> {
    this.chunks = [];
    this.size = 0;
    this.blobKey = init.task.id;
    this.taskId = init.task.id;
    this.mime = mimeOfTask(init.task);
    this.started = true;
    // Web 端不保留半截 Blob，始终从 0 开始（忽略 startBytes）
    return { actualStartBytes: 0 };
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.started) throw new AppError('E_INVALID_STATE', 'sink 未初始化');
    if (chunk.byteLength === 0) return;
    // EXT-04/FR-63：与原生 sink 共用同一个全局桶（Web 端只有这一条路径）
    await downloadRateLimiter.consume(chunk.byteLength, this.taskId);
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

  async suspend(): Promise<void> {
    // 暂停：保留 chunks 在内存（如果页面不刷新，可续传）
    this.started = false;
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
      // 合并后的 HLS 分片为 MPEG-TS，不能再标成 m3u8 清单
      return 'video/mp2t';
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
