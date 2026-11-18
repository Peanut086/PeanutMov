import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import type { CreateDownloadInput } from '@/types';

import { resetAll } from './helpers';

/**
 * 批次二 · 10：同一集并发创建下载任务要去重。
 *
 * `create` 的「查已有 → 落库」中间隔着两次 await（`findActiveByEpisode` 读 IDB、
 * `policySnapshot` 读设置），而 IDB 没有跨事务的唯一约束。双击下载按钮、或详情页
 * 与播放页同时下单时，两边都读到「还没有」，于是同一集落库两个任务：
 * 各占一份队列容量、各下一条、删一个还剩一个。
 */

function makeInput(overrides: Partial<CreateDownloadInput> = {}): CreateDownloadInput {
  return {
    sourceId: DEMO_SOURCE_ID,
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.mp4',
    format: 'mp4',
    ...overrides,
  };
}

async function ids(): Promise<string[]> {
  return (await downloadRepo.listAll()).map((task) => `${task.mediaId}/${task.episodeId}/${task.id}`);
}

describe('downloadService.create 在飞去重', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
    vi.restoreAllMocks();
  });

  it('同集并发创建只落库一个任务，两次调用拿到同一个任务', async () => {
    // 把「查已有」钉成永远查不到，复现两个请求都越过存在性检查的窗口
    vi.spyOn(downloadRepo, 'listByEpisode').mockResolvedValue([]);
    const save = vi.spyOn(downloadRepo, 'save');

    const [a, b] = await Promise.all([downloadService.create(makeInput()), downloadService.create(makeInput())]);

    expect(save).toHaveBeenCalledTimes(1);
    expect(a.task.id).toBe(b.task.id);
    expect(await downloadRepo.listAll()).toHaveLength(1);
  });

  it('不同集并发创建互不阻塞', async () => {
    vi.spyOn(downloadRepo, 'listByEpisode').mockResolvedValue([]);

    const [a, b] = await Promise.all([
      downloadService.create(makeInput({ episodeId: 'demo:m1:e1' })),
      downloadService.create(makeInput({ episodeId: 'demo:m1:e2' })),
    ]);

    expect(a.task.id).not.toBe(b.task.id);
    expect(await downloadRepo.listAll()).toHaveLength(2);
  });

  it('创建失败后释放去重锁，下一次调用会真的重试', async () => {
    vi.spyOn(downloadRepo, 'listByEpisode').mockResolvedValue([]);
    const save = vi.spyOn(downloadRepo, 'save');
    save.mockRejectedValueOnce(new Error('写库失败'));

    await expect(downloadService.create(makeInput())).rejects.toThrow('写库失败');

    const retry = await downloadService.create(makeInput());
    expect(retry.existed).toBe(false);
    expect(save).toHaveBeenCalledTimes(2);
    expect(await downloadRepo.listAll()).toHaveLength(1);
  });

  it('上一集创建完成后，同集再次下载走「已存在」而不是复用旧 Promise', async () => {
    const first = await downloadService.create(makeInput());
    expect(first.existed).toBe(false);

    const again = await downloadService.create(makeInput());
    expect(again.existed).toBe(true);
    expect(again.task.id).toBe(first.task.id);
    expect(await downloadRepo.listAll()).toHaveLength(1);
  });

  it('createMany 收到重复集数：一条创建、一条计入已存在', async () => {
    const { created, skipped } = await downloadService.createMany([makeInput(), makeInput()]);

    expect(created).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(await downloadRepo.listAll()).toHaveLength(1);
  });

  /**
   * DL-P1-3：详情页「下载全部」走的是 `createMany`，而它过去不给任务写 batchId。
   * 这批任务在「下载」页落进 batchId='' 的「单独下载」组，而「重试本批失败项」
   * 「删除本批已完成」对空 batchId 直接 return——真实入口上两个按钮点了没反应。
   * 整批共用一个批次号，批内操作才有对象。
   */
  it('createMany 给整批共用一个 batchId', async () => {
    const { created } = await downloadService.createMany([
      makeInput({ episodeId: 'demo:m1:e1' }),
      makeInput({ episodeId: 'demo:m1:e2' }),
      makeInput({ episodeId: 'demo:m1:e3' }),
    ]);

    expect(created).toHaveLength(3);
    expect(new Set(created.map((row) => row.batchId)).size).toBe(1);
    expect(created[0]?.batchId).toBeTruthy();
    const rows = await downloadRepo.listAll();
    expect(rows.filter((row) => row.batchId === created[0]?.batchId)).toHaveLength(3);
  });

  it('createMany 不覆盖调用方自带的 batchId', async () => {
    const { created } = await downloadService.createMany([
      makeInput({ episodeId: 'demo:m1:e1', batchId: 'batch_given' }),
      makeInput({ episodeId: 'demo:m1:e2' }),
    ]);

    expect(created[0]?.batchId).toBe('batch_given');
    expect(created[1]?.batchId).not.toBe('batch_given');
    expect(created[1]?.batchId).toBeTruthy();
  });

  it('两个批量下单并发提交同一集：整库仍只有一个任务', async () => {
    const [x, y] = await Promise.all([
      downloadService.createBatch([makeInput()]),
      downloadService.createBatch([makeInput()]),
    ]);

    const rows = await downloadRepo.listAll();
    expect(rows).toHaveLength(1);
    // 两个批次各自都认为自己「新建」了，但库里只有一份——去重锁保证的是落库不重复
    expect(new Set([x.created[0]?.id, y.created[0]?.id].filter(Boolean))).toHaveLength(1);
  });

  it('取消后重新下单仍能创建新任务（去重锁不残留）', async () => {
    vi.spyOn(downloadRepo, 'listByEpisode').mockResolvedValue([]);

    const first = await downloadService.create(makeInput());
    await downloadService.cancel(first.task.id);
    const second = await downloadService.create(makeInput());

    expect(second.task.id).not.toBe(first.task.id);
    expect(await ids()).toHaveLength(2);
  });
});
