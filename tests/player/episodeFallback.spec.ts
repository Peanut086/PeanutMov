import { describe, expect, it } from 'vitest';

import { offlineEpisodeMessage, resolveTargetEpisode } from '@/player/episodeFallback';

/**
 * 历史集号超出源范围（AC-68 / REV-26 / BUG-18）
 *
 * 场景：历史记录「看到第 30 集」，但当前源只有 20 集。
 * 断言走「已下线」分支（`offlineNumber = 30` + 回退第 1 集），而不是静默回退。
 */
interface Ep {
  id: string;
  number: number;
}

function makeEpisodes(count: number, line = 'L1'): Ep[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${line}:ep-${i + 1}`, number: i + 1 }));
}

const EPISODES_20 = makeEpisodes(20);

describe('resolveTargetEpisode：已下线判定（AC-68）', () => {
  it('记录第 30 集但源只有 20 集 → offlineNumber=30，回退第 1 集', () => {
    const result = resolveTargetEpisode({
      recordedEpisodeId: 'L1:ep-30',
      recordedNumber: 30,
      episodes: EPISODES_20,
    });

    expect(result.offlineNumber).toBe(30);
    expect(result.episode?.number).toBe(1);
    expect(result.episode?.id).toBe('L1:ep-1');
  });

  it('记录第 30 集、id 也已失效但集号仍存在（源扩展到 40 集）→ 按集号命中，不提示下线', () => {
    const result = resolveTargetEpisode({
      recordedEpisodeId: 'old-line:ep-30',
      recordedNumber: 30,
      episodes: makeEpisodes(40),
    });

    expect(result.offlineNumber).toBeNull();
    expect(result.episode?.number).toBe(30);
  });

  it('id 命中（同集仍在）→ 不提示下线', () => {
    const result = resolveTargetEpisode({
      recordedEpisodeId: 'L1:ep-5',
      recordedNumber: 5,
      episodes: EPISODES_20,
    });

    expect(result.offlineNumber).toBeNull();
    expect(result.episode?.number).toBe(5);
  });

  it('集号恰为最大集（第 20 集）→ 命中，不误判下线', () => {
    const result = resolveTargetEpisode({
      recordedEpisodeId: 'L1:ep-20',
      recordedNumber: 20,
      episodes: EPISODES_20,
    });

    expect(result.offlineNumber).toBeNull();
    expect(result.episode?.number).toBe(20);
  });

  it('无历史记录（集号 null）→ 首集且不提示下线', () => {
    const result = resolveTargetEpisode({
      recordedEpisodeId: null,
      recordedNumber: null,
      episodes: EPISODES_20,
    });

    expect(result.offlineNumber).toBeNull();
    expect(result.episode?.number).toBe(1);
  });

  it('源为空（0 集）→ episode 为 null，不产生下线提示', () => {
    const result = resolveTargetEpisode({
      recordedEpisodeId: 'L1:ep-30',
      recordedNumber: 30,
      episodes: [],
    });

    expect(result.episode).toBeNull();
    expect(result.offlineNumber).toBeNull();
  });

  it('episodes 乱序时仍按集号正确定位与判定', () => {
    const shuffled = [...EPISODES_20].reverse();
    const hit = resolveTargetEpisode({
      recordedEpisodeId: null,
      recordedNumber: 3,
      episodes: shuffled,
    });
    expect(hit.episode?.number).toBe(3);
    expect(hit.offlineNumber).toBeNull();

    const offline = resolveTargetEpisode({
      recordedEpisodeId: null,
      recordedNumber: 30,
      episodes: shuffled,
    });
    expect(offline.episode?.number).toBe(1);
    expect(offline.offlineNumber).toBe(30);
  });
});

describe('offlineEpisodeMessage（AC-68 文案）', () => {
  it('按 AC 措辞输出「看到第 N 集（已下线），已从第 1 集开始」', () => {
    expect(offlineEpisodeMessage(30)).toBe('看到第 30 集（已下线），已从第 1 集开始');
  });
});
