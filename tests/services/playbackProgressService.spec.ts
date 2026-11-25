import { beforeEach, describe, expect, it } from 'vitest';

import { learnPair, lookupAliases } from '@/services/aliasService';
import { findCrossSourceProgress, findLatestCrossSourceProgress, resolveLatestPlaybackProgress, resolvePlaybackProgress } from '@/services/playbackProgressService';
import { settingsService } from '@/services/settingsService';
import { historyIdOf } from '@/shared/id';
import type { HistoryRecord } from '@/types';

import { resetAll } from '../unit/helpers';

function target(overrides: Partial<Parameters<typeof findCrossSourceProgress>[0]> = {}) {
  return {
    sourceId: 'src-a',
    mediaId: 'A:m1',
    title: '绝命毒师 第三季',
    year: 2008,
    episodeNumber: 5,
    ...overrides,
  };
}

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  const sourceId = overrides.sourceId ?? 'src-b';
  const mediaId = overrides.mediaId ?? 'B:m1';
  return {
    id: historyIdOf(sourceId, mediaId),
    sourceId,
    mediaId,
    episodeId: `${mediaId}:e5`,
    episodeNumber: 5,
    title: '绝命毒师 S03',
    posterUrl: null,
    positionSec: 120,
    durationSec: 600,
    progress: 0.2,
    finished: false,
    totalEpisodes: 7,
    createdAt: 1_000,
    updatedAt: 2_000,
    mediaSnapshot: {
      sourceItemId: mediaId,
      type: 'series',
      year: 2008,
      episodeCount: 7,
      originalTitle: null,
    },
    ...overrides,
  };
}

describe('跨源续播解析', () => {
  it('详情页跨源取最近观看集号，供目标源映射续播入口', () => {
    const older = record({ sourceId: 'src-b', mediaId: 'B:old', episodeNumber: 2, episodeId: 'B:old:e2', updatedAt: 2_000 });
    const newer = record({ sourceId: 'src-c', mediaId: 'C:new', episodeNumber: 5, episodeId: 'C:new:e5', updatedAt: 3_000 });

    expect(findLatestCrossSourceProgress(target({ episodeNumber: null }), [older, newer])).toEqual({
      record: newer,
      episodeNumber: 5,
    });
  });

  it('详情页解析同样保持当前源精确记录优先', async () => {
    const exact = record({ sourceId: 'src-a', mediaId: 'A:m1', episodeNumber: 2, updatedAt: 1_000 });
    const cross = record({ episodeNumber: 5, updatedAt: 9_000 });

    await expect(resolveLatestPlaybackProgress(target({ episodeNumber: null }), [cross, exact])).resolves.toEqual({
      record: exact,
      episodeNumber: 2,
    });
  });

  it('当前源无精确记录时，返回其他源同作品同季同集的来源记录与集号', () => {
    const candidate = record();

    expect(findCrossSourceProgress(target(), [candidate])).toEqual({
      record: candidate,
      episodeNumber: 5,
    });
  });

  it('当前源精确记录优先于更新的跨源候选', async () => {
    const exact = record({ sourceId: 'src-a', mediaId: 'A:m1', updatedAt: 1_000 });
    const cross = record({ updatedAt: 9_000 });

    await expect(resolvePlaybackProgress(target(), [cross, exact])).resolves.toEqual({
      record: exact,
      episodeNumber: 5,
    });
  });

  it('当前源精确记录即使缺少集号也优先返回', async () => {
    const exact = record({ sourceId: 'src-a', mediaId: 'A:m1', episodeNumber: null });
    const cross = record({ updatedAt: 9_000 });

    await expect(resolvePlaybackProgress(target(), [cross, exact])).resolves.toEqual({
      record: exact,
      episodeNumber: null,
    });
  });

  it('当前源的其他媒体记录不作为跨源候选', () => {
    const sameSource = record({ sourceId: 'src-a', mediaId: 'A:other' });

    expect(findCrossSourceProgress(target(), [sameSource])).toBeNull();
  });

  it('多个同强候选只在最近更新者唯一时返回', () => {
    const older = record({ sourceId: 'src-b', mediaId: 'B:old', updatedAt: 2_000 });
    const newer = record({ sourceId: 'src-c', mediaId: 'C:new', updatedAt: 3_000 });

    expect(findCrossSourceProgress(target(), [older, newer])?.record).toBe(newer);
  });

  it('最近更新者并列时不猜候选', () => {
    const left = record({ sourceId: 'src-b', mediaId: 'B:left', updatedAt: 3_000 });
    const right = record({ sourceId: 'src-c', mediaId: 'C:right', updatedAt: 3_000 });

    expect(findCrossSourceProgress(target(), [left, right])).toBeNull();
  });

  it('双方年份明确冲突时不匹配', () => {
    const candidate = record({
      mediaSnapshot: { sourceItemId: 'B:m1', type: 'series', year: 2010, episodeCount: 7, originalTitle: null },
    });

    expect(findCrossSourceProgress(target(), [candidate])).toBeNull();
  });

  it('一侧年份缺失时不按年份冲突拒绝', () => {
    const candidate = record({
      mediaSnapshot: { sourceItemId: 'B:m1', type: 'series', year: null, episodeCount: 7, originalTitle: null },
    });

    expect(findCrossSourceProgress(target(), [candidate])?.record).toBe(candidate);
    expect(findCrossSourceProgress(target({ year: null }), [record()])?.record).toBeDefined();
  });

  it('季号不同或一侧缺少季号时不匹配', () => {
    const otherSeason = record({ title: '绝命毒师 第四季' });
    const noSeason = record({ sourceId: 'src-c', mediaId: 'C:m1', title: '绝命毒师' });

    expect(findCrossSourceProgress(target(), [otherSeason, noSeason])).toBeNull();
  });

  it('跨季打包条目不参与匹配', () => {
    const candidate = record({ title: '绝命毒师 1-5季' });

    expect(findCrossSourceProgress(target(), [candidate])).toBeNull();
    expect(findCrossSourceProgress(target({ title: '绝命毒师 1-5季' }), [record()])).toBeNull();
  });

  it('只做归一化精确匹配，不用开放式模糊匹配', () => {
    const candidate = record({ title: '绝命毒师外传 第三季' });

    expect(findCrossSourceProgress(target(), [candidate])).toBeNull();
  });

  it('来源历史没有有效集号时不串', () => {
    expect(findCrossSourceProgress(target(), [record({ episodeNumber: null })])).toBeNull();
    expect(findCrossSourceProgress(target(), [record({ episodeNumber: 0 })])).toBeNull();
  });

  it('目标集号缺失且无法从分集标题解析时不串', () => {
    const candidate = record();

    expect(
      findCrossSourceProgress(target({ episodeNumber: null, episodeTitle: null }), [candidate]),
    ).toBeNull();
    expect(
      findCrossSourceProgress(target({ episodeNumber: null, episodeTitle: '出发' }), [candidate]),
    ).toBeNull();
  });

  it('目标集号明确时只匹配相同集号', () => {
    const candidate = record();

    expect(findCrossSourceProgress(target({ episodeNumber: 6 }), [candidate])).toBeNull();
    expect(findCrossSourceProgress(target({ episodeNumber: 5 }), [candidate])?.record).toBe(candidate);
  });

  it('同集号但双方分集标题明确冲突时不匹配', () => {
    const candidate = { ...record(), episodeTitle: 'EP05 重逢' };

    expect(
      findCrossSourceProgress(target({ episodeNumber: 5, episodeTitle: '第5集 出发' }), [candidate]),
    ).toBeNull();
  });

  it('同集号的等价分集标题写法不误判冲突', () => {
    const candidate = { ...record(), episodeTitle: 'EP05：重逢' };

    expect(
      findCrossSourceProgress(target({ episodeNumber: 5, episodeTitle: '第5集 重逢' }), [candidate])?.record,
    ).toBe(candidate);
  });

  it('目标集号缺失但分集标题含集号时仍按集号约束', () => {
    const candidate = record();

    expect(
      findCrossSourceProgress(target({ episodeNumber: null, episodeTitle: '第6集 出发' }), [candidate]),
    ).toBeNull();
  });

  it('已学习别名可桥接不同根标题，但不替代季号校验', () => {
    const candidate = record();
    const aliasedTarget = target({ title: 'Breaking Bad S03' });

    expect(findCrossSourceProgress(aliasedTarget, [candidate])).toBeNull();
    expect(findCrossSourceProgress(aliasedTarget, [candidate], ['绝命毒师'])?.record).toBe(candidate);
    expect(findCrossSourceProgress(aliasedTarget, [record({ title: '绝命毒师 第四季' })], ['绝命毒师'])).toBeNull();
  });

  it('归一化直接命中强于别名命中，最近更新不跨强度翻盘', () => {
    const direct = record({ sourceId: 'src-b', mediaId: 'B:direct', updatedAt: 2_000 });
    const aliased = record({
      sourceId: 'src-c',
      mediaId: 'C:alias',
      title: 'Breaking Bad S03',
      updatedAt: 9_000,
    });

    expect(findCrossSourceProgress(target(), [aliased, direct], ['Breaking Bad'])?.record).toBe(direct);
  });
});

describe('跨源续播别名读取', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('直接候选并列时不退回较弱的别名候选', async () => {
    await resetAll();
    expect(await learnPair('绝命毒师 剧集 S03', '绝命毒师 第三季')).toBe(true);
    const left = record({ sourceId: 'src-b', mediaId: 'B:left', updatedAt: 3_000 });
    const right = record({ sourceId: 'src-c', mediaId: 'C:right', updatedAt: 3_000 });
    const aliased = record({
      sourceId: 'src-d',
      mediaId: 'D:alias',
      title: '绝命毒师 剧集 S03',
      updatedAt: 9_000,
    });

    await expect(resolvePlaybackProgress(target(), [left, right, aliased])).resolves.toBeNull();
    await expect(resolveLatestPlaybackProgress(target({ episodeNumber: null }), [left, right, aliased])).resolves.toBeNull();
  });

  it('隐私未开启时自动读取已学习别名', async () => {
    expect(await learnPair('绝命毒师 剧集 S03', '绝命毒师 第三季')).toBe(true);
    expect(await lookupAliases('绝命毒师 剧集 S03')).toContain('绝命毒师 第三季');
    const candidate = record();

    await expect(resolvePlaybackProgress(target({ title: '绝命毒师 剧集 S03' }), [candidate])).resolves.toEqual({
      record: candidate,
      episodeNumber: 5,
    });
  });

  it('隐私开启时不使用已学习别名', async () => {
    expect(await learnPair('绝命毒师 剧集 S03', '绝命毒师 第三季')).toBe(true);
    await settingsService.update({ pauseHistoryRecording: true });

    expect(await lookupAliases('绝命毒师 剧集 S03')).toEqual([]);
    await expect(
      resolvePlaybackProgress(target({ title: '绝命毒师 剧集 S03' }), [record()]),
    ).resolves.toBeNull();
  });
});
