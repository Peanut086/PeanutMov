/**
 * OPT-09：后台保活按队列实际状态起停
 *
 * 旧行为：`bindLifecycle` 一进后台就无条件 `startForegroundService()`，回前台才停。
 * 队列全暂停 / 全完成时也会拉起一条常驻的「视频下载」前台通知，进程被白保活整个后台期。
 *
 * 现在：起停都过 `hasKeepAliveWork()`（`queued` / `downloading` 才算在飞），
 * 后台期间任务跑空也要主动收回，而不是等回前台。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import type { DownloadTask, DownloadStatus } from '@/types';

import { resetAll, tick } from './helpers';

const hoisted = vi.hoisted(() => ({
  native: true,
  stateCb: null as null | ((state: 'active' | 'background') => void),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
}));

vi.mock('@/shared/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/platform')>()),
  isNative: () => hoisted.native,
}));

vi.mock('@/native/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/native/appLifecycle')>()),
  onAppStateChange: (cb: (state: 'active' | 'background') => void) => {
    hoisted.stateCb = cb;
    return () => {
      hoisted.stateCb = null;
    };
  },
}));

// 只桩掉与本次断言相关的原生入口；引擎构造/队列状态机仍走真实实现
vi.mock('@/native/downloadPlugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/native/downloadPlugin')>()),
  nativeDownloadStartForegroundService: hoisted.start,
  nativeDownloadStopForegroundService: hoisted.stop,
  nativeDownloadSetConcurrency: vi.fn(async () => undefined),
}));

vi.mock('@/native/network', () => ({
  currentNetworkType: () => 'wifi',
  isOnline: () => true,
  onNetworkChange: () => () => undefined,
  getNetworkStatus: async () => ({ connected: true, type: 'wifi' }),
  primeNetworkStatus: async () => undefined,
}));

const NOW = 1_700_000_000_000;

function makeTask(id: string, status: DownloadStatus): DownloadTask {
  const busy = status === 'downloading' || status === 'queued';
  return {
    id,
    sourceId: 'demo',
    mediaId: `demo:${id}`,
    episodeId: `demo:${id}:e1`,
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status,
    priority: NOW,
    totalBytes: 1000,
    downloadedBytes: busy ? 400 : 1000,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'filesystem',
    filePath: `downloads/${id}.mp4`,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: busy ? null : NOW,
  } as DownloadTask;
}

/** 触发一次前后台切换（`bindLifecycle` 注册的回调由 mock 捕获） */
function goTo(state: 'active' | 'background'): void {
  hoisted.stateCb?.(state);
}

describe('下载后台保活（OPT-09）', () => {
  beforeEach(async () => {
    await resetAll();
    hoisted.native = true;
    hoisted.start.mockClear();
    hoisted.stop.mockClear();
    hoisted.stateCb = null;
  });

  it('没有在飞任务（全暂停/全完成）时进后台不起前台 Service', async () => {
    await downloadRepo.save(makeTask('paused-1', 'paused'));
    await downloadRepo.save(makeTask('done-1', 'completed'));

    downloadService.bindLifecycle();
    goTo('background');
    await tick(20);

    expect(hoisted.start).not.toHaveBeenCalled();
  });

  it('有在飞任务时进后台起前台 Service', async () => {
    await downloadRepo.save(makeTask('run-1', 'downloading'));

    downloadService.bindLifecycle();
    goTo('background');
    await vi.waitFor(() => expect(hoisted.start).toHaveBeenCalledTimes(1));
  });

  it('后台期间队列跑空：不等回前台就收回前台 Service', async () => {
    await downloadRepo.save(makeTask('run-2', 'downloading'));

    downloadService.bindLifecycle();
    goTo('background');
    await vi.waitFor(() => expect(hoisted.start).toHaveBeenCalledTimes(1));

    // 删除任务 = 队列里最后一个在飞任务消失（remove 内部会广播队列汇总）
    await downloadService.remove('run-2', { deleteFile: false });

    await vi.waitFor(() => expect(hoisted.stop).toHaveBeenCalledTimes(1));
  });

  it('回前台无条件收回前台 Service（下一次进后台再按队列状态决定）', async () => {
    await downloadRepo.save(makeTask('run-3', 'downloading'));

    downloadService.bindLifecycle();
    goTo('background');
    await vi.waitFor(() => expect(hoisted.start).toHaveBeenCalledTimes(1));

    goTo('active');
    await vi.waitFor(() => expect(hoisted.stop).toHaveBeenCalledTimes(1));
    expect(hoisted.start).toHaveBeenCalledTimes(1);
  });

  it('Web 端不参与前台 Service（切后台只暂停队列）', async () => {
    hoisted.native = false;
    await downloadRepo.save(makeTask('web-1', 'downloading'));
    vi.spyOn(downloadService, 'pauseAll').mockResolvedValue(undefined);

    downloadService.bindLifecycle();
    goTo('background');
    await tick(20);

    expect(hoisted.start).not.toHaveBeenCalled();
    expect(hoisted.stop).not.toHaveBeenCalled();
    expect(downloadService.pauseAll).toHaveBeenCalledWith('background');
  });
});
