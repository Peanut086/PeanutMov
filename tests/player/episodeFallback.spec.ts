import { describe, expect, it } from 'vitest';

import {
  findEpisodeOwnerLineId,
  offlineEpisodeMessage,
  resolvePlaybackEpisode,
  resolvePlaybackLineId,
  resolveTargetEpisode,
} from '@/player/episodeFallback';

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

/**
 * 下载第 2 集却播成第 1 集（11-14 #2）
 *
 * 现场：下载列表点已完成的第 2 集 → 路由只带 `episodeId`，不带线路 →
 * 线路落到首条 → 该 id 不在这条线路的选集里 → 回退第 1 集。
 * 断言线路由「这一集真正属于哪条」决定，且拿不到归属时交出 null 让调用方兜底。
 */
describe('findEpisodeOwnerLineId：按集 id 反查所属线路', () => {
  const lines = ['L1', 'L2'];
  const episodes = [
    { id: 'L1:e1', lineId: 'L1' },
    { id: 'L1:e2', lineId: 'L1' },
    { id: 'L2:e1', lineId: 'L2' },
    { id: 'L2:e2', lineId: 'L2' },
  ];

  it('目标集只属于次条线路 → 返回次条线路，而不是首条', () => {
    expect(findEpisodeOwnerLineId(episodes, lines, 'L2:e2')).toBe('L2');
  });

  it('目标集在首条线路 → 返回首条（不因顺序偏好出错）', () => {
    expect(findEpisodeOwnerLineId(episodes, lines, 'L1:e2')).toBe('L1');
  });

  it('详情尚未加载（空列表）→ null，交回调用方按路由/首条兜底', () => {
    expect(findEpisodeOwnerLineId([], lines, 'L2:e2')).toBeNull();
  });

  it('该集所属线路不在可选线路列表内 → null（不能选一条已消失的线路）', () => {
    expect(findEpisodeOwnerLineId(episodes, ['L1'], 'L2:e2')).toBeNull();
  });

  it('无 episodeId（未指定目标集）→ null', () => {
    expect(findEpisodeOwnerLineId(episodes, lines, null)).toBeNull();
  });
});

describe('resolvePlaybackLineId：历史线路恢复与失效回退', () => {
  const episodes = [
    { id: 'L1:e1', lineId: 'L1' },
    { id: 'L2:e2', lineId: 'L2' },
  ];
  const base = {
    explicitLineId: null,
    episodes,
    lineIds: ['L1', 'L2'],
    episodeId: null,
    requestedLineId: null,
    anchorLineId: null,
  };

  it('历史记录带有效线路时显式恢复该线路', () => {
    expect(resolvePlaybackLineId({ ...base, requestedLineId: 'L2' })).toBe('L2');
  });

  it('目标集所属线路优先于历史线路，避免续播落到另一条线', () => {
    expect(resolvePlaybackLineId({
      ...base,
      episodeId: 'L2:e2',
      requestedLineId: 'L1',
    })).toBe('L2');
  });

  it('旧记录没有线路时仍按目标集归属恢复', () => {
    expect(resolvePlaybackLineId({ ...base, episodeId: 'L2:e2' })).toBe('L2');
  });

  it('历史线路已消失时回退有效黑匣子锚点', () => {
    expect(resolvePlaybackLineId({
      ...base,
      requestedLineId: 'gone',
      anchorLineId: 'L2',
    })).toBe('L2');
  });

  it('历史线路与锚点都失效时回退首条可用线路', () => {
    expect(resolvePlaybackLineId({
      ...base,
      requestedLineId: 'gone',
      anchorLineId: 'gone-too',
    })).toBe('L1');
  });

  it('用户显式切换的线路保持最高优先级', () => {
    expect(resolvePlaybackLineId({
      ...base,
      explicitLineId: 'L1',
      episodeId: 'L2:e2',
      requestedLineId: 'L2',
    })).toBe('L1');
  });
});

/**
 * 播放页目标集定位（P1-1：消除"静默播成第 1 集"）
 *
 * 真机日志里 4 次「路由集号在当前线路无匹配，回退首集」——用户看到的是目标集，
 * 实际播放、进度写回、弹幕匹配、下载入口全记在第 1 集上。现在这类情况必须
 * 显式落到 `missing: true`，由页面披露，不再自动起播。
 */
describe('resolvePlaybackEpisode：定位失败要披露，不要冒充首集', () => {
  const line1 = [
    { id: 'L1:e1', number: 1 },
    { id: 'L1:e2', number: 2 },
    { id: 'L1:e3', number: 3 },
  ];
  const line2 = [
    { id: 'L2:e1', number: 1 },
    { id: 'L2:e2', number: 2 },
    { id: 'L2:e3', number: 3 },
  ];
  const all = [...line1, ...line2];

  it('路由 id 在当前线路 → 精确命中', () => {
    const r = resolvePlaybackEpisode({ lineEpisodes: line1, allEpisodes: all, routeEpisodeId: 'L1:e2' });
    expect(r).toMatchObject({ episode: { id: 'L1:e2' }, missing: false, matchedBy: 'line-id' });
  });

  it('路由 id 属于另一条线路 → 按同号集命中，不落到首集', () => {
    const r = resolvePlaybackEpisode({
      lineEpisodes: line1,
      allEpisodes: all,
      routeEpisodeId: 'L2:e3',
      offlineNumber: 3, // 另一条线路的 id 会被 AC-68 误判为"已下线"，这里验证集号口径优先
    });
    expect(r).toMatchObject({ episode: { id: 'L1:e3', number: 3 }, missing: false, matchedBy: 'cross-line-number' });
  });

  it('目标 id 陈旧、任何集号口径都落空 → missing=true，不返回首集', () => {
    const r = resolvePlaybackEpisode({ lineEpisodes: line1, allEpisodes: all, routeEpisodeId: 'gone:e9' });
    expect(r.episode).toBeNull();
    expect(r.missing).toBe(true);
    expect(r.matchedBy).toBe('none');
  });

  it('陈旧 id 但 AC-68 判定整集已下线（offlineNumber 非空）→ 保持回退首集 + 已披露', () => {
    const r = resolvePlaybackEpisode({
      lineEpisodes: line1,
      allEpisodes: all,
      routeEpisodeId: 'gone:e30',
      offlineNumber: 30,
    });
    expect(r).toMatchObject({ episode: { id: 'L1:e1' }, missing: false, matchedBy: 'offline-first' });
  });

  it('集号锚优先级：id 精确命中 > 深链 ?ep= > 历史集号 > 黑匣子 > 跨线路同号', () => {
    const byId = resolvePlaybackEpisode({
      lineEpisodes: line1,
      allEpisodes: all,
      routeEpisodeId: 'L1:e3',
      deepLinkNumber: 1,
    });
    // id 精确命中永远优先于集号
    expect(byId).toMatchObject({ episode: { id: 'L1:e3' }, matchedBy: 'line-id' });

    const byDeepLink = resolvePlaybackEpisode({
      lineEpisodes: line1,
      allEpisodes: all,
      routeEpisodeId: 'gone:e9',
      historyNumber: 2,
      anchorNumber: 3,
      deepLinkNumber: 3,
    });
    expect(byDeepLink).toMatchObject({ episode: { id: 'L1:e3' }, matchedBy: 'deep-link' });

    const byAnchor = resolvePlaybackEpisode({
      lineEpisodes: line1,
      allEpisodes: all,
      routeEpisodeId: 'gone:e9',
      anchorNumber: 2,
    });
    expect(byAnchor).toMatchObject({ episode: { id: 'L1:e2' }, matchedBy: 'anchor' });
  });

  it('无路由 id（口令/黑匣子直达）→ 按集号锚，落空则首集且不算 missing', () => {
    const byAnchor = resolvePlaybackEpisode({
      lineEpisodes: line1,
      allEpisodes: all,
      routeEpisodeId: null,
      anchorNumber: 2,
    });
    expect(byAnchor).toMatchObject({ episode: { id: 'L1:e2' }, missing: false, matchedBy: 'anchor' });

    const byDeepLink = resolvePlaybackEpisode({
      lineEpisodes: line1,
      allEpisodes: all,
      routeEpisodeId: null,
      deepLinkNumber: 99,
    });
    expect(byDeepLink).toMatchObject({ episode: { id: 'L1:e1' }, missing: false, matchedBy: 'first' });
  });

  it('当前线路 0 集 → episode=null 且 missing=false（交给"找不到要播放的内容"分支）', () => {
    const r = resolvePlaybackEpisode({ lineEpisodes: [], allEpisodes: all, routeEpisodeId: 'L1:e1' });
    expect(r).toMatchObject({ episode: null, missing: false, matchedBy: 'none' });
  });
});
