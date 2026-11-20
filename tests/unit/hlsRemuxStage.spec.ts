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

const { deleteFile } = vi.hoisted(() => ({ deleteFile: vi.fn(async () => undefined) }));
vi.mock('@/native/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/fs')>();
  return { ...actual, deleteFile };
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
function setup(options: { findTwinArtifact?: (mediaId: string, taskId: string, digest: string) => Promise<string | null> } = {}) {
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
    findTwinArtifact: options.findTwinArtifact,
  });
  const remuxPatch = () => patches.find((p) => p.remux !== undefined)?.remux;
  return { downloader, patches, stages, remuxPatch };
}

describe('OPT-05 转封装阶段状态', () => {
  beforeEach(async () => {
    await resetAll();
    remuxMp4.mockReset();
    deleteFile.mockReset();
    deleteFile.mockImplementation(async () => undefined);
  });

  it('成功：复检通过后先落库再删 .ts（start → done）', async () => {
    remuxMp4.mockResolvedValue({
      ok: true,
      skipped: false,
      outputBytes: 180,
      durationMs: 1234,
      probeVerdict: 'pass',
      inputRetained: true,
    });
    const { downloader, stages, patches } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:done']);
    const saved = patches.find((p) => p.remux?.status === 'done' && p.filePath);
    expect(saved?.filePath).toBe(TS_PATH.replace(/\.ts$/, '.mp4'));
    expect(saved?.totalBytes).toBe(180);
    // 原件的删除权在 JS 侧：原生不许在返回前删（否则复检失败就只剩一份没验证的产物）
    expect(remuxMp4.mock.calls[0]?.[0]).toMatchObject({ deleteInput: false });
    // 删 .ts 必须排在改指 .mp4 之后
    const commitIndex = patches.findIndex((p) => p.filePath === TS_PATH.replace(/\.ts$/, '.mp4'));
    expect(commitIndex).toBeGreaterThanOrEqual(0);
    expect(deleteFile).toHaveBeenCalledWith(TS_PATH);
    // 交付阶段一路记到 input-cleaned，开机对账据此跳过这条
    expect(patches.at(-1)?.remux).toMatchObject({ delivery: 'input-cleaned', probeVerdict: 'pass' });
  });

  /**
   * P0-3 的核心红线：复检不过 = 原生已丢弃 `.mp4`、`.ts` 保留，
   * 记录必须继续指 `.ts`，且一次都不许删盘上任何东西。
   * 注入的是「`.mp4` 被截断」——真机上「转封装过的视频报时间轴异常」就是这一类产物。
   */
  it('复检失败（截断的 MP4）：不交付、不删原件，记录仍指 .ts', async () => {
    remuxMp4.mockResolvedValue({
      ok: false,
      skipped: false,
      code: 'E_UNSUPPORTED_FORMAT',
      reason: 'verify-failed:tail-seek-miss',
      probeVerdict: 'tail-seek-miss',
      inputRetained: true,
    });
    const { downloader, stages, remuxPatch, patches } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:failed:verify-failed:tail-seek-miss']);
    expect(remuxPatch()).toMatchObject({
      status: 'failed',
      outcome: 'verify-failed',
      reason: 'verify-failed:tail-seek-miss',
      probeVerdict: 'tail-seek-miss',
    });
    expect(patches.every((p) => p.filePath === undefined || p.filePath === TS_PATH)).toBe(true);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  /** `muxer.stop()` 抛错这类原生失败：按失败落库，产物保持 .ts */
  it('muxer.stop() 失败：普通失败档，不动产物', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_UNSUPPORTED_FORMAT', reason: 'no-samples' });
    const { downloader, remuxPatch } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(remuxPatch()).toMatchObject({ status: 'failed', outcome: 'failed', reason: 'no-samples' });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  /** ENOSPC：同样是失败档，且绝不能走到删输入那一步 */
  it('空间不足（ENOSPC）：失败档且保留 .ts', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_STORAGE_QUOTA', reason: 'insufficient-space' });
    const { downloader, stages, remuxPatch } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:failed:insufficient-space']);
    expect(remuxPatch()).toMatchObject({ status: 'failed', outcome: 'failed', reason: 'insufficient-space' });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  /**
   * 复检通过、改指 .mp4 的那一笔写不进去：这就是「落库失败」档。
   * 处置是保留两份产物、记录仍指 .ts，并禁止删除输入——崩在这里由开机对账认领。
   */
  it('复检通过但交付落库失败：两份产物都留着，记录仍指 .ts', async () => {
    remuxMp4.mockResolvedValue({
      ok: true,
      skipped: false,
      outputBytes: 180,
      durationMs: 12,
      probeVerdict: 'pass',
      inputRetained: true,
    });
    const MP4_PATH = TS_PATH.replace(/\.ts$/, '.mp4');
    const patches: Array<Record<string, unknown>> = [];
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        patches.push(patch as Record<string, unknown>);
        // 只有「改指 .mp4」这一笔失败，其余照常
        if (patch.filePath === MP4_PATH) throw new Error('IndexedDB quota exceeded');
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
    });

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();

    // 发布标记留下来了（崩在这里对账能找到那份 .mp4），交付那一笔失败
    expect(patches.some((p) => (p.remux as { delivery?: string } | undefined)?.delivery === 'published')).toBe(true);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  /** 能力缺席（旧 APK 不回报复检结论）：不交付，也不删原件 */
  it('原生未回报复检结论：按未经校验处理，保持 .ts 交付', async () => {
    remuxMp4.mockResolvedValue({ ok: true, skipped: false, outputBytes: 180, durationMs: 1234 });
    const { downloader, stages, remuxPatch, patches } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:failed:unverified-capability']);
    expect(remuxPatch()).toMatchObject({ status: 'failed', outcome: 'unverified' });
    expect(patches.every((p) => p.filePath === undefined || p.filePath === TS_PATH)).toBe(true);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  /** 取消档：用户取消转封装时记 `canceled`，不许记成失败后被当成坏件证据 */
  it('取消转封装：记 canceled 档且保留 .ts', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_CANCELED', reason: 'canceled' });
    const { downloader, remuxPatch } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(remuxPatch()).toMatchObject({ status: 'failed', outcome: 'canceled', reason: 'canceled' });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('超时档：记 timeout，与真正的转封装失败分开', async () => {
    remuxMp4.mockRejectedValue(new Error('remux timeout'));
    const { downloader, remuxPatch } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(remuxPatch()).toMatchObject({ status: 'failed', outcome: 'timeout' });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('跳过：落库 skipped + 原因，事件同步收口', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: true, reason: 'not-mpeg-ts' });
    const { downloader, stages, remuxPatch } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:skipped:not-mpeg-ts']);
    expect(remuxPatch()).toMatchObject({ status: 'skipped', outcome: 'skipped', reason: 'not-mpeg-ts' });
  });

  it('失败：reason 缺失时退回 code，且不动已下好的 .ts 路径', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_FFMPEG_EXIT' });
    const { downloader, stages, remuxPatch, patches } = setup();

    await downloader.run(task(), new AbortController().signal);

    expect(stages).toEqual(['remux:start', 'remux:failed:E_FFMPEG_EXIT']);
    expect(remuxPatch()).toMatchObject({ status: 'failed', outcome: 'failed', reason: 'E_FFMPEG_EXIT' });
    // 没有任何一次落库把 filePath 改成 mp4
    expect(patches.every((p) => p.filePath === undefined || p.filePath === TS_PATH)).toBe(true);
  });

  it('原生桥抛异常：仍按失败落库，且不把下载判成失败', async () => {
    remuxMp4.mockRejectedValue(new Error('插件未响应'));
    const { downloader, stages, remuxPatch } = setup();

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();

    expect(stages).toEqual(['remux:start', 'remux:failed:插件未响应']);
    expect(remuxPatch()).toMatchObject({ status: 'failed', outcome: 'failed', reason: '插件未响应' });
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

  /**
   * DL-R0 同期更正（真机 11-18）：时间轴自检曾被当作占位内容的第二道证据，命中即删产物。
   * 实测那条判决对真实内容也会触发——1920x1080 / 2h44m30s 的一集报
   * `video-timeline-degenerate:ratchet=49%`（121,787/246,820 视频样本回退、音频 0 回退，
   * 而 246,820 ÷ 9,870.08s 正好 25.0 fps），这是 B 帧流按解码序出样的正常形态。
   * P1-1 之后 B 帧流在拷贝循环里就被分类为 `bframes-not-expressible` 并以 skipped 收口，
   * 但交付侧的口径一个字没变：时间轴问题只算一次普通的转封装未成交——不许删产物，
   * 更不许把已下完的一集判成下载失败。
   */
  it('时间轴按 skipped 收口（B 帧不可表达）：产物保留且照常交付', async () => {
    const skippedReason = 'bframes-not-expressible:depthUs=80000@videoSample37';
    remuxMp4.mockResolvedValue({ ok: false, skipped: true, reason: skippedReason });
    const { downloader, stages, remuxPatch, patches } = setup();

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();

    expect(stages).toEqual(['remux:start', `remux:skipped:${skippedReason}`]);
    expect(remuxPatch()).toMatchObject({ status: 'skipped', outcome: 'skipped', reason: skippedReason });
    expect(deleteFile).not.toHaveBeenCalled();
    // 没有任何一次落库把成品字段抹掉
    expect(patches.some((p) => p.filePath === null || p.contentDigest === null)).toBe(false);
  });

  it('自检以异常形式抛出时同样只记失败：不许把整集删掉', async () => {
    remuxMp4.mockRejectedValue(new Error('audio-timeline-mismatch:audioUs=3161000000/videoUs=5293000000'));
    const { downloader, stages } = setup();

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();
    expect(stages).toEqual([
      'remux:start',
      'remux:failed:audio-timeline-mismatch:audioUs=3161000000/videoUs=5293000000',
    ]);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  /**
   * 判废即清账：删掉产物必须把字节与分片索引一起归零。
   * 真机那一集就是栽在这里——库里留着 `dbBytes: 779919880` 与 988/988 的索引，
   * 磁盘上什么都没有，于是每一轮重新起跑都从零取回 780 MB，一天烧掉三轮。
   */
  it('跨集同指纹判废：删产物并把记账归零，且没有第二次落库把它写回去', async () => {
    // 转封装失败但 `.ts` 保留：判废要删的就是这份还在库里的产物
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_FFMPEG_EXIT' });
    const { downloader, patches } = setup({ findTwinArtifact: async () => '第 2 集' });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_FAKE_SOURCE_CONTENT',
      retryable: false,
    });

    expect(deleteFile).toHaveBeenCalledWith(TS_PATH);
    const cleared = patches.find((p) => p.contentDigest === null);
    expect(cleared).toMatchObject({
      filePath: null,
      blobKey: null,
      downloadedBytes: 0,
      completedSegments: [],
      hlsTotalSegments: 0,
    });
    expect(cleared?.totalBytes).toBeNull();
    // 外层 catch 的那次「停笔即结算」不许把归零的账再写回 200 字节
    expect(patches.filter((p) => p.downloadedBytes !== undefined).at(-1)).toBe(cleared);
  });

  /**
   * P0-3 与 DL-P0-2 的交点：崩在「`.mp4` 已发布、记录还没改指」时盘上有两份产物，
   * 而这条集又被跨集查重判成占位。判废只删记录引用的那份 `.ts` 是不够的——
   * 那份没被任何记录引用的孤儿 `.mp4` 会在下次开机对账里被"认领"成成品，
   * 把已经烧掉的 780 MB 再算一份有效内容。
   */
  it('交付落库失败 + 跨集判废：两份产物一起删掉', async () => {
    const MP4_PATH = TS_PATH.replace(/\.ts$/, '.mp4');
    remuxMp4.mockResolvedValue({
      ok: true,
      skipped: false,
      outputBytes: 180,
      durationMs: 12,
      probeVerdict: 'pass',
      inputRetained: true,
    });
    const downloader = createHlsDownloader({
      load: async () => task(),
      saveProgress: async (_id, patch) => {
        // 只有「改指 .mp4」这一笔失败：交付停在 published，两份产物都在盘上
        if (patch.filePath === MP4_PATH) throw new Error('IndexedDB quota exceeded');
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
      findTwinArtifact: async () => '第 2 集',
    });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_FAKE_SOURCE_CONTENT',
      retryable: false,
    });

    expect(deleteFile).toHaveBeenCalledWith(TS_PATH);
    expect(deleteFile).toHaveBeenCalledWith(MP4_PATH);
  });

  it('产物删不掉时把账留着：DL-R0 的采纳门槛才能零流量接回这份成品', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_FFMPEG_EXIT' });
    deleteFile.mockRejectedValue(new Error('EBUSY'));
    const { downloader, patches } = setup({ findTwinArtifact: async () => '第 2 集' });

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_FAKE_SOURCE_CONTENT',
    });

    const cleared = patches.find((p) => p.contentDigest === null);
    expect(cleared?.filePath).toBeNull();
    expect(cleared?.downloadedBytes).toBeUndefined();
    expect(cleared?.completedSegments).toBeUndefined();
  });

  it('其它原因的转封装失败不否决：真实内容不能因为容器问题被删掉', async () => {
    remuxMp4.mockResolvedValue({ ok: false, skipped: false, code: 'E_FFMPEG_EXIT', reason: 'ffmpeg-exit-1' });
    const { downloader } = setup();

    await expect(downloader.run(task(), new AbortController().signal)).resolves.toBeUndefined();
    expect(deleteFile).not.toHaveBeenCalled();
  });
});
