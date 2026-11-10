import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_ITEMS } from '@/data/demo/demoCatalog';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { settingsService } from '@/services/settingsService';
import { historyService } from '@/services/historyService';
import { libraryService } from '@/services/libraryService';
import { appEvents } from '@/services/events';
import { mediaIdOf } from '@/shared/id';
import type { HistoryRecord, MediaItem } from '@/types';

import { resetAll } from './helpers';

/**
 * AC-98 / REV-24：「隐藏演示内容」必须作用于"继续观看"
 *
 * 缺陷：`libraryService` 的 browse/search/listCached/listRecent 都按 `isDemo` 过滤，
 * 但 `historyService.listContinueWatching` 只按进度过滤，而 `HistoryRecord` 不含 `isDemo` →
 * 开启开关后继续观看仍返回演示条目（实测 1 条）。
 *
 * 修复：`listContinueWatching` 在 `hideDemoContent=true` 时按 mediaId 回查 `media` 表过滤。
 */

function historyOf(item: MediaItem): HistoryRecord {
  return {
    id: `${item.sourceId}:${item.id}`,
    sourceId: item.sourceId,
    mediaId: item.id,
    episodeId: `${item.id}:e1`,
    episodeNumber: 1,
    title: item.title,
    posterUrl: null,
    positionSec: 120,
    durationSec: 600,
    progress: 0.2,
    finished: false,
    totalEpisodes: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

describe('REV-24 「隐藏演示内容」作用于继续观看（AC-98）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    await seedDemoData();
  });

  it('关闭开关：继续观看返回演示条目（基线）', async () => {
    const demoItem = await mediaRepo.get(mediaIdOf(DEMO_SOURCE_ID, DEMO_ITEMS[0]?.itemId ?? ''));
    expect(demoItem).not.toBeNull();
    await historyRepo.save(historyOf(demoItem as MediaItem));

    await settingsService.update({ hideDemoContent: false });
    expect(await historyService.listContinueWatching()).toHaveLength(1);
  });

  it('开启开关：继续观看不返回 isDemo 条目（实测缺陷点）', async () => {
    const demoItem = await mediaRepo.get(mediaIdOf(DEMO_SOURCE_ID, DEMO_ITEMS[0]?.itemId ?? ''));
    await historyRepo.save(historyOf(demoItem as MediaItem));

    await settingsService.update({ hideDemoContent: true });
    expect(await historyService.listContinueWatching()).toHaveLength(0);
  });

  it('开启开关：真实（非演示）内容的继续观看仍然保留', async () => {
    const realItem: MediaItem = {
      id: 'real-src:m1',
      sourceId: 'real-src',
      sourceItemId: 'm1',
      title: '真实影片',
      titleLower: '真实影片',
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
      isDemo: false,
    };
    await mediaRepo.save(realItem);
    await historyRepo.save(historyOf(realItem));

    const demoItem = await mediaRepo.get(mediaIdOf(DEMO_SOURCE_ID, DEMO_ITEMS[0]?.itemId ?? ''));
    await historyRepo.save(historyOf(demoItem as MediaItem));

    await settingsService.update({ hideDemoContent: true });
    const pending = await historyService.listContinueWatching();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.mediaId).toBe('real-src:m1');
  });

  it('media 缓存缺失的历史记录不被误隐藏（按非演示处理）', async () => {
    await historyRepo.save({
      ...historyOf({
        id: 'gone:m1',
        sourceId: 'gone',
        isDemo: false,
      } as MediaItem),
    });
    await settingsService.update({ hideDemoContent: true });

    expect(await historyService.listContinueWatching()).toHaveLength(1);
  });

  it('演示源仍存在于源管理列表（开关只影响内容可见性，AC-98 后半段）', async () => {
    await settingsService.update({ hideDemoContent: true });
    const sources = await useSourceList();
    expect(sources.some((source) => source.id === DEMO_SOURCE_ID)).toBe(true);
  });
});

async function useSourceList(): Promise<Array<{ id: string }>> {
  const { sourceRepo } = await import('@/db/repositories/sourceRepo');
  return sourceRepo.list();
}

/**
 * REV-23 / AC-78：本地文件丢失不再"静默"回退网络源
 *
 * `PlaybackSource` 类型冻结，无法新增 `localMissing` 字段，因此在服务层用
 * `downloadService.localMissingTaskOf()` + `local:missing` 事件表达：
 * - 返回结果仍是可播放的网络源（`ok`），但事件让 UI 能提示"本地文件不可用，已切换网络源"；
 * - 事件带 `taskId`，UI 可据此调用 `downloadService.redownload(taskId)`。
 */
describe('REV-23 本地文件丢失时给出可识别标记（AC-78）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    await seedDemoData();
  });

  it('任务已完成但 Blob 缺失：resolvePlay 回退网络源的同时发出 local:missing 事件', async () => {
    const { downloadRepo } = await import('@/db/repositories/downloadRepo');
    const { mediaIdOf: idOf } = await import('@/shared/id');
    const mediaId = idOf(DEMO_SOURCE_ID, DEMO_ITEMS[0]?.itemId ?? '');
    const episodeId = `${mediaId}:ep1`;

    await downloadRepo.save({
      id: 'task-missing',
      sourceId: DEMO_SOURCE_ID,
      mediaId,
      episodeId,
      episodeNumber: 1,
      title: '演示影片',
      episodeTitle: '第 1 集',
      posterUrl: null,
      url: 'https://cdn.example.com/a.mp4',
      headers: {},
      format: 'mp4',
      quality: null,
      status: 'completed',
      priority: 1,
      totalBytes: 1000,
      downloadedBytes: 1000,
      speedBps: 0,
      retries: 0,
      maxRetries: 2,
      resumable: true,
      sink: 'idb-blob',
      filePath: null,
      blobKey: 'blob-lost', // blobs 表里没有这条 → 本地不可用
      errorCode: null,
      errorMessage: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_000,
    });

    const events: Array<{ taskId: string; text: string }> = [];
    appEvents.on('local:missing', (payload) => events.push(payload));

    const { downloadService } = await import('@/services/downloadService');
    expect(await downloadService.isLocalFileMissing(mediaId, episodeId)).toBe(true);
    expect((await downloadService.localMissingTaskOf(mediaId, episodeId))?.id).toBe('task-missing');

    const playback = await libraryService.resolvePlay({ mediaId, episodeId, lineId: null });
    expect(playback.isLocal).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      taskId: 'task-missing',
      mediaId,
      episodeId,
      text: '本地文件不可用，已切换网络源',
    });
  });

  it('本地文件可用时：返回 isLocal=true 且不发 local:missing 事件', async () => {
    const { downloadRepo } = await import('@/db/repositories/downloadRepo');
    const { downloadService } = await import('@/services/downloadService');
    const { mediaIdOf: idOf } = await import('@/shared/id');
    const mediaId = idOf(DEMO_SOURCE_ID, DEMO_ITEMS[0]?.itemId ?? '');
    const episodeId = `${mediaId}:ep2`;

    await downloadRepo.save({
      id: 'task-ok',
      sourceId: DEMO_SOURCE_ID,
      mediaId,
      episodeId,
      episodeNumber: 1,
      title: '演示影片',
      episodeTitle: '第 1 集',
      posterUrl: null,
      url: 'https://cdn.example.com/a.mp4',
      headers: {},
      format: 'mp4',
      quality: null,
      status: 'completed',
      priority: 1,
      totalBytes: 8,
      downloadedBytes: 8,
      speedBps: 0,
      retries: 0,
      maxRetries: 2,
      resumable: true,
      sink: 'idb-blob',
      filePath: null,
      blobKey: 'blob-ok',
      errorCode: null,
      errorMessage: null,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      completedAt: 1_700_000_000_000,
    });

    // happy-dom + fake-indexeddb 无法真实往返 Blob（结构化克隆后不是 Blob 实例），
    // 这里直接注入"本地可播放"的结果验证分支：可用时不发 local:missing。
    const localPlay = {
      url: 'blob:local-ok',
      format: 'mp4' as const,
      headers: {},
      subtitles: [],
      lineId: 'local:task-ok',
      quality: null,
      expiresAt: null,
      isLocal: true,
    };
    const findSpy = vi.spyOn(downloadService, 'findLocalForMedia').mockResolvedValue(localPlay);
    const missingSpy = vi.spyOn(downloadService, 'localMissingForMedia');

    const listener = vi.fn();
    appEvents.on('local:missing', listener);

    const playback = await libraryService.resolvePlay({ mediaId, episodeId, lineId: null });
    expect(playback.isLocal).toBe(true);
    expect(playback.url).toBe('blob:local-ok');
    expect(listener).not.toHaveBeenCalled();
    // 本地可用时不应再走"缺失"探测
    expect(missingSpy).not.toHaveBeenCalled();

    findSpy.mockRestore();
    missingSpy.mockRestore();
  });
});
