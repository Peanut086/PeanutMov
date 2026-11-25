import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  PLAYER_FAILOVER_MAX_LINES,
  PLAYER_FAILOVER_MAX_SOURCES,
  PLAYER_FAILOVER_WINDOW_MS,
} from '@/shared/constants';
import {
  __resetFailoverSession,
  activeFailoverRound,
  armFailoverNavigation,
  beginLoadAttempt,
  busyFailoverPlan,
  BUSY_WAIT_MAX_MS,
  cancelFailoverRound,
  currentFailoverRound,
  failoverAttemptKey,
  hasPendingFailoverNavigation,
  noteFailoverFailure,
  onFailoverTerminal,
  type FailoverAnchor,
} from '@/player/failoverSession';

/**
 * 换线 / 换源会话（P0-2）
 *
 * 真机现象：集号在 ep1/ep2 之间来回跳、线路一路自动切到全部失效。根因是预算记在
 * 被 `fullPath` key 重建的实例上，每次换线都归零。这里锁住修好之后的四条不变量：
 * 同目标不新开预算、整轮一个墙钟截止、额度按 `sourceId|lineId|episodeId` 去重、
 * 成功只认播放器真的推进。
 */
const anchor = (seasonNumber: number | null, episodeNumber: number | null): FailoverAnchor => ({
  seasonNumber,
  episodeNumber,
});

const keyOf = (line: string, episode: string): string => failoverAttemptKey('S1', line, episode);

function start(overrides: Partial<Parameters<typeof beginLoadAttempt>[0]> = {}) {
  return beginLoadAttempt({
    anchor: anchor(1, 3),
    trigger: 'resolveAndLoad',
    key: keyOf('L1', 'e3'),
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  __resetFailoverSession();
});

afterEach(() => {
  __resetFailoverSession();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('failoverAttemptKey', () => {
  it('按 sourceId|lineId|episodeId 组装，缺失段用 - 占位', () => {
    expect(failoverAttemptKey('S1', 'L2', 'e5')).toBe('S1|L2|e5');
    expect(failoverAttemptKey(null, undefined, 7)).toBe('-|-|7');
  });
});

describe('同目标的路由重建不新开预算', () => {
  it('连续 8 次进入起播流程仍是同一轮：deadline 不动、attemptId 递增', () => {
    const first = start();
    const deadline = first.deadlineAt;
    for (let i = 0; i < 7; i += 1) {
      const again = start({ key: keyOf(`L${(i % 3) + 1}`, 'e3') });
      expect(again).toBe(first);
      expect(again.deadlineAt).toBe(deadline);
    }
    expect(first.attemptId).toBe(8);
    // 旧口径在这里会重置 35 秒窗口并清零额度 —— 这就是"永远切不完"的成因
    expect(first.snapshot().linesTried).toBe(0);
    expect(first.remainingMs()).toBe(PLAYER_FAILOVER_WINDOW_MS);
  });

  it('换集（季/集不同）才算新意图：旧轮 superseded，新轮拿满预算', () => {
    const first = start();
    const terminals: string[] = [];
    onFailoverTerminal((round) => terminals.push(`${round.id}:${round.snapshot().terminalReason}`));

    const second = start({ anchor: anchor(1, 5), key: keyOf('L1', 'e5') });
    expect(second).not.toBe(first);
    expect(second.deadlineAt - second.startedAt).toBe(PLAYER_FAILOVER_WINDOW_MS);
    expect(first.isTerminal()).toBe(true);
    expect(terminals).toEqual([`1:superseded`]);
  });

  it('换季（季号冲突）同样开新一轮', () => {
    const first = start();
    const second = start({ anchor: anchor(2, 3) });
    expect(second).not.toBe(first);
  });

  it('用户明确重试（userIntent）即便目标相同也重开一轮', () => {
    const first = start();
    const second = start({ userIntent: true });
    expect(second).not.toBe(first);
    expect(first.snapshot().terminalReason).toBe('superseded');
  });
});

describe('额度与去重', () => {
  it('线路额度用满后 allowLine=false，且已试过的线路不再给额度', () => {
    const round = start();
    expect(round.allowLine('L2')).toBe(true);
    for (let i = 0; i < PLAYER_FAILOVER_MAX_LINES; i += 1) {
      round.chargeLineAttempt(keyOf(`L${i + 2}`, 'e3'));
    }
    expect(round.allowLine(`L${PLAYER_FAILOVER_MAX_LINES + 2}`)).toBe(false);
    // 已试集合里出现过的线路：即便额度还剩也判 false
    expect(round.hasTriedLine('L2')).toBe(true);
    const fresh = start({ anchor: anchor(1, 9), userIntent: true });
    fresh.chargeLineAttempt(keyOf('L2', 'e9'));
    expect(fresh.allowLine('L2')).toBe(false);
    expect(fresh.allowLine('L3')).toBe(true);
  });

  it('换源额度只给一次', () => {
    const round = start();
    expect(round.allowSource()).toBe(true);
    for (let i = 0; i < PLAYER_FAILOVER_MAX_SOURCES; i += 1) round.chargeSourceAttempt();
    expect(round.allowSource()).toBe(false);
  });

  it('推进之后额度释放、deadline 不变：播放中途真掉线仍会自动换线，但整轮仍被封顶', () => {
    const round = start();
    round.chargeLineAttempt(keyOf('L2', 'e3'));
    round.chargeSourceAttempt();
    vi.setSystemTime(10_000);
    round.markAdvanced();
    expect(round.allowLine('L2')).toBe(true);
    expect(round.allowSource()).toBe(true);
    expect(round.remainingMs()).toBe(PLAYER_FAILOVER_WINDOW_MS - 10_000);
    expect(round.hasAdvanced()).toBe(true);
  });
});

describe('失效地址刷新额度', () => {
  it('同一 attempt 只刷新一次，下一次加载才重新放行', () => {
    const round = start();
    expect(round.claimAddressRefresh()).toBe(true);
    expect(round.claimAddressRefresh()).toBe(false);
    start({ key: keyOf('L1', 'e3') });
    expect(round.attemptId).toBe(2);
    expect(round.claimAddressRefresh()).toBe(true);
  });

  it('到点或收口后不再放行刷新', () => {
    const round = start();
    round.finish('deadline');
    expect(round.claimAddressRefresh()).toBe(false);
  });
});

describe('截止时间与终态', () => {
  it('到点只有一个终态，且只通知一次；之后再进入同目标才开新一轮', () => {
    const first = start();
    const terminals: string[] = [];
    onFailoverTerminal((round, snapshot) => terminals.push(`${round.id}:${snapshot.terminalReason}`));

    vi.advanceTimersByTime(PLAYER_FAILOVER_WINDOW_MS);
    expect(first.snapshot().terminalReason).toBe('deadline');
    vi.advanceTimersByTime(PLAYER_FAILOVER_WINDOW_MS);
    expect(terminals).toEqual(['1:deadline']);
    expect(activeFailoverRound()).toBeNull();
    expect(currentFailoverRound()).toBe(first);

    // 迟到的引擎事件不能继续驱动状态机
    expect(noteFailoverFailure(first.attemptId)).toBe(false);

    const second = start();
    expect(second).not.toBe(first);
    expect(activeFailoverRound()).toBe(second);
  });

  it('同一 attemptId 的解析错误与引擎错误只算一次失败，新一轮尝试重新计', () => {
    const round = start();
    expect(noteFailoverFailure(round.attemptId)).toBe(true);
    expect(round.noteFailure(round.attemptId)).toBe(false); // 引擎错误紧随其后
    start({ key: keyOf('L2', 'e3') }); // 换线引起的挂载 = 本轮延续，attemptId 递增
    expect(round.attemptId).toBe(2);
    expect(round.noteFailure(round.attemptId)).toBe(true);
  });

  it('候选搜索与解析共用剩余时间：remainingMs 随墙钟递减，不会因重建回血', () => {
    const round = start();
    vi.setSystemTime(20_000);
    expect(round.remainingMs()).toBe(15_000);
    start({ key: keyOf('L3', 'e3') }); // 一次完整的路由重建
    expect(round.remainingMs()).toBe(15_000);
    vi.setSystemTime(36_000);
    expect(round.acceptsAttempts()).toBe(false);
  });

  it('到点之前被取消（例如引擎被外部停止）：cancelled 终态同样只生效一次', () => {
    const round = start();
    cancelFailoverRound('cancelled');
    expect(round.snapshot().terminalReason).toBe('cancelled');
    cancelFailoverRound('deadline'); // 二次收尾不再改写原因
    expect(round.snapshot().terminalReason).toBe('cancelled');
    expect(currentFailoverRound()?.isTerminal()).toBe(true);
  });
});

describe('换线引起的路由变化归属', () => {
  it('arm 之后卸载侧读到"属于本轮"，5 秒内没被取走则过期作废', () => {
    start();
    armFailoverNavigation();
    expect(hasPendingFailoverNavigation()).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(hasPendingFailoverNavigation()).toBe(false);
  });

  it('被同目标沿用（takeNavigation）后令牌即作废，不会长期白送免收预算的豁免', () => {
    start();
    armFailoverNavigation();
    start({ key: keyOf('L2', 'e3') }); // beginLoadAttempt 沿用本轮并取走令牌
    expect(hasPendingFailoverNavigation()).toBe(false);
  });

  it('本轮收口时令牌一起作废', () => {
    start();
    armFailoverNavigation();
    cancelFailoverRound('cancelled');
    expect(hasPendingFailoverNavigation()).toBe(false);
  });

  it('没有开启中的轮时 arm 是空操作', () => {
    expect(() => armFailoverNavigation()).not.toThrow();
    expect(hasPendingFailoverNavigation()).toBe(false);
  });
});

describe('订阅管理', () => {
  it('取消订阅后不再收到终态回调', () => {
    const seen: string[] = [];
    const off = onFailoverTerminal((_round, snapshot) => seen.push(String(snapshot.terminalReason)));
    const round = start();
    off();
    cancelFailoverRound('cancelled');
    expect(seen).toEqual([]);
    expect(round.isTerminal()).toBe(true);
  });
});

describe('忙态兜底口径（P1-③-7 busyFailoverPlan）', () => {
  it('非忙态错误码不进入忙态分支', () => {
    for (const code of ['E_PARSE', 'E_DECODE', 'E_NO_PLAY_URL', 'E_NETWORK']) {
      expect(busyFailoverPlan(code, 0)).toBe('not-busy');
      expect(busyFailoverPlan(code, 30_000)).toBe('not-busy');
      expect(busyFailoverPlan(code, null)).toBe('not-busy');
    }
  });

  it('冷却在等待上限内原地等闸门，超过它直接换源', () => {
    expect(busyFailoverPlan('E_SOURCE_BUSY', 0)).toBe('wait');
    expect(busyFailoverPlan('E_SOURCE_BUSY', BUSY_WAIT_MAX_MS)).toBe('wait');
    expect(busyFailoverPlan('E_SOURCE_BUSY', BUSY_WAIT_MAX_MS + 1)).toBe('switch-source');
    expect(busyFailoverPlan('E_SOURCE_BUSY', 30_000)).toBe('switch-source');
  });

  it('缺失或为负的剩余冷却按「立刻可试」处理，不因此跳过换线', () => {
    // 探测被这次点播放打断时 busyStateOf 回的是 0：没有占用就不许拦用户，也不该把换源当成唯一出路
    expect(busyFailoverPlan('E_SOURCE_BUSY', undefined)).toBe('wait');
    expect(busyFailoverPlan('E_SOURCE_BUSY', -5_000)).toBe('wait');
  });
});
