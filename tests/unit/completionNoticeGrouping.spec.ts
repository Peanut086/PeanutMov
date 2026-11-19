/**
 * 完成提示的聚合与文案（P2-4）
 *
 * 真机实测（13 集批次）：两集完成即弹两条一模一样的「绝命毒师 第四季」下载完成——
 * 文案只有片名，看不出是哪一集，也看不出它们属于同一批。
 *
 * 现在同一批在一个提示窗口内合成一条，并点名到集；无分集概念的单文件维持原话术。
 */
import { describe, expect, it } from 'vitest';

import { completionGroupKey, planCompletionToasts } from '@/services/downloadBatch';
import type { DownloadTask } from '@/types';

const NOW = 1_700_000_000_000;

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: overrides.id ?? 'task-1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: `demo:m1:e${overrides.episodeNumber ?? 1}`,
    episodeNumber: 1,
    title: '绝命毒师 第四季',
    episodeTitle: `第 ${overrides.episodeNumber ?? 1} 集`,
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
    sink: 'filesystem',
    filePath: `downloads/${overrides.id ?? 'task-1'}.mp4`,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    ...overrides,
  };
}

function episode(id: string, no: number, batchId: string): DownloadTask {
  return makeTask({ id, episodeNumber: no, batchId });
}

describe('planCompletionToasts（批次聚合 + 集号文案）', () => {
  it('空输入什么都不弹', () => {
    expect(planCompletionToasts([])).toEqual([]);
  });

  it('批次里单集完成：文案点名到集，不再只报片名', () => {
    const lines = planCompletionToasts([episode('e3', 3, 'batch_a')]);
    expect(lines).toEqual(['「绝命毒师 第四季」第 3 集已下载']);
  });

  it('同批两集落在同一窗口：合成一条并列出两集', () => {
    const lines = planCompletionToasts([episode('e1', 1, 'batch_a'), episode('e2', 2, 'batch_a')]);
    expect(lines).toEqual(['「绝命毒师 第四季」第 1 集、第 2 集已下载（共 2 集）']);
  });

  it('同批多集：只点名前 3 集，其余归入「等」', () => {
    const fresh = [1, 2, 3, 4, 5].map((no) => episode(`e${no}`, no, 'batch_a'));
    expect(planCompletionToasts(fresh)).toEqual([
      '「绝命毒师 第四季」第 1 集、第 2 集、第 3 集等已下载（共 5 集）',
    ]);
  });

  it('两个不同批各自成条（互不吞并）', () => {
    const lines = planCompletionToasts([episode('a-e1', 1, 'batch_a'), episode('b-e1', 1, 'batch_b')]);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.includes('第 1 集已下载'))).toBe(true);
  });

  it('单文件下载（无集号）维持「下载完成」话术', () => {
    const lines = planCompletionToasts([
      makeTask({ id: 'solo', title: '某部影片', episodeNumber: null, episodeTitle: null }),
    ]);
    expect(lines).toEqual(['「某部影片」下载完成']);
  });

  it('缺分集标题时退回集号；整批无集号时按项数报', () => {
    const byNumber = planCompletionToasts([
      makeTask({ id: 'e7', episodeNumber: 7, episodeTitle: null, batchId: 'batch_a' }),
    ]);
    expect(byNumber).toEqual(['「绝命毒师 第四季」第 7 集已下载']);

    const mixed = planCompletionToasts([
      makeTask({ id: 'x1', episodeNumber: null, episodeTitle: null, batchId: 'batch_a' }),
      makeTask({ id: 'x2', episodeNumber: null, episodeTitle: null, batchId: 'batch_a' }),
    ]);
    expect(mixed).toEqual(['「绝命毒师 第四季」2 项下载完成']);
  });

  it('片名缺失时不至于弹成「undefined」', () => {
    const lines = planCompletionToasts([
      makeTask({ id: 'noname', title: '   ', episodeNumber: null, episodeTitle: null }),
    ]);
    expect(lines).toEqual(['「下载」下载完成']);
  });

  it('分组键区分批号与任务 id 两个命名空间', () => {
    const solo = makeTask({ id: 'batch_a' });
    const batched = episode('other', 1, 'batch_a');
    expect(completionGroupKey(solo)).toBe('solo:batch_a');
    expect(completionGroupKey(batched)).toBe('batch:batch_a');
    expect(planCompletionToasts([solo, batched])).toHaveLength(2);
  });
});
