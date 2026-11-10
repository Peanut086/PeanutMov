import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import { stat } from '@/native/fs';
import { AppError } from '@/shared/errors';
import type { DownloadTask } from '@/types';

import { resetAll } from './helpers';

vi.mock('@/native/fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/fs')>();
  return { ...actual, stat: vi.fn() };
});

/**
 * FIX-D8 启动自检：`checkCorruptedHlsTasks()` 不能反噬启动流程
 *
 * 缺陷链（真机复现，`AppError: 任务状态不允许该操作：completed→paused`）：
 * HLS 进度落库有 1s 节流，而收尾那次 `saveProgress` 不带 `completedSegments`，
 * 于是"文件已写满 559 段、索引只记到 556"的**正常任务**被自检判成假完成；
 * 降级用的 `transition(task, 'pause')` 对终态 `completed` 直接抛错，
 * 异常穿过 `initDownloads()` 的 catch，连带跳过 `downloadService.bootstrap()`
 * （AC-72 前后台恢复）与离线文件优化（P0-1）——每次启动都静默失效。
 *
 * 约定：产物体积是权威；自检只修数据，任何一条坏记录都不得影响其余任务与启动。
 */

const NOW = 1_700_000_000_000;

function hlsTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: overrides.id ?? 'task-hls',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/master.m3u8',
    headers: {},
    format: 'hls',
    quality: null,
    status: 'completed',
    priority: NOW,
    totalBytes: 1000,
    downloadedBytes: 1000,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: false,
    sink: 'filesystem',
    filePath: 'downloads/demo:m1/m1-e1.ts',
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    hlsTotalSegments: 10,
    completedSegments: [0, 1, 2, 3, 4, 5, 6],
    ...overrides,
  };
}

describe('FIX-D8 HLS 启动自检（不阻塞启动）', () => {
  beforeEach(async () => {
    await resetAll();
    vi.mocked(stat).mockReset();
  });

  it('产物完整但索引落后于节流写入 → 补全索引并保持 completed（不再误判假完成）', async () => {
    await downloadRepo.save(hlsTask());
    vi.mocked(stat).mockResolvedValue({ exists: true, size: 1000, mtime: NOW });

    await expect(downloadService.checkCorruptedHlsTasks()).resolves.toBeUndefined();

    const row = await downloadRepo.get('task-hls');
    expect(row?.status).toBe('completed');
    expect(row?.completedSegments).toHaveLength(10);
    expect(row?.errorMessage).toBeNull();
  });

  it('产物缺失 → 降级 paused（completed 是终态，走数据修复而非状态机）', async () => {
    await downloadRepo.save(hlsTask());
    vi.mocked(stat).mockResolvedValue({ exists: false, size: 0, mtime: null });

    await downloadService.checkCorruptedHlsTasks();

    const row = await downloadRepo.get('task-hls');
    expect(row?.status).toBe('paused');
    expect(row?.errorMessage).toContain('分片不完整（7/10）');
  });

  it('产物短于记录字节 → 判定真·假完成并降级', async () => {
    await downloadRepo.save(hlsTask());
    vi.mocked(stat).mockResolvedValue({ exists: true, size: 700, mtime: NOW });

    await downloadService.checkCorruptedHlsTasks();

    expect((await downloadRepo.get('task-hls'))?.status).toBe('paused');
  });

  it('单条记录抛错只跳过自己：后续任务照常自检，整体不抛', async () => {
    await downloadRepo.save(
      hlsTask({ id: 'bad', mediaId: 'demo:m2', episodeId: 'demo:m2:e1', filePath: 'downloads/m2/m2-e1.ts' }),
    );
    await downloadRepo.save(
      hlsTask({ id: 'good', mediaId: 'demo:m3', episodeId: 'demo:m3:e1', filePath: 'downloads/ok.ts' }),
    );
    vi.mocked(stat).mockImplementation(async (path) => {
      if (path.includes('m2')) throw new AppError('E_STORAGE_QUOTA', 'boom');
      return { exists: true, size: 1000, mtime: NOW };
    });

    await expect(downloadService.checkCorruptedHlsTasks()).resolves.toBeUndefined();

    expect((await downloadRepo.get('bad'))?.status).toBe('completed');
    expect((await downloadRepo.get('good'))?.completedSegments).toHaveLength(10);
  });

  it('索引已齐的任务不做任何写入（幂等，避免每次启动重存）', async () => {
    await downloadRepo.save(hlsTask({ completedSegments: Array.from({ length: 10 }, (_, i) => i) }));

    await downloadService.checkCorruptedHlsTasks();

    expect(stat).not.toHaveBeenCalled();
  });

  it('无 hlsTotalSegments 的历史记录不参与判定（无法自动检测）', async () => {
    await downloadRepo.save(hlsTask({ hlsTotalSegments: undefined }));

    await downloadService.checkCorruptedHlsTasks();

    expect(stat).not.toHaveBeenCalled();
    expect((await downloadRepo.get('task-hls'))?.status).toBe('completed');
  });
});
