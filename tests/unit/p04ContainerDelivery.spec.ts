import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0-4：容器判定、`remuxToMp4` 开关与任务阶段要一路接到交付那一步。
 *
 * 修之前这三件事各断一截：
 * - 容器只在转封装成功落库那笔才写，清单说 fMP4 也照样请原生转封装，
 *   而原生对 fMP4 只回一句 `skipped: fmp4-passthrough` 且不做任何文件操作——
 *   一份本来就是 MP4 家族的产物，账上永远停在「没判定」，交付名也永远是指向 `.ts`；
 * - 开关只挡住了存量迁移，新下载照转不误；
 * - 看门狗按 `updatedAt` 判停滞（90s），可转封装实测能跑几百秒且不产生字节进度，
 *   而 runner 仍占着队列槽位 → 走的是 `abortTask` 那一支，把一份马上要交付的产物打断重跑；
 * - JS 侧从没接原生那句 `cancelRemux`，取消之后晚到的结果还照常提交。
 */

const h = vi.hoisted(() => {
  const remuxEnabled = { value: true };
  return {
    remuxEnabled,
    remuxMp4: vi.fn(),
    cancelRemux: vi.fn(),
    verifyRemuxedMedia: vi.fn(),
    getStorageInfo: vi.fn(),
    writeBase64: vi.fn(async () => undefined),
    renameFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async () => undefined),
  };
});

vi.mock('@/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform')>();
  return { ...actual, isNative: () => true };
});

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/services/settingsService', async (importOriginal) => {
  // 保留其余导出：`resetAll()` 要拿真实的 `__resetCache` 清缓存
  const actual = await importOriginal<typeof import('@/services/settingsService')>();
  return {
    ...actual,
    settingsService: {
      ...actual.settingsService,
      get: async () => ({ download: { remuxToMp4: h.remuxEnabled.value } }),
    },
  };
});

vi.mock('@/native/mediaToolPlugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/mediaToolPlugin')>();
  return {
    ...actual,
    isMediaToolAvailable: () => true,
    getStorageInfo: h.getStorageInfo,
    // 复检要从这层接：`verifyRemuxedMedia` 是模块内函数，内部引用的是插件对象本身，
    // 只 mock `MediaTool` 的话它照样会撞上"能力缺席"，把有效的 fMP4 判成 unverified
    verifyRemuxedMedia: h.verifyRemuxedMedia,
    MediaTool: { ...actual.MediaTool, remuxMp4: h.remuxMp4, cancelRemux: h.cancelRemux },
  };
});

vi.mock('@/native/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/fs')>();
  return { ...actual, writeBase64: h.writeBase64, renameFile: h.renameFile, deleteFile: h.deleteFile };
});

// 原生代理在测试环境不可用：让分片请求直接走注入的 fetchImpl
vi.mock('@/native/localProxy', () => ({
  LocalProxy: { proxy: vi.fn().mockRejectedValue(new Error('proxy unavailable')) },
}));

import { createHlsDownloader, parseM3u8 } from '@/services/hlsDownloader';
import { getPhase, isInTrackedPostProcess } from '@/services/downloadPhaseRegistry';
import type { DownloadTask } from '@/types';
import { fmp4Segment, resetAll, tsSegment } from './helpers';

const TS_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
https://cdn.example.com/segment0.ts
#EXTINF:9.009,
https://cdn.example.com/segment1.ts
#EXT-X-ENDLIST`;

const FMP4_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="https://cdn.example.com/init.mp4"
#EXTINF:9.009,
https://cdn.example.com/segment0.m4s
#EXTINF:9.009,
https://cdn.example.com/segment1.m4s
#EXT-X-ENDLIST`;

/** 中途换初始化段：规范允许，但合并产物只有一个文件头，按 fMP4 交付就是头尾不匹配 */
const MULTI_MAP_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="https://cdn.example.com/init.mp4"
#EXTINF:9.009,
https://cdn.example.com/segment0.m4s
#EXT-X-MAP:URI="https://cdn.example.com/init2.mp4"
#EXTINF:9.009,
https://cdn.example.com/segment1.m4s
#EXT-X-ENDLIST`;

const TS_PATH = '/storage/emulated/0/Android/data/com.qoder.cinema/files/downloads/m1/e1.ts';
const MP4_PATH = TS_PATH.replace(/\.ts$/, '.mp4');

/** 转封装/复检通过的产物：交付那一步只认这个形状 */
const PASS = { ok: true, skipped: false, outputBytes: 180, durationMs: 40, probeVerdict: 'pass' };

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: 'task-p04',
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
    ...overrides,
  };
}

/**
 * 假网络：清单按 `playlist` 返回，分片按扩展名给结构合法的字节。
 * `failOn` 命中的 URL 返回 404，用来造「缺初始化分片 / 缺一页分片」。
 * `slowFirst` 让 0 号分片比 1 号晚到：分片是并发取的，到达顺序不等于写入顺序。
 */
function mockFetch(playlist: string, failOn?: string, slowFirst?: boolean): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (failOn && url.includes(failOn)) return new Response('nope', { status: 404 });
    if (url.endsWith('.m3u8')) {
      return new Response(playlist, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
    }
    if (url.endsWith('.mp4')) return new Response(fmp4Segment('ftyp'), { status: 200 });
    if (url.endsWith('.m4s')) return new Response(fmp4Segment('moof'), { status: 200 });
    const index = Number(/segment(\d+)\.ts$/.exec(url)?.[1] ?? 0);
    if (slowFirst && index === 0) await new Promise((resolve) => setTimeout(resolve, 30));
    // 用 fill 把分片序号编进字节，合并结果才能反查顺序
    return new Response(tsSegment(2, index), { status: 200 });
  }) as unknown as typeof fetch;
}

function setup(playlist: string, failOn?: string, slowFirst?: boolean) {
  const patches: Array<Partial<DownloadTask>> = [];
  const chunks: Uint8Array[] = [];
  let written = 0;
  const downloader = createHlsDownloader({
    load: async () => task(),
    saveProgress: async (_id, patch) => {
      patches.push(patch);
    },
    fetchImpl: mockFetch(playlist, failOn, slowFirst),
    createSinkImpl: () => ({
      kind: 'filesystem',
      async begin() {
        return { actualStartBytes: 0 };
      },
      async write(chunk) {
        chunks.push(chunk);
        written += chunk.byteLength;
      },
      async finish() {
        return { filePath: TS_PATH, blobKey: null, size: written };
      },
      async suspend() {},
      async abort() {},
    }),
  });
  return { downloader, patches, chunks };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** 等到某个布尔条件成立（最多 200 拍），替代裸 sleep */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  if (!cond()) throw new Error('等待条件超时');
}

beforeEach(async () => {
  await resetAll();
  h.remuxEnabled.value = true;
  for (const fn of [h.remuxMp4, h.cancelRemux, h.verifyRemuxedMedia, h.getStorageInfo, h.writeBase64, h.renameFile, h.deleteFile]) {
    fn.mockReset();
  }
  h.cancelRemux.mockImplementation(async () => ({ canceled: true }));
  h.writeBase64.mockImplementation(async () => undefined);
  h.renameFile.mockImplementation(async () => undefined);
  h.deleteFile.mockImplementation(async () => undefined);
  // 默认放行：空间充足、复检通过（各用例按需要覆写）
  h.getStorageInfo.mockResolvedValue({ freeBytes: 10_000_000_000, totalBytes: 20_000_000_000, appBytes: 0 });
  h.verifyRemuxedMedia.mockResolvedValue({ ok: true, probeVerdict: 'pass', outputBytes: 200 });
});

describe('P0-4 容器贯穿交付', () => {
  it('TS 线路：请原生转封装，交付后容器与格式一起改指 mp4', async () => {
    h.remuxMp4.mockResolvedValue(PASS);
    const { downloader, patches } = setup(TS_PLAYLIST);

    await downloader.run(task(), new AbortController().signal);

    // containerDetected：清单口径先落一次库，之后交付才改成 mp4
    expect(patches.some((p) => p.container === 'ts')).toBe(true);
    expect(h.remuxMp4.mock.calls[0]?.[0]).toMatchObject({
      inputPath: TS_PATH,
      outputPath: MP4_PATH,
      container: 'ts',
      deleteInput: false,
      timeoutMs: 300_000,
    });
    const committed = patches.find((p) => p.filePath === MP4_PATH);
    expect(committed).toMatchObject({ format: 'mp4', container: 'mp4', totalBytes: 180 });
    expect(h.deleteFile).toHaveBeenCalledWith(TS_PATH);
  });

  /**
   * fMP4 的字节本来就是 MP4 家族：转封装是多余的（原生也只做 passthrough）。
   * 这一路要的是「复检 → 改名 → 落库」，容器名跟着判定写 `fmp4`，
   * 且输入与交付件是同一份字节，一次删除都不许发生。
   */
  it('fMP4 线路：不跑转封装，复检通过后改名交付 container=fmp4', async () => {
    const { downloader, patches } = setup(FMP4_PLAYLIST);

    await downloader.run(task(), new AbortController().signal);

    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(patches.some((p) => p.container === 'fmp4')).toBe(true);
    expect(h.verifyRemuxedMedia.mock.calls[0]?.[0]).toBe(TS_PATH);
    expect(h.renameFile).toHaveBeenCalledWith(TS_PATH, MP4_PATH);
    const committed = patches.find((p) => p.filePath === MP4_PATH);
    expect(committed).toMatchObject({ format: 'mp4', container: 'fmp4' });
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  /**
   * P0-4：「检查初始化段变化」要有地方落地。规范允许中途换 `#EXT-X-MAP`，而合并产物
   * 只有一个文件头——旧实现让后来者赢，头跟前面所有分片都对不上，还被当成有效 fMP4 改名交付。
   */
  it('换 init 段的清单：数量记下来、头部取第一份声明、容器降级为 other', () => {
    const playlist = parseM3u8(MULTI_MAP_PLAYLIST, 'https://cdn.example.com/master.m3u8');
    expect(playlist.initMapCount).toBe(2);
    expect(playlist.initSegment?.url).toBe('https://cdn.example.com/init.mp4');
    expect(playlist.container).toBe('other');
  });

  it('换 init 段：不去取第二份声明，按 other 交给原生探测而不是改名直通', async () => {
    h.remuxMp4.mockResolvedValue(PASS);
    const { downloader, patches } = setup(MULTI_MAP_PLAYLIST, 'init2.mp4');

    await downloader.run(task(), new AbortController().signal);

    expect(h.verifyRemuxedMedia).not.toHaveBeenCalled();
    expect(h.remuxMp4.mock.calls[0]?.[0]).toMatchObject({ container: 'other' });
    expect(patches.some((p) => p.container === 'other')).toBe(true);
  });

  /** 缺 init 段：下载阶段就断，产物根本进不到交付，也就没人偷偷改指一份残缺的 .mp4 */
  it('fMP4 缺初始化分片：判失败，交付动作一次都不做', async () => {
    const { downloader, patches } = setup(FMP4_PLAYLIST, 'init.mp4');

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toBeTruthy();

    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(h.renameFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(patches.some((p) => p.filePath === MP4_PATH)).toBe(false);
  });

  /** 分片缺一页（乱序调度里的丢片）：合并都没发生，谈不上交付 */
  it('分片缺失：不进入交付，也不留下改指的记录', async () => {
    const { downloader, patches } = setup(TS_PLAYLIST, 'segment1.ts');

    await expect(downloader.run(task(), new AbortController().signal)).rejects.toBeTruthy();

    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(patches.some((p) => p.filePath === MP4_PATH)).toBe(false);
  });

  /** 截断的 fMP4 产物：改名等于把一份坏件提升成唯一可引用产物，必须拦下 */
  it('fMP4 复检不过（截断）：保持 .ts，不交付', async () => {
    h.verifyRemuxedMedia.mockResolvedValue({ ok: false, probeVerdict: 'tail-seek-miss', outputBytes: 200 });
    const { downloader, patches } = setup(FMP4_PLAYLIST);

    await downloader.run(task(), new AbortController().signal);

    expect(h.renameFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(patches.some((p) => p.filePath === MP4_PATH)).toBe(false);
    expect(patches.find((p) => p.remux !== undefined)?.remux).toMatchObject({
      status: 'failed',
      outcome: 'verify-failed',
      probeVerdict: 'tail-seek-miss',
    });
  });

  /**
   * 分片并发取，1 号先回来是常态。合并必须按清单序号写入，交付也只发生一次
   * （乱序最坏的历史后果是「同一集转封装两遍」）。
   */
  it('分片乱序到达：按清单序号合并，转封装只跑一次', async () => {
    h.remuxMp4.mockResolvedValue(PASS);
    const { downloader, chunks, patches } = setup(TS_PLAYLIST, undefined, true);

    await downloader.run(task(), new AbortController().signal);

    // fill 字节里编的是分片号：写入序列必须是 0 → 1
    expect(chunks.map((c) => c[1])).toEqual([0, 1]);
    expect(h.remuxMp4).toHaveBeenCalledTimes(1);
    // 交付改指 .mp4 也只有一笔：乱序不该让同一条任务跑第二遍后处理
    expect(patches.filter((p) => p.filePath === MP4_PATH)).toHaveLength(1);
  });

  /**
   * P0-4：转封装前按目标文件系统核算空间。原生那句 `insufficient-space` 要等它跑起来才知道，
   * 提前判定省掉一次「跑到一半写不下」的白烧；账记成 `skipped`，与「没开转封装」区分得开。
   */
  it('剩余空间放不下第二份产物：跳过转换并记 skipped，一次原生调用都不发', async () => {
    h.remuxMp4.mockResolvedValue(PASS);
    h.getStorageInfo.mockResolvedValue({ freeBytes: 100, totalBytes: 20_000, appBytes: 0 });
    const { downloader, patches } = setup(TS_PLAYLIST);

    await downloader.run(task(), new AbortController().signal);

    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(patches.find((p) => p.remux !== undefined)?.remux).toMatchObject({ status: 'skipped', outcome: 'skipped' });
  });

  /**
   * 关掉的开关对新下载同样有效（此前只挡住了存量迁移）。
   * 两种容器都要挡住：fMP4 那条改名路也是容器交付，不是「转封装」。
   */
  it('remuxToMp4 关闭：TS 与 fMP4 都不做容器交付，原件即成品', async () => {
    h.remuxEnabled.value = false;
    const ts = setup(TS_PLAYLIST);
    await ts.downloader.run(task(), new AbortController().signal);
    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(ts.patches.some((p) => p.filePath === MP4_PATH)).toBe(false);

    const fmp4 = setup(FMP4_PLAYLIST);
    await fmp4.downloader.run(task(), new AbortController().signal);
    expect(h.verifyRemuxedMedia).not.toHaveBeenCalled();
    expect(h.renameFile).not.toHaveBeenCalledWith(TS_PATH, MP4_PATH);
    // 容器判定本身照样落库——那是事实，不是可选优化
    expect(fmp4.patches.some((p) => p.container === 'fmp4')).toBe(true);
  });
});

describe('P0-4 后处理阶段与取消', () => {
  /**
   * 看门狗按 `updatedAt` 判停滞（90s），而一次大片的转封装能跑几百秒且不产生字节进度。
   * runner 在后处理期间把任务登记在这里，看门狗据此放过它；预算取「原生超时 + 宽限」。
   */
  it('转封装进行中：任务登记为 postprocess 阶段，结束即注销', async () => {
    const gate = deferred<typeof PASS>();
    h.remuxMp4.mockReturnValue(gate.promise);
    const { downloader } = setup(TS_PLAYLIST);

    const run = downloader.run(task(), new AbortController().signal);
    await until(() => h.remuxMp4.mock.calls.length > 0);

    expect(getPhase('task-p04')?.phase).toBe('postprocess');
    expect(isInTrackedPostProcess('task-p04', Date.now())).toBe(true);
    // 预算必须盖得住原生那一笔的超时，否则 90s 阈值的看门狗照样会打断它
    expect(getPhase('task-p04')?.deadlineMs).toBeGreaterThanOrEqual(300_000);

    gate.resolve(PASS);
    await run;
    expect(getPhase('task-p04')).toBeNull();
    expect(isInTrackedPostProcess('task-p04', Date.now())).toBe(false);
  });

  /**
   * 取消要接到原生 `cancelRemux`（此前 JS 侧从没调用过它），并且晚到的结果不许提交：
   * 真机上「取消后整集重下 / 记录指向一份没人等的 .mp4」就是这两件事缺一半造成的。
   */
  it('取消转封装：cancelRemux 收到回执，晚到的通过结果不提交', async () => {
    const gate = deferred<typeof PASS>();
    h.remuxMp4.mockReturnValue(gate.promise);
    const controller = new AbortController();
    const { downloader, patches } = setup(TS_PLAYLIST);

    const run = downloader.run(task(), controller.signal);
    await until(() => h.remuxMp4.mock.calls.length > 0);

    const startedAt = Date.now();
    controller.abort();
    // 原生侧收到取消后很快返回（真实行为：worker 在样本循环边界停手）
    gate.resolve(PASS);
    await expect(run).rejects.toMatchObject({ code: 'E_ABORTED' });
    expect(Date.now() - startedAt).toBeLessThan(1000);

    expect(h.cancelRemux).toHaveBeenCalledTimes(1);
    expect(h.cancelRemux.mock.calls[0]?.[0]).toMatchObject({ taskId: 'task-p04', inputPath: TS_PATH });
    // 晚到的 pass 不许把记录改指 .mp4，也不许删原件
    expect(patches.some((p) => p.filePath === MP4_PATH)).toBe(false);
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(patches.find((p) => p.remux?.outcome !== undefined)?.remux).toMatchObject({
      status: 'failed',
      outcome: 'canceled',
    });
    // 阶段登记在异常路径上也要收掉，不然这条任务从此对停滞检测免疫
    expect(getPhase('task-p04')).toBeNull();
  });
});
