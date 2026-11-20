import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Router } from 'vue-router';

/**
 * P0-5：启动恢复不重放崩溃现场。
 *
 * 修之前有两处硬伤，合起来就是真机日志里那句"重开就在 ep1/ep2 之间跳、线路一路自动切到全废"：
 * 1. 会话快照由 `router.afterEach` 无条件写入，而自动换线 / 自动换源也是 `router.replace`——
 *    于是**兜底链的候选**（用户从没确认过、且很可能正是刚把进程打死的那一次）成了下次启动的目标；
 * 2. 恢复不看上次是怎么退出的：被系统清掉（华为 iAware force-stop / AK-LowMem SIGKILL，
 *    真机上占绝大多数）和进程自己崩了走得是同一条路，崩溃现场被当成"接着放"再跑一遍。
 *
 * 这里锁四件事：退出归因分档、恢复落点判定、候选导航不覆盖快照、恢复只发生一次且不改历史。
 */

const h = vi.hoisted(() => ({
  exits: [] as Array<Record<string, unknown>>,
  getRecentExits: vi.fn(),
}));

vi.mock('@/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/platform')>();
  return { ...actual, isNative: () => true };
});

vi.mock('@/shared/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/native/appLifecycle', () => ({
  onAppStateChange: vi.fn(() => () => undefined),
}));

vi.mock('@/native/spiderPlugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/native/spiderPlugin')>();
  // sourceBlockState 只用 `getRecentExits`；给一个干净对象，别继承 registerPlugin 的代理
  return { ...actual, Spider: { ...actual.Spider, getRecentExits: h.getRecentExits } };
});

import { historyRepo } from '@/db/repositories/historyRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { __resetFailoverSession, armFailoverNavigation, beginLoadAttempt } from '@/player/failoverSession';
import {
  __resetSessionRestore,
  bindSessionRestore,
  planRestore,
  type SessionSnapshot,
} from '@/services/sessionRestoreService';
import {
  __resetSourceBlockState,
  exitKindOf,
  isHighConfidenceBlockedSource,
  lastExitKind,
  noteSourceBlocked,
} from '@/services/sourceBlockState';
import { KV_KEY_LAST_SESSION } from '@/shared/constants';
import type { HistoryRecord } from '@/types';

import { readKv, resetAll, tick } from '../unit/helpers';

const MEDIA_ID = 'demo:movie-1~abc123';
const SOURCE_ID = 'demo';

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    name: 'player',
    params: { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L1:7` },
    query: { lineId: 'L1' },
    at: Date.now(),
    ...overrides,
  };
}

function historyRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  const now = Date.now();
  return {
    id: `${SOURCE_ID}:${MEDIA_ID}`,
    sourceId: SOURCE_ID,
    mediaId: MEDIA_ID,
    episodeId: `${MEDIA_ID}:L1:7`,
    episodeNumber: 7,
    title: '影片',
    posterUrl: null,
    positionSec: 120,
    durationSec: 1800,
    progress: 120 / 1800,
    finished: false,
    totalEpisodes: 12,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 只实现服务真正用到的成员，避免为一个守卫拉起整个 vue-router */
function makeStubRouter() {
  const beforeEachHooks: Array<(to: { name?: string }) => unknown> = [];
  const afterEachHooks: Array<(to: unknown) => void> = [];
  const stub = {
    beforeEachHooks,
    afterEachHooks,
    currentRoute: { value: { name: 'home', params: {}, query: {} } as unknown },
    beforeEach(fn: (to: { name?: string }) => unknown) {
      beforeEachHooks.push(fn);
    },
    afterEach(fn: (to: unknown) => void) {
      afterEachHooks.push(fn);
    },
  };
  return { stub, router: stub as unknown as Router };
}

function routeLike(name: string, params: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  return { name, params, query };
}

async function stored(): Promise<SessionSnapshot | null> {
  return readKv<SessionSnapshot>(KV_KEY_LAST_SESSION);
}

beforeEach(async () => {
  await resetAll();
  __resetSessionRestore();
  __resetSourceBlockState();
  __resetFailoverSession();
  h.exits.length = 0;
  h.getRecentExits.mockReset();
  h.getRecentExits.mockImplementation(async () => ({ items: h.exits }));
});

afterEach(() => {
  __resetFailoverSession();
  __resetSessionRestore();
});

describe('P0-5 上次退出归因分档', () => {
  it('四类退出读得开，且被杀与崩在信号上分得开', () => {
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'aei:REASON_EXIT_SELF' })).toBe('normal');
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'aei:REASON_LOW_MEMORY' })).toBe('system_reclaim');
    // 真机见过形态：iAware force-stop 落进 SIGNALED + SIGKILL
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'aei:REASON_SIGNALED', signal: 'SIGKILL' })).toBe('system_reclaim');
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'aei:REASON_CRASH_NATIVE', signal: 'SIGSEGV' })).toBe('native');
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'native:tombstone' })).toBe('native');
    // 11-20 那次真崩在 jar 里的 IncompatibleClassChangeError 走的是 java 档
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'java:java.lang.LinkageError' })).toBe('java');
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'aei:REASON_CRASH' })).toBe('java');
    // 系统没给原因也不猜：未知 = 不按崩溃处理
    expect(exitKindOf({ ts: 1, pid: 1, exitReason: 'aei:REASON_UNKNOWN' })).toBe('unknown');
    expect(exitKindOf({ ts: 1, pid: 1 })).toBe('unknown');
  });

  it('归因取时间戳最新的一条；没有证据时是 unknown', async () => {
    h.exits.push(
      { ts: 1000, pid: 1, exitReason: 'aei:REASON_CRASH_NATIVE' },
      { ts: 2000, pid: 2, exitReason: 'aei:REASON_LOW_MEMORY' },
    );
    expect(await lastExitKind()).toMatchObject({ kind: 'system_reclaim', evidence: { pid: 2 } });

    h.exits.length = 0;
    expect(await lastExitKind()).toMatchObject({ kind: 'unknown', evidence: null });
  });

  /** 归因读不到（旧 APK / 插件未实现）不能变成新的体验倒退 */
  it('退出现场读取失败时按 unknown 处理，不抛出', async () => {
    h.getRecentExits.mockRejectedValue(new Error('not implemented'));
    expect(await lastExitKind()).toMatchObject({ kind: 'unknown' });
  });

  it('高可信只认 jar 级隔离：短时冷却不算（那一档一半是误判）', () => {
    noteSourceBlocked('demo', 'cooldown');
    expect(isHighConfidenceBlockedSource('demo')).toBe(false);
    noteSourceBlocked('demo', 'quarantined');
    expect(isHighConfidenceBlockedSource('demo')).toBe(true);
    expect(isHighConfidenceBlockedSource(null)).toBe(false);
  });
});

describe('P0-5 恢复落点判定', () => {
  it('被系统回收：照常续播到播放器，目标集不变', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'aei:REASON_LOW_MEMORY', signal: 'SIGKILL' });
    const plan = await planRestore(snapshot());
    expect(plan).toMatchObject({
      name: 'player',
      restoreReason: 'system_reclaim_resume',
      matchedBy: 'episode-id',
      exitKind: 'system_reclaim',
      sourceSkipped: null,
      resumeEpisode: null,
    });
    // 目标集是快照里那条集 id，没有被候选替换
    expect(plan.params.episodeId).toBe(`${MEDIA_ID}:L1:7`);
  });

  /**
   * 快照里的集 id 已经过期（源换过选集列表）：落点判定不改指别的集——
   * "恢复的语义是回到那一集"，能不能播由播放页的披露态（P1-1）拦在起播之前。
   */
  it('过期集 ID：原样保留，不悄悄换成另一集', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'aei:REASON_LOW_MEMORY', signal: 'SIGKILL' });
    const stale = snapshot({ params: { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L1:99` } });
    const plan = await planRestore(stale);
    expect(plan).toMatchObject({ name: 'player', matchedBy: 'episode-id', sourceSkipped: null });
    expect(plan.params.episodeId).toBe(`${MEDIA_ID}:L1:99`);
  });

  it('正常退出不影响续播（不会因为没有崩溃记录就跳过源）', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'aei:REASON_EXIT_SELF' });
    noteSourceBlocked(SOURCE_ID, 'quarantined');
    const plan = await planRestore(snapshot());
    expect(plan).toMatchObject({ name: 'player', restoreReason: 'resume', exitKind: 'normal' });
  });

  /**
   * 崩溃 + 该片的源被 jar 级隔离：不进播放页（那正是要重放的现场），
   * 停在同片详情页并带上集号，等用户自己选线路。
   */
  it('崩溃关联到已隔离的源：改停详情页、跳过该源、集号仍来自历史', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'java:java.lang.IncompatibleClassChangeError' });
    noteSourceBlocked(SOURCE_ID, 'quarantined');
    await historyRepo.save(historyRecord());

    const plan = await planRestore(snapshot());

    expect(plan).toMatchObject({
      name: 'detail',
      restoreReason: 'crash_source_skipped',
      matchedBy: 'episode-number',
      exitKind: 'java',
      resumeEpisode: 7,
      sourceSkipped: SOURCE_ID,
    });
    expect(plan.params).toEqual({ mediaId: MEDIA_ID });
    expect(plan.query).toEqual({ ep: '7' });
  });

  /** 快照没带集号时按历史集号定位；两边都没有就只带片 id，等用户选 */
  it('崩溃隔离：路由没集号时按历史集号补齐，仍没有则只回详情页', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'native:tombstone', signal: 'SIGSEGV' });
    noteSourceBlocked(SOURCE_ID, 'quarantined');
    await historyRepo.save(historyRecord());
    const withHistory = await planRestore(snapshot({ params: { mediaId: MEDIA_ID } }));
    expect(withHistory).toMatchObject({ resumeEpisode: 7, matchedBy: 'episode-number' });

    await historyRepo.clear();
    const withoutHistory = await planRestore(snapshot({ params: { mediaId: MEDIA_ID } }));
    expect(withoutHistory).toMatchObject({ name: 'detail', resumeEpisode: null, matchedBy: 'media' });
  });

  /** 冷却档是弱归因（真机上一半是低内存杀进程的误判），不据此拦恢复 */
  it('崩溃但源只是短时冷却：照常续播，不跳过', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'java:java.lang.LinkageError' });
    noteSourceBlocked(SOURCE_ID, 'cooldown');
    await historyRepo.save(historyRecord());
    const plan = await planRestore(snapshot());
    expect(plan).toMatchObject({ name: 'player', restoreReason: 'resume', sourceSkipped: null });
  });

  /** 低内存重启即使源在隔离名单里也照常续播：被系统清掉不是这集的问题 */
  it('系统回收 + 源被隔离：仍照常续播（跳过只由崩溃触发）', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'aei:REASON_LOW_MEMORY' });
    noteSourceBlocked(SOURCE_ID, 'quarantined');
    await historyRepo.save(historyRecord());
    const plan = await planRestore(snapshot());
    expect(plan).toMatchObject({ name: 'player', restoreReason: 'system_reclaim_resume', sourceSkipped: null });
  });

  it('非播放页快照原样恢复（详情页/回看不做源归因）', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'java:java.lang.LinkageError' });
    noteSourceBlocked(SOURCE_ID, 'quarantined');

    const detail = await planRestore(snapshot({ name: 'detail', params: { mediaId: MEDIA_ID }, query: { ep: '3' } }));
    expect(detail).toMatchObject({ name: 'detail', matchedBy: 'ep-query', resumeEpisode: 3, sourceSkipped: null });

    const replay = await planRestore(
      snapshot({ name: 'replay', params: { sourceId: SOURCE_ID, programId: 'p1' }, query: {} }),
    );
    expect(replay).toMatchObject({ name: 'replay', matchedBy: 'route', sourceSkipped: null });
  });

  /** 拦恢复需要"崩溃 + 已隔离的源"两个条件同时成立，缺一个就照常续播 */
  it('崩溃但源未被隔离：路由里没集号也原样续播', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'java:java.lang.LinkageError' });
    const plan = await planRestore(snapshot({ params: { mediaId: MEDIA_ID }, query: {} }));
    expect(plan).toMatchObject({ name: 'player', matchedBy: 'route', sourceSkipped: null });
  });
});

describe('P0-5 候选导航不覆盖快照', () => {
  /** 起一轮兜底会话：自动换线在真实代码里就是先 arm 再 replace */
  function openRound(): ReturnType<typeof beginLoadAttempt> {
    return beginLoadAttempt({ anchor: { seasonNumber: 1, episodeNumber: 7 }, trigger: 'test' });
  }

  /** 候选在挂载时被 `beginLoadAttempt` 取走令牌，之后推进才属于"这轮真的播起来了" */
  it('自动换线的候选线路不写快照，推进之后才记为最后稳定线路', async () => {
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);

    // 用户确认的那一次（手动选集/选线）
    stub.afterEachHooks[0]!(routeLike('player', { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L1:7` }, { lineId: 'L1' }));
    await tick(10);
    expect((await stored())?.query.lineId).toBe('L1');

    const round = openRound();
    armFailoverNavigation(true);
    const candidate = routeLike('player', { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L2:7` }, { lineId: 'L2' });
    stub.afterEachHooks[0]!(candidate);
    await tick(10);
    // 候选没被写进去：崩溃后重开仍然回到 L1，而不是那一次把进程打死的 L2
    expect((await stored())?.query.lineId).toBe('L1');
    expect((await stored())?.params.episodeId).toBe(`${MEDIA_ID}:L1:7`);

    // 换线引起的重建：新实例挂载时取走令牌、沿用同一份预算
    const reused = beginLoadAttempt({ anchor: { seasonNumber: 1, episodeNumber: 7 }, trigger: 'remount' });
    expect(reused).toBe(round);

    // 播放器在候选上真的推进了 → 它成了"最后稳定线路"，此刻才补记
    stub.currentRoute.value = candidate;
    reused.markAdvanced();
    await tick(10);
    expect((await stored())?.query.lineId).toBe('L2');
  });

  it('用户手动换线照常覆盖快照（那是他确认过的目标）', async () => {
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);
    const round = openRound();
    armFailoverNavigation(); // auto=false
    stub.afterEachHooks[0]!(routeLike('player', { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L3:7` }, { lineId: 'L3' }));
    await tick(10);
    expect((await stored())?.query.lineId).toBe('L3');
    expect(round.isTerminal()).toBe(false);
  });

  it('切后台补写也挡住候选：进程停在候选导航上时不留现场', async () => {
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);
    stub.afterEachHooks[0]!(routeLike('player', { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L1:7` }, { lineId: 'L1' }));
    await tick(10);

    const round = openRound();
    armFailoverNavigation(true);
    stub.currentRoute.value = routeLike('player', { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L2:7` }, { lineId: 'L2' });
    round.finish('deadline'); // 本轮收口但候选没播起来
    await tick(10);
    expect((await stored())?.query.lineId).toBe('L1');
  });
});

describe('P0-5 接管一次性与历史不受影响', () => {
  async function countHistory(): Promise<number> {
    return historyRepo.count();
  }

  it('恢复只发生一次，第二帧不再改写落点', async () => {
    await seedSnapshot(
      snapshot({ params: { mediaId: MEDIA_ID, episodeId: `${MEDIA_ID}:L1:7` }, query: { lineId: 'L1' } }),
    );
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);

    const first = stub.beforeEachHooks[0]!(routeLike('home'));
    expect(first).toMatchObject({ name: 'player', replace: true });
    const second = stub.beforeEachHooks[0]!(routeLike('home'));
    expect(second).toBe(true);
  });

  /**
   * 真机上最常见的"反复退出"是秒级二次启动。快照是一次性消费的（读到即删），
   * 所以第二次冷启动不会再落回播放页——同一份崩溃现场只可能被重放一次。
   */
  it('短时间重复退出：第二次冷启动不再恢复', async () => {
    h.exits.push({ ts: 1, pid: 1, exitReason: 'native:tombstone', signal: 'SIGSEGV' });
    await seedSnapshot(snapshot());

    const firstStart = makeStubRouter();
    await bindSessionRestore(firstStart.router);
    expect(firstStart.stub.beforeEachHooks[0]!(routeLike('home'))).toMatchObject({ name: 'player' });

    const secondStart = makeStubRouter();
    await bindSessionRestore(secondStart.router);
    expect(secondStart.stub.beforeEachHooks[0]!(routeLike('home'))).toBe(true);
    expect(await stored()).toBeNull();
  });

  /** 深链/提醒跳转有明确目标，恢复不动它，也不消费第二次启动的机会 */
  it('首帧不是首页时不动它（深链优先）', async () => {
    await seedSnapshot(snapshot());
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);
    expect(stub.beforeEachHooks[0]!(routeLike('detail'))).toBe(true);
  });

  /** 恢复只改路由：不把历史里的那条记录挪到别的集上（P1-1 披露态负责拦错集起播） */
  it('恢复一次都不写历史，也不改动既有那条记录', async () => {
    await historyRepo.save(historyRecord());
    await seedSnapshot(snapshot());
    const before = await countHistory();
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);
    stub.beforeEachHooks[0]!(routeLike('home'));
    await tick(10);

    expect(await countHistory()).toBe(before);
    const row = await historyRepo.getByMedia(MEDIA_ID);
    expect(row?.episodeId).toBe(`${MEDIA_ID}:L1:7`);
    expect(row?.episodeNumber).toBe(7);
  });
});

/** 直接落一条快照到 KV（模拟上次会话留下的现场） */
async function seedSnapshot(next: SessionSnapshot): Promise<void> {
  await kvRepo.set(KV_KEY_LAST_SESSION, next);
}
