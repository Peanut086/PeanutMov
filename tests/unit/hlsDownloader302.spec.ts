import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll, tsSegment } from './helpers';
import { blobRepo } from '@/db/repositories/blobRepo';
import { settingsService } from '@/services/settingsService';
import { createHlsDownloader } from '@/services/hlsDownloader';
import type { DownloadTask } from '@/types';

/**
 * FIX-04 回归：m3u8 清单请求走 LocalProxy，302 不再让下载在第一个字节前失败
 *
 * 背景：CapacitorHttp 拦截层不接受 3xx（分片/密钥/初始化分片早已改走本机回环代理），
 * 但第 1 步主清单与子清单仍是直连；CDN 对清单返回 302 时下载直接 `E_NETWORK`。
 *
 * 本文件固定的契约：
 * 1. 主清单与子清单都必须经 `LocalProxy` 转发（而不是裸 URL 直连）；
 * 2. 清单里的相对引用必须按「302 落地地址」解析——直连路径用响应自报的落地地址，
 *    代理路径用原生侧以落地地址改写后的绝对地址（`unwrapPlaylistUrls` 还原）；
 * 3. 代理请求异常时回退直连，且回退后仍按落地地址归一化；
 * 4. 302 链路不得绕过 FIX-03 的受保护加密拦截（AC-40）。
 */

const PROXY_BASE = 'http://127.0.0.1:45678/p/token-main';

const proxyRegister = vi.hoisted(() => vi.fn());

vi.mock('@/native/localProxy', () => ({
  LocalProxy: {
    proxy: proxyRegister,
    isSupported: async () => ({ supported: true }),
  },
  needsHeaderProxy: (): boolean => false,
  localProxyUrl: async (): Promise<string | null> => null,
}));

/** 下载器对资源统一使用 `${proxyBase}/${encodeURIComponent(target)}` */
function proxied(target: string): string {
  return `${PROXY_BASE}/${encodeURIComponent(target)}`;
}

/** 覆盖全局 Capacitor 桥，让 `isNative()` 判定为原生（走代理路径） */
function setNative(): void {
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    getPlatform: () => 'android',
    isNativePlatform: () => true,
    isNative: true,
  };
}

function clearPlatform(): void {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
}

/** 构造响应；`url` 用于模拟「跟随跳转后运行时自报的落地地址」 */
function makeResponse(body: string | Uint8Array, options: { status?: number; url?: string } = {}): Response {
  const response = new Response(body as BodyInit, { status: options.status ?? 200 });
  if (options.url !== undefined) {
    Object.defineProperty(response, 'url', { value: options.url, configurable: true });
  }
  return response;
}

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-302',
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

describe('FIX-04 清单 302：走 LocalProxy + 按落地地址归一化', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    clearPlatform();
    proxyRegister.mockReset();
    proxyRegister.mockResolvedValue({ url: PROXY_BASE });
  });

  afterEach(() => {
    clearPlatform();
  });

  it('代理路径：主清单 302 到新目录，子清单相对引用按落地地址还原后正常下载', async () => {
    setNative();
    // 302 后主清单落在 /v2/ 目录；原生侧 rewriteM3u8 以落地地址为基线改写相对引用
    const masterViaProxy = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
${proxied('https://cdn.example.com/v2/720p.m3u8')}`;
    const variantViaProxy = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
${proxied('https://cdn.example.com/v2/seg0.ts')}
#EXTINF:9.009,
${proxied('https://cdn.example.com/v2/seg1.ts')}
#EXT-X-ENDLIST`;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === proxied('https://cdn.example.com/master.m3u8')) {
        return makeResponse(masterViaProxy, { url: proxied('https://cdn.example.com/master.m3u8') });
      }
      if (url === proxied('https://cdn.example.com/v2/720p.m3u8')) {
        return makeResponse(variantViaProxy, { url: proxied('https://cdn.example.com/v2/720p.m3u8') });
      }
      if (url === proxied('https://cdn.example.com/v2/seg0.ts') || url === proxied('https://cdn.example.com/v2/seg1.ts')) {
        return makeResponse(tsSegment(1));
      }
      return makeResponse('Not Found', { status: 404 });
    });

    const saveProgress = vi.fn(async (_id: string, _patch: Partial<DownloadTask>) => undefined);
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await downloader.run(task(), new AbortController().signal);

    const calls = fetchImpl.mock.calls.map((call) => String(call[0]));
    // 主清单与子清单都经代理转发，不存在裸 URL 直连
    expect(calls[0]).toBe(proxied('https://cdn.example.com/master.m3u8'));
    expect(calls).toContain(proxied('https://cdn.example.com/v2/720p.m3u8'));
    expect(calls).not.toContain('https://cdn.example.com/master.m3u8');
    // 分片落在 302 落地目录 /v2/，而不是原始请求目录 /
    expect(calls).toContain(proxied('https://cdn.example.com/v2/seg0.ts'));
    expect(calls.some((url) => url.includes('/seg0.ts') && !url.includes('/v2/'))).toBe(false);

    expect((await blobRepo.get('task-302'))?.size).toBe(376);
    const patches = saveProgress.mock.calls.map((call) => call[1] as Partial<DownloadTask>);
    expect(patches.some((patch) => typeof patch.completedAt === 'number')).toBe(true);
  });

  it('代理不可用回退直连：相对引用按 302 落地地址解析，而不是原始请求地址', async () => {
    // 未设置 Capacitor 全局 → isNative() 为 false → 只有直连路径
    const masterRelative = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
720p.m3u8`;
    const variantRelative = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXT-X-ENDLIST`;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // 原始请求地址 302 到 /real/dir/index.m3u8：清单里的相对引用属于落地目录
      if (url === 'https://cdn.example.com/master.m3u8') {
        return makeResponse(masterRelative, { url: 'https://cdn.example.com/real/dir/index.m3u8' });
      }
      if (url === 'https://cdn.example.com/real/dir/720p.m3u8') {
        return makeResponse(variantRelative, { url: 'https://cdn.example.com/real/dir/720p.m3u8' });
      }
      if (url === 'https://cdn.example.com/real/dir/seg0.ts' || url === 'https://cdn.example.com/real/dir/seg1.ts') {
        return makeResponse(tsSegment(1));
      }
      // 按原始请求地址拼出来的错误路径（旧实现会走到这里）
      return makeResponse('Not Found', { status: 404 });
    });

    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await downloader.run(task(), new AbortController().signal);

    const calls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(calls).toContain('https://cdn.example.com/real/dir/720p.m3u8');
    expect(calls).toContain('https://cdn.example.com/real/dir/seg0.ts');
    expect(calls).not.toContain('https://cdn.example.com/720p.m3u8');
    expect(calls).not.toContain('https://cdn.example.com/seg0.ts');
    expect((await blobRepo.get('task-302'))?.size).toBe(376);
  });

  it('代理原样透传（清单仍含相对引用）：不得把相对地址解析到回环地址上', async () => {
    setNative();
    const passthrough = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
seg0.ts
#EXT-X-ENDLIST`;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // 代理自报地址就是回环地址（真实 LocalProxy 的行为），它不含上游路径语义
      if (url === proxied('https://cdn.example.com/master.m3u8')) {
        return makeResponse(passthrough, { url: proxied('https://cdn.example.com/master.m3u8') });
      }
      if (url === proxied('https://cdn.example.com/seg0.ts')) {
        return makeResponse(tsSegment(1));
      }
      return makeResponse('Not Found', { status: 404 });
    });

    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await downloader.run(task(), new AbortController().signal);

    const calls = fetchImpl.mock.calls.map((call) => String(call[0]));
    // 相对引用仍按上游请求地址解析，且不会被拼到 127.0.0.1 的路径上
    expect(calls).toContain(proxied('https://cdn.example.com/seg0.ts'));
    expect(calls.some((url) => url.startsWith('http://127.0.0.1:45678/p/token-main/seg0.ts'))).toBe(false);
    expect(calls.some((url) => url.startsWith('http://127.0.0.1:45678/seg0.ts'))).toBe(false);
    expect((await blobRepo.get('task-302'))?.size).toBe(188);
  });

  it('代理对清单返回 302：回退直连后下载流程不中断', async () => {
    setNative();
    const media = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
https://cdn.example.com/seg0.ts
#EXT-X-ENDLIST`;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // 代理没能跟随跳转（例如熔断或插件版本过旧），原样把 302 交回来
      if (url === proxied('https://cdn.example.com/master.m3u8')) {
        return makeResponse('', { status: 302 });
      }
      if (url === 'https://cdn.example.com/master.m3u8') {
        return makeResponse(media, { url: 'https://cdn.example.com/master.m3u8' });
      }
      if (url === proxied('https://cdn.example.com/seg0.ts')) {
        return makeResponse(tsSegment(1));
      }
      return makeResponse('Not Found', { status: 404 });
    });

    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await downloader.run(task(), new AbortController().signal);

    const calls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(calls[0]).toBe(proxied('https://cdn.example.com/master.m3u8'));
    expect(calls).toContain('https://cdn.example.com/master.m3u8');
    expect((await blobRepo.get('task-302'))?.size).toBe(188);
  });

  it('302 后的子清单命中 SAMPLE-AES：仍在任何分片请求前抛 E_DRM_PROTECTED（AC-40）', async () => {
    setNative();
    const masterViaProxy = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
${proxied('https://cdn.example.com/v2/720p.m3u8')}`;
    const protectedVariant = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://cdn.example.com/v2/key.bin"
#EXTINF:9.009,
${proxied('https://cdn.example.com/v2/seg0.ts')}
#EXT-X-ENDLIST`;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === proxied('https://cdn.example.com/master.m3u8')) {
        return makeResponse(masterViaProxy, { url: proxied('https://cdn.example.com/master.m3u8') });
      }
      if (url === proxied('https://cdn.example.com/v2/720p.m3u8')) {
        return makeResponse(protectedVariant, { url: proxied('https://cdn.example.com/v2/720p.m3u8') });
      }
      return makeResponse(new Uint8Array(10));
    });

    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_DRM_PROTECTED',
    });

    const calls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(calls.some((url) => url.includes('seg0.ts') || url.includes('key.bin'))).toBe(false);
    expect(await blobRepo.get('task-302')).toBeNull();
  });
});
