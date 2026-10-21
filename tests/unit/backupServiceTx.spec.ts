import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withTx } from '@/db/index';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { backupService } from '@/services/backupService';
import { AppError } from '@/shared/errors';
import type { BackupFile, FavoriteRecord, HistoryRecord, Source } from '@/types';

import { resetAll } from './helpers';

/**
 * 备份导入的事务原子性（REV-01 / AC-90 / AC-89）
 *
 * 缺陷：`importData` 在外层 `withTx(['sources','favorites','history'])` 回调里调用
 * 旧版 `historyRepo.save(record)`（内部自开事务）→ 外层事务在 await 期间自动提交，
 * 后续写入抛 `InvalidStateError`；此前已提交的数据无法回滚。
 *
 * 修复：`historyRepo.save/saveMany` 支持可选 `tx`，导入时把外层事务传入。
 * 本文件断言"导入中途某条写入抛错 → 三表全部无变化"。
 */

const NOW = 1_700_000_000_000;

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

function makeBackup(): BackupFile {
  return {
    schemaVersion: 1,
    appVersion: 'test',
    exportedAt: NOW,
    sources: [makeSource('import-src')],
    favorites: [makeFavorite('import-src', 'm1')],
    history: [makeHistory('import-src', 'm1')],
    settings: null,
    downloads: [],
  };
}

/** 先写入一套"现有数据"，用于断言失败后未被修改 */
async function seedExisting(): Promise<void> {
  await sourceRepo.save(makeSource('keep-src'));
  await favoriteRepo.save(makeFavorite('keep-src', 'k1'));
  await historyRepo.save(makeHistory('keep-src', 'k1'));
}

async function snapshot(): Promise<{ sources: string[]; favorites: string[]; history: string[] }> {
  const [sources, favorites, history] = await Promise.all([
    sourceRepo.list(),
    favoriteRepo.listAll(),
    historyRepo.listAllRaw(),
  ]);
  return {
    sources: sources.map((row) => row.id).sort(),
    favorites: favorites.map((row) => row.id).sort(),
    history: history.map((row) => row.id).sort(),
  };
}

describe('REV-01 backupService.importData 事务原子性', () => {
  beforeEach(async () => {
    await resetAll();
    await seedExisting();
  });

  it('导入中途写入抛错 → sources/favorites/history 三表全部无变化（AC-90）', async () => {
    const before = await snapshot();
    const original = backupService.importData.bind(backupService);

    // 让第 2 条历史的 put 抛错（模拟"导入中途某条写入失败"）
    const spy = vi.spyOn(historyRepo, 'saveMany').mockImplementation(async (records, tx) => {
      if (tx) {
        const store = tx.objectStore('history');
        // 第 1 条正常写入（此时事务内已有 sources/favorites 的写入）
        await store.put(records[0] as HistoryRecord);
        throw new AppError('E_INVALID_STATE', '模拟导入中途失败');
      }
      return Promise.resolve();
    });

    await expect(original(makeBackup(), 'overwrite')).rejects.toBeInstanceOf(AppError);

    spy.mockRestore();

    const after = await snapshot();
    expect(after).toEqual(before);
    expect(after.sources).toEqual(['keep-src']);
    expect(after.favorites).toEqual(['keep-src:k1']);
    expect(after.history).toEqual(['keep-src:k1']);
  });

  it('merge 模式中途失败同样整体回滚（不清空既有数据、不落新数据）', async () => {
    const before = await snapshot();
    // sources 已在事务内写入后，写历史时抛错 → 整体回滚
    const spy = vi.spyOn(historyRepo, 'saveMany').mockImplementation(() => {
      throw new AppError('E_DB', '模拟写历史失败');
    });

    await expect(backupService.importData(makeBackup(), 'merge')).rejects.toBeInstanceOf(AppError);
    spy.mockRestore();

    expect(await snapshot()).toEqual(before);
  });

  it('正常导入写入一次事务：三表均为新数据，旧数据被 overwrite 清空', async () => {
    const report = await backupService.importData(makeBackup(), 'overwrite');
    expect(report).toMatchObject({ sources: 1, favorites: 1, history: 1 });

    const after = await snapshot();
    expect(after).toEqual({
      sources: ['import-src'],
      favorites: ['import-src:m1'],
      history: ['import-src:m1'],
    });
  });

  it('historyRepo.save/saveMany 接受 tx 时不再自开事务（可在外层事务内多次调用）', async () => {
    await withTx(['sources', 'history'], 'readwrite', async (tx) => {
      await tx.objectStore('sources').put(makeSource('inline-src'));
      await tx.objectStore('sources').put(makeSource('inline-src-2'));
      await historyRepo.save(makeHistory('inline-src', 'h1'), tx);
      await historyRepo.saveMany([makeHistory('inline-src', 'h2'), makeHistory('inline-src', 'h3')], tx);
    });

    expect((await sourceRepo.list()).map((row) => row.id).sort()).toEqual(['inline-src', 'inline-src-2', 'keep-src']);
    expect((await historyRepo.listAllRaw()).map((row) => row.id).sort()).toEqual([
      'inline-src:h1',
      'inline-src:h2',
      'inline-src:h3',
      'keep-src:k1',
    ]);
  });

  it('withTx 检测到"回调结束但事务已提前提交"时输出错误日志（开发期护栏）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await withTx(['sources', 'history'], 'readwrite', async (tx) => {
      await tx.objectStore('sources').put(makeSource('early-src'));
      // 故意调用未传 tx 的版本：外层事务在 await 期间自动提交（缺陷形态）
      await historyRepo.save(makeHistory('early-src', 'h1'));
    });

    const messages = errorSpy.mock.calls.map((args) => String(args[1] ?? ''));
    expect(messages.some((text) => text.includes('事务已提前结束'))).toBe(true);
    errorSpy.mockRestore();
  });
});
