/**
 * 下载引擎（API-09 下载执行）
 *
 * 职责：
 * - 用 fetch 流式读取（`responseType: stream`），按 Range 续传（AC-73）；
 * - 服务端不支持 Range → `task.resumable = false`，从 0 重下并 toast（技术方案 6 章）；
 * - 每 `DOWNLOAD_PROGRESS_PERSIST_MS` 落库一次进度，节流避免频繁写；
 * - 配额错误映射 `E_STORAGE_QUOTA`，失败时清理 sink（AC-76）。
 */
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { DOWNLOAD_PROGRESS_PERSIST_MS } from '@/shared/constants';
import { createSink, type DownloadSink } from '@/services/downloadSink';
import { appEvents } from '@/services/events';
import type { DownloadTask } from '@/types';

export interface DownloadEngineDeps {
  /** 读取任务最新状态（用于判断是否被暂停/取消） */
  load: (id: string) => Promise<DownloadTask | null>;
  /** 保存进度（字节数、总大小、速度） */
  saveProgress: (id: string, patch: Partial<DownloadTask>) => Promise<void>;
  /** fetch 实现（测试注入） */
  fetchImpl?: typeof fetch;
  /** sink 工厂（测试注入） */
  createSinkImpl?: (kind: DownloadTask['sink']) => DownloadSink;
  /** 进度持久化间隔（毫秒） */
  persistIntervalMs?: number;
  /** 当前时间戳（测试注入） */
  now?: () => number;
}

export interface DownloadProgressEvent {
  taskId: string;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number;
  resumable: boolean;
}

/** 单次读取上限：过大分块会长时间占用主线程 */
const READ_CHUNK_LIMIT = 256 * 1024;

function parseContentLength(headers: Headers): number | null {
  const raw = headers.get('content-length');
  if (!raw) return null;
  const num = Number.parseInt(raw, 10);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

/** Range 是否被服务端接受 */
function rangeAccepted(status: number): boolean {
  return status === 206;
}

export class DownloadEngine {
  constructor(private readonly deps: DownloadEngineDeps) {}

  /**
   * 执行一次下载（失败抛 AppError；取消抛 `E_ABORTED`）。
   * `signal` 来自队列，暂停/取消时会 abort。
   */
  async run(task: DownloadTask, signal: AbortSignal): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch.bind(globalThis);
    const sinkFactory = this.deps.createSinkImpl ?? createSink;
    const now = this.deps.now ?? Date.now;
    const persistInterval = this.deps.persistIntervalMs ?? DOWNLOAD_PROGRESS_PERSIST_MS;

    const startBytes = task.resumable ? task.downloadedBytes : 0;
    const headers: Record<string, string> = { ...task.headers };
    if (startBytes > 0) headers['Range'] = `bytes=${startBytes}-`;

    let response: Response;
    try {
      response = await fetchImpl(task.url, { method: 'GET', headers, signal, cache: 'no-store' });
    } catch (e) {
      throw toAppError(e, 'E_NETWORK');
    }

    if (!response.ok && response.status !== 206) {
      if (response.status === 416 && startBytes > 0) {
        // 续传位置越界：从头重下
        await this.deps.saveProgress(task.id, {
          resumable: false,
          downloadedBytes: 0,
          updatedAt: now(),
        });
        appEvents.emit('toast', { text: '该地址不支持断点续传，将重新下载', type: 'info' });
        return this.run({ ...task, resumable: false, downloadedBytes: 0 }, signal);
      }
      throw new AppError(
        response.status === 401 || response.status === 403
          ? 'E_AUTH'
          : response.status >= 500
            ? 'E_HTTP_5XX'
            : response.status === 404
              ? 'E_HTTP_404'
              : response.status === 429
                ? 'E_HTTP_429'
                : 'E_UNKNOWN',
        undefined,
        { httpStatus: response.status },
      );
    }

    let resumable = startBytes > 0 && rangeAccepted(response.status);
    if (startBytes > 0 && !rangeAccepted(response.status)) {
      // 服务端忽略 Range：从 0 开始（AC-73）
      resumable = false;
      appEvents.emit('toast', { text: '该地址不支持断点续传，将重新下载', type: 'info' });
      await this.deps.saveProgress(task.id, { resumable: false, downloadedBytes: 0, updatedAt: now() });
    }

    const contentLength = parseContentLength(response.headers);
    const totalBytes =
      contentLength === null ? task.totalBytes : resumable ? startBytes + contentLength : contentLength;

    const sink = sinkFactory(task.sink);
    await sink.begin({ task: { ...task, resumable }, startBytes: resumable ? startBytes : 0 });

    let downloaded = resumable ? startBytes : 0;
    let lastPersist = now();
    let lastSampleAt = now();
    let lastSampleBytes = downloaded;

    await this.deps.saveProgress(task.id, {
      status: 'downloading',
      downloadedBytes: downloaded,
      totalBytes,
      resumable,
      speedBps: 0,
      updatedAt: now(),
    });

    const body = response.body;
    try {
      if (!body) {
        // 无流式 body：整体读入（小文件兜底）
        const buffer = new Uint8Array(await response.arrayBuffer());
        await sink.write(buffer);
        downloaded += buffer.byteLength;
      } else {
        const reader = body.getReader();
        for (;;) {
          if (signal.aborted) throw new AppError('E_ABORTED');
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          let offset = 0;
          while (offset < value.byteLength) {
            const end = Math.min(offset + READ_CHUNK_LIMIT, value.byteLength);
            const slice = value.subarray(offset, end);
            await sink.write(slice);
            downloaded += slice.byteLength;
            offset = end;
          }
          const currentTime = now();
          if (currentTime - lastPersist >= persistInterval) {
            const elapsedSec = Math.max((currentTime - lastSampleAt) / 1000, 0.001);
            const speedBps = Math.max(0, Math.round((downloaded - lastSampleBytes) / elapsedSec));
            lastPersist = currentTime;
            lastSampleAt = currentTime;
            lastSampleBytes = downloaded;
            await this.deps.saveProgress(task.id, {
              downloadedBytes: downloaded,
              totalBytes,
              speedBps,
              updatedAt: currentTime,
            });
            appEvents.emit('downloads:changed', { id: task.id });
          }
        }
      }

      const result = await sink.finish();
      await this.deps.saveProgress(task.id, {
        downloadedBytes: result.size > 0 ? result.size : downloaded,
        totalBytes: totalBytes ?? (result.size > 0 ? result.size : downloaded),
        filePath: result.filePath,
        blobKey: result.blobKey,
        speedBps: 0,
        updatedAt: now(),
        completedAt: now(),
      });
    } catch (e) {
      await sink.abort().catch(() => undefined);
      throw toAppError(e, 'E_UNKNOWN');
    }
  }
}

/**
 * 简化实现：`downloadEngine.download(task, signal)`。
 * 服务层在创建时注入真实依赖。
 */
export function createDownloadEngine(deps: DownloadEngineDeps): DownloadEngine {
  return new DownloadEngine(deps);
}

/** 默认（模块级）引擎依赖占位，避免循环依赖；服务层在 bootstrap 时注入实际实现 */
export let downloadEngine: DownloadEngine | null = null;

export function setDownloadEngine(engine: DownloadEngine | null): void {
  downloadEngine = engine;
  logger.debug('下载引擎已更新', { hasEngine: engine !== null });
}
