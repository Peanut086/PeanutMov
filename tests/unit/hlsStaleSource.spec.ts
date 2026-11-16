import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll, tsSegment } from './helpers';
import { createHlsDownloader, nonManifestBodyError, parseM3u8 } from '@/services/hlsDownloader';
import { settingsService } from '@/services/settingsService';
import type { DownloadTask } from '@/types';

/**
 * 11-14 #3：源侧「200 的错误页」与瞬时限流不该把任务判死。
 *
 * 现场：下载偶发中断后再也下不动，错误面板写着「缺少 #EXTM3U 头」——
 * 那其实是源站返回的防盗链/过期页（正文里就是「缺少 xxx 头」），
 * 被当成清单格式错误（E_PARSE 不可重试），分片重试也被 AppError 短路。
 */

const MANIFEST_URL = 'https://cdn.example.com/master.m3u8';
const SEGMENT_URL = 'https://cdn.example.com/segment0.ts';

const ONE_SEGMENT_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
${SEGMENT_URL}
#EXT-X-ENDLIST`;

function task(): DownloadTask {
  const now = Date.now();
  return {
    id: 'task-stale',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: MANIFEST_URL,
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
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

/** 分片按调用次序返回不同响应；清单恒定 */
function mockFetch(segmentResponses: Array<{ body: string | Uint8Array; status?: number; contentType?: string }>) {
  let segmentCalls = 0;
  const impl = vi.fn(async (url: string) => {
    if (url === MANIFEST_URL) {
      return new Response(ONE_SEGMENT_PLAYLIST, {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    const next = segmentResponses[Math.min(segmentCalls, segmentResponses.length - 1)]!;
    segmentCalls += 1;
    return new Response(next.body, {
      status: next.status ?? 200,
      headers: { 'content-type': next.contentType ?? 'video/MP2T' },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls: () => segmentCalls };
}

function runDownloader(segmentResponses: Parameters<typeof mockFetch>[0]) {
  const fetchMock = mockFetch(segmentResponses);
  const downloader = createHlsDownloader({
    load: async () => task(),
    saveProgress: async () => undefined,
    fetchImpl: fetchMock.impl,
  });
  return { promise: downloader.run(task(), new AbortController().signal), fetchMock };
}

describe('清单错误体分类（#3）', () => {
  it('HTML 错误页归为可重试的源不可用，不再冒充「缺少 #EXTM3U 头」', () => {
    const html = '<!DOCTYPE html><html><head><title>403</title></head><body>缺少 Referer 头</body></html>';
    const err = nonManifestBodyError(html, 'text/html; charset=utf-8');
    expect(err?.code).toBe('E_SOURCE_UNAVAILABLE');
    expect(err?.retryable).toBe(true);
    expect(err?.message).toContain('网页而不是视频清单');
    expect(err?.message).not.toContain('#EXTM3U');
    // 源站原话留在 detail 里，便于定位是哪一道防盗链
    expect(err?.detail).toContain('缺少 Referer 头');
  });

  it('JSON 接口错误体同样归为源不可用', () => {
    const err = nonManifestBodyError('{"code":401,"msg":"缺少 token 头"}', 'application/json');
    expect(err?.code).toBe('E_SOURCE_UNAVAILABLE');
    expect(err?.message).toContain('接口错误');
  });

  it('content-type 说是网页、正文却不带标签时也认（正文嗅探只是兜底）', () => {
    expect(nonManifestBodyError('access denied', 'text/html')?.code).toBe('E_SOURCE_UNAVAILABLE');
  });

  it('真正的坏清单仍是 E_PARSE，不被误判成源问题', () => {
    expect(nonManifestBodyError('just some text', 'text/plain')).toBeNull();
    expect(() => parseM3u8('just some text', MANIFEST_URL, 'text/plain')).toThrowError(
      expect.objectContaining({ code: 'E_PARSE' }),
    );
  });

  it('正常清单不受影响', () => {
    expect(nonManifestBodyError(ONE_SEGMENT_PLAYLIST, 'application/vnd.apple.mpegurl')).toBeNull();
    const playlist = parseM3u8(ONE_SEGMENT_PLAYLIST, MANIFEST_URL, 'application/vnd.apple.mpegurl');
    expect(playlist.segments).toHaveLength(1);
  });

  it('parseM3u8 收到 200 的 HTML 时抛源不可用（而不是解析失败）', () => {
    expect(() => parseM3u8('<html><body>deny</body></html>', MANIFEST_URL, 'text/html')).toThrowError(
      expect.objectContaining({ code: 'E_SOURCE_UNAVAILABLE' }),
    );
  });
});

describe('分片重试与坏产物防护（#3）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  it('分片一次 503 后退避重试成功，不再整任务判死', async () => {
    const { promise, fetchMock } = runDownloader([
      { body: 'busy', status: 503 },
      { body: tsSegment(1) },
    ]);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock.calls()).toBe(2);
  }, 10_000);

  it('分片被限流（429）同样重试成功', async () => {
    const { promise, fetchMock } = runDownloader([
      { body: 'slow down', status: 429 },
      { body: tsSegment(1) },
    ]);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock.calls()).toBe(2);
  }, 10_000);

  it('404 是不可重试错误：立即失败，不做无谓退避', async () => {
    const { promise, fetchMock } = runDownloader([{ body: 'gone', status: 404 }]);
    await expect(promise).rejects.toMatchObject({ code: 'E_HTTP_404' });
    expect(fetchMock.calls()).toBe(1);
  });

  it('200 的 HTML 错误页不会被当分片写进产物', async () => {
    const { promise } = runDownloader([
      { body: '<html><body>缺少签名头</body></html>', contentType: 'text/html' },
    ]);
    await expect(promise).rejects.toMatchObject({ code: 'E_SOURCE_UNAVAILABLE' });
  }, 15_000);
});