/**
 * HLS 分片下载与合并
 *
 * 职责：
 * - 解析 m3u8 清单，提取所有 .ts 分片 URL
 * - 顺序下载每个分片
 * - 合并到 sink（NativeFsSink 或 IdbBlobSink）
 * - 支持取消（通过 AbortSignal）
 */
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { createSink, type DownloadSink } from '@/services/downloadSink';
import type { DownloadTask } from '@/types';

export interface HlsDownloaderDeps {
  load: (id: string) => Promise<DownloadTask | null>;
  saveProgress: (id: string, patch: Partial<DownloadTask>) => Promise<void>;
  fetchImpl?: typeof fetch;
  createSinkImpl?: (kind: DownloadTask['sink']) => DownloadSink;
  now?: () => number;
}

interface HlsSegment {
  url: string;
  duration: number;
}

/**
 * 解析 m3u8 清单文本，提取分片列表
 */
function parseM3u8(manifest: string, baseUrl: string): HlsSegment[] {
  const lines = manifest.split('\n').map((l) => l.trim());
  const segments: HlsSegment[] = [];
  let currentDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      if (match) {
        currentDuration = parseFloat(match[1]);
      }
    } else if (line && !line.startsWith('#')) {
      const url = resolveUrl(line, baseUrl);
      segments.push({ url, duration: currentDuration });
      currentDuration = 0;
    }
  }

  if (segments.length === 0) {
    throw new AppError('E_PARSE', 'm3u8 清单中未找到任何分片');
  }

  return segments;
}

/**
 * 解析相对/绝对 URL
 */
function resolveUrl(url: string, baseUrl: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('//')) {
    return 'https:' + url;
  }
  if (url.startsWith('/')) {
    const base = new URL(baseUrl);
    return `${base.protocol}//${base.host}${url}`;
  }
  const base = new URL(baseUrl);
  const dir = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
  return `${base.protocol}//${base.host}${dir}${url}`;
}

export class HlsDownloader {
  constructor(private readonly deps: HlsDownloaderDeps) {}

  async run(task: DownloadTask, signal: AbortSignal): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch.bind(globalThis);
    const sinkFactory = this.deps.createSinkImpl ?? createSink;
    const now = this.deps.now ?? Date.now;

    logger.debug('开始 HLS 下载', { taskId: task.id, url: task.url });

    let manifest: string;
    try {
      const response = await fetchImpl(task.url, {
        method: 'GET',
        headers: task.headers,
        signal,
        cache: 'no-store',
      });
      if (!response.ok) {
        const code = response.status === 401 ? 'E_AUTH' :
                     response.status === 403 ? 'E_HTTP_403' :
                     response.status === 404 ? 'E_HTTP_404' :
                     response.status >= 500 ? 'E_HTTP_5XX' : 'E_HTTP_400';
        throw new AppError(code, `获取 m3u8 清单失败：HTTP ${response.status}`);
      }
      manifest = await response.text();
    } catch (e) {
      throw toAppError(e, 'E_NETWORK');
    }

    const segments = parseM3u8(manifest, task.url);
    logger.debug('解析到分片', { count: segments.length });

    const totalBytes = null;
    const sink = sinkFactory(task.sink);
    await sink.begin({ task: { ...task, resumable: false }, startBytes: 0 });

    let downloaded = 0;
    let lastPersist = now();
    let lastSampleAt = now();
    let lastSampleBytes = 0;

    await this.deps.saveProgress(task.id, {
      status: 'downloading',
      downloadedBytes: 0,
      totalBytes,
      resumable: false,
      speedBps: 0,
      updatedAt: now(),
    });

    try {
      for (let i = 0; i < segments.length; i++) {
        if (signal.aborted) throw new AppError('E_ABORTED');

        const segment = segments[i];
        logger.debug('下载分片', { index: i, url: segment.url });

        const response = await fetchImpl(segment.url, {
          method: 'GET',
          headers: task.headers,
          signal,
          cache: 'no-store',
        });

        if (!response.ok) {
          const code = response.status === 401 ? 'E_AUTH' :
                       response.status === 403 ? 'E_HTTP_403' :
                       response.status === 404 ? 'E_HTTP_404' :
                       response.status >= 500 ? 'E_HTTP_5XX' : 'E_HTTP_400';
          throw new AppError(code, `下载分片失败：${segment.url}`);
        }

        const buffer = new Uint8Array(await response.arrayBuffer());
        await sink.write(buffer);
        downloaded += buffer.byteLength;

        const currentTime = now();
        if (currentTime - lastPersist >= 1000) {
          const elapsedSec = Math.max((currentTime - lastSampleAt) / 1000, 0.001);
          const speedBps = Math.max(0, Math.round((downloaded - lastSampleBytes) / elapsedSec));
          lastPersist = currentTime;
          lastSampleAt = currentTime;
          lastSampleBytes = downloaded;
          await this.deps.saveProgress(task.id, {
            downloadedBytes: downloaded,
            speedBps,
            updatedAt: currentTime,
          });
        }
      }

      const result = await sink.finish();
      await this.deps.saveProgress(task.id, {
        downloadedBytes: downloaded,
        totalBytes: downloaded,
        filePath: result.filePath,
        blobKey: result.blobKey,
        speedBps: 0,
        updatedAt: now(),
        completedAt: now(),
      });

      logger.debug('HLS 下载完成', { taskId: task.id, size: downloaded });
    } catch (e) {
      await sink.abort().catch(() => undefined);
      throw toAppError(e, 'E_UNKNOWN');
    }
  }
}

export function createHlsDownloader(deps: HlsDownloaderDeps): HlsDownloader {
  return new HlsDownloader(deps);
}
