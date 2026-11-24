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
import { isM3u8Url } from '@/player/sourceGuard';
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
  truncatePart,
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
  /**
   * DL-R0：起点来自「已晋升的成品」而不是 `.part`。
   *
   * 此时这份字节与任务记录里的分片索引是同一轮产出（采纳前已核对过索引完备性），
   * 续传侧不能再把「起点 ≠ DB 记账」当成损坏证据去清空索引、从头重下。
   */
  adoptedArtifact?: boolean;
}

export interface DownloadSink {
  readonly kind: DownloadSinkKind;
  /** 开始写入；返回实际续传起点 */
  begin(init: SinkInit): Promise<BeginResult>;
  /** 追加一块数据 */
  write(chunk: Uint8Array): Promise<void>;
  /** 把缓冲写入持久层；保存字节检查点前必须调用 */
  flush?(): Promise<void>;
  /** 裁掉未记账的文件尾部；当前字节检查点之前的数据保持不变 */
  truncateTo?(size: number): Promise<void>;
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
  // P0-4：下载期一律按 `format` 取名，不看 `task.container`——fMP4 的下载残件会变成
  // `ep1.mp4.part`，而原生启动清理专门删 `*.mp4.part`（那是转封装残件的约定名），
  // 于是每次冷启动都把一集没下完的 fMP4 清零。容器名在交付阶段才改指 `.mp4`。
  const ext = extensionOf(task.url, task.format);
  return `${FS_ROOT}/${mediaSegment}/${episodeSegment}.${ext}`;
}

/** Android 临时路径：最终路径 + `.part` */
export function nativePartPathOf(task: DownloadTask): string {
  return `${nativeFilePathOf(task)}.part`;
}

/**
 * HLS 分片索引是否已覆盖清单声明的全部分片。
 *
 * 负数序号是初始化分片（fMP4 的 init segment），不占媒体分片位，与
 * `checkCorruptedHlsTasks` 的口径保持一致：只数 `>= 0` 的。
 */
export function isSegmentIndexComplete(task: DownloadTask): boolean {
  const total = task.hlsTotalSegments ?? 0;
  if (total <= 0) return false;
  return (task.completedSegments ?? []).filter((index) => index >= 0).length >= total;
}

/**
 * 「下载阶段已经跑完、只剩结算/转封装」这一形态的唯一判据（DL-R0）。
 *
 * 两处共用：sink 据此决定能不能拿成品当续传基线，僵尸检测据此决定能不能不判失败。
 * 只看 HLS——直链的续传起点同时是 `Range` 的起点，把更长的成品当基线会在拼接处空出
 * 一段字节；HLS 是一片一个 URL、按索引各写各的，起点长一点短一点都不会错位。
 */
export function isDownloadPhaseSettled(task: DownloadTask): boolean {
  if (task.format !== 'hls' && !isM3u8Url(task.url)) return false;
  return isSegmentIndexComplete(task);
}

/** 去掉文件名里的非法字符（ID 已含 `:` 与 `~`），并把过长的段收进文件系统上限
 *
 * Android 底层按**字节**限制单个名字（ext4 为 255），而 ID 里常带中文（一个汉字 3 字节），
 * 爬虫源的 `mediaId` 更能直接超过 255。超限的首次写盘就抛 ENAMETOOLONG，真机实测用户只看到
 * 一句「操作失败，请重试」——那条路每次重试都会算出同一个超长路径，永远好不了。
 * 超预算的段改成「前缀 + 全量哈希」：同一条任务永远得到同一个路径（续传、去重、自检都依赖它），
 * 不同 ID 即便共享前缀也能区分。
 */
function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|]/g, '_');
  if (utf8Length(cleaned) <= MAX_SEGMENT_BYTES) return cleaned;
  const head = sliceUtf8(cleaned, MAX_SEGMENT_BYTES - HASH_SUFFIX_BYTES);
  return `${head}#${fnv1a32Hex(cleaned)}`;
}

/** 单个路径段的字节预算（最终名还要再拼 `.{ext}` ≤6 与下载期的 `.part` 5 字节） */
const MAX_SEGMENT_BYTES = 180;
/** `#` + 8 位十六进制哈希 */
const HASH_SUFFIX_BYTES = 9;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** 按码点裁剪，不把多字节字符切成半个（残缺序列在部分 ROM 上仍是非法名字） */
function sliceUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  let used = 0;
  let out = '';
  for (const char of value) {
    const size = encoder.encode(char).length;
    if (used + size > maxBytes) break;
    used += size;
    out += char;
  }
  return out;
}

/** FNV-1a/32：只用于截断后的去歧义，不作安全用途 */
function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
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

    let adopted = false;
    if (init.startBytes > 0 && init.task.resumable && actualSize === 0) {
      // DL-R0：`.part` 不见了但 DB 记着已下字节——先看成品在不在。`finish()` 是把
      // `.part` 原子改名成成品的，所以这个形态多半是「下载阶段已经跑完，只差结算/
      // 转封装时进程被强杀」。采纳成品的话这一轮会把已齐的分片全部跳过、直接收尾，
      // 零流量；判据不满足（字节对不上、分片索引不全）才落回「从头下载」。
      const artifactBytes = await this.adoptPromotedArtifact(init.task, init.startBytes);
      if (artifactBytes === null) {
        await this.resetToZero();
      } else {
        adopted = true;
        this.written = artifactBytes;
      }
    } else if (init.startBytes > 0 && init.task.resumable) {
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
      await this.resetToZero();
    }

    this.writeBuffer = [];
    this.writeBufferSize = 0;
    this.started = true;
    return adopted
      ? { actualStartBytes: this.written, adoptedArtifact: true }
      : { actualStartBytes: this.written };
  }

  /** 建立空的 `.part`（从 0 开始的唯一入口，避免两处各写一遍 delete+create） */
  private async resetToZero(): Promise<void> {
    await deleteFile(this.partPath);
    await writeBase64(this.partPath, '');
    this.written = 0;
  }

  /**
   * 把已晋升的成品接回续传基线，成功返回其字节数，否则返回 null。
   *
   * 三条门槛，缺一不采纳（宁可让用户重下一遍，也不能产出一份拼接坏的文件）：
   * - 形态可信（`isDownloadPhaseSettled`：HLS 且分片索引覆盖清单全部分片）；
   * - 成品确实在盘上；
   * - 体积不能小于 DB 记账——比记录还短说明连下载阶段都没走完。
   * 索引缺过半却有个完整体积的成品，说明它是上一轮从头重下之前留下的，与索引不再
   * 一一对应，据此跳片会写出半途拼接的成品，比重新下载更糟。
   */
  private async adoptPromotedArtifact(task: DownloadTask, startBytes: number): Promise<number | null> {
    if (!isDownloadPhaseSettled(task)) return null;
    const fileStat = await stat(this.filePath);
    if (!fileStat.exists || fileStat.size < startBytes) return null;

    await renameFile(this.filePath, this.partPath);
    logger.info('下载阶段已完成、只剩收尾：以成品作为续传基线，不再重下', {
      filePath: this.filePath,
      partPath: this.partPath,
      artifactBytes: fileStat.size,
      dbBytes: startBytes,
    });
    return fileStat.size;
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
    const base64 = arrayBufferToBase64(merged.buffer);
    await appendBase64(this.partPath, base64);
    this.writeBuffer = [];
    this.writeBufferSize = 0;
    this.written += merged.byteLength;
  }

  async flush(): Promise<void> {
    if (!this.started) throw new AppError('E_INVALID_STATE', 'sink 未初始化');
    await this.flushBuffer();
  }

  async truncateTo(size: number): Promise<void> {
    if (!this.started) throw new AppError('E_INVALID_STATE', 'sink 未初始化');
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new AppError('E_INVALID_INPUT', '截断长度必须是非负安全整数');
    }
    this.writeBuffer = [];
    this.writeBufferSize = 0;
    await truncatePart(this.partPath, size);
    this.written = size;
  }

  async finish(): Promise<{ filePath: string | null; blobKey: string | null; size: number }> {
    if (!this.started) {
      return { filePath: null, blobKey: null, size: 0 };
    }

    // P1-1: 刷出剩余缓冲
    await this.flushBuffer();
    this.started = false;

    /*
     * DL-P1-1：先按磁盘真实大小对账，再决定要不要把 `.part` 晋升成成品。
     *
     * 旧顺序是「先 rename，再比较计数器」——两边都比的是内存计数，自己跟自己对账永远相等，
     * 真截断反而查不出来，而且比较失败时文件已经叫成成品名、库里也已经写了 filePath。
     * 现在不一致就不 rename：半截文件留在 `.part` 里既能续传，也不会被播放侧当成成品。
     */
    const partStat = await stat(this.partPath);
    if (!partStat.exists) {
      throw new AppError('E_FILE_MISSING', '下载写入的临时文件不见了，请重新下载这一集', {
        detail: this.partPath,
      });
    }
    if (partStat.size !== this.written) {
      logger.error('.part 实际大小与写入计数不一致，不晋升为成品', {
        partPath: this.partPath,
        fileBytes: partStat.size,
        written: this.written,
      });
      throw new AppError(
        'E_LOCAL_CORRUPT',
        `本地落盘大小与写入字节数不一致（磁盘 ${partStat.size} / 计数 ${this.written}），已保留断点`,
        { retryable: true },
      );
    }

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

    // 以磁盘实际大小回报：引擎那句「产物大小 vs 写入计数」从此比的是真实文件，
    // 不再是一个恒成立的等式。
    return { filePath: this.filePath, blobKey: null, size: partStat.size };
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
      // P0-4：合并后的产物跟着清单声明的容器走。fMP4 是 MP4 家族，标成 `video/mp2t`
      // 会让 Web 端 `<video>` 与 Blob 回放按 TS 找解码器；仍未判定容器时保持旧口径。
      if (task.container === 'fmp4' || task.container === 'mp4') return 'video/mp4';
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
