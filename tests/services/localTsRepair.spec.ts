import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  stat: vi.fn(),
  readTextFile: vi.fn(),
  deleteFile: vi.fn(),
  scan: vi.fn(),
  writeIndex: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@/db/repositories/downloadRepo', () => ({
  downloadRepo: { get: h.get, save: h.save },
}));
vi.mock('@/native/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/fs')>();
  return { ...actual, stat: h.stat, readTextFile: h.readTextFile, deleteFile: h.deleteFile };
});
vi.mock('@/native/mediaToolPlugin', () => ({ scanTsTimelineFile: h.scan }));
vi.mock('@/services/localHlsIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/localHlsIndex')>();
  return { ...actual, writeLocalHlsIndex: h.writeIndex };
});
vi.mock('@/services/events', () => ({ appEvents: { emit: h.emit } }));
vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { buildLocalHlsManifest } from '@/services/localHlsIndex';
import { buildTimelineHlsIndex, repairLocalTsIndex } from '@/services/localTsRepair';
import type { DownloadHlsIndex, DownloadTask } from '@/types';
import type { TsTimelineScanResult } from '@/native/mediaToolPlugin';

const PATH = '/downloads/m1/e1.ts';
const INDEX_PATH = '/downloads/m1/e1.m3u8';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: 'old-ts',
    sourceId: 'demo',
    mediaId: 'm1',
    episodeId: 'e1',
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
    totalBytes: 2000,
    downloadedBytes: 2000,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: false,
    sink: 'filesystem',
    filePath: PATH,
    blobKey: null,
    container: 'ts',
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function scan(overrides: Partial<TsTimelineScanResult> = {}): TsTimelineScanResult {
  return {
    ok: true,
    timelineReliable: true,
    verdict: 'ok',
    fileSize: 2000,
    packetSize: 188,
    alignedStart: 0,
    totalPackets: 11,
    badPackets: 0,
    firstBadOffset: -1,
    tailBytes: 0,
    timestampCount: 20,
    timelineSource: 'video-pts',
    durationUs: 4_000_000,
    discontinuities: 1,
    segments: [
      { offset: 0, durationUs: 1_500_000, discontinuity: false },
      { offset: 1000, durationUs: 2_500_000, discontinuity: true },
    ],
    ...overrides,
  };
}

function existingIndex(): DownloadHlsIndex {
  return {
    version: 1,
    playlistFingerprint: 'local-ts-2000-4000000-2',
    targetDuration: 3,
    mediaSequence: 0,
    segments: [
      { index: 0, offset: 0, length: 1000, duration: 1.5, discontinuity: false },
      { index: 1, offset: 1000, length: 1000, duration: 2.5, discontinuity: true },
    ],
  };
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.get.mockResolvedValue(task());
  h.stat.mockResolvedValue({ exists: true, size: 2000 });
  h.scan.mockResolvedValue(scan());
  h.writeIndex.mockResolvedValue(INDEX_PATH);
  h.save.mockResolvedValue(undefined);
  h.deleteFile.mockResolvedValue(undefined);
});

describe('存量 TS 时间轴索引', () => {
  it('按真实 region 边界生成连续 BYTERANGE 索引', () => {
    const index = buildTimelineHlsIndex(scan(), 2000);

    expect(index).toMatchObject({
      version: 1,
      playlistFingerprint: 'local-ts-2000-4000000-2',
      targetDuration: 3,
      segments: [
        { index: 0, offset: 0, length: 1000, duration: 1.5, discontinuity: false },
        { index: 1, offset: 1000, length: 1000, duration: 2.5, discontinuity: true },
      ],
    });
  });

  it('首个时间戳不在文件开头时把前置 TS 字节并入首段', () => {
    const index = buildTimelineHlsIndex(scan({
      fileSize: 841_869_452,
      segments: [
        { offset: 564, durationUs: 3_486_483_000, discontinuity: false },
      ],
      durationUs: 3_486_483_000,
      discontinuities: 0,
    }), 841_869_452);

    expect(index).toMatchObject({
      segments: [
        { index: 0, offset: 0, length: 841_869_452, duration: 3_486.483, discontinuity: false },
      ],
    });
  });

  it('字节边界重复时拒绝生成索引', () => {
    const invalid = scan({
      segments: [
        { offset: 0, durationUs: 1_500_000, discontinuity: false },
        { offset: 0, durationUs: 2_500_000, discontinuity: true },
      ],
    });

    expect(() => buildTimelineHlsIndex(invalid, 2000)).toThrow('无效的字节边界');
  });

  it('region 时长为零时不伪造可拖动时长', () => {
    const invalid = scan({
      durationUs: 2_500_000,
      segments: [
        { offset: 0, durationUs: 0, discontinuity: false },
        { offset: 1000, durationUs: 2_500_000, discontinuity: true },
      ],
    });

    expect(() => buildTimelineHlsIndex(invalid, 2000)).toThrow('无效的字节边界');
  });

  it('已有完整且内容一致的清单时跳过扫描', async () => {
    const index = existingIndex();
    h.get.mockResolvedValue(task({
      hlsIndex: index,
      hlsIndexPath: INDEX_PATH,
      hlsTotalSegments: 2,
      hlsPlaylistFingerprint: index.playlistFingerprint,
    }));
    h.readTextFile.mockResolvedValue(buildLocalHlsManifest(index, PATH));

    await expect(repairLocalTsIndex('old-ts')).resolves.toEqual({
      status: 'already',
      message: '拖动索引已存在',
    });
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.writeIndex).not.toHaveBeenCalled();
  });

  it('时间轴不可靠时只返回结论，不改写原文件', async () => {
    h.scan.mockResolvedValue(scan({ ok: false, timelineReliable: false, verdict: 'corrupt' }));

    await expect(repairLocalTsIndex('old-ts')).resolves.toMatchObject({ status: 'unreliable' });
    expect(h.writeIndex).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  it('旧 APK 能力缺席与时间轴不合格分开返回', async () => {
    h.scan.mockResolvedValue(null);

    await expect(repairLocalTsIndex('old-ts')).resolves.toMatchObject({ status: 'unsupported' });
    expect(h.writeIndex).not.toHaveBeenCalled();
  });

  it('修复成功只新增 sidecar 并更新旧任务索引', async () => {
    await expect(repairLocalTsIndex('old-ts', { force: true })).resolves.toMatchObject({
      status: 'repaired',
      durationSec: 4,
      segments: 2,
    });

    expect(h.writeIndex).toHaveBeenCalledWith(PATH, expect.objectContaining({
      segments: [
        { index: 0, offset: 0, length: 1000, duration: 1.5, discontinuity: false },
        { index: 1, offset: 1000, length: 1000, duration: 2.5, discontinuity: true },
      ],
    }));
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'old-ts',
      filePath: PATH,
      hlsIndexPath: INDEX_PATH,
      hlsTotalSegments: 2,
      hlsDiscontinuities: 1,
    }));
    expect(h.deleteFile).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith('downloads:changed', { id: 'old-ts' });
  });

  it('索引已写但任务落库失败时删除新清单，原 TS 不动', async () => {
    h.save.mockRejectedValue(new Error('IndexedDB quota exceeded'));

    await expect(repairLocalTsIndex('old-ts', { force: true })).rejects.toThrow('quota');
    expect(h.deleteFile).toHaveBeenCalledWith(INDEX_PATH);
  });
});
