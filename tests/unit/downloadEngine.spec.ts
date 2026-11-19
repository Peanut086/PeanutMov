import { beforeEach, describe, expect, it, vi } from 'vitest';

/** P1-6 归因依赖在线判定，测试里把它钉成变量（其余导出保持真实实现） */
let online = true;
vi.mock('@/native/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/network')>();
  return { ...actual, isOnline: () => online };
});

import { resetAll } from './helpers';
import { closeDb } from '@/db/index';
import { createDownloadEngine } from '@/services/downloadEngine';
import { IdbBlobSink } from '@/services/downloadSink';
import { blobRepo } from '@/db/repositories/blobRepo';
import { AppError } from '@/shared/errors';
import { settingsService } from '@/services/settingsService';
import type { DownloadTask } from '@/types';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-engine',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'downloading',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 0,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
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

/** 构造一个可流式读取的 Response */
function streamResponse(bytes: Uint8Array, init?: { status?: number; headers?: Record<string, string> }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunkSize = 100;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-length': String(bytes.length) },
  });
}

interface SavedProgress {
  downloadedBytes?: number;
  totalBytes?: number | null;
  resumable?: boolean;
  completedAt?: number;
}

describe('下载引擎（AC-73 / AC-76）', () => {
  beforeEach(async () => {
    online = true;
    await resetAll();
    settingsService.__resetCache();
  });

  it('首次下载：流式写入并落库 filePath/blobKey', async () => {
    const bytes = new Uint8Array(1000).fill(7);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => streamResponse(bytes));
    const progress: SavedProgress[] = [];

    const engine = createDownloadEngine({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        progress.push(patch as SavedProgress);
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistIntervalMs: 0,
    });
    await engine.run(task(), new AbortController().signal);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const firstInit = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(firstInit?.headers).toEqual({});
    const last = progress[progress.length - 1];
    expect(last?.totalBytes).toBe(1000);
    expect(last?.completedAt).toBeGreaterThan(0);
    const row = await blobRepo.get('task-engine');
    expect(row?.size).toBe(1000);
    expect(row?.mime).toBe('video/mp4');
  });

  it('Range 续传：已有 400 字节时发 Range 头，服务端 206 时继续（AC-73）', async () => {
    const tail = new Uint8Array(600).fill(3);
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      streamResponse(tail, {
        status: 206,
        headers: { 'content-length': String(tail.length), 'content-range': 'bytes 400-999/1000' },
      }),
    );
    const progress: SavedProgress[] = [];

    const engine = createDownloadEngine({
      load: async () => task({ downloadedBytes: 400 }),
      saveProgress: async (_id, patch) => {
        progress.push(patch as SavedProgress);
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistIntervalMs: 0,
    });
    await engine.run(task({ downloadedBytes: 400 }), new AbortController().signal);

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init).toBeDefined();
    const headers = ((init as RequestInit).headers ?? {}) as Record<string, string>;
    expect(headers['Range']).toBe('bytes=400-');
    const row = await blobRepo.get('task-engine');
    expect(row?.size).toBe(600);
    expect(progress.some((p) => p.totalBytes === 1000)).toBe(true);
  });

  it('服务端忽略 Range（返回 200）：resumable 置 false 并从 0 重下（AC-73）', async () => {
    const full = new Uint8Array(1000).fill(1);
    const fetchImpl = vi.fn(async () => streamResponse(full, { status: 200 }));
    const progress: SavedProgress[] = [];
    const engine = createDownloadEngine({
      load: async () => task({ downloadedBytes: 400 }),
      saveProgress: async (_id, patch) => {
        progress.push(patch as SavedProgress);
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistIntervalMs: 0,
    });
    await engine.run(task({ downloadedBytes: 400 }), new AbortController().signal);

    expect(progress.some((p) => p.resumable === false)).toBe(true);
    const row = await blobRepo.get('task-engine');
    expect(row?.size).toBe(1000);
  });

  it('配额不足：抛 E_STORAGE_QUOTA 并清理半截 Blob（AC-76）', async () => {
    const bytes = new Uint8Array(500);
    // 先真实交付 100 字节让 sink 写入成功，下一次 pull 才抛配额错误。
    // 注意：若在 start() 里 enqueue 后立刻 controller.error()，按 WHATWG 规范
    // 已入队分片会被丢弃，reader.read() 直接抛错，sink.write 永远不会发生。
    let pulled = 0;
    const failingStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled === 0) {
          pulled += 1;
          controller.enqueue(bytes.subarray(0, 100));
          return;
        }
        controller.error(new DOMException('quota', 'QuotaExceededError'));
      },
    });
    const failingSinkSink = new IdbBlobSink();
    const writeSpy = vi.spyOn(failingSinkSink, 'write');
    const abortSpy = vi.spyOn(failingSinkSink, 'abort');

    const engine2 = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () => new Response(failingStream, { status: 200 })) as unknown as typeof fetch,
      createSinkImpl: () => failingSinkSink,
      persistIntervalMs: 0,
    });
    await expect(engine2.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_STORAGE_QUOTA',
    });
    expect(writeSpy).toHaveBeenCalled();
    expect(abortSpy).toHaveBeenCalled();
    expect(await blobRepo.has('task-engine')).toBe(false);
  });

  it('HTTP 404 → E_HTTP_404；401 → E_AUTH', async () => {
    const engine404 = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () => new Response('', { status: 404 })) as unknown as typeof fetch,
      createSinkImpl: () => new IdbBlobSink(),
    });
    await expect(engine404.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_HTTP_404',
    });

    const engine401 = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
      createSinkImpl: () => new IdbBlobSink(),
    });
    await expect(engine401.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_AUTH',
    });
  });

  it('HTTP 403 → E_HTTP_403（与 401 的 E_AUTH 区分，AC-39 / REV-16）', async () => {
    const engine403 = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () => new Response('', { status: 403 })) as unknown as typeof fetch,
      createSinkImpl: () => new IdbBlobSink(),
    });
    // 403 语义是"无权限访问"，不能退化为"需要登录"；且 403/401 均不可重试
    await expect(engine403.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_HTTP_403',
      message: '无权限访问(403)',
      httpStatus: 403,
      retryable: false,
    });

    const engine401 = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
      createSinkImpl: () => new IdbBlobSink(),
    });
    await expect(engine401.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_AUTH',
      message: '认证失败，请检查账号或 Token',
      httpStatus: 401,
      retryable: false,
    });
  });

  it('取消（abort）：中断读取并清理 sink（AC-80 支撑）', async () => {
    const controller = new AbortController();
    // 永不结束的流：读到第一块后触发取消
    const slowStream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new Uint8Array(100));
        // 不 close，等待 abort
        setTimeout(() => {
          try {
            streamController.error(new DOMException('aborted', 'AbortError'));
          } catch {
            // 已关闭
          }
        }, 5);
      },
    });
    const sink = new IdbBlobSink();
    const abortSpy = vi.spyOn(sink, 'abort');
    const engine = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () =>
        new Response(slowStream, { status: 200, headers: { 'content-length': '1000' } })) as unknown as typeof fetch,
      createSinkImpl: () => sink,
      persistIntervalMs: 0,
    });

    setTimeout(() => controller.abort(), 1);
    await expect(engine.run(task(), controller.signal)).rejects.toBeInstanceOf(AppError);
    expect(abortSpy).toHaveBeenCalled();
    expect(await blobRepo.has('task-engine')).toBe(false);
    await closeDb();
  });

  it('设备在线但 fetch 连不上 → 归因到线路（P1-6：不再让用户去查网络）', async () => {
    const engine = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      createSinkImpl: () => new IdbBlobSink(),
    });
    await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_SOURCE_UNAVAILABLE',
      retryable: true,
    });
  });

  it('设备真离线 → 保留 E_NETWORK 文案', async () => {
    online = false;
    const engine = createDownloadEngine({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as typeof fetch,
      createSinkImpl: () => new IdbBlobSink(),
    });
    await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: '网络不可用，请检查网络后重试',
    });
  });
});
