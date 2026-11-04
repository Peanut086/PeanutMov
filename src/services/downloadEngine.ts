/**
 * 下载引擎（API-09 下载执行）
 *
 * 职责：
 * - Phase 1：优先使用 Native 下载器（OkHttp，速度快、支持后台）
 * - 回退到 JS 下载：fetch 流式读取 + Range 续传
 * - 服务端不支持 Range → `task.resumable = false`，从 0 重下并 toast
 * - 每 `DOWNLOAD_PROGRESS_PERSIST_MS` 落库一次进度，节流避免频繁写
 * - 配额错误映射 `E_STORAGE_QUOTA`，失败时清理 sink（AC-76）
 */
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { DOWNLOAD_PROGRESS_PERSIST_MS, DOWNLOAD_WEB_SIZE_WARN_BYTES, DOWNLOAD_SPEED_LIMITS } from '@/shared/constants';
import { createSink, nativeFilePathOf, type DownloadSink } from '@/services/downloadSink';
import { createHlsDownloader } from '@/services/hlsDownloader';
import { appEvents } from '@/services/events';
import { settingsService } from '@/services/settingsService';
import {
  isNativeDownloadAvailable,
  nativeDownloadStart,
  nativeDownloadCancel,
  onProgress,
  onCompleted,
  onError,
} from '@/native/downloadPlugin';
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
    // HLS 分片下载：委托给 HlsDownloader（暂不支持 Native）
    if (task.format === 'hls') {
      const hlsDownloader = createHlsDownloader({
        load: this.deps.load,
        saveProgress: this.deps.saveProgress,
        fetchImpl: this.deps.fetchImpl,
        createSinkImpl: this.deps.createSinkImpl,
        now: this.deps.now,
      });
      await hlsDownloader.run(task, signal);
      return;
    }

    // Phase 1：优先使用 Native 下载器（Android only）
    const useNative = await this.tryNativeDownload(task, signal);
    if (useNative) return;

    // 回退到 JS 下载
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
      // AC-39 / REV-16：401 才是"需要登录"（E_AUTH），403 是"无权限访问"，
      // 不能合并，否则错误面板文案会退化为「认证失败」。
      throw new AppError(
        response.status === 401
          ? 'E_AUTH'
          : response.status === 403
            ? 'E_HTTP_403'
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

    // Web 端 1GB 前置拒绝（FR-33 / AC-76 / REV-07）：已知体积且超限时，
    // 在写入任何分片之前抛明确错误码，避免"先吃掉内存再失败"。
    if (task.sink === 'idb-blob' && totalBytes !== null && totalBytes > DOWNLOAD_WEB_SIZE_WARN_BYTES) {
      throw new AppError('E_STORAGE_QUOTA', '单文件超过 1GB，浏览器环境建议改用 App 下载');
    }

    const sink = sinkFactory(task.sink);
    const beginResult = await sink.begin({ task: { ...task, resumable }, startBytes: resumable ? startBytes : 0 });
    // 以 sink 返回的实际起点为准（可能与 DB 不一致，例如 .part 文件缺失或大小不符）
    const actualStart = beginResult.actualStartBytes;
    if (resumable && actualStart !== startBytes) {
      logger.warn('续传起点已校正', { taskId: task.id, dbBytes: startBytes, actualBytes: actualStart });
      await this.deps.saveProgress(task.id, { downloadedBytes: actualStart, updatedAt: now() });
    }

    let downloaded = resumable ? actualStart : 0;
    let lastPersist = now();
    let lastSampleAt = now();
    let lastSampleBytes = downloaded;

    // 获取限速设置
    let speedLimitBytesPerSec = Infinity;
    try {
      const settings = await settingsService.get();
      speedLimitBytesPerSec = DOWNLOAD_SPEED_LIMITS[settings.download.speedLimit];
    } catch (e) {
      logger.debug('获取限速设置失败，使用不限速', e);
    }

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
        let throttleStart = now();
        let throttleBytes = 0;
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

            // 限速控制：如果超过限速，等待一段时间
            if (speedLimitBytesPerSec < Infinity) {
              throttleBytes += slice.byteLength;
              const elapsed = now() - throttleStart;
              const expectedMs = (throttleBytes / speedLimitBytesPerSec) * 1000;
              if (expectedMs > elapsed) {
                const sleepMs = Math.min(expectedMs - elapsed, 1000); // 最多等 1 秒
                await new Promise((resolve) => setTimeout(resolve, sleepMs));
                if (elapsed > 1000) {
                  // 超过 1 秒重置计数
                  throttleStart = now();
                  throttleBytes = 0;
                }
              }
            }
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
      // 错误处理策略：
      // - Web (idb-blob)：始终 abort()，因为 Web 端不支持续传，保留半截 Blob 无意义
      // - Native (filesystem)：
      //   - 取消 (canceled) → abort() 删除 .part 文件
      //   - 暂停 (paused) 或其他错误 → suspend() 保留 .part 文件供续传
      const appError = toAppError(e, 'E_UNKNOWN');
      if (task.sink === 'idb-blob') {
        await sink.abort().catch(() => undefined);
      } else {
        const currentTask = await this.deps.load(task.id);
        if (currentTask?.status === 'canceled') {
          await sink.abort().catch(() => undefined);
        } else {
          await sink.suspend().catch(() => undefined);
        }
      }
      throw appError;
    }
  }

  /**
   * 尝试使用 Native 下载器（Phase 1）
   * @returns true 如果使用了 Native 下载器（无论成功失败），false 如果应回退到 JS
   */
  private async tryNativeDownload(task: DownloadTask, signal: AbortSignal): Promise<boolean> {
    // 仅 Android 原生环境支持
    if (task.sink !== 'filesystem') return false;

    const available = await isNativeDownloadAvailable();
    if (!available) return false;

    const now = this.deps.now ?? Date.now;
    const filePath = nativeFilePathOf(task);

    logger.debug('Using native downloader', { taskId: task.id, filePath });

    return new Promise<boolean>((resolve) => {
      let resolved = false;
      const removeListeners: Array<() => void> = [];

      const cleanup = () => {
        removeListeners.forEach((fn) => fn());
      };

      // 监听进度
      removeListeners.push(
        onProgress((event) => {
          if (event.taskId !== task.id) return;
          this.deps.saveProgress(task.id, {
            downloadedBytes: event.downloadedBytes,
            totalBytes: event.totalBytes > 0 ? event.totalBytes : task.totalBytes,
            speedBps: event.speedBps,
            updatedAt: now(),
          });
          appEvents.emit('downloads:changed', { id: task.id });
        }),
      );

      // 监听完成
      removeListeners.push(
        onCompleted(async (event) => {
          if (event.taskId !== task.id) return;
          cleanup();
          await this.deps.saveProgress(task.id, {
            downloadedBytes: event.totalBytes,
            totalBytes: event.totalBytes,
            filePath: event.filePath,
            speedBps: 0,
            updatedAt: now(),
            completedAt: now(),
            status: 'completed',
          });
          if (!resolved) {
            resolved = true;
            resolve(true);
          }
        }),
      );

      // 监听错误
      removeListeners.push(
        onError(async (event) => {
          if (event.taskId !== task.id) return;
          cleanup();
          if (!resolved) {
            resolved = true;
            // Native 错误时回退到 JS 下载
            logger.warn('Native download failed, falling back to JS', {
              taskId: task.id,
              errorCode: event.errorCode,
            });
            resolve(false);
          }
        }),
      );

      // 监听取消信号
      const onAbort = () => {
        cleanup();
        nativeDownloadCancel(task.id).catch(() => undefined);
        if (!resolved) {
          resolved = true;
          resolve(true);
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // 启动 Native 下载
      nativeDownloadStart({
        taskId: task.id,
        url: task.url,
        filePath,
        headers: task.headers,
        startBytes: task.resumable ? task.downloadedBytes : 0,
        totalBytes: task.totalBytes ?? -1,
      })
        .then(() => {
          // 更新状态为 downloading
          this.deps.saveProgress(task.id, {
            status: 'downloading',
            updatedAt: now(),
          });
        })
        .catch((e) => {
          cleanup();
          signal.removeEventListener('abort', onAbort);
          logger.error('Failed to start native download', e);
          if (!resolved) {
            resolved = true;
            resolve(false); // 回退到 JS
          }
        });
    });
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
