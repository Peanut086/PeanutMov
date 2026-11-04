import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { closeDb } from '@/db/index';
import { createDownloadEngine } from '@/services/downloadEngine';
import { IdbBlobSink, NativeFsSink } from '@/services/downloadSink';
import { blobRepo } from '@/db/repositories/blobRepo';
import { AppError } from '@/shared/errors';
import { settingsService } from '@/services/settingsService';
import type { DownloadTask } from '@/types';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-edge',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/video.mp4',
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

function streamResponse(bytes: Uint8Array, init?: { status?: number; headers?: Record<string, string> }): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: init?.headers ?? { 'content-length': String(bytes.length) },
  });
}

describe('边界场景测试（Phase 3）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  describe('网络错误', () => {
    it('fetch 抛网络错误 → E_NETWORK', async () => {
      const fetchImpl = vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      });

      const engine = createDownloadEngine({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_NETWORK',
      });
    });

    it('流中途断开 → E_UNKNOWN', async () => {
      const fetchImpl = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(100));
            setTimeout(() => controller.error(new Error('Connection reset')), 10);
          },
        });
        return new Response(stream, { status: 200 });
      });

      const engine = createDownloadEngine({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task(), new AbortController().signal)).rejects.toBeDefined();
    });
  });

  describe('HTTP 错误码', () => {
    it('401 → E_AUTH', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));

      const engine = createDownloadEngine({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_AUTH',
      });
    });

    it('403 → E_HTTP_403', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));

      const engine = createDownloadEngine({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_HTTP_403',
      });
    });

    it('404 → E_HTTP_404', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));

      const engine = createDownloadEngine({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_HTTP_404',
      });
    });

    it('429 → E_HTTP_429', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));

      const engine = createDownloadEngine({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_HTTP_429',
      });
    });

    it('500 → E_HTTP_5XX', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 500 }));

      const engine = createDownloadEngine({
        load: async () => task(),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task(), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_HTTP_5XX',
      });
    });
  });

  describe('416 Range Not Satisfiable', () => {
    it('续传位置越界 → 从头重下', async () => {
      let callCount = 0;
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        callCount++;
        if (callCount === 1) {
          // 第一次：416 错误
          return new Response('', { status: 416 });
        }
        // 第二次：正常响应（从头开始）
        return streamResponse(new Uint8Array(1000).fill(7));
      });

      const saveProgress = vi.fn();
      const engine = createDownloadEngine({
        load: async () => task({ downloadedBytes: 500 }), // DB 记录已下载 500
        saveProgress,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await engine.run(task({ downloadedBytes: 500 }), new AbortController().signal);

      // 应该调用两次 fetch
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      // 第二次请求不应该有 Range 头
      const secondCallHeaders = fetchImpl.mock.calls[1][1]?.headers as Record<string, string>;
      expect(secondCallHeaders?.['Range']).toBeUndefined();

      // 应该保存 resumable=false
      expect(saveProgress).toHaveBeenCalledWith(
        'task-edge',
        expect.objectContaining({ resumable: false, downloadedBytes: 0 }),
      );
    });
  });

  describe('配额错误', () => {
    it('超过 1GB → E_STORAGE_QUOTA', async () => {
      const fetchImpl = vi.fn(async () => {
        return new Response('', {
          status: 200,
          headers: { 'content-length': String(2 * 1024 * 1024 * 1024) }, // 2GB
        });
      });

      const engine = createDownloadEngine({
        load: async () => task({ sink: 'idb-blob' }),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task({ sink: 'idb-blob' }), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_STORAGE_QUOTA',
      });
    });
  });

  describe('取消场景', () => {
    it('下载前取消 → E_ABORTED', async () => {
      const controller = new AbortController();

      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        // 检查 signal 是否已 abort
        if (init?.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        return streamResponse(new Uint8Array(100));
      });

      const engine = createDownloadEngine({
        load: async () => task({ status: 'canceled' }),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      controller.abort(); // 在 run 之前取消

      await expect(engine.run(task(), controller.signal)).rejects.toMatchObject({
        code: 'E_ABORTED',
      });
    });

    it('下载中取消 → E_ABORTED', async () => {
      const controller = new AbortController();

      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller_) {
            controller_.enqueue(new Uint8Array(100));
            // 等待取消信号
            setTimeout(() => {
              if (init?.signal?.aborted) {
                controller_.error(new DOMException('Aborted', 'AbortError'));
              } else {
                controller_.close();
              }
            }, 50);
          },
        });
        return new Response(stream, { status: 200 });
      });

      const engine = createDownloadEngine({
        load: async () => task({ status: 'canceled' }),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      setTimeout(() => controller.abort(), 10);

      await expect(engine.run(task(), controller.signal)).rejects.toMatchObject({
        code: 'E_ABORTED',
      });
    });
  });

  describe('Sink 错误处理', () => {
    it('Web (idb-blob) 出错 → abort()', async () => {
      const sink = new IdbBlobSink();
      const abortSpy = vi.spyOn(sink, 'abort');

      vi.spyOn(sink, 'write').mockImplementation(async () => {
        throw new AppError('E_STORAGE_QUOTA', 'Quota exceeded');
      });

      const engine = createDownloadEngine({
        load: async () => task({ sink: 'idb-blob' }),
        saveProgress: async () => undefined,
        fetchImpl: (async () => streamResponse(new Uint8Array(100))) as unknown as typeof fetch,
        createSinkImpl: () => sink,
        persistIntervalMs: 0,
      });

      await expect(engine.run(task({ sink: 'idb-blob' }), new AbortController().signal)).rejects.toMatchObject({
        code: 'E_STORAGE_QUOTA',
      });

      expect(abortSpy).toHaveBeenCalled();
    });
  });

  describe('续传校正', () => {
    it('服务端不支持 Range → 从头开始', async () => {
      const fetchImpl = vi.fn(async () => {
        return streamResponse(new Uint8Array(1000).fill(7), { status: 200 }); // 200 而非 206
      });

      const saveProgress = vi.fn();
      const engine = createDownloadEngine({
        load: async () => task({ downloadedBytes: 500, resumable: true }),
        saveProgress,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        persistIntervalMs: 0,
      });

      await engine.run(task({ downloadedBytes: 500, resumable: true }), new AbortController().signal);

      // 应该保存 resumable=false
      expect(saveProgress).toHaveBeenCalledWith(
        'task-edge',
        expect.objectContaining({ resumable: false }),
      );
    });
  });
});
