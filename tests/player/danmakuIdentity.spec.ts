import { describe, expect, it } from 'vitest';

import {
  isSameDanmakuIdentity,
  resolveDanmakuIdentity,
} from '@/player/danmakuIdentity';

describe('本地播放弹幕身份', () => {
  it('详情未加载时使用下载任务标题、集号与历史快照年份', () => {
    expect(resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: 2,
      localTaskTitle: '士兵突击',
      historyTitle: '士兵突击',
      historyYear: 2006,
    })).toEqual({
      episodeId: 'demo:e2',
      episodeNumber: 2,
      title: '士兵突击',
      year: 2006,
      matchKey: '士兵突击|2006|2',
    });
  });

  it('详情明确没有年份时不用旧历史年份覆盖', () => {
    const identity = resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: 2,
      localTaskTitle: '同名剧',
      detailYear: null,
      historyYear: 2006,
      favoriteYear: 2013,
    });

    expect(identity?.year).toBeNull();
    expect(identity?.matchKey).toBe('同名剧|na|2');
  });

  it('没有历史年份时可从收藏恢复年份', () => {
    const identity = resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: 2,
      localTaskTitle: '士兵突击',
      favoriteYear: 2006,
    });

    expect(identity?.year).toBe(2006);
  });

  it('年份未知不阻断本地弹幕身份', () => {
    const identity = resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: 2,
      localTaskTitle: '士兵突击',
    });

    expect(identity?.year).toBeNull();
    expect(identity?.episodeNumber).toBe(2);
  });

  it('缺少真实集号或标题时不生成可请求身份', () => {
    expect(resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: null,
      localTaskTitle: '士兵突击',
    })).toBeNull();
    expect(resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: 2,
    })).toBeNull();
  });

  it('同集号跨线路的迟到结果不能覆盖当前集', () => {
    const current = resolveDanmakuIdentity({
      episodeId: 'demo:e2:line-b',
      episodeNumber: 2,
      localTaskTitle: '士兵突击',
      historyYear: 2006,
    });
    const stale = resolveDanmakuIdentity({
      episodeId: 'demo:e2:line-a',
      episodeNumber: 2,
      localTaskTitle: '士兵突击',
      historyYear: 2006,
    });

    expect(current).not.toBeNull();
    expect(stale).not.toBeNull();
    if (!current || !stale) throw new Error('身份构造失败');
    expect(isSameDanmakuIdentity(current, stale)).toBe(false);
    expect(isSameDanmakuIdentity(current, current)).toBe(true);
  });

  it('详情补出年份后旧请求失效，避免沿用未知年份的结局', () => {
    const before = resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: 2,
      localTaskTitle: '士兵突击',
    });
    const after = resolveDanmakuIdentity({
      episodeId: 'demo:e2',
      episodeNumber: 2,
      localTaskTitle: '士兵突击',
      historyYear: 2006,
    });

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    if (!before || !after) throw new Error('身份构造失败');
    expect(isSameDanmakuIdentity(before, after)).toBe(false);
  });
});
