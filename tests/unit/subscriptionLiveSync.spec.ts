/**
 * 订阅刷新的直播源同步结果（EXT 批次 24：静默失败收口）
 *
 * 旧口径：`addTvboxLives` 内部 `catch {}` 吞掉单个失败，外层 `catch` 只写日志，
 * 而 `livesSynced` 直接取 `preview.lives.length`——于是"直播源一个都没同步上"也会
 * 被页面播报成「已刷新：覆盖 N 个源」的成功语气。
 *
 * 现在 addTvboxLives 回报 `{added, failed}`，刷新结果带上 `livesSynced / livesFailed`，
 * 由调用方决定语气（SubscriptionListView 在 `livesFailed>0` 时降级为 info 并写明缺口）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { liveRepo } from '@/db/repositories/liveRepo';
import { importService } from '@/services/importService';
import { liveService } from '@/services/liveService';
import type { ImportPreview, LiveRecord } from '@/types';

import { resetAll } from './helpers';

function makeRecord(url: string): LiveRecord {
  return {
    id: `live-${url}`,
    name: '已存在源',
    url,
    format: 'txt',
    channelCount: 1,
    subscriptionId: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makePreview(lives: Array<{ name: string; url: string }>): ImportPreview {
  return {
    origin: 'url',
    sourceUrl: 'https://cdn.example.com/sub.json',
    fileName: null,
    fetchedAt: 1,
    name: '测试订阅',
    total: 0,
    entries: [],
    globalIssues: [],
    repos: [],
    lives,
  };
}

const URL = 'https://cdn.example.com/sub.json';
const LIVES = [
  { name: '卫视1', url: 'http://a.example.com/1.txt' },
  { name: '卫视2', url: 'http://a.example.com/2.txt' },
  { name: '卫视3', url: 'http://a.example.com/3.txt' },
];

// vitest 配置为 clearMocks，只清调用记录不清实现，本文件的 spy 实现必须显式还原
afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await resetAll();
  vi.spyOn(importService, 'previewFromUrl').mockResolvedValue(makePreview(LIVES));
  vi.spyOn(importService, 'commit').mockResolvedValue({
    success: 2,
    skipped: 0,
    failed: 0,
    sourceIds: [],
    issues: [],
  });
});

describe('订阅刷新的直播源同步（批次 24）', () => {
  it('整批同步抛错 → livesFailed 等于全部条数，livesSynced=0', async () => {
    vi.spyOn(liveService, 'addTvboxLives').mockRejectedValue(new Error('无法访问外部存储'));

    const result = await importService.refreshSubscription(URL);
    expect(result).toMatchObject({ updated: 2, livesSynced: 0, livesFailed: LIVES.length });
  });

  it('单条失败也计入 livesFailed，成功的照常计数', async () => {
    vi.spyOn(liveService, 'addTvboxLives').mockResolvedValue({ added: 2, failed: 1 });

    const result = await importService.refreshSubscription(URL);
    expect(result).toMatchObject({ livesSynced: 2, livesFailed: 1 });
  });

  it('全部同步成功 → livesFailed=0（正向对照）', async () => {
    vi.spyOn(liveService, 'addTvboxLives').mockResolvedValue({ added: 3, failed: 0 });

    const result = await importService.refreshSubscription(URL);
    expect(result).toMatchObject({ livesSynced: 3, livesFailed: 0 });
  });

  it('订阅里没有 lives 时不去调用，也不虚报失败', async () => {
    vi.mocked(importService.previewFromUrl).mockResolvedValue(makePreview([]));
    const add = vi.spyOn(liveService, 'addTvboxLives');

    const result = await importService.refreshSubscription(URL);
    expect(add).not.toHaveBeenCalled();
    expect(result).toMatchObject({ livesSynced: 0, livesFailed: 0 });
  });

  it('addTvboxLives 逐条统计：单条写入失败不阻塞后续', async () => {
    const add = vi.spyOn(liveService, 'add').mockImplementation(async ({ url }) => {
      if (url.includes('/2.')) throw new Error('存储写入失败');
      return { id: 'live-x' } as never;
    });

    const result = await liveService.addTvboxLives(LIVES, URL);
    expect(result).toEqual({ added: 2, failed: 1 });
    expect(add).toHaveBeenCalledTimes(3);
    add.mockRestore();
  });

  it('addTvboxLives 跳过已存在的同 URL（既不算新增也不算失败）', async () => {
    await liveRepo.save(makeRecord(LIVES[0]!.url));
    const add = vi.spyOn(liveService, 'add').mockResolvedValue({ id: 'live-x' } as never);

    const result = await liveService.addTvboxLives(LIVES, URL);
    expect(add).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ added: 2, failed: 0 });
  });
});
