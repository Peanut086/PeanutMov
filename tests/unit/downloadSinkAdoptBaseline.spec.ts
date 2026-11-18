import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 重启后续传基线的采纳判定（DL-R0，真机实测）。
 *
 * 现场：一整集 779,919,880 字节的 HLS 已下完并晋升成成品，进程在转封装途中被强杀；
 * 重启后 `NativeFsSink.begin()` 只看 `.part`——而 `finish()` 恰恰把 `.part` 原子改名
 * 成了成品，于是这个任务在续传眼里等于 0 字节，`hlsDownloader` 据此判「分片确实丢了」，
 * 清空索引从头重下，并与成品共存（磁盘瞬时 1.5GB）。用户看到的就是进度条从 0M 重新开始。
 *
 * 修法是把成品接回续传基线，但只在「有证据说明这份字节与分片索引是同一轮产出」时采纳：
 * 门槛一松就会产出半途拼接的成品，比让用户重下一遍更糟。
 */
vi.mock('@/shared/platform', () => ({
  isNative: vi.fn(() => true),
}));

const fs = vi.hoisted(() => ({
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  deleteFile: vi.fn(),
  stat: vi.fn(),
  rename: vi.fn(),
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Filesystem: fs,
}));

import { NativeFsSink, isDownloadPhaseSettled, nativeFilePathOf, nativePartPathOf } from '@/services/downloadSink';
import type { DownloadTask } from '@/types';

/** 真机现场体积：一整集 988 片 */
const ARTIFACT_BYTES = 779_919_880;
const TOTAL_SEGMENTS = 988;

function hlsTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-r0',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    url: 'https://cdn.example.com/720p.m3u8',
    format: 'hls',
    // hlsDownloader 第一次 begin 恒传 `resumable: true`，续传基线的门槛也认这个字段
    resumable: true,
    hlsTotalSegments: TOTAL_SEGMENTS,
    completedSegments: Array.from({ length: TOTAL_SEGMENTS }, (_, i) => i),
    downloadedBytes: ARTIFACT_BYTES,
    ...overrides,
  } as DownloadTask;
}

/** 按字节记账的假文件系统（不占内存：只记体积） */
let store: Map<string, number>;
let artifactPath: string;
let partPath: string;

function installFakeFs(): void {
  store = new Map();
  fs.mkdir.mockResolvedValue(undefined);
  fs.deleteFile.mockImplementation(async ({ path }: { path: string }) => {
    store.delete(path);
  });
  fs.writeFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
    store.set(path, Buffer.from(data, 'base64').length);
  });
  fs.appendFile.mockImplementation(async ({ path, data }: { path: string; data: string }) => {
    store.set(path, (store.get(path) ?? 0) + Buffer.from(data, 'base64').length);
  });
  fs.stat.mockImplementation(async ({ path }: { path: string }) => {
    if (!store.has(path)) return Promise.reject({ code: 'OS-PLUG-FILE-0008', message: 'File does not exist' });
    return { type: 'file', size: store.get(path) as number, mtime: 1 };
  });
  fs.rename.mockImplementation(async ({ from, to }: { from: string; to: string }) => {
    store.set(to, store.get(from) ?? 0);
    store.delete(from);
  });
}

/** 把磁盘摆成案发现场：成品在、`.part` 不在 */
function promoteArtifact(): void {
  store.set(artifactPath, ARTIFACT_BYTES);
}

beforeEach(() => {
  vi.resetAllMocks();
  installFakeFs();
  artifactPath = nativeFilePathOf(hlsTask());
  partPath = nativePartPathOf(hlsTask());
});

describe('采纳已晋升成品作为续传基线（DL-R0）', () => {
  it('下载阶段已齐 + 成品在盘：起点接回成品体积，不发生第二次 rename 之外的写', async () => {
    promoteArtifact();

    const sink = new NativeFsSink();
    const result = await sink.begin({ task: hlsTask(), startBytes: ARTIFACT_BYTES });

    expect(result).toEqual({ actualStartBytes: ARTIFACT_BYTES, adoptedArtifact: true });
    expect(fs.rename).toHaveBeenCalledTimes(1);
    expect(fs.rename).toHaveBeenCalledWith(expect.objectContaining({ from: artifactPath, to: partPath }));
    // 成品被接回下载期文件名继续记账，而不是凭空多出一份
    expect(store.get(partPath)).toBe(ARTIFACT_BYTES);
    expect(store.has(artifactPath)).toBe(false);
    // 关键回归点：不许走「清空 .part 重建」那句
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.appendFile).not.toHaveBeenCalled();
  });

  it('采纳后 finish() 零流量收尾：分片不必再取，成品名与体积原样回来', async () => {
    promoteArtifact();

    const sink = new NativeFsSink();
    await sink.begin({ task: hlsTask(), startBytes: ARTIFACT_BYTES });
    const finished = await sink.finish();

    expect(finished.size).toBe(ARTIFACT_BYTES);
    expect(finished.filePath).toBe(artifactPath);
    expect(store.get(artifactPath)).toBe(ARTIFACT_BYTES);
    expect(fs.appendFile).not.toHaveBeenCalled();
  });

  it('索引只记到 54/988：证据不足，不采纳，照常从空的 .part 下', async () => {
    promoteArtifact();
    const sink = new NativeFsSink();
    const result = await sink.begin({
      task: hlsTask({ completedSegments: Array.from({ length: 54 }, (_, i) => i) }),
      startBytes: 42_319_364,
    });

    expect(result.actualStartBytes).toBe(0);
    expect(result.adoptedArtifact).toBeUndefined();
    expect(fs.rename).not.toHaveBeenCalled();
    // 成品留在原处（这一轮会重新下一份，晋升时由 renameFile 覆盖旧产物）
    expect(store.get(artifactPath)).toBe(ARTIFACT_BYTES);
    expect(store.get(partPath)).toBe(0);
  });

  it('成品不在盘上（被清理/换设备）：照旧从头，不冒充有基线', async () => {
    const sink = new NativeFsSink();
    const result = await sink.begin({ task: hlsTask(), startBytes: ARTIFACT_BYTES });

    expect(result.actualStartBytes).toBe(0);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(store.get(partPath)).toBe(0);
  });

  it('成品比 DB 记账还短：连下载阶段都没走完，不采纳', async () => {
    store.set(artifactPath, 100_000);

    const sink = new NativeFsSink();
    const result = await sink.begin({ task: hlsTask(), startBytes: ARTIFACT_BYTES });

    expect(result.actualStartBytes).toBe(0);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('直链任务绝不采纳：Range 起点与「文件已有多长」不是一回事，拼起来会空洞', async () => {
    const direct = hlsTask({ format: 'mp4', url: 'https://cdn.example.com/720p.mp4' });
    store.set(nativeFilePathOf(direct), ARTIFACT_BYTES);

    const sink = new NativeFsSink();
    const result = await sink.begin({ task: direct, startBytes: ARTIFACT_BYTES });

    expect(result.actualStartBytes).toBe(0);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('旧记录没有 hlsTotalSegments：无从判断索引完备性，不采纳', async () => {
    const legacy = hlsTask({ hlsTotalSegments: undefined });
    store.set(nativeFilePathOf(legacy), ARTIFACT_BYTES);

    expect(isDownloadPhaseSettled(legacy)).toBe(false);

    const sink = new NativeFsSink();
    const result = await sink.begin({ task: legacy, startBytes: ARTIFACT_BYTES });
    expect(result.actualStartBytes).toBe(0);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it('采纳不是放行门：随后「从头下」的那次 begin 仍会把 .part 截成 0', async () => {
    promoteArtifact();
    const sink = new NativeFsSink();
    await sink.begin({ task: hlsTask(), startBytes: ARTIFACT_BYTES });

    // hlsDownloader 判损坏后走的第二次 begin（resumable:false / startBytes:0）
    const again = await sink.begin({ task: { ...hlsTask(), resumable: false }, startBytes: 0 });

    expect(again.actualStartBytes).toBe(0);
    expect(store.get(partPath)).toBe(0);
  });
});
