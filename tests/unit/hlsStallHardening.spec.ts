import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { createHlsDownloader } from '@/services/hlsDownloader';
import { settingsService } from '@/services/settingsService';
import type { DownloadTask } from '@/types';

/**
 * 11-17 下载停滞批次的下载器侧收口（真机日志定案后补的用例）：
 * - CDN 的 402 是「URL 签名过期」，必须走换直链那条路，而不是留在 E_HTTP_400 里判死；
 * - 一轮退出要把在途分片全部中止，否则僵尸请求会和下一轮并发打同一批地址（429/进度永远 0）；
 * - 密钥解不开要在几片之内判死，不能对 987 片各重试 3 次空跑。
 */

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: 'task-stall-hls',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/index.m3u8',
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
    ...overrides,
  };
}

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.0,
https://cdn.example.com/segment0.ts
#EXTINF:9.0,
https://cdn.example.com/segment1.ts
#EXT-X-ENDLIST`;

const ENCRYPTED_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin",IV=0x00000000000000000000000000000001
#EXTINF:9.0,
https://cdn.example.com/segment0.ts
#EXTINF:9.0,
https://cdn.example.com/segment1.ts
#EXT-X-ENDLIST`;

function downloaderFor(fetchImpl: unknown) {
  return createHlsDownloader({
    load: async () => task(),
    saveProgress: async () => undefined,
    fetchImpl: fetchImpl as typeof fetch,
  });
}

beforeEach(async () => {
  await resetAll();
  settingsService.__resetCache();
});

describe('HTTP 402 归入直链失效', () => {
  it('清单返回 402 时给出可刷新的错误码，并保留真实状态码', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<html>payment required</html>', {
        status: 402,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const error = await downloaderFor(fetchImpl)
      .run(task(), new AbortController().signal)
      .catch((e: unknown) => e as { code?: string; message?: string });

    expect(error?.code).toBe('E_HTTP_403');
    expect(error?.message).toContain('HTTP 402');
  });
});

describe('退出即回收在途分片（僵尸请求）', () => {
  it('一轮里有分片失败退出时，其余在途请求的信号全部被中止', async () => {
    const signalsByUrl = new Map<string, AbortSignal[]>();
    const remember = (u: string, init?: RequestInit): void => {
      const list = signalsByUrl.get(u) ?? [];
      list.push(init?.signal as AbortSignal);
      signalsByUrl.set(u, list);
    };
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('.m3u8')) {
        return Promise.resolve(
          new Response(MEDIA_PLAYLIST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }),
        );
      }
      remember(u, init);
      if (u.endsWith('segment0.ts')) {
        return Promise.resolve(new Response('gone', { status: 404 }));
      }
      // 永不 settle：真实场景就是挂在那里的分片请求
      return new Promise<Response>(() => undefined);
    });

    await downloaderFor(fetchImpl).run(task(), new AbortController().signal).catch(() => undefined);

    const hanging = signalsByUrl.get('https://cdn.example.com/segment1.ts') ?? [];
    expect(hanging.length).toBeGreaterThan(0);
    // 僵尸请求必须被这轮退出带走，否则下一轮会和它并发打同一批地址（实测 12 路 → 429/进度 0）
    expect(hanging.every((s) => s.aborted)).toBe(true);
  });
});

describe('密钥解不开时快速判死', () => {
  it('连续解密失败不再空跑整部片，给出换线路的可读原因', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const u = String(url);
      requests.push(u);
      if (u.endsWith('.m3u8')) {
        return new Response(ENCRYPTED_PLAYLIST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      if (u.endsWith('key.bin')) {
        return new Response(new Uint8Array(16).fill(3), { headers: { 'content-type': 'application/octet-stream' } });
      }
      // 长度对齐（16 的倍数）但密钥对不上 → crypto.subtle 只给空消息 OperationError
      return new Response(new Uint8Array(96).fill(7), { headers: { 'content-type': 'video/MP2T' } });
    });

    const error = await downloaderFor(fetchImpl)
      .run(task(), new AbortController().signal)
      .catch((e: unknown) => e as { code?: string; message?: string });

    expect(error?.code).toBe('E_DRM_PROTECTED');
    expect(error?.message).toContain('解密失败');
    // 判死得早：分片请求次数远小于「每片 3 次 × 全片」
    expect(requests.filter((u) => u.endsWith('.ts')).length).toBeLessThanOrEqual(8);
  });
});
