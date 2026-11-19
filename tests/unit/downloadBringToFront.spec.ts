import { beforeEach, describe, expect, it } from 'vitest';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import { AppError } from '@/shared/errors';
import type { DownloadTask } from '@/types';

import { resetAll } from './helpers';

/**
 * P3-1：优先级控制。
 *
 * 真机实测环节 4：下载页没有任何优先级入口，`priority` 在创建时被直接写成 `now`，
 * 队列按 `priority → createdAt` 排序——等于纯 FIFO，用户想让第 7 集先下只能干等前面 6 集。
 * 这里锁住「置顶」的三条口径：值必须压到所有等待任务之下（同批 `createdAt` 相同，只减不行）、
 * 新值必须落库（重启后队列仍认这个顺序）、非等待中的任务要报错而不是静默。
 */

const T0 = 1_700_000_000_000;

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    lineId: null,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'queued',
    priority: T0,
    totalBytes: null,
    downloadedBytes: 0,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: null,
    ...overrides,
  };
}

/** 模拟详情页「缓存整季」：同一毫秒创建的一批任务，priority 与 createdAt 全相同 */
async function seedBatch(count: number): Promise<DownloadTask[]> {
  const rows = Array.from({ length: count }, (_, index) =>
    makeTask({
      id: `t${index}`,
      episodeId: `demo:m1:e${index + 1}`,
      episodeNumber: index + 1,
      episodeTitle: `第 ${index + 1} 集`,
      priority: T0 + index,
      createdAt: T0,
    }),
  );
  for (const row of rows) await downloadRepo.save(row);
  return rows;
}

describe('下载优先级（P3-1 置顶）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('置顶把 priority 压到所有等待任务之下，队列从此先跑它', async () => {
    const rows = await seedBatch(3);

    const next = await downloadService.bringToFront(rows[2]!.id);

    expect(next.priority).toBeLessThan(T0);
    const ordered = await downloadRepo.listAll();
    expect(ordered.map((task) => task.id)).toEqual(['t2', 't0', 't1']);
  });

  it('新值落库：重启后队列从库里读到的仍是置顶后的次序', async () => {
    await seedBatch(2);
    await downloadService.bringToFront('t1');

    const stored = await downloadRepo.get('t1');
    expect(stored?.priority).toBeLessThan((await downloadRepo.get('t0'))?.priority ?? 0);
  });

  it('同批 createdAt 相同也能排进去（只减 1 不够，必须低于最小值）', async () => {
    // 两条 priority 完全相同的任务（同一次批量创建），置顶第二条
    await downloadRepo.save(makeTask({ id: 'same-1', episodeId: 'demo:m1:e1', priority: T0 }));
    await downloadRepo.save(makeTask({ id: 'same-2', episodeId: 'demo:m1:e2', episodeNumber: 2, priority: T0 }));

    await downloadService.bringToFront('same-2');

    expect((await downloadRepo.listAll()).map((task) => task.id)).toEqual(['same-2', 'same-1']);
  });

  it('只有等待中的任务可以置顶：暂停/下载中/已完成都明确报错', async () => {
    await downloadRepo.save(makeTask({ id: 'paused', status: 'paused' }));
    await downloadRepo.save(makeTask({ id: 'running', status: 'downloading' }));
    await downloadRepo.save(makeTask({ id: 'done', status: 'completed' }));

    for (const id of ['paused', 'running', 'done']) {
      await expect(downloadService.bringToFront(id)).rejects.toThrow(/只有等待中的任务可以置顶/);
    }
    // 报错不许改库
    expect((await downloadRepo.get('paused'))?.priority).toBe(T0);
  });

  it('未知 id 抛 E_NOT_FOUND', async () => {
    const error = await downloadService.bringToFront('不存在').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('E_NOT_FOUND');
  });
});
