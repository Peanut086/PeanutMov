/**
 * 冷启动会话恢复单测（G3）
 *
 * 覆盖：快照构造（可恢复页面白名单 / 必填参数 / restart 丢弃 / 数组值归一）、
 * 存储读回的归一化与 TTL、bind 后的写库与一次性接管、隐私开关下的不落盘。
 */
import type { Router } from 'vue-router';
import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import {
  __resetSessionRestore,
  bindSessionRestore,
  clearSessionSnapshot,
  normalizeSessionSnapshot,
  sessionSnapshotOf,
  takeSessionSnapshot,
  type SessionSnapshot,
} from '@/services/sessionRestoreService';
import { settingsService } from '@/services/settingsService';
import { KV_KEY_LAST_SESSION } from '@/shared/constants';

import { readKv, resetAll, tick } from '../unit/helpers';

function routeLike(name: string, params: Record<string, unknown> = {}, query: Record<string, unknown> = {}) {
  return { name, params, query };
}

/** 只实现服务真正用到的三个成员，避免为一个守卫拉起整个 vue-router */
function makeStubRouter() {
  const beforeEachHooks: Array<(to: { name?: string }) => unknown> = [];
  const afterEachHooks: Array<(to: unknown) => void> = [];
  const stub = {
    beforeEachHooks,
    afterEachHooks,
    currentRoute: { value: routeLike('home') as unknown },
    beforeEach(fn: (to: { name?: string }) => unknown) {
      beforeEachHooks.push(fn);
    },
    afterEach(fn: (to: unknown) => void) {
      afterEachHooks.push(fn);
    },
  };
  return { stub, router: stub as unknown as Router };
}

async function flushWrites(): Promise<void> {
  await tick(10);
}

/** 触发 Web 端前后台切换（appLifecycle 的 visibilitychange 兜底） */
function emitVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('sessionSnapshotOf', () => {
  it('播放页保留 params 与除 restart/t 之外的 query', () => {
    const snapshot = sessionSnapshotOf(
      routeLike(
        'player',
        { mediaId: 'm1', episodeId: 'e2' },
        { lineId: 'L1', restart: '1', local: '1', ep: '7', t: '120' },
      ),
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot!.name).toBe('player');
    expect(snapshot!.params).toEqual({ mediaId: 'm1', episodeId: 'e2' });
    // restart 被丢弃：恢复的语义是"接着放"，留着它每次都从头播
    // t 同样丢弃：口令/深链定位点是"那一次"的进度，跨会话应听黑匣子与历史
    // ep 保留：目标集号仍可恢复（找不到时由 episodeFallback 兜底）
    expect(snapshot!.query).toEqual({ lineId: 'L1', local: '1', ep: '7' });
    expect(snapshot!.at).toBeGreaterThan(0);
  });

  it('数组值取首个，空值与 null 直接丢掉', () => {
    const snapshot = sessionSnapshotOf(
      routeLike('detail', { mediaId: ['m9', 'm8'], blank: '' }, { sourceId: ['s1'], empty: null, ep: '3' }),
    );
    expect(snapshot!.params).toEqual({ mediaId: 'm9' });
    expect(snapshot!.query).toEqual({ sourceId: 's1', ep: '3' });
  });

  it('首页/搜索/设置等页面不产生快照', () => {
    for (const name of ['home', 'search', 'settings', 'library', 'welcome', 'not-found']) {
      expect(sessionSnapshotOf(routeLike(name, { mediaId: 'm1' }))).toBeNull();
    }
  });

  it('缺必填路径参数时不产生快照（拼不出 URL）', () => {
    expect(sessionSnapshotOf(routeLike('player', {}))).toBeNull();
    expect(sessionSnapshotOf(routeLike('player', { mediaId: '' }))).toBeNull();
    expect(sessionSnapshotOf(routeLike('detail', { mediaId: 'm1' }))).not.toBeNull();
    // 回看页两个参数缺一不可
    expect(sessionSnapshotOf(routeLike('replay', { sourceId: 's1' }))).toBeNull();
    expect(sessionSnapshotOf(routeLike('replay', { sourceId: 's1', programId: '1700:t' }))).not.toBeNull();
  });

  it('无名路由（未匹配）不产生快照', () => {
    expect(sessionSnapshotOf({ name: undefined, params: { mediaId: 'm1' }, query: {} })).toBeNull();
    expect(sessionSnapshotOf({ name: Symbol('x'), params: { mediaId: 'm1' }, query: {} })).toBeNull();
  });
});

describe('normalizeSessionSnapshot', () => {
  it('原样保留合法快照的时间戳', () => {
    const at = Date.now() - 60 * 1000;
    expect(
      normalizeSessionSnapshot({ name: 'player', params: { mediaId: 'm' }, query: { lineId: 'L' }, at }),
    ).toEqual({ name: 'player', params: { mediaId: 'm' }, query: { lineId: 'L' }, at });
  });

  it('过期 / 未来时间 / 缺时间戳都按没有快照处理', () => {
    const now = Date.now();
    expect(
      normalizeSessionSnapshot({ name: 'detail', params: { mediaId: 'm' }, query: {}, at: now - 13 * 60 * 60 * 1000 }),
    ).toBeNull();
    expect(
      normalizeSessionSnapshot({ name: 'detail', params: { mediaId: 'm' }, query: {}, at: now + 60 * 60 * 1000 }),
    ).toBeNull();
    expect(normalizeSessionSnapshot({ name: 'detail', params: { mediaId: 'm' }, query: {} })).toBeNull();
  });

  it('脏数据（非对象 / 不可恢复页 / 缺参数 / 参数非字符串）降级为 null', () => {
    expect(normalizeSessionSnapshot(null)).toBeNull();
    expect(normalizeSessionSnapshot('oops')).toBeNull();
    expect(normalizeSessionSnapshot(42)).toBeNull();
    const at = Date.now();
    expect(normalizeSessionSnapshot({ name: 'home', params: {}, query: {}, at })).toBeNull();
    expect(normalizeSessionSnapshot({ name: 'player', params: {}, query: {}, at })).toBeNull();
    expect(
      normalizeSessionSnapshot({ name: 'player', params: { mediaId: { odd: true } }, query: {}, at }),
    ).toBeNull();
  });
});

describe('takeSessionSnapshot（一次性消费）', () => {
  beforeEach(async () => {
    await resetAll();
    __resetSessionRestore();
  });

  it('读出即删除，第二次读为空', async () => {
    await kvRepo.set(KV_KEY_LAST_SESSION, {
      name: 'player',
      params: { mediaId: 'm1', episodeId: 'e2' },
      query: {},
      at: Date.now(),
    } satisfies SessionSnapshot);

    const first = await takeSessionSnapshot();
    expect(first?.params).toEqual({ mediaId: 'm1', episodeId: 'e2' });
    expect(await readKv(KV_KEY_LAST_SESSION)).toBeNull();
    expect(await takeSessionSnapshot()).toBeNull();
  });

  it('无快照时不产生多余的删除事务', async () => {
    expect(await takeSessionSnapshot()).toBeNull();
    expect(await readKv(KV_KEY_LAST_SESSION)).toBeNull();
  });

  it('clearSessionSnapshot 抹掉存储', async () => {
    await kvRepo.set(KV_KEY_LAST_SESSION, { name: 'detail', params: { mediaId: 'm' }, query: {}, at: Date.now() });
    await clearSessionSnapshot();
    expect(await readKv(KV_KEY_LAST_SESSION)).toBeNull();
  });
});

describe('bindSessionRestore', () => {
  beforeEach(async () => {
    await resetAll();
    __resetSessionRestore();
  });

  it('进入播放页落库，退回首页清除', async () => {
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);

    stub.afterEachHooks[0](routeLike('player', { mediaId: 'm1', episodeId: 'e7' }, { lineId: 'L2' }));
    await flushWrites();
    expect(await readKv<SessionSnapshot>(KV_KEY_LAST_SESSION)).toMatchObject({
      name: 'player',
      params: { mediaId: 'm1', episodeId: 'e7' },
      query: { lineId: 'L2' },
    });

    stub.afterEachHooks[0](routeLike('home'));
    await flushWrites();
    expect(await readKv(KV_KEY_LAST_SESSION)).toBeNull();
  });

  it('首帧落在首页时接管一次，之后不再改写导航', async () => {
    await kvRepo.set(KV_KEY_LAST_SESSION, {
      name: 'player',
      params: { mediaId: 'm1', episodeId: 'e2' },
      query: { lineId: 'L1' },
      at: Date.now(),
    } satisfies SessionSnapshot);
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);

    const guard = stub.beforeEachHooks[0];
    expect(guard(routeLike('home'))).toEqual({
      name: 'player',
      params: { mediaId: 'm1', episodeId: 'e2' },
      query: { lineId: 'L1' },
      replace: true,
    });
    // 重定向后守卫会再跑一遍：必须放行，否则死循环
    expect(guard(routeLike('player'))).toBe(true);
    expect(guard(routeLike('home'))).toBe(true);
  });

  it('深链/提醒跳转等明确目标不动它', async () => {
    await kvRepo.set(KV_KEY_LAST_SESSION, {
      name: 'detail',
      params: { mediaId: 'm1' },
      query: {},
      at: Date.now(),
    } satisfies SessionSnapshot);
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);
    expect(stub.beforeEachHooks[0](routeLike('detail'))).toBe(true);
  });

  it('过期快照不接管（读时已被丢弃）', async () => {
    await kvRepo.set(KV_KEY_LAST_SESSION, {
      name: 'player',
      params: { mediaId: 'm1' },
      query: {},
      at: Date.now() - 13 * 60 * 60 * 1000,
    });
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);
    expect(stub.beforeEachHooks[0](routeLike('home'))).toBe(true);
  });

  it('隐私开关打开时既不落库，也会抹掉此前留下的快照', async () => {
    await settingsService.update({ pauseHistoryRecording: true });
    await kvRepo.set(KV_KEY_LAST_SESSION, {
      name: 'player',
      params: { mediaId: 'm1' },
      query: {},
      at: Date.now(),
    } satisfies SessionSnapshot);

    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);
    expect(await readKv(KV_KEY_LAST_SESSION)).toBeNull();
    expect(stub.beforeEachHooks[0](routeLike('home'))).toBe(true);

    stub.afterEachHooks[0](routeLike('player', { mediaId: 'm2' }));
    await flushWrites();
    expect(await readKv(KV_KEY_LAST_SESSION)).toBeNull();
  });

  it('切后台按当前路由补写一次（进程随时可能被清掉，此刻的 at 才是最后停留时间）', async () => {
    const { stub, router } = makeStubRouter();
    await bindSessionRestore(router);

    stub.afterEachHooks[0](routeLike('replay', { sourceId: 's1', programId: '1700:新闻' }, { ch: ['CCTV1'] }));
    await flushWrites();
    expect(await readKv<SessionSnapshot>(KV_KEY_LAST_SESSION)).toMatchObject({
      name: 'replay',
      query: { ch: 'CCTV1' },
    });

    // 页面内改了路由但 afterEach 还没跑（例如原生 PiP 期间），切后台兜底一次
    stub.currentRoute.value = routeLike('player', { mediaId: 'm1', episodeId: 'e9' });
    await kvRepo.delete(KV_KEY_LAST_SESSION);
    emitVisibility('hidden');
    await flushWrites();
    expect(await readKv<SessionSnapshot>(KV_KEY_LAST_SESSION)).toMatchObject({
      name: 'player',
      params: { mediaId: 'm1', episodeId: 'e9' },
    });
    emitVisibility('visible');
  });
});
