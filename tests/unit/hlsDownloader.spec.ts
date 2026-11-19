import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1-6 归因依赖在线判定：钉成变量，别靠宿主环境的 `navigator.onLine` 默认值 */
let online = true;
vi.mock('@/native/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/network')>();
  return { ...actual, isOnline: () => online };
});

import { resetAll, tsSegment, fmp4Segment } from './helpers';
import { createHlsDownloader, screenSegmentBytes } from '@/services/hlsDownloader';
import { blobRepo } from '@/db/repositories/blobRepo';
import { settingsService } from '@/services/settingsService';
import { AppError } from '@/shared/errors';
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
    online = true;
    await resetAll();
    settingsService.__resetCache();
  });

  describe('Master Playlist 选择', () => {
    it('选择最高码率变体', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: MASTER_PLAYLIST }],
        ['https://cdn.example.com/1080p.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment1.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment2.ts', { body: tsSegment(1) }],
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
        ['https://cdn.example.com/segment0.ts', { body: tsSegment(1, 0) }],
        ['https://cdn.example.com/segment1.ts', { body: tsSegment(1, 1) }],
        ['https://cdn.example.com/segment2.ts', { body: tsSegment(1, 2) }],
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

      // 检查 blob 大小（3 × 188 = 564）
      const blob = await blobRepo.get('task-hls');
      expect(blob?.size).toBe(564);
    });
  });

  describe('加密方式：AES-128 不应被 DRM 守卫误拒', () => {
    it('AES-128 清单不在清单阶段被 DRM 守卫拦截，照常进入密钥获取', async () => {
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

      // 解密结果不在本用例关注范围（假密钥），只关心"清单阶段有没有被误判成 DRM"。
      // 假密钥解不开如今会撞到解密判死（同样是 E_DRM_PROTECTED，但发生在分片阶段），
      // 所以按判据区分：清单阶段的守卫把证据写在 detail 里。
      const error = await downloader.run(task(), new AbortController().signal).then(
        () => null,
        (e: { code?: string; detail?: string }) => e,
      );

      expect(error?.detail ?? '').not.toMatch(/不支持的 HLS 加密方式/);
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
        ['https://cdn.example.com/segment0.m4s', { body: fmp4Segment('moof') }],
        ['https://cdn.example.com/segment1.m4s', { body: fmp4Segment('moof') }],
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

      // 总大小 = init(50) + seg0(104) + seg1(104) = 258
      const blob = await blobRepo.get('task-hls');
      expect(blob?.size).toBe(258);
    });
  });

  describe('并行分片下载', () => {
    it('parallelSegments 控制并发数', async () => {
      const responses = new Map([
        ['https://cdn.example.com/master.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment1.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment2.ts', { body: tsSegment(1) }],
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
        ['https://cdn.example.com/segment0.ts', { body: tsSegment(1) }],
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
        ['https://cdn.example.com/segment0.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment1.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment2.ts', { body: tsSegment(1) }],
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

  describe('FIX-PLAY-A2/A3：分片落盘校验', () => {
    it('screenSegmentBytes：合法 TS 原样通过', () => {
      const data = tsSegment(3, 9);
      expect(screenSegmentBytes(data, { url: 'https://cdn.example.com/seg0.ts' })).toBe(data);
    });

    it('screenSegmentBytes：192 包长（带时间码）不再被 188 校验误杀', () => {
      const data = new Uint8Array(192 * 3);
      for (let i = 0; i < 3; i++) data[i * 192] = 0x47;
      expect(screenSegmentBytes(data, { url: 'https://cdn.example.com/seg0.ts' }).length).toBe(192 * 3);
    });

    it('screenSegmentBytes：尾部残包截掉，保留完整包', () => {
      const full = tsSegment(2);
      const data = new Uint8Array(full.length + 77);
      data.set(full);
      data[full.length] = 0x47; // 残包头
      const out = screenSegmentBytes(data, { url: 'https://cdn.example.com/seg0.ts' });
      expect(out.length).toBe(376);
    });

    it('screenSegmentBytes：TS 中途错位/污染抛可重试 E_NETWORK', () => {
      const data = tsSegment(4);
      data[188 * 2] = 0x00; // 第二个包同步字节被改写
      expect(() => screenSegmentBytes(data, { url: 'https://cdn.example.com/seg0.ts' })).toThrow(
        expect.objectContaining({ code: 'E_NETWORK' }),
      );
    });

    it('screenSegmentBytes：.ts 正文错位（污染前缀超过定位窗口）必须拒绝', () => {
      // 模拟图片垃圾响应：整体没有可对齐的 0x47 结构
      const garbage = new Uint8Array(1024).fill(0x89);
      expect(() => screenSegmentBytes(garbage, { url: 'https://cdn.example.com/seg0.ts' })).toThrow(
        expect.objectContaining({ code: 'E_NETWORK' }),
      );
    });

    it('screenSegmentBytes：空响应体拒绝（限流常见 200 空包）', () => {
      expect(() => screenSegmentBytes(new Uint8Array(0), { url: 'https://cdn.example.com/seg0.ts' })).toThrow(
        expect.objectContaining({ code: 'E_NETWORK' }),
      );
    });

    it('screenSegmentBytes：无 TS/fMP4 线索的未知格式维持旧行为不误杀', () => {
      const data = new Uint8Array(64).fill(0xff); // 形似 ADTS 的裸音频
      expect(screenSegmentBytes(data, { url: 'https://cdn.example.com/seg0.aac' })).toBe(data);
    });

    it('screenSegmentBytes：fMP4 box 头谎报超长直接判死', () => {
      const data = fmp4Segment('moof', 96);
      new DataView(data.buffer).setUint32(0, 9999); // size 超过实际分片长度
      expect(() => screenSegmentBytes(data, { url: 'https://cdn.example.com/seg0.m4s' })).toThrow(
        expect.objectContaining({ code: 'E_NETWORK' }),
      );
    });

    it('Content-Length 缺量的分片重试后仍缺 → 任务失败，缺量分片不混入产物', async () => {
      const responses = new Map<string, { body: string | Uint8Array; status?: number }>([
        ['https://cdn.example.com/master.m3u8', { body: MEDIA_PLAYLIST }],
        ['https://cdn.example.com/segment0.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment1.ts', { body: tsSegment(1) }],
        ['https://cdn.example.com/segment2.ts', { body: tsSegment(1) }],
      ]);
      let seg2Attempts = 0;
      const fetchImpl = vi.fn(async (url: string) => {
        if (url === 'https://cdn.example.com/segment2.ts') seg2Attempts += 1;
        const response = responses.get(url);
        if (!response) return new Response('Not Found', { status: 404 });
        // 给 segment2 宣告 376 字节但只回 188：模拟被掐断的短包
        const headers: Record<string, string> = typeof response.body === 'string'
          ? { 'content-type': 'application/vnd.apple.mpegurl' }
          : { 'content-type': 'video/mp2t', 'content-length': url.endsWith('segment2.ts') ? '376' : '188' };
        return new Response(response.body, { status: response.status ?? 200, headers });
      });

      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_NETWORK',
      });
      // 首试 + MAX_SEGMENT_RETRIES(2) 次退避重试
      expect(seg2Attempts).toBe(3);
      // 允许留下可续传的前缀产物，但缺量分片绝不混入、任务绝不进完成态
      const blob = await blobRepo.get('task-hls');
      expect(blob == null || blob.size < 564).toBe(true);
    }, 15_000);
  });

  describe('FIX-PLAY-D1/D2：BYTERANGE 续接与 DISCONTINUITY 元数据（下载侧）', () => {
    it('缺省偏移隐式续接上一个 range；完成落库带 hlsDiscontinuities', async () => {
      const playlist = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9,
#EXT-X-BYTERANGE:188@0
https://cdn.example.com/big.ts
#EXTINF:9,
#EXT-X-BYTERANGE:188
https://cdn.example.com/big.ts
#EXT-X-DISCONTINUITY
#EXTINF:9,
#EXT-X-BYTERANGE:188@564
https://cdn.example.com/big.ts
#EXT-X-ENDLIST`;
      const ranges: Array<string | null> = [];
      const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('.m3u8')) {
          return new Response(playlist, {
            status: 200,
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          });
        }
        ranges.push(new Headers(init?.headers).get('range'));
        return new Response(tsSegment(1), { status: 206, headers: { 'content-type': 'video/mp2t' } });
      });
      const patches: Array<Record<string, unknown>> = [];
      const downloader = createHlsDownloader({
        load: async () => task(),
        saveProgress: async (_id, patch) => {
          patches.push(patch as Record<string, unknown>);
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      await downloader.run(task(), new AbortController().signal);

      expect(ranges).toEqual(['bytes=0-187', 'bytes=188-375', 'bytes=564-751']);
      const finalPatch = patches[patches.length - 1]!;
      expect(finalPatch.hlsTotalSegments).toBe(3);
      expect(finalPatch.hlsDiscontinuities).toBe(1);
    }, 15_000);
  });
});

/**
 * P1-6：清单进不去时的归因
 *
 * 死线路的 DNS 解析失败在旧实现里一律报成「网络不可用，请检查网络后重试」，
 * 用户照着去查自己的网络，查不到任何东西——那台设备是在线的，挂的是这个源。
 */
describe('m3u8 清单连不上时的归因（P1-6）', () => {
  async function runWith(rejectWith: unknown): Promise<unknown> {
    online = true;
    await resetAll();
    settingsService.__resetCache();
    const fetchImpl = vi.fn(async () => {
      throw rejectWith;
    });
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return downloader.run(task(), new AbortController().signal).catch((e: unknown) => e);
  }

  it('设备在线但清单连不上 → 归因到线路', async () => {
    const err = await runWith(new TypeError('Failed to fetch'));
    expect(err).toMatchObject({
      code: 'E_SOURCE_UNAVAILABLE',
      message: expect.stringContaining('本机网络正常'),
    });
  });

  it('设备真离线 → 保留原文案 E_NETWORK', async () => {
    online = false;
    await resetAll();
    settingsService.__resetCache();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const err = await downloader.run(task(), new AbortController().signal).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'E_NETWORK' });
    online = true;
  });

  it('已明说成因的错误不改写（超时/取消仍按原结论上报）', async () => {
    const timeout = await runWith(new AppError('E_NETWORK', '清单直连请求超时: https://cdn.example.com/master.m3u8'));
    expect(timeout).toMatchObject({ code: 'E_NETWORK', message: '清单直连请求超时: https://cdn.example.com/master.m3u8' });

    const aborted = await runWith(new AppError('E_ABORTED', 'aborted'));
    expect(aborted).toMatchObject({ code: 'E_ABORTED' });
  });
});
