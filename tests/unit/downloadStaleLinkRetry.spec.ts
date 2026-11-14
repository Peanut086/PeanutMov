import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import { libraryService } from '@/services/libraryService';
import type { DownloadTask, ErrorCode, PlaybackSource } from '@/types';

/**
 * 11-14 #3：直链过期后「重试」必须换地址，而不是拿同一个死链再撞一次墙。
 *
 * 现场：下载偶发中断，续传时源站回「缺少 xxx 头」，此后无论点多少次重试都下不动。
 * 断点在 retry 只重置状态、不重新解析直链——签名过期后那个地址已经永久失效。
 *
 * 引擎在此被替换成记录器：断言的是「真正交给下载器的任务」，而不只是库里的字段。
 */

const h = vi.hoisted(() => ({ runs: [] as DownloadTask[] }));

vi.mock('@/services/downloadEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/downloadEngine')>();
  return {
    ...actual,
    createDownloadEngine: () => ({
      run: async (task: DownloadTask) => {
        h.runs.push(task);
      },
    }),
  };
});

const OLD_URL = 'https://cdn.example.com/vod/ep1.m3u8?sign=expired';

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: 'task-stale-retry',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    lineId: 'L1',
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: OLD_URL,
    headers: { Referer: 'https://old.example.com/' },
    format: 'hls',
    quality: null,
    status: 'failed',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 500,
    speedBps: 0,
    retries: 2,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: 'E_SOURCE_UNAVAILABLE',
    errorMessage: '源返回了网页而不是视频清单',
    completedSegments: [0, 1, 2],
    hlsTotalSegments: 10,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function makePlayback(overrides: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    url: 'https://cdn.example.com/vod/ep1.m3u8?sign=fresh',
    format: 'hls',
    headers: { Referer: 'https://new.example.com/' },
    subtitles: [],
    lineId: 'L1',
    quality: null,
    expiresAt: null,
    isLocal: false,
    ...overrides,
  };
}

/** 直接写库造出现场：不经 create，避免队列并发改写状态 */
async function seedFailed(overrides: Partial<DownloadTask> = {}): Promise<DownloadTask> {
  const task = makeTask(overrides);
  await downloadRepo.save(task);
  return task;
}

async function retryAndCapture(): Promise<DownloadTask> {
  await downloadService.retry('task-stale-retry');
  // 队列在微任务里才调度，等它真正把任务交给引擎
  for (let i = 0; i < 100 && h.runs.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const ran = h.runs[h.runs.length - 1];
  if (!ran) throw new Error('重试没有把任务交给下载引擎');
  return ran;
}

describe('失败重试前刷新直链（#3）', () => {
  beforeEach(async () => {
    await resetAll();
    downloadService.__resetQueue();
    h.runs.length = 0;
    vi.restoreAllMocks();
    // 记录型引擎会立刻把任务判完成，连带触发附件/弹幕预取（真实网络）——与本用例无关
    vi.spyOn(downloadService, 'downloadAttachments').mockResolvedValue(undefined);
  });

  it('直链失效类失败：重新解析地址与请求头后才入队', async () => {
    await seedFailed();
    const resolve = vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback());

    const ran = await retryAndCapture();

    expect(resolve).toHaveBeenCalledWith({
      mediaId: 'demo:m1',
      episodeId: 'demo:m1:e1',
      lineId: 'L1',
      prefer: 'network',
    });
    expect(ran.url).toBe('https://cdn.example.com/vod/ep1.m3u8?sign=fresh');
    expect(ran.headers).toEqual({ Referer: 'https://new.example.com/' });
    expect(ran.status).not.toBe('failed');
  });

  it('只换签名（资源路径未变）：保留已下载字节与分片记录，续传不作废', async () => {
    await seedFailed();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback());

    const ran = await retryAndCapture();

    expect(ran.url).toContain('sign=fresh');
    expect(ran.downloadedBytes).toBe(500);
    expect(ran.completedSegments).toEqual([0, 1, 2]);
    expect(ran.resumable).toBe(true);
  });

  it('资源路径变了：进度与分片记录清零，不把旧清单的分片拼到新文件上', async () => {
    await seedFailed();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(
      makePlayback({ url: 'https://cdn.example.com/vod/ep1-720p.m3u8?sign=fresh' }),
    );

    const ran = await retryAndCapture();

    expect(ran.url).toContain('ep1-720p.m3u8');
    expect(ran.downloadedBytes).toBe(0);
    expect(ran.totalBytes).toBeNull();
    expect(ran.completedSegments).toEqual([]);
    expect(ran.hlsTotalSegments).toBe(0);
    expect(ran.resumable).toBe(false);
  });

  it('网络类失败不重新解析（地址没坏，重试即可）', async () => {
    await seedFailed({ errorCode: 'E_NETWORK', errorMessage: '网络中断' });
    const resolve = vi.spyOn(libraryService, 'resolvePlay');

    const ran = await retryAndCapture();

    expect(resolve).not.toHaveBeenCalled();
    expect(ran.url).toBe(OLD_URL);
    expect(ran.downloadedBytes).toBe(500);
  });

  it('解析失败不阻断重试：沿用原地址入队', async () => {
    await seedFailed();
    vi.spyOn(libraryService, 'resolvePlay').mockRejectedValue(new Error('源挂了'));

    const ran = await retryAndCapture();

    expect(ran.url).toBe(OLD_URL);
    expect(ran.downloadedBytes).toBe(500);
  });

  it('解析回吐本地文件桥地址时拒绝采用（否则又是一个进度永远 0 的死任务）', async () => {
    await seedFailed();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(
      makePlayback({ url: 'https://localhost/_capacitor_file_/data/downloads/demo/m1/e1.ts' }),
    );

    const ran = await retryAndCapture();

    expect(ran.url).toBe(OLD_URL);
  });

  it('没有错误码的失败任务不触发解析', async () => {
    await seedFailed({ errorCode: null, errorMessage: null });
    const resolve = vi.spyOn(libraryService, 'resolvePlay');

    await retryAndCapture();

    expect(resolve).not.toHaveBeenCalled();
  });

  it('403/404/鉴权失败同样按直链失效处理', async () => {
    const codes: ErrorCode[] = ['E_HTTP_403', 'E_HTTP_404', 'E_AUTH', 'E_PARSE'];
    const resolve = vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback());
    for (const code of codes) {
      h.runs.length = 0;
      downloadService.__resetQueue();
      resolve.mockClear();
      await seedFailed({ errorCode: code });

      const ran = await retryAndCapture();

      expect(resolve, code).toHaveBeenCalledTimes(1);
      expect(ran.url, code).toContain('sign=fresh');
    }
  });
});