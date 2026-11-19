/**
 * 本地存储占用口径（P2-3）
 *
 * 真机现场（11-18 端到端）：预检 12 集一起下单、只下完 1 集，下载页头部写
 * 「本地存储 78.4 GB（12 个文件）」；把那 11 条删掉数字也不回落。
 * 旧实现把每条任务的 `totalBytes`（源站预估的成品大小）无差别累加，
 * 排队/失败/取消都算成了已占用空间。
 *
 * 现在的口径：只算**已经落盘**的字节——成品算全额，
 * 暂停/失败留下的残片算 `downloadedBytes` 并单独报出来，取消的当场删片所以不计。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import type { DownloadTask } from '@/types';

import { resetAll } from './helpers';

vi.mock('@/shared/platform', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/shared/platform')>();
  return { ...mod, isNative: () => true };
});

const NOW = 1_700_000_000_000;
const MB = 1024 * 1024;

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: overrides.id ?? 'task-1',
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
    status: 'completed',
    priority: NOW,
    totalBytes: 600 * MB,
    downloadedBytes: 600 * MB,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'filesystem',
    filePath: `downloads/${overrides.id ?? 'task-1'}.mp4`,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

beforeEach(async () => {
  await resetAll();
});

describe('downloadService.calculateStorageUsage', () => {
  it('未下完的任务不再按预估体积计入占用', async () => {
    await downloadRepo.save(makeTask({ id: 'done', totalBytes: 600 * MB, downloadedBytes: 600 * MB }));
    for (let i = 0; i < 11; i += 1) {
      await downloadRepo.save(
        makeTask({ id: `wait-${i}`, status: 'queued', totalBytes: 6 * MB * 1024, downloadedBytes: 0 }),
      );
    }

    const usage = await downloadService.calculateStorageUsage();
    expect(usage.totalBytes).toBe(600 * MB);
    expect(usage.fileCount).toBe(1);
    expect(usage.partialBytes).toBe(0);
  });

  it('体积未知的排队任务不贡献字节', async () => {
    await downloadRepo.save(makeTask({ id: 'cold', status: 'queued', totalBytes: null, downloadedBytes: 0 }));
    expect(await downloadService.calculateStorageUsage()).toEqual({
      totalBytes: 0,
      fileCount: 0,
      partialBytes: 0,
    });
  });

  it('暂停/失败留下的残片按已写字节计，并单独报出', async () => {
    await downloadRepo.save(makeTask({ id: 'done', totalBytes: 600 * MB, downloadedBytes: 600 * MB }));
    await downloadRepo.save(makeTask({ id: 'paused', status: 'paused', totalBytes: 6 * MB, downloadedBytes: 2 * MB }));
    await downloadRepo.save(makeTask({ id: 'bad', status: 'failed', totalBytes: 6 * MB, downloadedBytes: MB }));

    const usage = await downloadService.calculateStorageUsage();
    expect(usage.totalBytes).toBe(600 * MB + 3 * MB);
    expect(usage.fileCount).toBe(1);
    expect(usage.partialBytes).toBe(3 * MB);
  });

  it('取消的任务不留文件，因此不计占用', async () => {
    await downloadRepo.save(
      makeTask({ id: 'canceled', status: 'canceled', totalBytes: 6 * MB, downloadedBytes: 5 * MB }),
    );
    expect(await downloadService.calculateStorageUsage()).toEqual({
      totalBytes: 0,
      fileCount: 0,
      partialBytes: 0,
    });
  });

  it('成品缺 totalBytes 时回退已写字节（老任务记录）', async () => {
    await downloadRepo.save(makeTask({ id: 'legacy', totalBytes: null, downloadedBytes: 4 * MB }));

    const usage = await downloadService.calculateStorageUsage();
    expect(usage.totalBytes).toBe(4 * MB);
    expect(usage.fileCount).toBe(1);
  });

  it('已写字节超过预估时不放大总数（进度上报抖动）', async () => {
    await downloadRepo.save(makeTask({ id: 'skew', status: 'paused', totalBytes: 2 * MB, downloadedBytes: 9 * MB }));
    expect((await downloadService.calculateStorageUsage()).partialBytes).toBe(2 * MB);
  });

  it('清空任务后回到 0（旧口径会停在最后一个数字）', async () => {
    await downloadRepo.save(makeTask({ id: 'x' }));
    expect((await downloadService.calculateStorageUsage()).totalBytes).toBeGreaterThan(0);

    await downloadRepo.remove('x');
    expect(await downloadService.calculateStorageUsage()).toEqual({
      totalBytes: 0,
      fileCount: 0,
      partialBytes: 0,
    });
  });
});
