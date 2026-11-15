/**
 * 下载设置 → 实际行为 的接线回归（第二轮 / 项 2）
 *
 * 覆盖三处「设置写了但不生效」：
 * 1. `download.concurrency` 此前只驱动 JS 队列，原生侧硬编码 2 路 → 现在同步下发闸门；
 * 2. `download.wifiOnly` 此前只在 preflight 拦新任务，切到移动网络后在飞任务照跑 →
 *    现在订阅网络变化并对在飞任务生效；
 * 3. 启动/切档都要把档位同步给原生限速桶（`applyNativeSpeedLimit`）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { settingsService } from '@/services/settingsService';
import { downloadService } from '@/services/downloadService';
import type { DownloadTask } from '@/types';

import { resetAll } from './helpers';

const hoisted = vi.hoisted(() => ({
  netType: 'wifi' as 'wifi' | 'cellular',
  listeners: new Set<() => void>(),
  setConcurrency: vi.fn(async (_n: number) => undefined),
  applySpeedLimit: vi.fn(async (_bps: number) => true),
}));

vi.mock('@/native/downloadPlugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/native/downloadPlugin')>()),
  nativeDownloadSetConcurrency: hoisted.setConcurrency,
}));

vi.mock('@/native/mediaToolPlugin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/native/mediaToolPlugin')>()),
  applyNativeSpeedLimit: hoisted.applySpeedLimit,
}));

vi.mock('@/native/network', () => ({
  currentNetworkType: () => hoisted.netType,
  isOnline: () => true,
  onNetworkChange: (cb: () => void) => {
    hoisted.listeners.add(cb);
    return () => hoisted.listeners.delete(cb);
  },
  getNetworkStatus: async () => ({ connected: true, type: hoisted.netType }),
}));

const NOW = 1_700_000_000_000;

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
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
    status: 'downloading',
    priority: NOW,
    totalBytes: 1000,
    downloadedBytes: 400,
    speedBps: 0,
    retries: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as DownloadTask;
}

function fireNetworkChange(): void {
  hoisted.listeners.forEach((cb) => cb());
}

describe('下载设置生效链路', () => {
  beforeEach(async () => {
    await resetAll();
    vi.clearAllMocks();
    hoisted.netType = 'wifi';
    hoisted.listeners.clear();
  });

  it('setConcurrency 同时驱动 JS 队列与原生闸门', async () => {
    await downloadService.setConcurrency(3);

    expect(hoisted.setConcurrency).toHaveBeenLastCalledWith(3);
    const settings = await settingsService.get();
    expect(settings.download.concurrency).toBe(3);
  });

  it('启动时把持久化的并发档位与限速档下发给原生（此前原生恒为 2、限速只扣 JS 侧）', async () => {
    await settingsService.update({ download: { concurrency: 1, speedLimit: 'low' } });
    hoisted.setConcurrency.mockClear();
    hoisted.applySpeedLimit.mockClear();

    await downloadService.bootstrap();

    expect(hoisted.setConcurrency).toHaveBeenCalledWith(1);
    expect(hoisted.applySpeedLimit).toHaveBeenCalled();
    downloadService.__resetQueue();
  });

  it('wifiOnly 开启时切到移动网络会暂停在飞任务', async () => {
    await settingsService.update({ download: { wifiOnly: true } });
    await downloadRepo.save(makeTask({ id: 'cell-1' }));

    const pauseAll = vi.spyOn(downloadService, 'pauseAll').mockResolvedValue(undefined);
    downloadService.bindLifecycle();

    hoisted.netType = 'cellular';
    fireNetworkChange();
    await vi.waitFor(() => expect(pauseAll).toHaveBeenCalledWith('network'));
    pauseAll.mockRestore();
  });

  it('wifiOnly 关闭时切到移动网络不动在飞任务', async () => {
    await settingsService.update({ download: { wifiOnly: false } });
    await downloadRepo.save(makeTask({ id: 'cell-2' }));

    const pauseAll = vi.spyOn(downloadService, 'pauseAll').mockResolvedValue(undefined);
    downloadService.bindLifecycle();

    hoisted.netType = 'cellular';
    fireNetworkChange();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pauseAll).not.toHaveBeenCalled();
    pauseAll.mockRestore();
  });

  it('没有进行中的任务时不弹暂停提示也不调用 pauseAll', async () => {
    await settingsService.update({ download: { wifiOnly: true } });

    const pauseAll = vi.spyOn(downloadService, 'pauseAll').mockResolvedValue(undefined);
    downloadService.bindLifecycle();

    hoisted.netType = 'cellular';
    fireNetworkChange();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pauseAll).not.toHaveBeenCalled();
    pauseAll.mockRestore();
  });
});
