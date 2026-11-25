import { describe, expect, it } from 'vitest';

import { buildLocalEpisodeCatalog } from '@/player/localEpisodeCatalog';
import type { DownloadTask } from '@/types';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = 1_700_000_000_000;
  return {
    id: 'task-1',
    sourceId: 'source-1',
    mediaId: 'media-1',
    episodeId: 'line-1:ep-1',
    episodeNumber: 1,
    lineId: 'line-1',
    title: '测试剧集',
    episodeTitle: overrides.episodeTitle !== undefined
      ? overrides.episodeTitle
      : `第 ${overrides.episodeNumber ?? 1} 集`,
    posterUrl: null,
    url: 'https://cdn.example.com/1.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'completed',
    priority: 1,
    totalBytes: 100,
    downloadedBytes: 100,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'filesystem',
    filePath: 'media-1/1.mp4',
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

describe('buildLocalEpisodeCatalog', () => {
  it('只收录已完成任务，并按数值集号排列', () => {
    const catalog = buildLocalEpisodeCatalog([
      task({ id: 'ep10', episodeId: 'L1:ep10', episodeNumber: 10 }),
      task({ id: 'ep2', episodeId: 'L1:ep2', episodeNumber: 2 }),
      task({ id: 'queued', episodeId: 'L1:ep1', episodeNumber: 1, status: 'queued' }),
      task({ id: 'failed', episodeId: 'L1:ep3', episodeNumber: 3, status: 'failed' }),
    ]);

    expect(catalog.map((entry) => entry.episode)).toEqual([
      { episodeId: 'L1:ep2', number: 2, title: '第 2 集' },
      { episodeId: 'L1:ep10', number: 10, title: '第 10 集' },
    ]);
    expect(catalog.map((entry) => entry.task.id)).toEqual(['ep2', 'ep10']);
  });

  it('同集多线路默认选最近完成的一条，不生成重复集号', () => {
    const catalog = buildLocalEpisodeCatalog([
      task({ id: 'old', episodeId: 'L1:ep2', episodeNumber: 2, completedAt: 100 }),
      task({ id: 'new', episodeId: 'L2:ep2', episodeNumber: 2, completedAt: 200 }),
    ]);

    expect(catalog).toHaveLength(1);
    expect(catalog[0]?.task.id).toBe('new');
    expect(catalog[0]?.episode.episodeId).toBe('L2:ep2');
  });

  it('当前点开的同集任务优先于更新记录，保证首集身份能进入目录', () => {
    const catalog = buildLocalEpisodeCatalog([
      task({ id: 'new', episodeId: 'L2:ep2', episodeNumber: 2, completedAt: 200 }),
      task({ id: 'opened', episodeId: 'L1:ep2', episodeNumber: 2, completedAt: 100 }),
    ], 'L1:ep2');

    expect(catalog[0]?.task.id).toBe('opened');
    expect(catalog[0]?.episode.episodeId).toBe('L1:ep2');
  });

  it('空集号不猜顺序，不放进上下集目录', () => {
    const catalog = buildLocalEpisodeCatalog([
      task({ id: 'unknown', episodeId: 'L1:unknown', episodeNumber: null }),
      task({ id: 'ep1', episodeId: 'L1:ep1', episodeNumber: 1 }),
    ], 'L1:unknown');

    expect(catalog.map((entry) => entry.episode.episodeId)).toEqual(['L1:ep1']);
  });

  it('缺少分集标题时使用集号文案，同时间记录按 id 稳定排序', () => {
    const catalog = buildLocalEpisodeCatalog([
      task({ id: 'b', episodeId: 'L2:ep1', episodeNumber: 1, episodeTitle: null }),
      task({ id: 'a', episodeId: 'L1:ep1', episodeNumber: 1, episodeTitle: null }),
    ]);

    expect(catalog[0]?.task.id).toBe('a');
    expect(catalog[0]?.episode.title).toBe('第 1 集');
  });
});
