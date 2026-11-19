/**
 * P3-3：换线路重复下载的下单前校验
 *
 * 真机链路上「搜到 → 下不动 → 换线路再下一遍」是常态，而 `createMany` 的重复判定只认字面
 * `mediaId+episodeId`：换一条线路必然是另一个 mediaId，于是同一集能在本地攒下好几份，
 * 用户既不知道，也没机会在下单前知道。
 *
 * 这里钉死判定口径（作品身份复用 P1-7 的归组实现）与提示文案，不改状态机、不拦下载。
 */
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDownloadGuards } from '@/composables/useDownloadGuards';
import { describeCrossLineDuplicates, findCrossLineDuplicates } from '@/services/downloadBatch';
import { useUiStore } from '@/stores/uiStore';
import type { CreateDownloadInput, DownloadTask } from '@/types';

const T0 = 1_700_000_000_000;

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 'task-1',
    sourceId: 'src-a',
    mediaId: 'A:m1',
    episodeId: 'A:m1~e5',
    episodeNumber: 5,
    title: '绝命毒师 第三季',
    episodeTitle: '第 5 集',
    posterUrl: null,
    url: 'https://example.test/a.mp4',
    headers: {},
    format: 'mp4',
    quality: '720p',
    status: 'completed',
    priority: 1,
    totalBytes: 1_073_741_824,
    downloadedBytes: 1_073_741_824,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'filesystem',
    filePath: '/sdcard/a.mp4',
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: T0,
    ...overrides,
  };
}

function input(overrides: Partial<CreateDownloadInput> = {}): CreateDownloadInput {
  return {
    sourceId: 'src-b',
    mediaId: 'B:m2',
    episodeId: 'B:m2~e5',
    episodeNumber: 5,
    title: '绝命毒师 第三季',
    episodeTitle: '第 5 集',
    posterUrl: null,
    url: 'https://example.test/b.mp4',
    format: 'mp4',
    ...overrides,
  };
}

const GB = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

describe('findCrossLineDuplicates', () => {
  it('换线路（不同 mediaId）的同作品同集：判为重复', () => {
    const hits = findCrossLineDuplicates([input()], [task()]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.planned.mediaId).toBe('B:m2');
    expect(hits[0]?.existing.mediaId).toBe('A:m1');
  });

  it('同一条线路的同集不报：那是 createMany 的 skipped 分支，话术已经在说「已在下载列表中」', () => {
    const hits = findCrossLineDuplicates([input({ mediaId: 'A:m1' })], [task()]);
    expect(hits).toEqual([]);
  });

  it('季号写法互认：S03 与「第三季」是同一部（复用 P1-7 归组口径）', () => {
    const hits = findCrossLineDuplicates(
      [input({ title: '绝命毒师 S03' })],
      [task({ title: '绝命毒师 第三季' })],
    );
    expect(hits).toHaveLength(1);
  });

  it('不同季不算重复：第三季的成品替代不了第四季', () => {
    const hits = findCrossLineDuplicates(
      [input({ title: '绝命毒师 第四季', episodeId: 'B:m2~e1' })],
      [task({ title: '绝命毒师 第三季' })],
    );
    expect(hits).toEqual([]);
  });

  it('集号不同不算重复', () => {
    const hits = findCrossLineDuplicates([input({ episodeNumber: 6 })], [task({ episodeNumber: 5 })]);
    expect(hits).toEqual([]);
  });

  it('跨季打包条目（1-5季）不参与比对：它覆盖整部，集号与单季不可比', () => {
    const hits = findCrossLineDuplicates([input()], [task({ title: '绝命毒师 1-5季' })]);
    expect(hits).toEqual([]);
  });

  it('一边只有分集标题、一边只有集号：按标题里的集号对上', () => {
    const hits = findCrossLineDuplicates(
      [input({ episodeNumber: null, episodeTitle: '第 5 集' })],
      [task({ episodeNumber: 5, episodeTitle: null })],
    );
    expect(hits).toHaveLength(1);
  });

  it('分集标题写法不同（EP05 / 第5集）也算同一集', () => {
    const hits = findCrossLineDuplicates(
      [input({ episodeNumber: null, episodeTitle: 'EP05' })],
      [task({ episodeNumber: null, episodeTitle: '第5集' })],
    );
    expect(hits).toHaveLength(1);
  });

  it('两边都拿不出分集信息（电影常见形态）：同作品即同内容', () => {
    const hits = findCrossLineDuplicates(
      [input({ title: '流浪地球', episodeNumber: null, episodeTitle: null })],
      [task({ title: '流浪地球', episodeNumber: null, episodeTitle: null })],
    );
    expect(hits).toHaveLength(1);
  });

  it('只有一边拿不出分集信息：不判——宁可漏报，也不拦下用户正在下的东西', () => {
    const hits = findCrossLineDuplicates(
      [input({ episodeNumber: 5, episodeTitle: '第 5 集' })],
      [task({ episodeNumber: null, episodeTitle: null })],
    );
    expect(hits).toEqual([]);
  });

  it('已取消的任务不算已有成品', () => {
    const hits = findCrossLineDuplicates([input()], [task({ status: 'canceled' })]);
    expect(hits).toEqual([]);
  });

  it('一批里逐集判定：只有命中的那几集报出来', () => {
    const planned = [
      input({ episodeId: 'B:m2~e4', episodeNumber: 4, episodeTitle: '第 4 集' }),
      input({ episodeId: 'B:m2~e5', episodeNumber: 5, episodeTitle: '第 5 集' }),
      input({ episodeId: 'B:m2~e6', episodeNumber: 6, episodeTitle: '第 6 集' }),
    ];
    const existing = [
      task({ id: 't4', episodeId: 'A:m1~e4', episodeNumber: 4, episodeTitle: '第 4 集' }),
      task({ id: 't6', episodeId: 'A:m1~e6', episodeNumber: 6, episodeTitle: '第 6 集' }),
    ];
    const hits = findCrossLineDuplicates(planned, existing);
    expect(hits.map((h) => h.planned.episodeNumber)).toEqual([4, 6]);
  });
});

describe('describeCrossLineDuplicates', () => {
  it('单集：点名到集、给出重复部分的体积', () => {
    const text = describeCrossLineDuplicates(findCrossLineDuplicates([input()], [task()]), GB);
    expect(text).toContain('「绝命毒师 第三季」的第 5 集');
    expect(text).toContain('约 1.0 GB');
    expect(text).toContain('换线路会再下一份');
  });

  it('多集：同作品合并成一条，超过两项收口成「等 N 项」', () => {
    const planned = [
      input({ episodeId: 'B:m2~e3', episodeNumber: 3, episodeTitle: '第 3 集' }),
      input({ episodeId: 'B:m2~e4', episodeNumber: 4, episodeTitle: '第 4 集' }),
      input({ episodeId: 'B:m2~e5', episodeNumber: 5, episodeTitle: '第 5 集' }),
    ];
    const existing = [
      task({ id: 't3', episodeId: 'A:m1~e3', episodeNumber: 3, episodeTitle: '第 3 集' }),
      task({ id: 't4', episodeId: 'A:m1~e4', episodeNumber: 4, episodeTitle: '第 4 集' }),
      task({ id: 't5', episodeId: 'A:m1~e5', episodeNumber: 5, episodeTitle: '第 5 集' }),
    ];
    const text = describeCrossLineDuplicates(findCrossLineDuplicates(planned, existing), GB);
    expect(text).toContain('第 3 集、第 4 集 等 3 项');
    expect(text).toContain('约 3.0 GB');
  });

  it('体积未知时不空口报数：文案不提「约」', () => {
    const text = describeCrossLineDuplicates(
      findCrossLineDuplicates([input()], [task({ totalBytes: null, downloadedBytes: 0 })]),
      GB,
    );
    expect(text).not.toContain('约');
    expect(text).toContain('第 5 集');
  });

  it('没有重复就不该产生文案', () => {
    expect(describeCrossLineDuplicates([], GB)).toBe('');
  });
});

/**
 * 闸门本身：详情页与播放页共用 `useDownloadGuards`，这里钉住「只披露、不拦截」的语义——
 * 没重复时连弹窗都不该出现（否则每次正常下载都要多点一下），有重复时取消必须让调用方中止下单。
 */
describe('useDownloadGuards.confirmCrossLineDuplicates', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无重复：不弹确认，直接放行', async () => {
    const ui = useUiStore();
    const confirm = vi.spyOn(ui, 'confirm');
    const guards = useDownloadGuards();

    await expect(guards.confirmCrossLineDuplicates([input()], [])).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('同线路的同集（mediaId 相同）：交给既有 skipped 分支，闸门不插手', async () => {
    const ui = useUiStore();
    const confirm = vi.spyOn(ui, 'confirm');
    const guards = useDownloadGuards();

    await expect(
      guards.confirmCrossLineDuplicates([input({ mediaId: 'A:m1', episodeId: 'A:m1~e5' })], [task()]),
    ).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('有重复：问一次，标题点明是「已下载过」，按钮是「仍要下载」而不是「确定」', async () => {
    const ui = useUiStore();
    const confirm = vi.spyOn(ui, 'confirm').mockResolvedValue(true);
    const guards = useDownloadGuards();

    await expect(guards.confirmCrossLineDuplicates([input()], [task()])).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    const options = confirm.mock.calls[0]![0];
    expect(options.title).toContain('已下载过');
    expect(options.message).toContain('第 5 集');
    expect(options.confirmText).toBe('仍要下载');
    expect(options.danger).not.toBe(true);
  });

  it('用户取消：返回 false，调用方据此不下单', async () => {
    const ui = useUiStore();
    vi.spyOn(ui, 'confirm').mockResolvedValue(false);
    const guards = useDownloadGuards();

    await expect(guards.confirmCrossLineDuplicates([input()], [task()])).resolves.toBe(false);
  });
});
