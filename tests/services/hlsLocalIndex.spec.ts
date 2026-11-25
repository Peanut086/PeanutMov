import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  patches: [] as Array<Record<string, unknown>>,
  writeBase64: vi.fn(async (_path: string, _data: string) => undefined),
  renameFile: vi.fn(async () => undefined),
  deleteFile: vi.fn(async () => undefined),
}));

vi.mock('@/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform')>();
  return { ...actual, isNative: () => true };
});
vi.mock('@/native/localProxy', () => ({
  LocalProxy: { proxy: vi.fn().mockRejectedValue(new Error('proxy unavailable')) },
}));
vi.mock('@/native/mediaToolPlugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/mediaToolPlugin')>();
  return { ...actual, isMediaToolAvailable: () => false };
});
vi.mock('@/native/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/fs')>();
  return {
    ...actual,
    writeBase64: h.writeBase64,
    renameFile: h.renameFile,
    deleteFile: h.deleteFile,
  };
});

import { createHlsDownloader, hlsPlaylistFingerprint, parseM3u8 } from '@/services/hlsDownloader';
import type { DownloadTask } from '@/types';

const MANIFEST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:2,
s0.ts
#EXT-X-DISCONTINUITY
#EXTINF:4,
s1.ts
#EXTINF:6,
s2.ts
#EXT-X-ENDLIST`;

function tsSegment(packets: number, fill: number): Uint8Array {
  const data = new Uint8Array(packets * 188).fill(fill);
  for (let i = 0; i < packets; i += 1) data[i * 188] = 0x47;
  return data;
}

function task(): DownloadTask {
  const now = Date.now();
  return {
    id: 'local-index',
    sourceId: 'demo',
    mediaId: 'm1',
    episodeId: 'e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/media.m3u8',
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
    sink: 'filesystem',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

describe('HLS 下载本地索引接线', () => {
  beforeEach(() => {
    h.patches.length = 0;
    h.writeBase64.mockReset();
    h.writeBase64.mockResolvedValue(undefined);
    h.renameFile.mockReset();
    h.renameFile.mockResolvedValue(undefined);
    h.deleteFile.mockReset();
    h.deleteFile.mockResolvedValue(undefined);
  });

  it('按最终落盘字节记录每片范围，并生成同目录 m3u8 sidecar', async () => {
    const segments = [tsSegment(1, 0), tsSegment(2, 1), tsSegment(3, 2)];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return new Response(MANIFEST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      const match = url.match(/s(\d)\.ts/);
      return new Response(match ? segments[Number(match[1])] : undefined, { status: 200 });
    }) as unknown as typeof fetch;
    let written = 0;
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        h.patches.push(patch as Record<string, unknown>);
      },
      fetchImpl,
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 0 }; },
        async write(data: Uint8Array) { written += data.byteLength; },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: written }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await downloader.run(task(), new AbortController().signal);

    expect(h.patches.at(-1)).toMatchObject({
      hlsIndexPath: 'downloads/m1/e1.m3u8',
      hlsIndex: {
        version: 1,
        targetDuration: 10,
        mediaSequence: 0,
        segments: [
          { index: 0, offset: 0, length: 188, duration: 2, discontinuity: false },
          { index: 1, offset: 188, length: 376, duration: 4, discontinuity: true },
          { index: 2, offset: 564, length: 564, duration: 6, discontinuity: false },
        ],
      },
    });
    expect(h.writeBase64).toHaveBeenCalledWith('downloads/m1/e1.m3u8.part', expect.any(String));
    const manifest = atob(h.writeBase64.mock.calls[0]![1] as string);
    expect(manifest).toContain('#EXT-X-BYTERANGE:376@188\ne1.ts');
    expect(manifest).toContain('#EXT-X-DISCONTINUITY\n#EXTINF:4.000,');
    expect(h.renameFile).toHaveBeenCalledWith('downloads/m1/e1.m3u8.part', 'downloads/m1/e1.m3u8');
  });

  it('分片 URI 无扩展名但正文是 TS 时按实际落盘字节生成索引', async () => {
    const manifest = MANIFEST.replaceAll('.ts', '');
    const segments = [tsSegment(1, 0), tsSegment(2, 1), tsSegment(3, 2)];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return new Response(manifest, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      const match = url.match(/s(\d)$/);
      return new Response(match ? segments[Number(match[1])] : undefined, { status: 200 });
    }) as unknown as typeof fetch;
    let written = 0;
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        h.patches.push(patch as Record<string, unknown>);
      },
      fetchImpl,
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 0 }; },
        async write(data: Uint8Array) { written += data.byteLength; },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: written }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await downloader.run(task(), new AbortController().signal);

    expect(h.patches.some((patch) => patch.container === 'ts')).toBe(true);
    expect(h.patches.at(-1)).toMatchObject({
      hlsIndexPath: 'downloads/m1/e1.m3u8',
      hlsIndex: {
        version: 1,
        segments: [
          { index: 0, offset: 0, length: 188 },
          { index: 1, offset: 188, length: 376 },
          { index: 2, offset: 564, length: 564 },
        ],
      },
    });
    expect(h.writeBase64).toHaveBeenCalledWith('downloads/m1/e1.m3u8.part', expect.any(String));
  });

  it('无扩展名 TS 续传保留已有分片边界，并沿用源清单指纹', async () => {
    const manifest = MANIFEST.replaceAll('.ts', '');
    const playlist = parseM3u8(manifest, 'https://cdn.example.com/media.m3u8');
    const resumed = {
      ...task(),
      downloadedBytes: 188,
      completedSegments: [0],
      hlsTotalSegments: 3,
      hlsDiscontinuities: 1,
      hlsPlaylistFingerprint: hlsPlaylistFingerprint(playlist),
      container: 'ts' as const,
      resumable: true,
      hlsIndex: {
        version: 1 as const,
        playlistFingerprint: hlsPlaylistFingerprint(playlist),
        targetDuration: 10,
        mediaSequence: 0,
        segments: [
          { index: 0, offset: 0, length: 188, duration: 2, discontinuity: false },
        ],
      },
    };
    const fetched: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url.endsWith('.m3u8')) {
        return new Response(manifest, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      if (url.endsWith('s0')) throw new Error('已完成分片不应重新下载');
      return new Response(url.endsWith('s1') ? tsSegment(2, 1) : tsSegment(3, 2), { status: 200 });
    }) as unknown as typeof fetch;
    let written = 188;
    const downloader = createHlsDownloader({
      load: async () => resumed,
      saveProgress: async (_id, patch) => {
        h.patches.push(patch as Record<string, unknown>);
      },
      fetchImpl,
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 188 }; },
        async write(data: Uint8Array) { written += data.byteLength; },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: written }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await downloader.run(resumed, new AbortController().signal);

    expect(fetched.some((url) => url.endsWith('s0'))).toBe(false);
    expect(h.patches.some((patch) =>
      patch.container === 'ts' && patch.hlsPlaylistFingerprint === hlsPlaylistFingerprint(playlist),
    )).toBe(true);
    expect(h.patches.at(-1)).toMatchObject({
      hlsIndexPath: 'downloads/m1/e1.m3u8',
      hlsIndex: {
        segments: [
          { index: 0, offset: 0, length: 188 },
          { index: 1, offset: 188, length: 376, discontinuity: true },
          { index: 2, offset: 564, length: 564 },
        ],
      },
    });
  });

  it('无扩展名且正文不是 TS 时保持 other，不伪造字节索引', async () => {
    const manifest = MANIFEST.replaceAll('.ts', '');
    const payload = new Uint8Array([1, 2, 3, 4]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(url.endsWith('.m3u8') ? manifest : payload, { status: 200 });
    }) as unknown as typeof fetch;
    let written = 0;
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => { h.patches.push(patch as Record<string, unknown>); },
      fetchImpl,
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 0 }; },
        async write(data: Uint8Array) { written += data.byteLength; },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: written }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await downloader.run(task(), new AbortController().signal);

    expect(h.patches.at(-1)).toMatchObject({ container: 'other', hlsIndex: null, hlsIndexPath: null });
    expect(h.writeBase64).not.toHaveBeenCalled();
  });

  it('分片写盘失败时不记账，也不生成播放清单', async () => {
    const segments = [tsSegment(1, 0), tsSegment(2, 1), tsSegment(3, 2)];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return new Response(MANIFEST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      const match = url.match(/s(\d)\.ts/);
      return new Response(match ? segments[Number(match[1])] : undefined, { status: 200 });
    }) as unknown as typeof fetch;
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => { h.patches.push(patch as Record<string, unknown>); },
      fetchImpl,
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 0 }; },
        async write() { throw new Error('ENOSPC'); },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: 0 }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toBeDefined();

    expect(h.writeBase64).not.toHaveBeenCalled();
    expect(h.patches.some((patch) => patch.hlsIndexPath !== undefined && patch.hlsIndexPath !== null)).toBe(false);
  });

  it('产物大小与写入记账不一致时拒绝生成清单', async () => {
    const segments = [tsSegment(1, 0), tsSegment(2, 1), tsSegment(3, 2)];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return new Response(MANIFEST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      const match = url.match(/s(\d)\.ts/);
      return new Response(match ? segments[Number(match[1])] : undefined, { status: 200 });
    }) as unknown as typeof fetch;
    let written = 0;
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => { h.patches.push(patch as Record<string, unknown>); },
      fetchImpl,
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 0 }; },
        async write(data: Uint8Array) { written += data.byteLength; },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: written + 1 }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_LOCAL_CORRUPT',
    });

    expect(h.writeBase64).not.toHaveBeenCalled();
  });

  it('占位内容拒绝发生在清单生成之前，不遗留 m3u8 sidecar', async () => {
    const segments = [tsSegment(1, 0), tsSegment(2, 1), tsSegment(3, 2)];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return new Response(MANIFEST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      const match = url.match(/s(\d)\.ts/);
      return new Response(match ? segments[Number(match[1])] : undefined, { status: 200 });
    }) as unknown as typeof fetch;
    let written = 0;
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => { h.patches.push(patch as Record<string, unknown>); },
      fetchImpl,
      findTwinArtifact: async () => '第 2 集',
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 0 }; },
        async write(data: Uint8Array) { written += data.byteLength; },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: written }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_FAKE_SOURCE_CONTENT',
    });

    expect(h.writeBase64).not.toHaveBeenCalled();
  });

  it('sidecar 写入失败时明确失败，并保留已声明的索引而不是回退裸 TS', async () => {
    h.writeBase64.mockRejectedValueOnce(new Error('disk full'));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) {
        return new Response(MANIFEST, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
      }
      const match = url.match(/s(\d)\.ts/);
      return new Response(match ? tsSegment(1, Number(match[1]) + 1) : undefined, { status: 200 });
    }) as unknown as typeof fetch;
    let written = 0;
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => { h.patches.push(patch as Record<string, unknown>); },
      fetchImpl,
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() { return { actualStartBytes: 0 }; },
        async write(data: Uint8Array) { written += data.byteLength; },
        async finish() { return { filePath: 'downloads/m1/e1.ts', blobKey: null, size: written }; },
        async suspend() {},
        async abort() {},
      }),
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_LOCAL_CORRUPT',
    });
    expect(h.renameFile).not.toHaveBeenCalled();
    expect(h.patches.at(-1)).toMatchObject({
      hlsIndex: { version: 1 },
      hlsIndexPath: null,
    });
    expect(h.patches.at(-1)?.hlsIndex).not.toBeNull();
  });
});
