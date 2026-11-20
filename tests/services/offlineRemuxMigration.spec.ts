import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0-3 开机对账与存量迁移的接线（`runOfflineRemuxMigration`）。
 *
 * `remuxDelivery.spec.ts` 已经把 `reconcileRemuxDeliveries` 的十种盘上实况逐个锁住，
 * 但那一层证明不了"App 启动时真的会跑它"。这里锁三件事：
 * 1. 对账排在迁移之前——否则上一轮崩在交付中间的那条记录会被同一集再转封装一遍；
 * 2. 对账不受 `remuxToMp4` 开关影响——关掉的只是"新文件要不要转封装"，
 *    已经中断的交付照样要收口，不然「有记账无文件」的账永远修不好；
 * 3. 迁移侧也是「先落库改指 .mp4，再删 .ts」，且原生永远拿到 `deleteInput: false`。
 *
 * 每个用例都 `vi.resetModules()` 重新 import：模块里有一次性启动标志与"正在播放"状态。
 */

const h = vi.hoisted(() => {
  const seq: string[] = [];
  return {
    seq,
    listByStatus: vi.fn(),
    get: vi.fn(),
    save: vi.fn(),
    remuxMp4: vi.fn(),
    deleteFile: vi.fn(),
    renameFile: vi.fn(async () => undefined),
    stat: vi.fn(),
    getStorageInfo: vi.fn(),
    verifyRemuxedMedia: vi.fn(),
    emit: vi.fn(),
  };
});

/** 当前这轮 `download.remuxToMp4` 的取值 */
const remuxEnabled = vi.hoisted(() => ({ value: true }));

vi.mock('@/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform')>();
  return { ...actual, isNative: () => true };
});

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/native/mediaToolPlugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/mediaToolPlugin')>();
  return {
    ...actual,
    isMediaToolAvailable: () => true,
    getStorageInfo: h.getStorageInfo,
    verifyRemuxedMedia: h.verifyRemuxedMedia,
    MediaTool: { ...actual.MediaTool, remuxMp4: h.remuxMp4, addListener: vi.fn(async () => undefined) },
  };
});

vi.mock('@/native/fs', () => ({ deleteFile: h.deleteFile, renameFile: h.renameFile, stat: h.stat }));

vi.mock('@/db/repositories/downloadRepo', () => ({
  downloadRepo: { listByStatus: h.listByStatus, get: h.get, save: h.save },
}));

vi.mock('@/services/settingsService', () => ({
  settingsService: { get: async () => ({ download: { remuxToMp4: remuxEnabled.value } }) },
}));

vi.mock('@/services/events', () => ({ appEvents: { emit: h.emit } }));

import type { DownloadTask } from '@/types';

const DIR = '/storage/emulated/0/Android/data/com.qoder.cinema/files/downloads/m1';
const TS1 = `${DIR}/e1.ts`;
const MP41 = `${DIR}/e1.mp4`;
const TS2 = `${DIR}/e2.ts`;
const MP42 = `${DIR}/e2.mp4`;

function record(overrides: Partial<DownloadTask>): DownloadTask {
  const now = Date.now();
  return {
    id: 't',
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
    status: 'completed',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 1000,
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
    completedAt: now,
    ...overrides,
  } as DownloadTask;
}

/** 假盘序列里用文件名就够了，绝对路径会把断言淹掉 */
const tail = (path: string): string => path.split('/').pop() ?? path;

/**
 * 装一个假盘：`files` 里的路径才存在，其余 `stat` 报不存在。
 * `records` 同时喂给「已完成列表」与「按 ID 取记录」两条读路径。
 */
function wire(args: { files: Record<string, number>; records: DownloadTask[] }) {
  h.listByStatus.mockImplementation(async (statuses: string[]) => {
    if (statuses.includes('downloading')) return [];
    return args.records;
  });
  h.get.mockImplementation(async (id: string) => args.records.find((r) => r.id === id) ?? null);
  h.stat.mockImplementation(async (path: string) => {
    h.seq.push(`stat:${tail(path)}`);
    const size = args.files[path];
    return size === undefined ? { exists: false, size: 0 } : { exists: true, size };
  });
  h.save.mockImplementation(async (next: DownloadTask) => {
    h.seq.push(`save:${next.filePath === null ? 'null' : tail(next.filePath)}:${next.remux?.delivery ?? next.remux?.outcome ?? '-'}`);
    const at = args.records.findIndex((r) => r.id === next.id);
    if (at >= 0) args.records[at] = next;
  });
  h.deleteFile.mockImplementation(async (path: string) => {
    h.seq.push(`remove:${tail(path)}`);
    delete args.files[path];
  });
  h.getStorageInfo.mockResolvedValue({ freeBytes: 10_000_000_000, totalBytes: 20_000_000_000, appBytes: 0 });
  h.verifyRemuxedMedia.mockResolvedValue(null);
  h.remuxMp4.mockImplementation(async (args2: { inputPath: string }) => {
    h.seq.push(`remux:${tail(args2.inputPath)}`);
    return { ok: true, skipped: false, outputBytes: 1100, durationMs: 20, probeVerdict: 'pass', inputRetained: true };
  });
}

/** 跑一轮启动迁移（15 秒静默期用假时钟跨过），`prepare` 拿到的是真正执行这一轮的那个实例 */
async function boot(prepare?: (mod: typeof import('@/services/offlineRemuxMigration')) => void): Promise<void> {
  vi.useFakeTimers();
  const mod = await import('@/services/offlineRemuxMigration');
  prepare?.(mod);
  const run = mod.runOfflineRemuxMigration();
  await vi.advanceTimersByTimeAsync(20_000);
  await run;
  vi.useRealTimers();
}

beforeEach(() => {
  vi.resetModules();
  h.seq.length = 0;
  for (const fn of [h.listByStatus, h.get, h.save, h.remuxMp4, h.deleteFile, h.renameFile, h.stat, h.getStorageInfo, h.verifyRemuxedMedia, h.emit]) {
    fn.mockReset();
  }
  h.renameFile.mockImplementation(async () => undefined);
  remuxEnabled.value = true;
});

describe('P0-3 开机对账接线', () => {
  it('开关关掉时对账照跑：坏掉的 MP4 记账修回 .ts，且一次都不转封装', async () => {
    remuxEnabled.value = false;
    // 记录指 .mp4，但那份文件不在了（旧 deleteInput 时代删掉了原件之外的第三种形态：写库后崩在删 .ts 之前又被人清走）
    const mp4Gone = record({ id: 'gone', filePath: MP41 });
    wire({ files: { [TS1]: 1000 }, records: [mp4Gone] });

    await boot();

    const saved = h.save.mock.calls.map((c) => c[0] as DownloadTask);
    expect(saved.some((t) => t.filePath === TS1 && t.remux?.outcome === 'failed' && t.remux?.reason === 'artifact-missing')).toBe(true);
    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  it('对账排在迁移之前，且交付顺序是「改指 .mp4 落库 → 才删 .ts」', async () => {
    // 第一条：崩在发布与落库之间，记录仍指 .ts，盘上已有一份复检通过的孤儿 .mp4
    const interrupted = record({ id: 'orphan', filePath: TS1, downloadedBytes: 1000, totalBytes: 1000 });
    // 第二条：正常待迁移的 .ts
    const candidate = record({ id: 'todo', filePath: TS2, downloadedBytes: 1000, totalBytes: 1000 });
    wire({ files: { [TS1]: 1000, [MP41]: 1100, [TS2]: 1000 }, records: [interrupted, candidate] });
    h.verifyRemuxedMedia.mockImplementation(async (path: string) =>
      path === MP41 ? { ok: true, probeVerdict: 'pass', outputBytes: 1100 } : null,
    );

    await boot();

    // 原生侧一律不删输入
    expect(h.remuxMp4.mock.calls[0]?.[0]).toMatchObject({ inputPath: TS2, deleteInput: false });

    // 对账先于迁移：孤儿 .mp4 被认领并补删 .ts，都发生在第一次转封装之前
    const adopted = h.seq.indexOf(`save:${tail(MP41)}:committed`);
    const orphanCleaned = h.seq.indexOf(`remove:${tail(TS1)}`);
    const firstRemux = h.seq.indexOf(`remux:${tail(TS2)}`);
    expect(adopted).toBeGreaterThanOrEqual(0);
    expect(orphanCleaned).toBeGreaterThan(adopted);
    expect(firstRemux).toBeGreaterThan(orphanCleaned);
    // 对账已经收口的那一集不再转第二遍
    expect(h.seq).not.toContain(`remux:${tail(TS1)}`);

    // 迁移交付：改指 .mp4 的那笔落库必须排在删 .ts 之前
    const commit = h.seq.indexOf(`save:${tail(MP42)}:committed`);
    const cleaned = h.seq.indexOf(`remove:${tail(TS2)}`);
    expect(h.seq).toContain(`save:${tail(TS2)}:published`);
    expect(commit).toBeGreaterThanOrEqual(0);
    expect(cleaned).toBeGreaterThan(commit);
    expect(h.seq.at(-1)).toBe(`save:${tail(MP42)}:input-cleaned`);
  });

  it('正在播放的那条既不转封装也不删', async () => {
    const playing = record({ id: 'busy', filePath: TS2 });
    wire({ files: { [TS2]: 1000 }, records: [playing] });

    await boot((mod) => mod.markOfflineFileInUse('busy'));

    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  /**
   * P0-4：存量里的 fMP4 线路。原生 `remuxMp4` 对 fMP4 只回一句
   * `skipped: fmp4-passthrough` 且不做任何文件操作——照旧口径这一集永远修不好，
   * 下一轮启动再转一遍。它要的是「复检 → 改名 → 落库」。
   */
  it('存量 fMP4 只按复检结论改名，一次转封装都不跑', async () => {
    const fmp4 = record({ id: 'f', filePath: TS2, container: 'fmp4' });
    wire({ files: { [TS2]: 1000 }, records: [fmp4] });
    h.verifyRemuxedMedia.mockResolvedValue({ ok: true, probeVerdict: 'pass', outputBytes: 1000 });

    await boot();

    expect(h.remuxMp4).not.toHaveBeenCalled();
    expect(h.renameFile).toHaveBeenCalledWith(TS2, MP42);
    const saved = h.save.mock.calls.map((c) => c[0] as DownloadTask);
    expect(saved.some((t) => t.filePath === MP42 && t.container === 'fmp4' && t.remux?.status === 'done')).toBe(true);
    // 改名前后是同一份字节：一次都不许删产物
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  /** 复检不过（缺 init 段这类）：不改名、不交付，记录继续指那份能解出轨道的原件 */
  it('存量 fMP4 复检不过：保持 .ts，不交付也不删', async () => {
    const fmp4 = record({ id: 'f2', filePath: TS2, container: 'fmp4' });
    wire({ files: { [TS2]: 1000 }, records: [fmp4] });
    h.verifyRemuxedMedia.mockResolvedValue({ ok: false, probeVerdict: 'no-video-track', outputBytes: 1000 });

    await boot();

    expect(h.renameFile).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
    const saved = h.save.mock.calls.map((c) => c[0] as DownloadTask);
    expect(saved.some((t) => t.filePath === MP42)).toBe(false);
    expect(saved.some((t) => t.remux?.outcome === 'verify-failed')).toBe(true);
  });
});
