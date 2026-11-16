import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OPT-05：HLS 收尾（转封装）的阶段状态
 *
 * `DownloadRemuxInfo` 早就声明了 `skipped` / `failed`，实现却只在成功时落库；
 * `postprocess` 事件的 `stage: 'remux'` 也从没发过。结果是两类看不见的状态：
 *
 * 1. 分片写完 → 任务仍是 `downloading`（状态要等 runner 整体返回才迁移），
 *    进度条 100% 却写着「下载中…」，长视频能持续几分钟，用户以为卡死；
 * 2. 转封装失败/跳过 → 任务停在 `remux: null`，与「没开转封装」一模一样，
 *    用户只能看到「文件一直是 .ts」，没有任何线索指向真正的原因。
 *
 * 这里锁住四条：阶段事件成对、四种结局都落库、落库异常不把下载判成失败。
 */

vi.mock('@/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform')>();
  return { ...actual, isNative: () => true };
});

const { remuxMp4 } = vi.hoisted(() => ({ remuxMp4: vi.fn() }));
vi.mock('@/native/mediaToolPlugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/mediaToolPlugin')>();
  return {
    ...actual,
    isMediaToolAvailable: () => true,
    MediaTool: { ...actual.MediaTool, remuxMp4 },
  };
});

// 原生代理在测试环境不可用：让分片请求直接走注入的 fetchImpl
vi.mock('@/native/localProxy', () => ({
  LocalProxy: { proxy: vi.fn().mockRejectedValue(new Error('proxy unavailable')) },
}));

import { createHlsDownloader, type PostProcessNotifier } from '@/services/hlsDownloader';
import type { DownloadTask } from '@/types';
import { resetAll, tsSegment } from './helpers';

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
https://cdn.example.com/segment0.ts
#EXTINF:9.009,
https://cdn.example.com/segment1.ts
#EXT-X-ENDLIST`;

const TS_PATH = '/storage/emulated/0/Android/data/com.qoder.cinema/files/downloads/m1/e1.ts';

function task(): DownloadTask {
  const now = Date.now();
  return {
    id: 'task-remux',
    sourceId: 'demo',
    mediaId: 'm1',
    episodeId: 'e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/master.m3u8',
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

function mockFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('.ts')) return new Response(tsSegment(1), { status: 200 });
    return new Response(MEDIA_PLAYLIST, {
      status: 200,
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    });
  }) as unknown as typeof fetch;
}

/** 只关心收尾阶段的落库内容，进度节流与真实 sink 不参与本用例 */
function setup() {
  const patches: Array<Partial<DownloadTask>> = [];
  const stages: string[] = [];
  const notifier: PostProcessNotifier = (_task, stage, state, extra) => {
    stages.push(`${stage}:${state}${extra?.reason ? `:${extra.reason}` : ''}`);
  };
  const downloader = createHlsDownloader({
    load: async () => task(),
    saveProgress: async (_id, patch) => {
      patches.push(patch);
    },
    fetchImpl: mockFetch(),
    createSinkImpl: () => ({
      kind: 'filesystem',
      async begin() {
        return { actualStartBytes: 0 };
      },
      async write() {},
      async finish() {
        return { filePath: TS_PATH, blobKey: null, size: 200 };
      },
      async suspend() {},
      async abort() {},
    }),
    onPostProcess: notifier,
  });
  const remuxPatch = () => patches.find((p) => p.remux !== undefined)?.remux;
  return { downloader, patches, stages, remuxPatch };
}

describe('OPT-05 转封装阶段状态', () => {
  beforeEach(async () => {
    await resetAll();
    remuxMp4.mockReset();
  });

  it('成功：start → done，并回写 mp4 路径与体积', async () => {
    remuxMp4.mockResolvedValue({ ok: true, skipped: false, outputBytes: 180, durationMs: 1234 });
    const { downloader, stages, patches } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:done']);
    const saved = patches.find((p) => p.remux?.status === 'done');
    expect(saved?.filePath).toBe(TS_PATH.replace(/\.ts$/, '.mp4'));
    expect(saved?.totalBytes).toBe(180);
  });

  it('跳过：落库 skipped + 原因，事件同步收口', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: true, reason: 'not-mpeg-ts' });
    const { downloader, stages, remuxPatch } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:skipped:not-mpeg-ts']);
    expect(remuxPatch()).toEqual({ status: 'skipped', reason: 'not-mpeg-ts' });
  });

  it('失败：reason 缺失时退回 code，且不动已下好的 .ts 路径', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_FFMPEG_EXIT' });
    const { downloader, stages, remuxPatch, patches } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:failed:E_FFMPEG_EXIT']);
    expect(remuxPatch()).toEqual({ status: 'failed', reason: 'E_FFMPEG_EXIT' });
    // 没有任何一次落库把 filePath 改成 mp4
    expect(patches.every((p) => p.filePath === undefined || p.filePath === TS_PATH)).toBe(true);
  });

  it('原生桥抛异常：仍按失败落库，且不把下载判成失败', async () => {
    remuxMp4.mockRejectedValue(new Error('插件未响应'));
    const { downloader, stages, remuxPatch } = setup();

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();

    expect(stages).toEqual(['remux:start', 'remux:failed:插件未响应']);
    expect(remuxPatch()).toEqual({ status: 'failed', reason: '插件未响应' });
  });

  it('状态落库失败只记日志：收尾阶段的问题不该毁掉已完成的下载', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: true, reason: 'not-mpeg-ts' });
    const stages: string[] = [];
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        if (patch.remux) throw new Error('写库失败');
      },
      fetchImpl: mockFetch(),
      createSinkImpl: () => ({
        kind: 'filesystem',
        async begin() {
          return { actualStartBytes: 0 };
        },
        async write() {},
        async finish() {
          return { filePath: TS_PATH, blobKey: null, size: 200 };
        },
        async suspend() {},
        async abort() {},
      }),
      onPostProcess: (_task, stage, state) => stages.push(`${stage}:${state}`),
    });

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();

    expect(stages).toEqual(['remux:start', 'remux:skipped']);
  });
});
