/**
 * 删除下载时的文件删除结果（EXT 批次 24：静默失败收口）
 *
 * 旧实现 `await deleteFile(task.filePath).catch(() => undefined)`：记录照删，文件删不掉也
 * 当没事发生——列表里没了，磁盘上多了一个任何人都找不到的孤儿文件，UI 还说「已删除」。
 *
 * 现在 `remove()` 返回 `fileLeftBehind`，批量/清理入口聚合成 `filesLeftBehind`，由页面说话。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { blobRepo } from '@/db/repositories/blobRepo';
import { downloadService } from '@/services/downloadService';
import type { DownloadTask } from '@/types';

import { resetAll } from './helpers';

vi.mock('@/shared/platform', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/shared/platform')>();
  return { ...mod, isNative: () => true };
});

vi.mock('@/native/fs', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/native/fs')>();
  return { ...mod, deleteFile: vi.fn().mockResolvedValue(undefined) };
});

import { deleteFile } from '@/native/fs';

const NOW = 1_700_000_000_000;

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
    totalBytes: 1000,
    downloadedBytes: 1000,
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

async function seed(task: DownloadTask): Promise<DownloadTask> {
  await downloadRepo.save(task);
  return task;
}

beforeEach(async () => {
  await resetAll();
  vi.mocked(deleteFile).mockReset();
  vi.mocked(deleteFile).mockResolvedValue(undefined);
});

describe('downloadService.remove 文件删除结果（批次 24）', () => {
  it('文件删失败：记录仍删除，但回报 fileLeftBehind', async () => {
    await seed(makeTask({ id: 'orphan' }));
    vi.mocked(deleteFile).mockRejectedValueOnce(new Error('EPERM'));

    const result = await downloadService.remove('orphan');
    expect(result).toEqual({ fileLeftBehind: true });
    expect(await downloadRepo.get('orphan')).toBeNull();
    expect(deleteFile).toHaveBeenCalledWith('downloads/orphan.mp4');
  });

  it('文件删成功：fileLeftBehind=false（正向对照，不是恒真断言）', async () => {
    await seed(makeTask({ id: 'clean' }));

    const result = await downloadService.remove('clean');
    expect(result).toEqual({ fileLeftBehind: false });
    expect(await downloadRepo.get('clean')).toBeNull();
  });

  it('只删记录（deleteFile:false）时不去碰文件，也不算留孤儿', async () => {
    await seed(makeTask({ id: 'keep-file' }));

    const result = await downloadService.remove('keep-file', { deleteFile: false });
    expect(result).toEqual({ fileLeftBehind: false });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('IDB 分块（blobKey）删不掉同样算留孤儿', async () => {
    await seed(makeTask({ id: 'blob', sink: 'idb-blob', filePath: null, blobKey: 'blob-1' }));
    const del = vi.spyOn(blobRepo, 'delete').mockRejectedValueOnce(new Error('quota'));

    const result = await downloadService.remove('blob');
    expect(result).toEqual({ fileLeftBehind: true });
    del.mockRestore();
  });

  it('任务不存在：不算失败也不留孤儿', async () => {
    const result = await downloadService.remove('missing');
    expect(result).toEqual({ fileLeftBehind: false });
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('removeMany 分开统计「删除成功 / 文件残留 / 整条失败」', async () => {
    await seed(makeTask({ id: 'a' }));
    await seed(makeTask({ id: 'b', status: 'failed', completedAt: null }));
    await seed(makeTask({ id: 'c' }));
    vi.mocked(deleteFile).mockImplementation(async (path: string) => {
      if (path.includes('/b.')) throw new Error('EPERM');
      if (path.includes('/c.')) throw new Error('EPERM');
    });
    const removeSpy = vi
      .spyOn(downloadRepo, 'remove')
      .mockImplementation(async (id: string): Promise<void> => {
        if (id === 'c') throw new Error('事务失败');
      });

    const result = await downloadService.removeMany(['a', 'b', 'c']);
    expect(result).toEqual({ removed: 2, filesLeftBehind: 1, failed: 1 });
    removeSpy.mockRestore();
  });

  it('clearCompleted 汇总残留文件数', async () => {
    await seed(makeTask({ id: 'done-1' }));
    await seed(makeTask({ id: 'done-2' }));
    await seed(makeTask({ id: 'running', status: 'downloading', completedAt: null }));
    vi.mocked(deleteFile).mockImplementation(async (path: string) => {
      if (path.includes('done-2')) throw new Error('EPERM');
    });

    const result = await downloadService.clearCompleted();
    expect(result).toEqual({ removed: 2, filesLeftBehind: 1 });
    expect(await downloadRepo.get('running')).toBeTruthy();
  });

  it('clearFailed 汇总残留文件数', async () => {
    await seed(makeTask({ id: 'bad-1', status: 'failed', completedAt: null }));
    await seed(makeTask({ id: 'bad-2', status: 'failed', completedAt: null }));
    vi.mocked(deleteFile).mockImplementation(async (path: string) => {
      if (path.includes('bad-1')) throw new Error('EPERM');
    });

    const result = await downloadService.clearFailed();
    expect(result).toEqual({ removed: 2, filesLeftBehind: 1 });
  });
});
