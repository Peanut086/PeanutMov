import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_ITEMS } from '@/data/demo/demoCatalog';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import { libraryService } from '@/services/libraryService';
import { mediaIdOf } from '@/shared/id';
import type { CreateDownloadInput, DownloadTask, PlaybackSource } from '@/types';

import { resetAll } from './helpers';

/**
 * 11-14 #2：下载任务的「线路身份」必须一路活到播放入口。
 *
 * 现场：第 2 集下载完成后从下载列表点播放，界面显示并播放第 1 集。
 * 断点在 `DownloadTask`——它不记线路，播放路由就只剩 mediaId + episodeId；
 * 而同一集在不同线路下的 id 各不相同，线路落到首条后目标集不在该线路选集里，
 * 于是被回退成第 1 集。这里锁住链路上每一环都还带着线路。
 */

const mediaId = mediaIdOf(DEMO_SOURCE_ID, DEMO_ITEMS[0]?.itemId ?? '');

function makeInput(overrides: Partial<CreateDownloadInput> = {}): CreateDownloadInput {
  return {
    sourceId: DEMO_SOURCE_ID,
    mediaId,
    episodeId: `${mediaId}:legacy-e1`,
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.mp4',
    format: 'mp4',
    ...overrides,
  };
}

function makePlayback(overrides: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    url: 'https://cdn.example.com/b.mp4',
    format: 'mp4',
    headers: {},
    subtitles: [],
    lineId: '',
    quality: null,
    expiresAt: null,
    isLocal: false,
    ...overrides,
  };
}

async function targetEpisode() {
  const episodes = await episodeRepo.listByMedia(mediaId);
  const ep = episodes.find((entry) => entry.number === 2) ?? episodes[0];
  if (!ep) throw new Error('演示数据未落到库');
  return ep;
}

describe('toDownloadInputs：线路以解析结果为准', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
    vi.restoreAllMocks();
  });

  it('解析内部回退到另一条线路时，记下实际线路而不是请求线路', async () => {
    const ep = await targetEpisode();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback({ lineId: 'L9-实际' }));

    const { inputs } = await libraryService.toDownloadInputs({
      mediaId,
      episodeIds: [ep.id],
      lineId: ep.lineId,
    });

    expect(inputs[0]?.lineId).toBe('L9-实际');
  });

  it('解析结果没带线路时退回请求线路（不写成 null）', async () => {
    const ep = await targetEpisode();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback({ lineId: '' }));

    const { inputs } = await libraryService.toDownloadInputs({
      mediaId,
      episodeIds: [ep.id],
      lineId: ep.lineId,
    });

    expect(inputs[0]?.lineId).toBe(ep.lineId);
  });

  it('未指定线路且解析也没给线路 → null（读取端按 null 处理）', async () => {
    const ep = await targetEpisode();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback({ lineId: '' }));

    const { inputs } = await libraryService.toDownloadInputs({
      mediaId,
      episodeIds: [ep.id],
      lineId: null,
    });

    expect(inputs[0]?.lineId).toBeNull();
  });
});

describe('downloadService.create：lineId 落库与存量兼容', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
    vi.restoreAllMocks();
  });

  it('创建的任务带上线，重读库仍是同一条线路', async () => {
    const ep = await targetEpisode();
    const { task } = await downloadService.create(makeInput({ episodeId: ep.id, lineId: ep.lineId }));
    expect(task.lineId).toBe(ep.lineId);

    const restored = await downloadRepo.get(task.id);
    expect(restored?.lineId).toBe(ep.lineId);
  });

  it('输入没有线路时写成 null，而不是 undefined', async () => {
    const { task } = await downloadService.create(makeInput());
    expect(task.lineId).toBeNull();
  });

  it('老任务缺 lineId 字段照样读得出来（不回填、不迁移）', async () => {
    const now = 1_700_000_000_000;
    const legacy = {
      id: 'legacy-t1',
      sourceId: DEMO_SOURCE_ID,
      mediaId,
      episodeId: `${mediaId}:legacy-e1`,
      episodeNumber: 1,
      title: '影片',
      episodeTitle: '第 1 集',
      posterUrl: null,
      url: 'https://cdn.example.com/legacy.mp4',
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
      sink: 'filesystem',
      filePath: 'mediaSeg/legacy/1.mp4',
      blobKey: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    } satisfies Omit<DownloadTask, 'lineId'>;
    await downloadRepo.save(legacy);

    const restored = await downloadRepo.get(legacy.id);
    expect(restored).not.toBeNull();
    expect(restored?.lineId).toBeUndefined();
  });
});
