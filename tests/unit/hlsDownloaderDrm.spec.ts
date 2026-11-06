import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { createHlsDownloader } from '@/services/hlsDownloader';
import { blobRepo } from '@/db/repositories/blobRepo';
import { settingsService } from '@/services/settingsService';
import type { DownloadSink } from '@/services/downloadSink';
import type { DownloadTask } from '@/types';

/**
 * FIX-03 / AC-40 回归：受保护（非 AES-128）加密的 HLS **下载侧**必须直接失败
 *
 * 背景：旧实现只对 `METHOD==='AES-128'` 解密，SAMPLE-AES / SAMPLE-AES-CTR 分片被原样
 * 拼接进产物，任务仍显示「已完成」——用户得到一个不可播的文件且没有任何错误提示。
 *
 * 期望（Q-02 决策 A）：
 * - 清单解析完成后、写任何字节之前抛 `E_DRM_PROTECTED`；
 * - 不创建 sink、不请求分片/密钥、不产生 blob、不落 completedAt；
 * - 不做 DRM 绕过尝试。
 */

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-drm',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: overrides.url ?? 'https://cdn.example.com/master.m3u8',
    headers: {},
    format: 'hls',
    quality: null,
    status: 'downloading',
    priority: 1,
    totalBytes: null,
    downloadedBytes: 0,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: false,
    sink: overrides.sink ?? 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

/** 直接含 SAMPLE-AES 的单层 media playlist */
const SAMPLE_AES_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example.com/key.bin",IV=0x00000000000000000000000000000001
#EXTINF:9.009,
https://cdn.example.com/segment0.ts
#EXTINF:9.009,
https://cdn.example.com/segment1.ts
#EXT-X-ENDLIST`;

/** master → media（受保护藏在子清单里） */
const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
https://cdn.example.com/720p.m3u8`;

const SAMPLE_AES_CTR_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="https://cdn.example.com/license"
#EXTINF:9.009,
https://cdn.example.com/segment0.ts
#EXT-X-ENDLIST`;

function createMockFetch(responses: Map<string, string>) {
  return vi.fn(async (url: string) => {
    const body = responses.get(String(url));
    if (body === undefined) return new Response('Not Found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  });
}

describe('FIX-03 HLS 下载：受保护加密直接拒绝（AC-40）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  it('单层清单命中 SAMPLE-AES：抛 E_DRM_PROTECTED，且不建 sink、不写分片、不产完成态', async () => {
    const fetchImpl = createMockFetch(new Map([['https://cdn.example.com/master.m3u8', SAMPLE_AES_MEDIA_PLAYLIST]]));
    const saveProgress = vi.fn(async (_id: string, _patch: Partial<DownloadTask>) => undefined);
    const sinkFactory = vi.fn((): DownloadSink => {
      throw new Error('受保护内容不应创建 sink');
    });

    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createSinkImpl: sinkFactory,
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_DRM_PROTECTED',
    });

    // 只请求了清单本身：密钥与分片一个都没发出去
    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toEqual(['https://cdn.example.com/master.m3u8']);
    expect(urls.some((u) => u.includes('segment'))).toBe(false);

    // 未创建 sink → 不可能写入任何字节
    expect(sinkFactory).not.toHaveBeenCalled();

    // 无产物
    expect(await blobRepo.get('task-drm')).toBeNull();

    // 不落「完成」语义（completedAt / 完成态）
    const patches = saveProgress.mock.calls.map((call) => call[1] as Partial<DownloadTask>);
    expect(patches.some((patch) => patch.completedAt !== undefined && patch.completedAt !== null)).toBe(false);
  });

  it('master → media 子清单命中 SAMPLE-AES-CTR：同样在分片请求前拒绝', async () => {
    const fetchImpl = createMockFetch(
      new Map([
        ['https://cdn.example.com/master.m3u8', MASTER_PLAYLIST],
        ['https://cdn.example.com/720p.m3u8', SAMPLE_AES_CTR_PLAYLIST],
      ]),
    );
    const saveProgress = vi.fn(async (_id: string, _patch: Partial<DownloadTask>) => undefined);

    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_DRM_PROTECTED',
    });

    const urls = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain('https://cdn.example.com/720p.m3u8');
    expect(urls.some((u) => u.includes('segment') || u.includes('license'))).toBe(false);
    expect(await blobRepo.get('task-drm')).toBeNull();
  });
});
