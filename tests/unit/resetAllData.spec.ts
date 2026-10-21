import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/index';
import { blobRepo } from '@/db/repositories/blobRepo';
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { STORE_NAMES, type StoreName } from '@/db/schema';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { DEMO_ITEM_COUNT } from '@/data/demo/demoCatalog';
import { settingsService } from '@/services/settingsService';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { AppError } from '@/shared/errors';
import { KV_KEY_SETTINGS } from '@/shared/constants';
import type { DownloadTask, FavoriteRecord, HistoryRecord, Source } from '@/types';

import { resetAll } from './helpers';

/**
 * 「清空全部数据」单测（REV-02 / AC-99 / FR-41）
 *
 * 缺陷：`resetAllData` 在外层 9-store 事务内调用 `sourceRepo.clear()`（无 tx 参数，
 * 内部自开事务）→ 外层事务提前提交 → 第 223 行 `mediaRepo.clear(tx)` 抛
 * `InvalidStateError` → 转 `E_DB`，且 sources 已被真实清空而其它表未动。
 *
 * 修复后断言：两个分支都真的清空 9 张表；keepDemo 时演示源与媒体恢复；
 * 失败时不留半清空状态。
 */

const NOW = 1_700_000_000_000;

/** 9 张业务表（不含 kv：设置与合规状态需要保留） */
const BUSINESS_STORES: StoreName[] = [
  STORE_NAMES.sources,
  STORE_NAMES.media,
  STORE_NAMES.lines,
  STORE_NAMES.episodes,
  STORE_NAMES.categories,
  STORE_NAMES.history,
  STORE_NAMES.favorites,
  STORE_NAMES.downloads,
  STORE_NAMES.blobs,
];

function makeSource(id: string): Source {
  return {
    id,
    key: id,
    name: `源 ${id}`,
    type: 'alist',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: 'https://alist.example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeFavorite(sourceId: string, mediaId: string): FavoriteRecord {
  return {
    id: `${sourceId}:${mediaId}`,
    sourceId,
    mediaId,
    title: `收藏 ${mediaId}`,
    posterUrl: null,
    type: 'movie',
    year: 2024,
    sourceRemoved: false,
    createdAt: NOW,
  };
}

function makeHistory(sourceId: string, mediaId: string): HistoryRecord {
  return {
    id: `${sourceId}:${mediaId}`,
    sourceId,
    mediaId,
    episodeId: `${mediaId}:e1`,
    episodeNumber: 1,
    title: `历史 ${mediaId}`,
    posterUrl: null,
    positionSec: 30,
    durationSec: 100,
    progress: 0.3,
    finished: false,
    totalEpisodes: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeTask(id: string): DownloadTask {
  return {
    id,
    sourceId: 'custom-src',
    mediaId: 'custom-src:m1',
    episodeId: 'custom-src:m1:e1',
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
    sink: 'idb-blob',
    filePath: null,
    blobKey: id,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  };
}

/** 每张业务表当前条数（直接读 store，绕过 repo 的语义过滤） */
async function storeCounts(): Promise<Record<string, number>> {
  const db = await getDb();
  const out: Record<string, number> = {};
  for (const name of BUSINESS_STORES) {
    out[name] = await db.count(name);
  }
  return out;
}

async function seedBusinessData(): Promise<void> {
  // 演示数据（含源/分类/12 条媒体/线路/剧集）
  await seedDemoData();
  // 自定义源 + 关联缓存
  const custom = makeSource('custom-src');
  await sourceRepo.save(custom);
  await mediaRepo.save({
    id: 'custom-src:m1',
    sourceId: custom.id,
    sourceItemId: 'm1',
    title: '自定义影片',
    titleLower: '自定义影片',
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
    updatedAt: NOW,
    cachedAt: NOW,
    isDemo: false,
  });
  await lineRepo.saveMany([{
    id: 'custom-src:m1:l1',
    mediaId: 'custom-src:m1',
    sourceId: custom.id,
    name: '线路 1',
    quality: null,
    format: 'mp4',
    index: 0,
  }]);
  await episodeRepo.saveMany([{
    id: 'custom-src:m1:e1',
    mediaId: 'custom-src:m1',
    sourceId: custom.id,
    lineId: 'custom-src:m1:l1',
    number: 1,
    title: '第 1 集',
    durationSec: 600,
    subtitles: [],
    updatedAt: NOW,
  }]);
  await categoryRepo.replaceForSource(custom.id, [
    { id: 'custom-src:movie', sourceId: custom.id, name: '电影', value: 'movie', order: 0 },
  ]);
  await historyRepo.save(makeHistory('custom-src', 'm1'));
  await favoriteRepo.save(makeFavorite('custom-src', 'm1'));
  await downloadRepo.save(makeTask('task-1'));
  await blobRepo.put({
    key: 'task-1',
    blob: new Blob([new Uint8Array(16)]),
    size: 16,
    mime: 'video/mp4',
    createdAt: NOW,
  });
}

describe('REV-02 settingsService.resetAllData', () => {
  beforeEach(async () => {
    await resetAll();
    await seedBusinessData();
  });

  it('前置：9 张业务表都有数据（否则清空断言无意义）', async () => {
    const counts = await storeCounts();
    for (const name of BUSINESS_STORES) {
      expect(counts[name], `${name} 应有数据`).toBeGreaterThan(0);
    }
  });

  it('keepDemo=false：9 张表全部清空，且不抛 E_DB', async () => {
    await expect(settingsService.resetAllData({ keepDemo: false })).resolves.toBeUndefined();

    const counts = await storeCounts();
    expect(counts).toEqual({
      sources: 0,
      media: 0,
      lines: 0,
      episodes: 0,
      categories: 0,
      history: 0,
      favorites: 0,
      downloads: 0,
      blobs: 0,
    });
    expect(await sourceRepo.list()).toHaveLength(0);
  });

  it('keepDemo=false：设置本身保留（kv 不清空），defaultSourceId 归零', async () => {
    await settingsService.update({ defaultSourceId: 'custom-src', theme: 'light' });
    await settingsService.resetAllData({ keepDemo: false });

    const stored = await kvRepo.get<{ theme: string; defaultSourceId: string | null }>(KV_KEY_SETTINGS);
    expect(stored?.theme).toBe('light');
    expect(stored?.defaultSourceId).toBeNull();
    expect(await kvRepo.get(KV_KEY_SETTINGS)).not.toBeNull();
  });

  it('keepDemo=true：演示源与 12 条演示媒体恢复，自定义数据被清空', async () => {
    await settingsService.resetAllData({ keepDemo: true });

    const sources = await sourceRepo.list();
    expect(sources.map((row) => row.id)).toEqual([DEMO_SOURCE_ID]);
    expect(sources[0]?.builtin).toBe(true);
    expect(sources[0]?.enabled).toBe(true);

    const media = await mediaRepo.listBySourceAll(DEMO_SOURCE_ID);
    expect(media).toHaveLength(DEMO_ITEM_COUNT);
    expect(media.every((item) => item.isDemo)).toBe(true);

    expect(await mediaRepo.countBySource('custom-src')).toBe(0);
    expect(await historyRepo.listAllRaw()).toHaveLength(0);
    expect(await favoriteRepo.listAll()).toHaveLength(0);
    expect(await downloadRepo.listAll()).toHaveLength(0);
    expect(await blobRepo.count()).toBe(0);
    expect(await categoryRepo.listBySource('custom-src')).toHaveLength(0);
    // 演示线路/剧集被重新种入
    const demoMedia = media[0];
    expect(demoMedia).toBeDefined();
    expect(await lineRepo.listByMedia(demoMedia?.id ?? '')).not.toHaveLength(0);
    expect(await episodeRepo.listByMedia(demoMedia?.id ?? '')).not.toHaveLength(0);
  });

  it('失败时无半清空状态：事务内任一清除抛错 → 9 张表保持原样', async () => {
    const before = await storeCounts();
    const sourcesBefore = (await sourceRepo.list()).map((row) => row.id).sort();

    const spy = vi.spyOn(favoriteRepo, 'clear').mockRejectedValue(new AppError('E_DB', '模拟清除失败'));

    await expect(settingsService.resetAllData({ keepDemo: false })).rejects.toBeInstanceOf(AppError);
    spy.mockRestore();

    expect(await storeCounts()).toEqual(before);
    expect((await sourceRepo.list()).map((row) => row.id).sort()).toEqual(sourcesBefore);
    // sources 不应被先清空（缺陷形态：sources 0 条，其它表未动）
    expect(before.sources).toBeGreaterThan(0);
  });

  it('keepDemo=true 分支的补种失败不会留下"半清空"（清空本身原子，补种在事务外）', async () => {
    // 补种失败：清空已提交，抛 E_DB 由调用方提示重试
    const spy = vi.spyOn(sourceRepo, 'get').mockRejectedValue(new AppError('E_DB', '模拟补种失败'));
    await expect(settingsService.resetAllData({ keepDemo: true })).rejects.toBeInstanceOf(AppError);
    spy.mockRestore();
    // 清空是原子的：要么全清、要么全留。此时已全清（补种在事务外）
    const counts = await storeCounts();
    expect(counts.history).toBe(0);
    expect(counts.favorites).toBe(0);
    expect(counts.sources).toBe(0);
    expect(counts.media).toBe(0);
  });
});
