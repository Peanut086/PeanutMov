import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHlsDownloader } from '@/services/hlsDownloader';
import { settingsService } from '@/services/settingsService';
import type { BeginResult, DownloadSink } from '@/services/downloadSink';
import type { DownloadTask } from '@/types';
import { resetAll, tsSegment } from './helpers';

/**
 * 占位资源与续传计数器（真机实测 DL-P0-2 / DL-P1-1）。
 *
 * - 源站失效后的常见形态是「清单正常、每一片都是同一段素材」：字节数、分片数、结构校验
 *   全能过。实测同一批 13 集产物 md5 完全一致、时长只有 19.5 秒，却全部标成「已完成」，
 *   用户点开才知道被耍了一次。字节数、分片数、容器结构这些形式校验全能穿过去，
 *   只能靠内容级指纹拦（原生时间轴自检不算一道网：它对真实的 B 帧流也会触发，
 *   见 `hlsRemuxStage.spec.ts` 里 DL-R0 同期更正的那两条）。
 * - 旧实现在「.part 与 DB 不一致 → 从头下载」这条分支里，第二次 `begin()` 已经清空并重算，
 *   但计数器仍沿用第一次的起点，凭空多算一整份旧文件（实测磁盘 881,720 / 计数 1,763,440）。
 */

const SEGMENT_PACKETS = 40;
const SEGMENT_BYTES = SEGMENT_PACKETS * 188;

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: 'task-hls',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
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
    resumable: true,
    sink: 'filesystem',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  } as DownloadTask;
}

function manifest(count: number): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
  for (let i = 0; i < count; i += 1) {
    lines.push('#EXTINF:10.000,', `https://cdn.example.com/segment${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

/** `fill` 相同即代表这些分片是同一份字节 */
function segments(count: number, fill: number | ((index: number) => number)): Map<string, Uint8Array> {
  const bodies = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    const value = typeof fill === 'function' ? fill(i) : fill;
    bodies.set(`https://cdn.example.com/segment${i}.ts`, tsSegment(SEGMENT_PACKETS, value));
  }
  return bodies;
}

function fetchFor(count: number, bodies: Map<string, Uint8Array>): typeof fetch {
  return vi.fn(async (url: string) => {
    if (url.endsWith('.m3u8')) {
      return new Response(manifest(count), {
        status: 200,
        headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      });
    }
    const body = bodies.get(url);
    return body
      ? new Response(body, { status: 200, headers: { 'content-type': 'video/MP2T' } })
      : new Response('Not Found', { status: 404 });
  }) as unknown as typeof fetch;
}

/** 记录调用的假 sink：既能控制 begin 返回值，也能断言有没有走到 finish */
function recorderSink(beginResults: BeginResult[]): DownloadSink & {
  beginCalls: number;
  finishCalls: number;
  bytes: number;
} {
  const sink = {
    kind: 'filesystem' as const,
    beginCalls: 0,
    finishCalls: 0,
    bytes: 0,
    async begin(): Promise<BeginResult> {
      const result = beginResults[Math.min(sink.beginCalls, beginResults.length - 1)] as BeginResult;
      sink.beginCalls += 1;
      return result;
    },
    async write(chunk: Uint8Array): Promise<void> {
      sink.bytes += chunk.byteLength;
    },
    async finish() {
      sink.finishCalls += 1;
      return { filePath: 'downloads/demo_m1/demo_m1_e1.ts', blobKey: null, size: sink.bytes };
    },
    async suspend(): Promise<void> {},
    async abort(): Promise<void> {},
  };
  return sink;
}

beforeEach(async () => {
  await resetAll();
  settingsService.__resetCache();
});

describe('占位内容闸门（DL-P0-2）', () => {
  it('每一片都是同一份字节：判成占位资源，不写成品、不标完成', async () => {
    // 假源的真实形态：同一份素材被塞进 10 个不同 URL
    const sink = recorderSink([{ actualStartBytes: 0 }]);
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchFor(10, segments(10, 1)),
      createSinkImpl: () => sink,
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_FAKE_SOURCE_CONTENT',
      retryable: false,
    });
    expect(sink.finishCalls).toBe(0);
  });

  it('内容各不相同的正常分片照常完成（闸门不误杀）', async () => {
    const sink = recorderSink([{ actualStartBytes: 0 }]);
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchFor(10, segments(10, (index) => index + 1)),
      createSinkImpl: () => sink,
    });

    await downloader.run(task(), new AbortController().signal);
    expect(sink.finishCalls).toBe(1);
    expect(sink.bytes).toBe(10 * SEGMENT_BYTES);
  });

  it('分片数不足 8 的小清单不触发闸门（这条流本来就短）', async () => {
    const sink = recorderSink([{ actualStartBytes: 0 }]);
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async () => undefined,
      fetchImpl: fetchFor(3, segments(3, 1)),
      createSinkImpl: () => sink,
    });

    await downloader.run(task(), new AbortController().signal);
    expect(sink.finishCalls).toBe(1);
  });
});

describe('从头下载时重新播种字节计数（DL-P1-1）', () => {
  it('第二次 begin 清空了 .part，计数就不能再从旧起点开始', async () => {
    const sink = recorderSink([{ actualStartBytes: 881_720 }, { actualStartBytes: 0 }]);
    const patches: Partial<DownloadTask>[] = [];
    const source = task({ downloadedBytes: 400_000, completedSegments: [0] });
    const downloader = createHlsDownloader({
      load: async () => source,
      saveProgress: async (_id, patch) => {
        patches.push(patch);
      },
      // DB 说下到 400,000、文件却是 881,720 → 触发「从头下载」，分片索引全部作废重下
      fetchImpl: fetchFor(3, segments(3, (index) => index + 1)),
      createSinkImpl: () => sink,
    });

    await downloader.run(source, new AbortController().signal);

    expect(sink.beginCalls).toBe(2);
    const final = patches[patches.length - 1] as Partial<DownloadTask>;
    // 落库的就是这一轮真正交给 sink 的字节数；旧实现会再叠上一次 .part 的 881,720
    expect(final.downloadedBytes).toBe(3 * SEGMENT_BYTES);
    expect(final.downloadedBytes).toBe(sink.bytes);
  });
});

/**
 * 续传记账（真机实测 DL-P1-4）。
 *
 * 假 sink 复刻真机的写盘节奏：`write()` 先进内存缓冲，攒满才落到「磁盘」，
 * `suspend()`（暂停）把缓冲全量刷出。于是暂停后文件比 DB 的记账长——DB 停在上一节流
 * 周期，刷盘的那一截从没落过库。下一轮 `begin` 一比就对不上，被当成损坏：
 * `completedSegments` 整段作废、重下全集，实测一次掉 47.8MB。
 */
function bufferedSink(onWrite?: () => void) {
  const FLUSH_LIMIT = 2 * SEGMENT_BYTES;
  const sink = {
    kind: 'filesystem' as const,
    /** 已落盘字节 */
    fileBytes: 0,
    /** 还在写盘缓冲里的字节 */
    buffered: 0,
    begins: [] as number[],
    async begin(init: { task: DownloadTask; startBytes: number }) {
      sink.begins.push(init.startBytes);
      if (!init.task.resumable) {
        sink.fileBytes = 0;
        sink.buffered = 0;
      }
      // 以磁盘为准——真机正是这样返回一个比 DB 更大的值
      return { actualStartBytes: sink.fileBytes };
    },
    async write(chunk: Uint8Array) {
      sink.buffered += chunk.byteLength;
      if (sink.buffered >= FLUSH_LIMIT) {
        sink.fileBytes += sink.buffered;
        sink.buffered = 0;
      }
      onWrite?.();
    },
    async finish() {
      return { filePath: 'downloads/demo_m1/demo_m1_e1.ts', blobKey: null, size: sink.fileBytes };
    },
    async suspend() {
      sink.fileBytes += sink.buffered;
      sink.buffered = 0;
    },
    async abort() {
      sink.fileBytes = 0;
      sink.buffered = 0;
    },
  };
  return sink;
}

describe('暂停时把磁盘真值结算回 DB（DL-P1-4）', () => {
  it('暂停后落库的字节数等于刷盘后的文件大小，续传不再被判成损坏重下', async () => {
    const ctrl = new AbortController();
    let writes = 0;
    const sink = bufferedSink(() => {
      writes += 1;
      if (writes === 3) ctrl.abort();
    });
    const patches: Partial<DownloadTask>[] = [];
    const fetchImpl = fetchFor(10, segments(10, (index) => index + 1));
    const calls = () => (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        patches.push(patch);
      },
      fetchImpl,
      createSinkImpl: () => sink,
    });

    await expect(downloader.run(task(), ctrl.signal)).rejects.toMatchObject({ code: 'E_ABORTED' });

    const checkpoint = patches[patches.length - 1] as Partial<DownloadTask>;
    // 快照：落库的是同一个数组引用，续传那一轮会把它继续增长
    const done = [...((checkpoint.completedSegments ?? []) as number[])];
    expect(done.length).toBeGreaterThan(0);
    // 刷盘把缓冲也写出去了：文件长度必须等于结算回 DB 的字节数
    expect(sink.buffered).toBe(0);
    expect(checkpoint.downloadedBytes).toBe(sink.fileBytes);

    // 拿这份结算结果续传
    const resumed = task({
      downloadedBytes: checkpoint.downloadedBytes ?? 0,
      completedSegments: done,
      totalBytes: 10 * SEGMENT_BYTES,
    });
    const resumeDownloader = createHlsDownloader({
      load: async () => resumed,
      saveProgress: async () => undefined,
      fetchImpl,
      createSinkImpl: () => sink,
    });
    const callsBeforeResume = calls();
    const fileBytesAtResume = sink.fileBytes;
    await resumeDownloader.run(resumed, new AbortController().signal);

    // 只 begin 了一次：起点与磁盘长度对得上，没触发「从头下载」的第二次 begin
    expect(sink.begins).toEqual([0, fileBytesAtResume]);
    // 清单 1 次 + 只补没落盘的那些片（旧实现这里会把 10 片全重下一遍）
    expect(calls() - callsBeforeResume).toBe(1 + (10 - done.length));
    expect(sink.fileBytes).toBe(10 * SEGMENT_BYTES);
  });
});

/**
 * 跨集产物指纹（DL-P0-2 闭环）。
 *
 * 真机实测那批 881,720 字节的假成品，每一集只发 2 片——永远进不了「≥8 片」的集内重复阈值。
 * 重复发生在集与集之间，所以边写边折一个集级滚动指纹，完成后拿它问服务层「同一部剧的另一集
 * 是不是就是这个字节」。命中即拒交付：删产物、清 filePath、判不可重试。
 */
describe('跨集同指纹判占位（DL-P0-2）', () => {
  /** 跑一遍下载，返回落库的集级指纹与全部补丁 */
  function runWith(
    count: number,
    fill: (index: number) => number,
    findTwinArtifact?: (mediaId: string, taskId: string, digest: string) => Promise<string | null>,
  ) {
    const patches: Partial<DownloadTask>[] = [];
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        patches.push(patch);
      },
      fetchImpl: fetchFor(count, segments(count, fill)),
      createSinkImpl: () => recorderSink([{ actualStartBytes: 0 }]),
      findTwinArtifact,
    });
    return { downloader, patches };
  }

  it('同一部剧的另一集指纹相同：拒交付、清掉成品字段、判不可重试', async () => {
    const seen: string[] = [];
    const { downloader, patches } = runWith(3, (index) => index + 1, async (mediaId, taskId, digest) => {
      seen.push(`${mediaId}|${taskId}|${digest}`);
      return '第 2 集';
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_FAKE_SOURCE_CONTENT',
      retryable: false,
      message: expect.stringContaining('第 2 集'),
    });

    // 查的是这一集刚折出来的指纹，且任务身份没有错位
    const saved = patches.find((p) => p.contentDigest)?.contentDigest;
    expect(saved).toBeTruthy();
    expect(seen).toEqual([`demo:m1|task-hls|${saved}`]);

    // 收尾把成品字段抹掉：库里不能留下一个指向占位文件的 filePath
    const cleared = patches.find((p) => p.contentDigest === null);
    expect(cleared).toBeDefined();
    expect(cleared?.filePath).toBeNull();
    expect(cleared?.blobKey).toBeNull();
  });

  it('没有同指纹的另一集时照常交付（闸门不误杀）', async () => {
    const { downloader, patches } = runWith(3, (index) => index + 1, async () => null);

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();
    expect(patches.some((p) => p.completedAt !== undefined)).toBe(true);
  });

  it('查重本身读库失败只少一道网，不许把下好的视频判成占位', async () => {
    const { downloader, patches } = runWith(3, (index) => index + 1, async () => {
      throw new Error('事务被占用');
    });

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();
    expect(patches.some((p) => p.completedAt !== undefined)).toBe(true);
  });

  it('同一份字节每集折出的指纹相同，内容不同则不同（跨集比对的前提）', async () => {
    const digests: string[] = [];
    const collect = async (fill: (index: number) => number) => {
      const { downloader } = runWith(4, fill, async (_mediaId, _taskId, digest) => {
        digests.push(digest);
        return null;
      });
      await downloader.run(task(), new AbortController().signal);
    };

    await collect((index) => index + 1);
    await collect((index) => index + 1);
    await collect((index) => index + 7);

    expect(digests).toHaveLength(3);
    expect(digests[0]).toBe(digests[1]);
    expect(digests[0]).not.toBe(digests[2]);
  });

  it('分片顺序不同就是不同产物：不会把两集不同的剪辑误判成同一份', async () => {
    const digests: string[] = [];
    const collect = async (reversed: boolean) => {
      const { downloader } = runWith(4, (index) => (reversed ? 4 - index : index + 1), async (_m, _t, digest) => {
        digests.push(digest);
        return null;
      });
      await downloader.run(task(), new AbortController().signal);
    };

    await collect(false);
    await collect(true);
    expect(digests[0]).not.toBe(digests[1]);
  });
});
