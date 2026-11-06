import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { createDownloadEngine } from '@/services/downloadEngine';
import { IdbBlobSink, type DownloadSink, type SinkInit, type BeginResult } from '@/services/downloadSink';
import { settingsService } from '@/services/settingsService';
import type { DownloadTask } from '@/types';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-resume',
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
    status: overrides.status ?? 'downloading',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: overrides.downloadedBytes ?? 0,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: overrides.resumable ?? true,
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

/** Mock sink that tracks suspend/abort calls and simulates file state */
class MockNativeSink implements DownloadSink {
  readonly kind = 'filesystem' as const;
  private partSize = 0;
  beginCalls = 0;
  suspendCalls = 0;
  abortCalls = 0;
  finishCalls = 0;

  constructor(initialPartSize = 0) {
    this.partSize = initialPartSize;
  }

  async begin(init: SinkInit): Promise<BeginResult> {
    this.beginCalls++;
    // Simulate checking .part file size
    if (init.startBytes > 0 && init.task.resumable && this.partSize > 0) {
      return { actualStartBytes: this.partSize };
    }
    this.partSize = 0;
    return { actualStartBytes: 0 };
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.partSize += chunk.byteLength;
  }

  async finish(): Promise<{ filePath: string | null; blobKey: string | null; size: number }> {
    this.finishCalls++;
    return { filePath: '/downloads/test.mp4', blobKey: null, size: this.partSize };
  }

  async suspend(): Promise<void> {
    this.suspendCalls++;
    // Keep partSize (simulates .part file preserved)
  }

  async abort(): Promise<void> {
    this.abortCalls++;
    this.partSize = 0; // Simulates .part file deleted
  }

  get currentPartSize() {
    return this.partSize;
  }
}

describe('续传正确性（Phase 0.1）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  describe('IdbBlobSink', () => {
    it('begin() 始终返回 actualStartBytes=0（Web 端不支持续传）', async () => {
      const sink = new IdbBlobSink();
      const result = await sink.begin({
        task: task({ downloadedBytes: 500, resumable: true }),
        startBytes: 500,
      });
      expect(result.actualStartBytes).toBe(0);
    });

    it('abort() 清理内存 chunks 并删除 blob', async () => {
      const sink = new IdbBlobSink();
      await sink.begin({ task: task(), startBytes: 0 });
      await sink.write(new Uint8Array(100));
      expect(sink.bufferedBytes).toBe(100);

      await sink.abort();
      expect(sink.bufferedBytes).toBe(0);
    });
  });

  describe('MockNativeSink', () => {
    it('begin() 返回实际 .part 文件大小（非 DB 记录值）', async () => {
      const sink = new MockNativeSink(300); // .part 文件实际 300 字节
      const result = await sink.begin({
        task: task({ downloadedBytes: 500, resumable: true }), // DB 记录 500
        startBytes: 500,
      });
      expect(result.actualStartBytes).toBe(300); // 以文件为准
    });

    it('suspend() 保留 .part 文件（不清理）', async () => {
      const sink = new MockNativeSink(0);
      await sink.begin({ task: task(), startBytes: 0 });
      await sink.write(new Uint8Array(200));
      expect(sink.currentPartSize).toBe(200);

      await sink.suspend();
      expect(sink.suspendCalls).toBe(1);
      expect(sink.currentPartSize).toBe(200); // 保留
    });

    it('abort() 删除 .part 文件', async () => {
      const sink = new MockNativeSink(0);
      await sink.begin({ task: task(), startBytes: 0 });
      await sink.write(new Uint8Array(200));

      await sink.abort();
      expect(sink.abortCalls).toBe(1);
      expect(sink.currentPartSize).toBe(0); // 已清理
    });
  });

  describe('downloadEngine 错误处理', () => {
    it('Web (idb-blob) 出错时调用 abort()', async () => {
      const sink = new IdbBlobSink();
      const abortSpy = vi.spyOn(sink, 'abort');
      const suspendSpy = vi.spyOn(sink, 'suspend');

      // 模拟写入时抛错
      vi.spyOn(sink, 'write').mockImplementation(async () => {
        throw new Error('quota exceeded');
      });

      const engine = createDownloadEngine({
        load: async () => task({ sink: 'idb-blob' }),
        saveProgress: async () => undefined,
        fetchImpl: (async () => streamResponse(new Uint8Array(100))) as unknown as typeof fetch,
        createSinkImpl: () => sink,
        persistIntervalMs: 0,
      });

      await expect(
        engine.run(task({ sink: 'idb-blob' }), new AbortController().signal),
      ).rejects.toThrow();

      expect(abortSpy).toHaveBeenCalled();
      expect(suspendSpy).not.toHaveBeenCalled();
    });

    it('Native (filesystem) 网络错误时调用 suspend()（保留 .part 供续传）', async () => {
      const sink = new MockNativeSink(0);
      const abortSpy = vi.spyOn(sink, 'abort');
      const suspendSpy = vi.spyOn(sink, 'suspend');

      // 模拟网络错误
      let fetchCount = 0;
      const fetchImpl = vi.fn(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          // 第一次：部分写入后网络错误
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(100));
              setTimeout(() => controller.error(new Error('network')), 10);
            },
          });
          return new Response(stream, { status: 200 });
        }
        return new Response('', { status: 500 });
      });

      const engine = createDownloadEngine({
        load: async () => task({ sink: 'filesystem', status: 'failed' }),
        saveProgress: async () => undefined,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        createSinkImpl: () => sink,
        persistIntervalMs: 0,
      });

      await expect(
        engine.run(task({ sink: 'filesystem' }), new AbortController().signal),
      ).rejects.toThrow();

      expect(suspendSpy).toHaveBeenCalled();
      expect(abortSpy).not.toHaveBeenCalled();
    });

    it('Native (filesystem) 取消时调用 abort()（删除 .part）', async () => {
      const sink = new MockNativeSink(0);
      const abortSpy = vi.spyOn(sink, 'abort');
      const suspendSpy = vi.spyOn(sink, 'suspend');

      const controller = new AbortController();

      const engine = createDownloadEngine({
        load: async () => task({ sink: 'filesystem', status: 'canceled' }),
        saveProgress: async () => undefined,
        fetchImpl: (async () => {
          // 模拟慢速响应，让 abort 有机会触发
          await new Promise((r) => setTimeout(r, 50));
          return streamResponse(new Uint8Array(1000));
        }) as unknown as typeof fetch,
        createSinkImpl: () => sink,
        persistIntervalMs: 0,
      });

      setTimeout(() => controller.abort(), 10);

      await expect(engine.run(task({ sink: 'filesystem' }), controller.signal)).rejects.toMatchObject({
        code: 'E_ABORTED',
      });

      expect(abortSpy).toHaveBeenCalled();
      expect(suspendSpy).not.toHaveBeenCalled();
    });
  });

  describe('续传流程集成', () => {
    it('暂停后续传：sink.begin() 校正 actualStartBytes', async () => {
      // 第一次下载：写入 300 字节后暂停
      const sink1 = new MockNativeSink(0);
      await sink1.begin({ task: task(), startBytes: 0 });
      await sink1.write(new Uint8Array(300));
      await sink1.suspend();
      expect(sink1.currentPartSize).toBe(300);

      // 模拟 DB 记录了错误的 downloadedBytes=500
      const taskWithStaleDb = task({ downloadedBytes: 500, resumable: true, sink: 'filesystem' });

      // 续传：sink.begin() 返回实际文件大小 300
      const sink2 = new MockNativeSink(sink1.currentPartSize);
      const result = await sink2.begin({
        task: taskWithStaleDb,
        startBytes: 500, // DB 说 500
      });
      expect(result.actualStartBytes).toBe(300); // 实际从 300 继续
    });
  });
});
