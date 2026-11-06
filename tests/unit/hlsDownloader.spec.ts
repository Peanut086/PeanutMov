import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { createHlsDownloader } from '@/services/hlsDownloader';
import { blobRepo } from '@/db/repositories/blobRepo';
import { settingsService } from '@/services/settingsService';
import type { DownloadTask } from '@/types';

/**
 * 关于 `persistIntervalMs`（QA-01 判定）
 *
 * 旧用例向 `createHlsDownloader` 传了 `persistIntervalMs: 0`，但 `HlsDownloaderDeps`
 * 从引入至今（e4545b8 → HEAD）从未声明该字段，实现侧固定按 1000ms 节流落库；
 * 该选项只存在于 `DownloadEngineDeps`。属**测试写超前**（照抄 DownloadEngine 入参），
 * 不是实现丢能力，故移除该入参，断言保持不变。
 */

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-hls',
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

/** 模拟 HLS master playlist */
const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f"
https://cdn.example.com/720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080,CODECS="avc1.640028"
https://cdn.example.com/1080p.m3u8`;

/** 模拟 HLS media playlist */
const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
https://cdn.example.com/segment0.ts
#EXTINF:9.009,
https://cdn.example.com/segment1.ts
#EXTINF:9.009,
https://cdn.example.com/segment2.ts
#EXT-X-ENDLIST`;

/** 模拟加密的 media playlist */
const ENCRYPTED_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin",IV=0x00000000000000000000000000000001
#EXTINF:9.009,
https://cdn.example.com/segment0.ts
#EXTINF:9.009,
https://cdn.example.com/segment1.ts
#EXT-X-ENDLIST`;

/** 模拟 fMP4 playlist */
const FMP4_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="https://cdn.example.com/init.mp4"
#EXTINF:9.009,
https://cdn.example.com/segment0.m4s
#EXTINF:9.009,
https://cdn.example.com/segment1.m4s
#EXT-X-ENDLIST`;

/** 创建模拟 fetch */
function createMockFetch(responses: Map<string, { body: string | Uint8Array; status?: number }>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const response = responses.get(url);
    if (!response) {
      return new Response('Not Found', { status: 404 });
    }
    const body = typeof response.body === 'string'
      ? response.body
      : response.body;
    return new Response(body, {
      status: response.status ?? 200,
      headers: { 'content-type': typeof response.body === 'string' ? 'application/vnd.apple.mpegurl' : 'video/MP2T' },
    });
  });
}

describe('HLS 下载（Phase 2）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  describe('Master Playlist 选择', () => {
    it('选择最高码率变体', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: MASTER_PLAYLIST }],
        ['https://cdn.example.com/1080p.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: new Uint8Array(100) }],
        ['https://cdn.example.com/segment1.ts', { body: new Uint8Array(100) }],
        ['https://cdn.example.com/segment2.ts', { body: new Uint8Array(100) }],
      ]);
      const fetchImpl = createMockFetch(responses);

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await downloader.run(task(), new AbortController().signal);

      // 应该请求 1080p（最高码率）
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://cdn.example.com/1080p.m3u8',
        expect.any(Object),
      );
    });
  });

  describe('Media Playlist 解析', () => {
    it('解析分片列表并顺序下载', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: new Uint8Array(100).fill(0) }],
        ['https://cdn.example.com/segment1.ts', { body: new Uint8Array(100).fill(1) }],
        ['https://cdn.example.com/segment2.ts', { body: new Uint8Array(100).fill(2) }],
      ]);
      const fetchImpl = createMockFetch(responses);

      const downloader = createHlsDownloader({
        load: async () => task({ url: 'https://cdn.example.com/master.m3u8' }),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await downloader.run(task({ url: 'https://cdn.example.com/master.m3u8' }), new AbortController().signal);

      // 应该下载所有 3 个分片
      expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.com/segment0.ts', expect.any(Object));
      expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.com/segment1.ts', expect.any(Object));
      expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example.com/segment2.ts', expect.any(Object));

      // 检查 blob 大小（3 * 100 = 300）
      const blob = await blobRepo.get('task-hls');
      expect(blob?.size).toBe(300);
    });
  });

  describe('加密方式：AES-128 不应被 DRM 守卫误拒', () => {
    it('AES-128 清单继续进入密钥获取，不抛 E_DRM_PROTECTED', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: ENCRYPTED_PLAYLIST }],
        ['https://cdn.example.com/key.bin', { body: new Uint8Array(16).fill(3) }],
        ['https://cdn.example.com/segment0.ts', { body: new Uint8Array(96) }],
        ['https://cdn.example.com/segment1.ts', { body: new Uint8Array(96) }],
      ]);
      const fetchImpl = createMockFetch(responses);

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      // 解密结果不在本用例关注范围（假密钥），只关心"清单阶段有没有被误判成 DRM"
      const error = await downloader.run(task(), new AbortController().signal).then(
        () => null,
        (e: { code?: string }) => e,
      );

      expect(error?.code).not.toBe('E_DRM_PROTECTED');
      const calls = fetchImpl.mock.calls.map((c) => String(c[0]));
      expect(calls).toContain('https://cdn.example.com/key.bin');
    });
  });

  describe('fMP4 初始化分片', () => {
    it('下载并写入 init segment', async () => {
      const initData = new Uint8Array(50).fill(99);
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: FMP4_PLAYLIST }],
        ['https://cdn.example.com/init.mp4', { body: initData }],
        ['https://cdn.example.com/segment0.m4s', { body: new Uint8Array(100) }],
        ['https://cdn.example.com/segment1.m4s', { body: new Uint8Array(100) }],
      ]);
      const fetchImpl = createMockFetch(responses);

      const downloader = createHlsDownloader({
        load: async () => task({ url: 'https://cdn.example.com/master.m3u8' }),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await downloader.run(task({ url: 'https://cdn.example.com/master.m3u8' }), new AbortController().signal);

      // 应该先请求 init segment
      const calls = fetchImpl.mock.calls.map((c) => c[0]);
      const initIdx = calls.indexOf('https://cdn.example.com/init.mp4');
      const seg0Idx = calls.indexOf('https://cdn.example.com/segment0.m4s');
      expect(initIdx).toBeLessThan(seg0Idx);

      // 总大小 = init(50) + seg0(100) + seg1(100) = 250
      const blob = await blobRepo.get('task-hls');
      expect(blob?.size).toBe(250);
    });
  });

  describe('并行分片下载', () => {
    it('parallelSegments 控制并发数', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: new Uint8Array(100) }],
        ['https://cdn.example.com/segment1.ts', { body: new Uint8Array(100) }],
        ['https://cdn.example.com/segment2.ts', { body: new Uint8Array(100) }],
      ]);

      // 使用延迟模拟慢速请求
      let concurrentCount = 0;
      let maxConcurrent = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        if (url.includes('segment')) {
          concurrentCount++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCount);
          await new Promise((r) => setTimeout(r, 50));
          concurrentCount--;
        }
        const response = responses.get(url);
        return new Response(response?.body ?? '', { status: 200 });
      });

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        parallelSegments: 2, // 限制为 2 并发
      });

      await downloader.run(task(), new AbortController().signal);

      // 最大并发应该不超过 2
      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  });

  describe('取消支持', () => {
    it('signal.aborted 时抛出 E_ABORTED', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: new Uint8Array(100) }],
      ]);

      // 慢速 fetch，让取消有机会触发
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        await new Promise((r) => setTimeout(r, 100));
        const response = responses.get(url);
        return new Response(response?.body ?? '', { status: 200 });
      });

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      await expect(downloader.run(task(), controller.signal)).rejects.toMatchObject({
        code: 'E_ABORTED',
      });
    });
  });

  describe('错误处理', () => {
    it('HTTP 404 抛 E_HTTP_404', async () => {
      const fetchImpl = vi.fn(async () => new Response('Not Found', { status: 404 }));

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_HTTP_404',
      });
    });

    it('空 playlist 抛 E_PARSE', async () => {
      const emptyPlaylist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-ENDLIST`;
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: emptyPlaylist }],
      ]);
      const fetchImpl = createMockFetch(responses);

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_PARSE',
      });
    });
  });

  describe('进度上报', () => {
    it('每 1 秒上报一次进度', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: new Uint8Array(100) }],
        ['https://cdn.example.com/segment1.ts', { body: new Uint8Array(100) }],
        ['https://cdn.example.com/segment2.ts', { body: new Uint8Array(100) }],
      ]);

      let nowValue = 0;
      const fetchImpl = createMockFetch(responses);
      const progressCalls: Array<{ downloadedBytes: number; speedBps: number }> = [];

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async (_id, patch) => {
          if (patch.downloadedBytes !== undefined && patch.speedBps !== undefined) {
            progressCalls.push({
              downloadedBytes: patch.downloadedBytes,
              speedBps: patch.speedBps,
            });
          }
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => {
          nowValue += 500; // 每次调用增加 500ms
          return nowValue;
        },
      });

      await downloader.run(task(), new AbortController().signal);

      // 应该有进度上报
      expect(progressCalls.length).toBeGreaterThan(0);
    });
  });
});
