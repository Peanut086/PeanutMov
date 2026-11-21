import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Source } from '@/types';

/**
 * P1-5「源忙」冷却口径（真机复现：批量下载期间刷新同源详情页，被硬拒「约 30 秒后可重试」）
 *
 * 原生侧 F1 同实例串行闸门（SpiderPlugin.java）仍然不松口：同一时刻只允许一个调用压在
 * jar 实例上。本文件固定的是 JS 侧配合这段闸门的三种形态：
 * 1. busy（上一次调用还在跑，很快落定）→ 排队重投一次，用户看不到报错；
 * 2. busy 但 5 秒内等不到 → 报「约 X 秒后结束」，X 取自其它在飞调用的真实 JS 截止时刻，
 *    不再一律喊 30 秒；重投只有一次，绝不循环；
 * 3. zombie（自己这次都没等到回执，实例疑似卡死）→ 维持 F3 的 30 秒快速失败，
 *    且后续调用不再往卡死的实例上补刀。
 *
 * P1-3 把 busy / zombie 两种成因对外统一成 `E_SOURCE_BUSY`（此前借道
 * `E_SOURCE_UNAVAILABLE`，于是被下游当成死源：即时重投第二次、换同源另一条线路、
 * 线路健康记一次连败）；等待预算改由 `busyStateOf` 的真实在飞剩余提供。
 */

const HOME_JSON = JSON.stringify({
  class: [
    { type_id: 1, type_name: '电影' },
    { type_id: 2, type_name: '剧集' },
  ],
});

const SEARCH_JSON = JSON.stringify({ list: [{ vod_id: 103, vod_name: '绝命毒师' }] });

const BUSY_MESSAGE = '源正忙（上一次调用仍在原生线程执行），请稍后重试';

/** 每次「挂住」的原生调用都留一个 release 句柄，由用例决定它何时落定 */
interface Held {
  release: () => void;
}

interface BusyState {
  /** true = 原生调用挂住不返回（模拟爬虫真在跑） */
  hang: boolean;
  /** 原生侧当前在飞调用数：>0 时第二次调用被 F1 闸门挡回 */
  inFlight: number;
  /** 被闸门挡回的次数（用于钉住「不循环」） */
  rejectedByLock: number;
}

function mockBusyPlugin() {
  const held: Held[] = [];
  const state: BusyState = { hang: false, inFlight: 0, rejectedByLock: 0 };
  const load = vi.fn().mockResolvedValue({ handle: 'sp-1' });
  const invoke = vi.fn((opts: { method: string }) => {
    if (state.inFlight > 0) {
      state.rejectedByLock += 1;
      return Promise.reject(new Error(BUSY_MESSAGE));
    }
    if (!state.hang) {
      return Promise.resolve({ json: opts.method === 'searchContent' ? SEARCH_JSON : HOME_JSON, logs: [] });
    }
    state.inFlight += 1;
    let release!: () => void;
    const promise = new Promise<{ json: string | null; logs: string[] }>((resolve) => {
      release = () => {
        state.inFlight -= 1;
        resolve({ json: opts.method === 'searchContent' ? SEARCH_JSON : HOME_JSON, logs: [] });
      };
    });
    held.push({ release });
    return promise;
  });
  vi.doMock('@/native/spiderPlugin', () => ({
    Spider: { load, invoke, proxy: vi.fn(), unload: vi.fn(), isSupported: vi.fn() },
    isSpiderAvailable: vi.fn().mockResolvedValue(true),
    spiderInvoke: vi.fn(),
  }));
  return { load, invoke, held, state };
}

function mockHttpHead() {
  vi.doMock('@/sources/base/httpClient', () => ({
    httpClient: { request: vi.fn(async () => undefined) },
  }));
}

function makeSource(): Source {
  return {
    id: 'src-busy',
    key: 'csp_XBPQ',
    name: '爬虫源',
    type: 'spider',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://example.com/1.jar',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: {
      kind: 'jar',
      api: 'csp_XBPQ',
      jarUrl: 'https://example.com/1.jar;md5;00000000000000000000000000000000',
      initExt: '{}',
      searchable: true,
    },
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** 让 adapter 内部的 Promise.resolve().then 派发跑到原生 */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

async function rejectsWith(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const e = (await promise.then(
    () => ({ code: '__resolved__', message: '' }),
    (err: unknown) => err as { code: string; message: string },
  )) as { code: string; message: string };
  return e;
}

describe('SpiderAdapter 源忙冷却（P1-5）', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    mockHttpHead();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('上一次调用 1 秒内落定：排队重投一次即成功，用户不再看到「30 秒后可重试」', async () => {
    const { invoke, held, state } = mockBusyPlugin();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    await adapter.listCategories(source);
    expect(invoke).toHaveBeenCalledTimes(1);

    state.hang = true;
    const first = adapter.listCategories(source);
    await flushMicrotasks();
    expect(held.length).toBe(1);
    expect(state.inFlight).toBe(1);

    const second = adapter.listCategories(source);
    // 真机常态：上一次调用很快落定（这里 30ms 后返回，远早于重投预算），落定后实例就空了
    setTimeout(() => {
      state.hang = false;
      held[0]?.release();
    }, 30);
    const startedAt = Date.now();
    const categories = await second;
    const elapsed = Date.now() - startedAt;

    expect(categories.map((c) => c.name)).toEqual(['电影', '剧集']);
    // 1 次预热 + 1 次在飞 + 1 次被闸门挡回 + 1 次重投；只重投一次，没有循环
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(state.rejectedByLock).toBe(1);
    // 落定即解除冷却：没有把窗口等满
    expect(elapsed).toBeLessThan(3_000);
    await first;
  });

  it('等不到空位：报真实剩余时间而不是固定 30 秒，且不反复补刀', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { invoke, state } = mockBusyPlugin();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    await adapter.listCategories(source);
    state.hang = true;
    // 在飞调用带 20 秒预算（SO-05），它的 JS 截止时刻就是「最坏还要多久」的上界
    const running = adapter.search({ source, keyword: '绝命毒师', page: 1, pageSize: 10, budgetMs: 20_000 });
    await flushMicrotasks();
    expect(state.inFlight).toBe(1);

    const queued = adapter.listCategories(source);
    const settled = rejectsWith(queued);
    await vi.advanceTimersByTimeAsync(5_100);
    const error = await settled;

    expect(error.code).toBe('E_SOURCE_BUSY');
    expect(error.message).toContain('该源正忙');
    expect(error.message).toContain('请稍后重试');
    expect(error.message).not.toContain('请检查网络');
    // 剩余时间来自在飞调用的 20 秒 deadline 减去已排队等待，而不是硬编码 30
    expect(error.message).toMatch(/约 1[0-9] 秒后结束/);
    // 预热 + 在飞 + 撞闸门一次；排队预算耗尽后没有第三次派发
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(state.rejectedByLock).toBe(1);
    void running;
  });

  it('僵尸窗口（自身都没等到回执）：维持 F3 的 30 秒快速失败，且不再发给卡死的实例', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { invoke, state } = mockBusyPlugin();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    state.hang = true;
    const running = adapter.listCategories(source);
    const runningSettled = rejectsWith(running);
    // 原生始终不回执 → JS 侧 30 秒预算到点
    await vi.advanceTimersByTimeAsync(30_100);
    expect((await runningSettled).code).toBe('E_TIMEOUT');
    expect(state.inFlight).toBe(1);

    const next = adapter.listCategories(source);
    const settled = rejectsWith(next);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await settled;

    expect(error.code).toBe('E_SOURCE_BUSY');
    expect(error.message).toMatch(/约 30 秒后结束/);
    // 僵尸窗口不排队、不补刀：原生只被调用过一次
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(state.rejectedByLock).toBe(0);
  });

  it('排队期间用户取消：按 E_ABORTED 收口，不被误报成「源忙/源不可用」', async () => {
    const { invoke, held, state } = mockBusyPlugin();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    await adapter.listCategories(source);
    state.hang = true;
    const first = adapter.listCategories(source);
    await flushMicrotasks();
    expect(held.length).toBe(1);

    const controller = new AbortController();
    const second = adapter.listCategories(source, controller.signal);
    setTimeout(() => controller.abort(), 200);
    const error = await rejectsWith(second);

    expect(error.code).toBe('E_ABORTED');
    expect(invoke).toHaveBeenCalledTimes(3);
    held[0]?.release();
    await first;
  });

  it('busyStateOf：真实在飞剩余随时间递减，落定后归零（上层重试预算的唯一来源）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { held, state } = mockBusyPlugin();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    expect(adapter.busyStateOf('未知源')).toEqual({ inFlightMs: 0, queueDepth: 0 });

    // 先跑一次把 jar 句柄焐热：冷加载那一串 await 会吃掉在飞时刻，让断言不稳定
    await adapter.listCategories(source);
    state.hang = true;
    const running = adapter.listCategories(source);
    await flushMicrotasks();
    expect(state.inFlight).toBe(1);

    const before = adapter.busyStateOf(source.id);
    expect(before.inFlightMs).toBeGreaterThan(0);
    expect(before.queueDepth).toBe(1);

    await vi.advanceTimersByTimeAsync(6_000);
    const after = adapter.busyStateOf(source.id);
    // 剩余就是「同一条 deadline 还剩多久」，不掺任何写死的秒数
    expect(before.inFlightMs - after.inFlightMs).toBe(6_000);

    held[0]?.release();
    await running;
    expect(adapter.busyStateOf(source.id)).toEqual({ inFlightMs: 0, queueDepth: 0 });
  });

  it('僵尸窗口：原生不回执时 busyStateOf 仍给出 30 秒量级，上层据此不盲目重投', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { state } = mockBusyPlugin();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    state.hang = true;
    const running = adapter.listCategories(source);
    const settled = rejectsWith(running);
    await vi.advanceTimersByTimeAsync(30_100);
    expect((await settled).code).toBe('E_TIMEOUT');

    // 僵尸冷却 30 秒已挂上，原生那条调用仍未落定 → 队列深度留在 1
    const zombie = adapter.busyStateOf(source.id);
    expect(zombie.inFlightMs).toBeGreaterThan(29_000);
    expect(zombie.inFlightMs).toBeLessThanOrEqual(30_000);
    expect(zombie.queueDepth).toBe(1);
  });
});
