import { describe, expect, it, vi } from 'vitest';

import { buildLocalPlaybackOptions } from '@/player/localPlayback';
import type { DownloadTask, PlaybackSource } from '@/types';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = 1_700_000_000_000;
  return {
    id: 'task-2',
    sourceId: 'source-1',
    mediaId: 'media-1',
    episodeId: 'L1:ep2',
    episodeNumber: 2,
    lineId: 'L1',
    title: '测试剧集',
    episodeTitle: '第 2 集',
    posterUrl: null,
    url: 'https://cdn.example.com/2.ts',
    headers: {},
    format: 'ts',
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
    filePath: 'media-1/2.ts',
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function playback(episodeId: string): PlaybackSource {
  return {
    url: `file:///downloads/${episodeId}.ts`,
    format: 'ts',
    headers: {},
    subtitles: [],
    lineId: `local:${episodeId}`,
    quality: null,
    expiresAt: null,
    isLocal: true,
  };
}

describe('buildLocalPlaybackOptions', () => {
  const current = task();
  const tasks = [
    task({ id: 'task-10', episodeId: 'L1:ep10', episodeNumber: 10, episodeTitle: '第 10 集' }),
    current,
    task({ id: 'task-1', episodeId: 'L1:ep1', episodeNumber: 1, status: 'queued' }),
  ];

  it('把已完成任务目录交给控制器，首集续播位置写入本地源', () => {
    const source = playback('L1:ep2');
    const options = buildLocalPlaybackOptions({
      mediaId: 'media-1',
      task: current,
      tasks,
      playback: source,
      startPositionSec: 12,
      loadTask: async (selected) => playback(selected.episodeId),
    });

    expect(options).toMatchObject({
      mediaId: 'media-1',
      episodeId: 'L1:ep2',
      lineId: 'local',
      title: '测试剧集',
      startPositionSec: 12,
      totalEpisodes: 2,
      preferLocal: true,
      episodes: [
        { episodeId: 'L1:ep2', number: 2, title: '第 2 集' },
        { episodeId: 'L1:ep10', number: 10, title: '第 10 集' },
      ],
    });
    expect(options.playback).toMatchObject({ isLocal: true, startPositionMs: 12_000 });
    expect(source.startPositionMs).toBeUndefined();
  });

  it('解析下一集时仍读取本地已完成文件，并保留完整目录', async () => {
    const loadTask = vi.fn(async (selected: DownloadTask) => playback(selected.episodeId));
    const options = buildLocalPlaybackOptions({
      mediaId: 'media-1',
      task: current,
      tasks,
      playback: playback('L1:ep2'),
      startPositionSec: 0,
      loadTask,
    });

    const next = await options.resolveEpisode?.('L1:ep10');

    expect(loadTask).toHaveBeenCalledWith(tasks[0]);
    expect(next).toMatchObject({
      episodeId: 'L1:ep10',
      lineId: 'local',
      startPositionSec: 0,
      totalEpisodes: 2,
      preferLocal: true,
      playback: { isLocal: true, url: 'file:///downloads/L1:ep10.ts' },
    });
    expect(next?.episodes.map((episode) => episode.episodeId)).toEqual(['L1:ep2', 'L1:ep10']);
  });

  it('目标集没有本地完成文件时明确失败，不回落网络', async () => {
    const loadTask = vi.fn(async (selected: DownloadTask) => playback(selected.episodeId));
    const options = buildLocalPlaybackOptions({
      mediaId: 'media-1',
      task: current,
      tasks,
      playback: playback('L1:ep2'),
      startPositionSec: 0,
      loadTask,
    });

    await expect(options.resolveEpisode?.('L1:ep1')).rejects.toThrow('本地文件不可用，请重新下载这一集');
    expect(loadTask).not.toHaveBeenCalled();
  });

  it('同集多线路保留当前点开的任务，避免控制器目录找不到当前 id', () => {
    const opened = task({ id: 'opened', episodeId: 'L2:ep2', completedAt: 100 });
    const newer = task({ id: 'newer', episodeId: 'L1:ep2', completedAt: 200 });
    const options = buildLocalPlaybackOptions({
      mediaId: 'media-1',
      task: opened,
      tasks: [newer, opened],
      playback: playback('L2:ep2'),
      startPositionSec: 0,
      loadTask: async (selected) => playback(selected.episodeId),
    });

    expect(options.episodeId).toBe('L2:ep2');
    expect(options.episodes).toEqual([
      { episodeId: 'L2:ep2', number: 2, title: '第 2 集' },
    ]);
  });
});
