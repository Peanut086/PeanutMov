import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mediaRepo } from '@/db/repositories/mediaRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { historyService } from '@/services/historyService';
import { settingsService } from '@/services/settingsService';
import type { HistoryRecord, MediaItem } from '@/types';

import { resetAll } from './helpers';

/**
 * 「继续观看」的两处全量放大。
 *
 * 1. `list()` 与 `listContinueWatching()` 各自 `historyRepo.listAll(500)` 一遍，
 *    store 每次刷新都要读两遍（历史带 `mediaSnapshot`，500 条不是小数目）。
 * 2. 开启「隐藏演示内容」后，对每条待看记录单独 `mediaRepo.get()` —— 几百条待看
 *    就是几百个独立 IDB 事务。改成去重后一次 `getMany`。
 *
 * 本文件不 mock `historyService`，跑的是真实实现。
 */

function media(id: string, isDemo: boolean): MediaItem {
  return {
    id,
    sourceId: 'src-1',
    sourceItemId: id,
    title: `影片 ${id}`,
    titleLower: `影片 ${id}`,
    originalTitle: null,
    type: 'movie',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    description: '',
    posterUrl: null,
    backdropUrl: null,
    durationSec: 600,
    episodeCount: 1,
    updatedAt: 1_700_000_000_000,
    cachedAt: 1_700_000_000_000,
    isDemo,
  };
}

function record(mediaId: string, updatedAt: number): HistoryRecord {
  return {
    id: `src-1:${mediaId}`,
    sourceId: 'src-1',
    mediaId,
    episodeId: `${mediaId}:e1`,
    episodeNumber: 1,
    title: `影片 ${mediaId}`,
    posterUrl: null,
    positionSec: 120,
    durationSec: 600,
    progress: 0.2,
    finished: false,
    totalEpisodes: 1,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('继续观看：一遍读全量 + 批量回查 media', () => {
  beforeEach(async () => {
    await resetAll();
    await mediaRepo.save(media('d1', true));
    await mediaRepo.save(media('d2', true));
    await mediaRepo.save(media('r1', false));
    await historyRepo.save(record('d1', 1_000));
    await historyRepo.save(record('d2', 2_000));
    await historyRepo.save(record('r1', 3_000));
    // 媒体缓存已被清理的历史：按非演示处理，不该被误隐藏
    await historyRepo.save(record('gone', 4_000));
    await settingsService.update({ hideDemoContent: true });
  });

  it('开启隐藏演示：一次 getMany 完成判定，且不再逐条 mediaRepo.get', async () => {
    const getMany = vi.spyOn(mediaRepo, 'getMany');
    const get = vi.spyOn(mediaRepo, 'get');

    const pending = await historyService.listContinueWatching();
    expect(pending.map((row) => row.mediaId)).toEqual(['gone', 'r1']);
    expect(getMany).toHaveBeenCalledTimes(1);
    expect([...(getMany.mock.calls[0]?.[0] ?? [])].sort()).toEqual(['d1', 'd2', 'gone', 'r1']);
    expect(get).not.toHaveBeenCalled();
  });

  it('listWithContinueWatching 只扫一遍历史全量', async () => {
    const listAll = vi.spyOn(historyRepo, 'listAll');
    const { items, continueWatching } = await historyService.listWithContinueWatching();
    expect(listAll).toHaveBeenCalledTimes(1);
    expect(items).toHaveLength(4);
    expect(continueWatching.map((row) => row.mediaId)).toEqual(['gone', 'r1']);
  });

  it('关闭开关时不回查 media 表', async () => {
    await settingsService.update({ hideDemoContent: false });
    const getMany = vi.spyOn(mediaRepo, 'getMany');

    expect(await historyService.listContinueWatching()).toHaveLength(4);
    expect(getMany).not.toHaveBeenCalled();
  });
});
