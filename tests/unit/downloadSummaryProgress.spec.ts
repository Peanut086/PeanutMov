import { describe, expect, it } from 'vitest';

import { aggregateSummary } from '@/shared/downloadSummary';
import type { DownloadTask } from '@/types';

/**
 * P2-1：汇总卡的进度口径。
 *
 * 真机现场（11-18 端到端）：13 集批次起跑 6s，头部显示「共 13 个任务 / 1.7 MB / 1.7 MB /
 * 100% / 下载中 2 · 等待 9 · 已完成 2」——字节分母只累加了"体积已知"的任务，
 * 9 个还没下来清单的 `totalBytes` 是 null，不进分母，于是已完成那 2 项自己跟自己比成 100%。
 * 断言的是口径本身：进度按任务加权，体积未知的任务数单独暴露出来给 UI 用。
 */

const MB = 1024 * 1024;

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    lineId: 'L1',
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/ep1.m3u8',
    headers: {},
    format: 'hls',
    quality: null,
    status: 'queued',
    priority: 1,
    totalBytes: null,
    downloadedBytes: 0,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

/** 起跑 6s 的那一帧：2 集已完成、2 集刚起跑（清单还没落体积）、9 集还在等待 */
function batchAtSixSeconds(): DownloadTask[] {
  const done = [0, 1].map((i) =>
    makeTask({
      id: `done-${i}`,
      episodeId: `demo:m1:e${i}`,
      status: 'completed',
      totalBytes: 881_720,
      downloadedBytes: 881_720,
    }),
  );
  // 真机这一帧的分子分母都是 1.7 MB：在跑的两项既没体积也没字节，字节比于是 100%
  const running = [2, 3].map((i) =>
    makeTask({ id: `run-${i}`, episodeId: `demo:m1:e${i}`, status: 'downloading' }),
  );
  const waiting = Array.from({ length: 9 }, (_, i) =>
    makeTask({ id: `wait-${i}`, episodeId: `demo:m1:e${i + 4}` }),
  );
  return [...done, ...running, ...waiting];
}

describe('下载汇总口径（P2-1）', () => {
  it('体积未知的任务不进字节分母：字节比会是 100%，任务加权进度不会', () => {
    const rows = batchAtSixSeconds();
    const summary = aggregateSummary(rows);

    // 现场复现：分母只有 2 项已完成，分子分母相等 → 旧口径报 100%
    expect(summary.totalBytes).toBe(rows.reduce((acc, r) => acc + (r.totalBytes ?? 0), 0));
    expect(summary.downloadedBytes).toBe(summary.totalBytes);
    expect(summary.downloadedBytes / summary.totalBytes).toBe(1);
    // 修正后：到手 2 集 / 13 集
    expect(summary.progress).toBeCloseTo(2 / 13, 6);
    expect(summary.unknownSizeTasks).toBe(11);
  });

  it('断网后那一帧：5 完成 3 失败也不许报 100%，失败项不计入到手份额', () => {
    const rows = [
      ...[0, 1, 2, 3, 4].map((i) =>
        makeTask({ id: `ok-${i}`, episodeId: `demo:m1:e${i}`, status: 'completed', totalBytes: 881_720, downloadedBytes: 881_720 }),
      ),
      ...[5, 6, 7].map((i) =>
        makeTask({ id: `bad-${i}`, episodeId: `demo:m1:e${i}`, status: 'failed', errorCode: 'E_SOURCE_UNAVAILABLE' }),
      ),
      ...Array.from({ length: 5 }, (_, i) => makeTask({ id: `wait-${i}`, episodeId: `demo:m1:e${i + 8}` })),
    ];
    const summary = aggregateSummary(rows);

    // 失败与等待的体积都没下来 → 分子分母又相等，旧口径照样 100%
    expect(summary.downloadedBytes).toBe(summary.totalBytes);
    expect(summary.progress).toBeCloseTo(5 / 13, 6);
    expect(summary.unknownSizeTasks).toBe(8);
  });

  it('在跑的任务按自己的字节比计权重：清单已落体积时进度随之推进', () => {
    const rows = [
      ...batchAtSixSeconds().slice(0, 2),
      makeTask({ id: 'run-2', episodeId: 'demo:m1:e2', status: 'downloading', totalBytes: 1_181_016, downloadedBytes: 590_508 }),
      makeTask({ id: 'run-3', episodeId: 'demo:m1:e3', status: 'downloading', totalBytes: 1_181_016, downloadedBytes: 590_508 }),
      ...batchAtSixSeconds().slice(4),
    ];
    const summary = aggregateSummary(rows);

    // 2 完成 + 2 个 50% = 3，除以 13
    expect(summary.progress).toBeCloseTo(3 / 13, 6);
    expect(summary.unknownSizeTasks).toBe(9);
  });

  it('进度只在真的全部完成时到 1', () => {
    const rows = [0, 1, 2].map((i) =>
      makeTask({ id: `c-${i}`, status: 'completed', totalBytes: MB, downloadedBytes: MB }),
    );
    expect(aggregateSummary(rows).progress).toBe(1);
    expect(aggregateSummary(rows).unknownSizeTasks).toBe(0);

    const withOneWaiting = [...rows, makeTask()];
    expect(aggregateSummary(withOneWaiting).progress).toBeCloseTo(0.75, 6);
  });

  it('单个任务的字节比就是它的权重，估算偏低时钳到 1 不越界', () => {
    expect(aggregateSummary([makeTask({ status: 'downloading', totalBytes: 100, downloadedBytes: 25 })]).progress).toBeCloseTo(0.25, 6);
    const over = aggregateSummary([makeTask({ status: 'downloading', totalBytes: 100, downloadedBytes: 180 })]);
    expect(over.progress).toBe(1);
  });

  it('失败与未开始同样按 0 计，不做"看起来快完了"的粉饰', () => {
    const rows = [
      makeTask({ status: 'failed', totalBytes: 500, downloadedBytes: 480, errorCode: 'E_SOURCE_UNAVAILABLE' }),
      makeTask(),
    ];
    const summary = aggregateSummary(rows);
    expect(summary.progress).toBe(0);
    expect(summary.unknownSizeTasks).toBe(1);
  });

  it('空列表：进度 0，不出现 NaN/除零', () => {
    const summary = aggregateSummary([]);
    expect(summary.total).toBe(0);
    expect(summary.progress).toBe(0);
    expect(summary.unknownSizeTasks).toBe(0);
  });

  it('状态计数与旧口径保持一致（total 含已取消，计数不含）', () => {
    const summary = aggregateSummary([
      makeTask({ status: 'queued' }),
      makeTask({ status: 'downloading' }),
      makeTask({ status: 'paused' }),
      makeTask({ status: 'completed', totalBytes: 10, downloadedBytes: 10 }),
      makeTask({ status: 'failed' }),
      makeTask({ status: 'canceled' }),
    ]);
    expect(summary).toMatchObject({
      total: 6,
      queued: 1,
      downloading: 1,
      paused: 1,
      completed: 1,
      failed: 1,
    });
  });
});
