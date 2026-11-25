import { describe, expect, it } from 'vitest';

import { groupCompletedByMedia } from '@/services/downloadBatch';
import type { DownloadTask } from '@/types';

const NOW = 1_700_000_000_000;

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '士兵突击',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.ts',
    headers: {},
    format: 'hls',
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
    filePath: 'downloads/task-1.ts',
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

describe('groupCompletedByMedia', () => {
  it('跨批次按集号数值排序，空集号置后', () => {
    const groups = groupCompletedByMedia([
      task({ id: 'e16', episodeNumber: 16, batchId: 'batch-new', priority: 1 }),
      task({ id: 'e10', episodeNumber: 10, batchId: 'batch-old', priority: 2 }),
      task({ id: 'e2', episodeNumber: 2, batchId: 'batch-old', priority: 3 }),
      task({ id: 'movie', episodeNumber: null, episodeTitle: null, batchId: 'batch-new' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].tasks.map((row) => row.id)).toEqual(['e2', 'e10', 'e16', 'movie']);
  });

  it('媒体按剧名排序，同名不同媒体不合并', () => {
    const groups = groupCompletedByMedia([
      task({ id: 'soldier-b', mediaId: 'demo:b', title: '士兵突击' }),
      task({ id: 'breaking-bad', mediaId: 'demo:c', title: '绝命毒师' }),
      task({ id: 'soldier-a', mediaId: 'demo:a', title: '士兵突击' }),
    ]);

    expect(groups.map((group) => group.mediaId)).toEqual(['demo:c', 'demo:a', 'demo:b']);
  });

  it('同集多线路记录保留，并按完成时间稳定排序', () => {
    const groups = groupCompletedByMedia([
      task({ id: 'new', episodeId: 'e1-new', lineId: 'line-b', completedAt: NOW + 2 }),
      task({ id: 'old', episodeId: 'e1-old', lineId: 'line-a', completedAt: NOW + 1 }),
    ]);

    expect(groups[0].tasks.map((row) => row.id)).toEqual(['old', 'new']);
  });

  it('只展示已完成任务', () => {
    const groups = groupCompletedByMedia([
      task({ id: 'done' }),
      task({ id: 'active', status: 'downloading' }),
    ]);

    expect(groups[0].tasks.map((row) => row.id)).toEqual(['done']);
  });
});
