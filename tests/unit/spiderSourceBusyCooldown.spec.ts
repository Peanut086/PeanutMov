import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PlaybackSource, ResolvePlayParams, ResolvePlayOrigin, Source } from '@/types';

/**
 * P1-5「源忙」冷却口径（真机复现：批量下载期间刷新同源详情页，被硬拒「约 30 秒后可重试」）
 *
 * 原生侧 F1 同实例串行闸门（SpiderPlugin.java）仍然不松口：同一时刻只允许一个调用压在
 * jar 实例上。本文件固定的是 JS 侧配合这段闸门的四种形态：
 * 1. busy（上一次调用还在跑，很快落定）→ 排队重投一次，用户看不到报错；
 * 2. busy 但 5 秒内等不到 → 报「约 X 秒后结束」，X 取自其它在飞调用的真实 JS 截止时刻，
 *    不再一律喊 30 秒；重投只有一次，绝不循环；
 * 3. zombie（自己这次都没等到回执，实例疑似卡死）→ 先陪等 2 秒再快速失败，
 *    且后续调用不再往卡死的实例上补刀；
 * 4. probe_abort（OPT-26 P0-③-1）→ 探测自己取消的那次调用**不登记** 30 秒闸门：
 *    真机上「点播放撞该源正忙」正是详情页后台探测被这次点击打断后自锁造成的。
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

/** 详情：一条线路一集，地址本身就是可播清单（不触发 parse / proxy 分支） */
const DETAIL_JSON = JSON.stringify({
  list: [
    {
      vod_id: 201,
      vod_name: '士兵突击',
      vod_play_from: '半日App',
      vod_play_url: '第10集$https://example.com/10.m3u8',
    },
  ],
});

const PLAYER_JSON = JSON.stringify({
  class: 'n',
  url: 'https://example.com/10.m3u8',
  header: { 'User-Agent': 'test-agent' },
});

const PLAY_URL = 'https://example.com/10.m3u8';

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
  const jsonFor = (method: string): string =>
    method === 'searchContent'
      ? SEARCH_JSON
      : method === 'detailContent'
        ? DETAIL_JSON
        : method === 'playerContent'
          ? PLAYER_JSON
          : HOME_JSON;
  const invoke = vi.fn((opts: { method: string }) => {
    if (state.inFlight > 0) {
      state.rejectedByLock += 1;
      return Promise.reject(new Error(BUSY_MESSAGE));
    }
    if (!state.hang) {
      return Promise.resolve({ json: jsonFor(opts.method), logs: [] });
    }
    state.inFlight += 1;
    let release!: () => void;
    let settled = false;
    const promise = new Promise<{ json: string | null; logs: string[] }>((resolve) => {
      release = () => {
        if (settled) return;
        settled = true;
        state.inFlight -= 1;
        resolve({ json: jsonFor(opts.method), logs: [] });
      };
    });
    held.push({ release });
    return promise;
  });
  vi.doMock('@/native/spiderPlugin', () => ({
    Spider: {
      load,
      invoke,
      proxy: vi.fn(),
      unload: vi.fn(),
      isSupported: vi.fn(),
      setCurrentOwner: vi.fn(),
    },
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

type BusyPlugin = ReturnType<typeof mockBusyPlugin>;

/** 用例只用到这两个入口；结构性声明，不和 SpiderAdapter 的具体签名绑死 */
interface BusyAdapter {
  listCategories: (source: Source, signal?: AbortSignal) => Promise<unknown>;
  resolvePlayUrl: (params: ResolvePlayParams) => Promise<unknown>;
}

/**
 * 等到原生真的被派发出去：adapter 的派发链是多跳 await（OPT-26 起又加了一层 raceJarNative），
 * 写死轮数会漂——轮数不够时断言读到的是「还没投出去」，取消也发生在派发之前，
 * 整个用例就在测另一条分支。按在飞计数收敛。
 */
async function waitDispatched(plugin: BusyPlugin, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks && plugin.state.inFlight === 0; i += 1) await Promise.resolve();
}

async function rejectsWith(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const e = (await promise.then(
    () => ({ code: '__resolved__', message: '' }),
    (err: unknown) => err as { code: string; message: string },
  )) as { code: string; message: string };
  return e;
}

/**
 * 把「挂住不返回」和「稍后落定」定成契约：释放按下发时登记的那一次调用（不是数组尾），
 * 且它是最后一条时顺手解除挂住开关——真机的常态是「上一次调用返回之后实例就空了」，
 * 排到空位的重投要能正常拿到结果，否则用例永远等在飞上。
 */
function holdThenRelease(plugin: BusyPlugin, releaseAfterMs = 30): void {
  const index = plugin.held.length - 1;
  setTimeout(() => {
    if (index === plugin.held.length - 1) plugin.state.hang = false;
    plugin.held[index]?.release();
  }, releaseAfterMs);
}

interface HangOpts {
  /** 先跑一次拿到 jar 句柄：冷加载那一串 await 会吃掉在飞时刻，让断言不稳定 */
  warmup?: boolean;
  /** 在飞那次多久后自己落定；null = 原生始终不回执（僵尸档） */
  releaseAfterMs?: number | null;
  signal?: AbortSignal;
}

/** 在飞那次的句柄：helper 在「原生确实开始执行」这一刻返回，结果留给用例自己等 */
interface Hanged<T = unknown> {
  running: Promise<T>;
}

/** 预热 + 一次「原生挂住不返回」的分类调用 */
async function listCategoriesHanged(
  adapter: BusyAdapter,
  source: Source,
  plugin: BusyPlugin,
  opts: HangOpts = {},
): Promise<Hanged> {
  if (opts.warmup ?? true) await adapter.listCategories(source);
  plugin.state.hang = true;
  const running = adapter.listCategories(source, opts.signal);
  await waitDispatched(plugin);
  if (opts.releaseAfterMs !== null) holdThenRelease(plugin, opts.releaseAfterMs ?? 30);
  return { running };
}

/** 同上，但走「取播放地址」链路：在飞的是 detailContent */
async function resolvePlayUrlHanged(
  adapter: BusyAdapter,
  source: Source,
  plugin: BusyPlugin,
  origin: ResolvePlayOrigin,
  opts: HangOpts = {},
): Promise<Hanged<PlaybackSource>> {
  if (opts.warmup ?? true) await adapter.listCategories(source);
  plugin.state.hang = true;
  const params: ResolvePlayParams = {
    source,
    mediaId: 'src-busy::201',
    sourceItemId: '201',
    lineId: '',
    episodeId: '',
    origin,
    signal: opts.signal,
  };
  const running = adapter.resolvePlayUrl(params) as Promise<PlaybackSource>;
  await waitDispatched(plugin);
  if (opts.releaseAfterMs !== null) holdThenRelease(plugin, opts.releaseAfterMs ?? 30);
  return { running };
}

describe('SpiderAdapter 源忙冷却（P1-5 / OPT-26）', () => {
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
    const plugin = mockBusyPlugin();
    const { invoke, held, state } = plugin;
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    // helper 返回时：在飞那次已被原生调用，且已排上「30ms 后落定」——真机的常态时序
    const hanged = await listCategoriesHanged(adapter, source, plugin);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(held.length).toBe(1);
    expect(state.inFlight).toBe(1);

    const second = adapter.listCategories(source);
    const startedAt = Date.now();
    const categories = await second;
    const elapsed = Date.now() - startedAt;

    expect(categories.map((c) => c.name)).toEqual(['电影', '剧集']);
    // 1 次预热 + 1 次在飞 + 1 次被闸门挡回 + 1 次重投；只重投一次，没有循环
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(state.rejectedByLock).toBe(1);
    // 落定即解除冷却：没有把窗口等满
    expect(elapsed).toBeLessThan(3_000);
    expect(await hanged.running).toBeInstanceOf(Array);
  });

  it('等不到空位：报真实剩余时间而不是固定 30 秒，且不反复补刀', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const plugin = mockBusyPlugin();
    const { invoke, state } = plugin;
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    await adapter.listCategories(source);
    state.hang = true;
    // 在飞调用带 20 秒预算（SO-05），它的 JS 截止时刻就是「最坏还要多久」的上界
    const running = adapter.search({ source, keyword: '绝命毒师', page: 1, pageSize: 10, budgetMs: 20_000 });
    await waitDispatched(plugin);
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

  it('僵尸窗口（自身都没等到回执）：先给 2 秒陪等，仍不落定才快速失败且不再补刀', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { invoke, state } = mockBusyPlugin();
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    state.hang = true;
    const running = adapter.listCategories(source);
    const runningSettled = rejectsWith(running);
    // 原生始终不回执 → JS 侧 30 秒预算到点；OPT-26 起这类「自己没等到回执」不再冒充超时
    await vi.advanceTimersByTimeAsync(30_100);
    expect((await runningSettled).code).toBe('E_SOURCE_BUSY');
    expect(state.inFlight).toBe(1);

    const next = adapter.listCategories(source);
    const settled = rejectsWith(next);
    // 前台僵尸档给 2 秒陪等（BUSY_ZOMBIE_RETRY_WINDOW_MS），等满仍不落定才快速失败
    await vi.advanceTimersByTimeAsync(2_100);
    const error = await settled;

    expect(error.code).toBe('E_SOURCE_BUSY');
    // 僵尸档给不出可信的「还剩几秒」，文案不再报秒数，改为说明会自动重试
    expect(error.message).toContain('该源正忙');
    expect(error.message).toContain('不必反复点');
    expect(error.message).not.toMatch(/约 \d+ 秒后结束/);
    // 僵尸窗口不补刀：原生只被调用过一次
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(state.rejectedByLock).toBe(0);
  });

  it('排队期间用户取消：按 E_ABORTED 收口，不被误报成「源忙/源不可用」', async () => {
    const plugin = mockBusyPlugin();
    const { invoke, held } = plugin;
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    // 上一次调用始终不落定（releaseAfterMs: null），第二次只能排队等到用户放弃
    const hanged = await listCategoriesHanged(adapter, source, plugin, { releaseAfterMs: null });
    expect(held.length).toBe(1);

    const controller = new AbortController();
    const second = adapter.listCategories(source, controller.signal);
    setTimeout(() => controller.abort(), 200);
    const error = await rejectsWith(second);

    expect(error.code).toBe('E_ABORTED');
    expect(invoke).toHaveBeenCalledTimes(3);
    held[0]?.release();
    await hanged.running;
  });

  it('busyStateOf：真实在飞剩余随时间递减，落定后归零（上层重试预算的唯一来源）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const plugin = mockBusyPlugin();
    const { held, state } = plugin;
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    expect(adapter.busyStateOf('未知源')).toEqual({
      inFlightMs: 0,
      queueDepth: 0,
      kind: null,
      retryAfterMs: 0,
      foregroundInFlight: false,
    });

    // 预热 + 在飞（这条始终不回执，落定由本用例最后手动 release）
    const hanged = await listCategoriesHanged(adapter, source, plugin, { releaseAfterMs: null });
    expect(state.inFlight).toBe(1);

    const before = adapter.busyStateOf(source.id);
    expect(before.inFlightMs).toBeGreaterThan(0);
    expect(before.queueDepth).toBe(1);

    await vi.advanceTimersByTimeAsync(6_000);
    const after = adapter.busyStateOf(source.id);
    // 剩余就是「同一条 deadline 还剩多久」，不掺任何写死的秒数
    expect(before.inFlightMs - after.inFlightMs).toBe(6_000);

    held[0]?.release();
    await hanged.running;
    expect(adapter.busyStateOf(source.id)).toEqual({
      inFlightMs: 0,
      queueDepth: 0,
      kind: null,
      retryAfterMs: 0,
      foregroundInFlight: false,
    });
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
    expect((await settled).code).toBe('E_SOURCE_BUSY');

    // 僵尸冷却 30 秒已挂上，原生那条调用仍未落定 → 队列深度留在 1
    const zombie = adapter.busyStateOf(source.id);
    expect(zombie.inFlightMs).toBeGreaterThan(29_000);
    expect(zombie.inFlightMs).toBeLessThanOrEqual(30_000);
    expect(zombie.queueDepth).toBe(1);
    // OPT-26：成因与重试预算一起交给上层，UI 侧不必从文案反推
    expect(zombie.kind).toBe('zombie');
    expect(zombie.retryAfterMs).toBeGreaterThan(29_000);
  });

  it('探测被打断：不给源挂闸门，紧随其后的点播照样排到空位并取到地址', async () => {
    const plugin = mockBusyPlugin();
    const { invoke, state } = plugin;
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    // 真机时序：详情页后台探测正在取址（在飞），用户点播放把这次探测掐了
    const controller = new AbortController();
    const hanged = await resolvePlayUrlHanged(adapter, source, plugin, 'probe', {
      signal: controller.signal,
      releaseAfterMs: null,
    });
    expect(state.inFlight).toBe(1);

    controller.abort();
    expect((await rejectsWith(hanged.running)).code).toBe('E_ABORTED');

    // 关键分档：被取消的是探测自己 → 不登记闸门，否则用户这一点击必吃 30 秒
    const gate = adapter.busyStateOf(source.id);
    expect(gate.kind).toBeNull();
    expect(gate.retryAfterMs).toBe(0);
    // 原生那条调用还在飞（探测取消 ≠ 原生结束），队列深度如实反映
    expect(gate.queueDepth).toBe(1);

    // 用户点播放：真撞上在飞调用会被 F1 挡回 → 按 busy 排队重投，一次「该源正忙」都不用报。
    // 那条被放弃的探测随后自己落定（真机常态），排队才等得到空位。
    holdThenRelease(plugin, 30);
    const resolved = (await adapter.resolvePlayUrl({
      source,
      mediaId: 'src-busy::201',
      sourceItemId: '201',
      lineId: '',
      episodeId: '',
      origin: 'foreground',
    })) as PlaybackSource;
    expect(resolved.url).toBe(PLAY_URL);
    // 预热 + 探测 + 点播撞闸门 + 重投 detailContent + playerContent
    expect(invoke).toHaveBeenCalledTimes(5);
    expect(state.rejectedByLock).toBe(1);
  });

  it('对照：同样被取消、但成因是用户请求 → 按僵尸挂 30 秒闸门，并先陪等 2 秒才报忙', async () => {
    const plugin = mockBusyPlugin();
    const { state } = plugin;
    const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
    const adapter = new Adapter();
    const source = makeSource();

    const controller = new AbortController();
    const hanged = await resolvePlayUrlHanged(adapter, source, plugin, 'foreground', {
      signal: controller.signal,
      releaseAfterMs: null,
    });
    expect(state.inFlight).toBe(1);

    controller.abort();
    expect((await rejectsWith(hanged.running)).code).toBe('E_ABORTED');

    const gate = adapter.busyStateOf(source.id);
    expect(gate.kind).toBe('zombie');
    expect(gate.retryAfterMs).toBeGreaterThan(29_000);

    // 紧随其后的请求先陪等 2 秒（僵尸档），仍未空位才快速失败
    const startedAt = Date.now();
    const error = await rejectsWith(
      adapter.resolvePlayUrl({
        source,
        mediaId: 'src-busy::201',
        sourceItemId: '201',
        lineId: '',
        episodeId: '',
        origin: 'foreground',
      }),
    );
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000);
    expect(error.code).toBe('E_SOURCE_BUSY');
    expect(error.message).toContain('不必反复点');
    // 僵尸窗口不补刀：没往卡死的实例上再投一次
    expect(state.rejectedByLock).toBe(0);
  });
});
