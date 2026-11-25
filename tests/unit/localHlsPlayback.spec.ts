import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  stat: vi.fn(),
  readTextFile: vi.fn(async () => ''),
  toPlayableUrl: vi.fn(async (path: string) => `capacitor://localhost/${path}`),
  deleteFile: vi.fn(async () => undefined),
}));

vi.mock('@/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform')>();
  return { ...actual, isNative: () => true };
});
vi.mock('@/native/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/fs')>();
  return { ...actual, stat: h.stat, readTextFile: h.readTextFile, toPlayableUrl: h.toPlayableUrl, deleteFile: h.deleteFile };
});

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import type { DownloadTask } from '@/types';
import { buildLocalHlsManifest } from '@/services/localHlsIndex';
import { resetAll } from './helpers';

function indexedTask(): DownloadTask {
  return {
    id: 'task-local-hls',
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
    container: 'ts',
    quality: null,
    status: 'completed',
    priority: 1,
    totalBytes: 188,
    downloadedBytes: 188,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: false,
    sink: 'filesystem',
    filePath: 'downloads/m1/e1.ts',
    blobKey: null,
    hlsTotalSegments: 1,
    hlsPlaylistFingerprint: 'fingerprint',
    hlsIndex: {
      version: 1,
      playlistFingerprint: 'fingerprint',
      targetDuration: 2,
      mediaSequence: 0,
      segments: [{ index: 0, offset: 0, length: 188, duration: 2, discontinuity: false }],
    },
    hlsIndexPath: 'downloads/m1/e1.m3u8',
    errorCode: null,
    errorMessage: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_000,
  };
}

beforeEach(async () => {
  await resetAll();
  h.stat.mockReset();
  h.readTextFile.mockReset();
  h.toPlayableUrl.mockClear();
  h.deleteFile.mockReset();
  h.deleteFile.mockResolvedValue(undefined);
});

describe('本地 HLS 播放', () => {
  it('用字节索引清单播放合并 TS，同时保留原 TS 路径供抽帧', async () => {
    const task = indexedTask();
    await downloadRepo.save(task);
    h.stat.mockImplementation(async (path: string) => ({
      exists: true,
      size: path.endsWith('.m3u8') ? 120 : 188,
      mtime: null,
    }));
    h.readTextFile.mockResolvedValue(buildLocalHlsManifest(task.hlsIndex!, task.filePath!));

    await expect(downloadService.taskToPlayback(task)).resolves.toMatchObject({
      url: 'capacitor://localhost/downloads/m1/e1.m3u8',
      localPath: 'downloads/m1/e1.ts',
      format: 'hls',
      isLocal: true,
    });
  });

  it('旧下载器把容器标为 other 时仍优先使用真实 TS 字节索引', async () => {
    const task = { ...indexedTask(), container: 'other' as DownloadTask['container'] };
    await downloadRepo.save(task);
    h.stat.mockImplementation(async (path: string) => ({
      exists: true,
      size: path.endsWith('.m3u8') ? 120 : 188,
      mtime: null,
    }));
    h.readTextFile.mockResolvedValue(buildLocalHlsManifest(task.hlsIndex!, task.filePath!));

    await expect(downloadService.taskToPlayback(task)).resolves.toMatchObject({
      url: 'capacitor://localhost/downloads/m1/e1.m3u8',
      localPath: 'downloads/m1/e1.ts',
      format: 'hls',
      isLocal: true,
    });
  });

  it('清单丢失时保留原件可播性，回退裸 TS 并由能力模型诚实降级', async () => {
    const task = indexedTask();
    await downloadRepo.save(task);
    h.stat.mockImplementation(async (path: string) => ({
      exists: !path.endsWith('.m3u8'),
      size: path.endsWith('.m3u8') ? 0 : 188,
      mtime: null,
    }));

    await expect(downloadService.taskToPlayback(task)).resolves.toMatchObject({
      url: 'capacitor://localhost/downloads/m1/e1.ts',
      format: 'ts',
    });
    expect(h.toPlayableUrl).toHaveBeenCalledWith(task.filePath);
  });

  it('索引字节范围与成品大小不符时回退原件，不生成虚假清单', async () => {
    const task = indexedTask();
    await downloadRepo.save(task);
    h.stat.mockResolvedValue({ exists: true, size: 189, mtime: null });

    await expect(downloadService.taskToPlayback(task)).resolves.toMatchObject({
      url: 'capacitor://localhost/downloads/m1/e1.ts',
      format: 'ts',
    });
    expect(h.toPlayableUrl).toHaveBeenCalledWith(task.filePath);
  });

  it('清单内容与索引不一致时回退原件', async () => {
    const task = indexedTask();
    await downloadRepo.save(task);
    h.stat.mockResolvedValue({ exists: true, size: 188, mtime: null });
    h.readTextFile.mockResolvedValue('#EXTM3U\n#EXT-X-ENDLIST\n');

    await expect(downloadService.taskToPlayback(task)).resolves.toMatchObject({
      url: 'capacitor://localhost/downloads/m1/e1.ts',
      format: 'ts',
    });
  });

  it('没有索引的存量下载继续按裸 TS 播放', async () => {
    const task = { ...indexedTask(), hlsIndex: null, hlsIndexPath: null };
    await downloadRepo.save(task);
    h.stat.mockResolvedValue({ exists: true, size: 188, mtime: null });

    await expect(downloadService.taskToPlayback(task)).resolves.toMatchObject({
      url: 'capacitor://localhost/downloads/m1/e1.ts',
      format: 'ts',
    });
  });

  it('删除任务时同时清理本地 HLS 清单', async () => {
    const task = indexedTask();
    await downloadRepo.save(task);

    await expect(downloadService.remove(task.id)).resolves.toEqual({ fileLeftBehind: false });
    expect(h.deleteFile).toHaveBeenCalledWith(task.filePath);
    expect(h.deleteFile).toHaveBeenCalledWith(task.hlsIndexPath);
  });
});
