/**
 * 探测给点播让路（OPT-26 / P2-⑪「探测与播放统一为单飞 + 优先级队列」）
 *
 * 真机形态：详情页一刷新就点播放，报「该源正忙，上一次调用 30 秒后结束」。
 * 背后是四路后台调用（线路探测、可播性探活、源预热、爬虫预热）各自为政地往同一个
 * 爬虫实例上投——原生 F1 只认"谁先到"，不认谁更重要，于是用户那一次点击排在了一次探测后面。
 *
 * `SpiderAdapter` 是唯一的收口：在飞登记带成因（foreground / probe），
 * 后台投进原生前先看有没有前台压着；让路是**等待**，不是取消，
 * 所以不会留下 P0-③-1 修掉的那种「被放弃的调用自锁 30 秒」。
 * 优先级只有这一个方向——探测在飞时点播照旧投进去（撞锁后按 busy 排队重投一次），
 * 不许反过来把用户的点击支去等一次没人要结果的探测。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  PlaybackSource,
  ResolvePlayOrigin,
  ResolvePlayParams,
  Source,
  SourceBusyState,
} from '@/types';

const HOME_JSON = JSON.stringify({
  class: [
    { type_id: 1, type_name: '电影' },
    { type_id: 2, type_name: '剧集' },
  ],
});

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

const BUSY_MESSAGE = '源正忙（上一次调用仍在原生线程执行），请稍后重试';

interface BusyPlugin {
  invoke: ReturnType<typeof vi.fn>;
  /** 每次「挂住不返回」的原生调用留一个 release 句柄，由用例决定它何时落定 */
  held: { release: () => void }[];
  state: { hang: boolean; inFlight: number; rejectedByLock: number };
}

function mockBusyPlugin(): BusyPlugin {
  const held: { release: () => void }[] = [];
  const state = { hang: false, inFlight: 0, rejectedByLock: 0 };
  const jsonFor = (method: string): string =>
    method === 'detailContent'
      ? DETAIL_JSON
      : method === 'playerContent'
        ? PLAYER_JSON
        : HOME_JSON;
  const invoke = vi.fn((opts: { method: string }) => {
    if (state.inFlight > 0) {
      state.rejectedByLock += 1;
      return Promise.reject(new Error(BUSY_MESSAGE));
    }
    if (!state.hang) return Promise.resolve({ json: jsonFor(opts.method), logs: [] });
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
      load: vi.fn().mockResolvedValue({ handle: 'sp-1' }),
      invoke,
      proxy: vi.fn(),
      unload: vi.fn(),
      isSupported: vi.fn(),
      setCurrentOwner: vi.fn(),
    },
    isSpiderAvailable: vi.fn().mockResolvedValue(true),
    spiderInvoke: vi.fn(),
  }));
  return { invoke, held, state };
}

function makeSource(): Source {
  return {
    id: 'src-yield',
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

/** 只用到这三个入口；结构性声明，不和 SpiderAdapter 的具体签名绑死 */
interface YieldAdapter {
  listCategories: (source: Source, signal?: AbortSignal) => Promise<unknown>;
  resolvePlayUrl: (params: ResolvePlayParams) => Promise<PlaybackSource>;
  busyStateOf: (sourceId: string) => SourceBusyState;
}

async function makeAdapter(): Promise<YieldAdapter> {
  const { SpiderAdapter } = await import('@/sources/spider/SpiderAdapter');
  return new SpiderAdapter() as unknown as YieldAdapter;
}

/** 等到原生真的被派发出去：adapter 的派发链是多跳 await，写死轮数会漂 */
async function waitDispatched(plugin: BusyPlugin, maxTicks = 400): Promise<void> {
  for (let i = 0; i < maxTicks && plugin.state.inFlight === 0; i += 1) await Promise.resolve();
}

function playParams(source: Source, origin: ResolvePlayOrigin): ResolvePlayParams {
  return {
    source,
    mediaId: 'src-yield::201',
    sourceItemId: '201',
    lineId: '',
    episodeId: '',
    origin,
  };
}

/**
 * 让一次取址挂在原生里不回执。先跑一次 `listCategories` 拿句柄：
 * 冷加载那一串 await 会吃掉「在飞」的时刻，断言就不稳定了。
 *
 * 返回值套一层对象：async 函数直接 `return` 一个未落定的 promise，调用方 `await`
 * 会把两层 promise 一起解掉，于是"等句柄"变成了"等这次挂住的取址落定"——用例就在这里死等。
 */
async function hangResolve(
  adapter: YieldAdapter,
  source: Source,
  plugin: BusyPlugin,
  origin: ResolvePlayOrigin,
): Promise<{ running: Promise<PlaybackSource> }> {
  await adapter.listCategories(source);
  plugin.state.hang = true;
  const running = adapter.resolvePlayUrl(playParams(source, origin));
  await waitDispatched(plugin);
  return { running };
}

describe('SpiderAdapter 探测让路（P2-⑪）', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
    vi.doMock('@/sources/base/httpClient', () => ({
      httpClient: { request: vi.fn(async () => undefined) },
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('点播压在原生里时探测一次都不开口，落定后才投', async () => {
    const plugin = mockBusyPlugin();
    const adapter = await makeAdapter();
    const source = makeSource();

    const { running: playing } = await hangResolve(adapter, source, plugin, 'foreground');
    expect(plugin.state.inFlight).toBe(1);
    const dispatchedBefore = plugin.invoke.mock.calls.length;

    const probe = adapter.resolvePlayUrl(playParams(source, 'probe'));
    // 让路期间既不许投，也不许去撞 F1（撞了就是用户那句「该源正忙」的来路）
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(plugin.invoke.mock.calls.length).toBe(dispatchedBefore);
    expect(plugin.state.rejectedByLock).toBe(0);

    plugin.state.hang = false;
    plugin.held[plugin.held.length - 1]?.release();
    const [playResult, probeResult] = await Promise.all([playing, probe]);
    expect(playResult.url).toBe('https://example.com/10.m3u8');
    expect(probeResult.url).toBe('https://example.com/10.m3u8');
    // 探测确实投出去了——让路不是把这次探测吃掉
    expect(plugin.state.rejectedByLock).toBe(0);
  });

  it('优先级只有单向：探测在飞不挡用户点播，撞锁后排队重投一次即成功', async () => {
    const plugin = mockBusyPlugin();
    const adapter = await makeAdapter();
    const source = makeSource();

    const { running: probing } = await hangResolve(adapter, source, plugin, 'probe');
    const playing = adapter.resolvePlayUrl(playParams(source, 'foreground'));

    // 前台没有被探测挡在门外：它真的投进去了，并被 F1 挡回一次
    await vi.waitFor(() => expect(plugin.state.rejectedByLock).toBe(1), { timeout: 2_000 });
    plugin.state.hang = false;
    plugin.held[plugin.held.length - 1]?.release();

    expect((await playing).url).toBe('https://example.com/10.m3u8');
    await expect(probing).resolves.toBeTruthy();
  });

  it('busyStateOf 分开报「压着的是点播还是探测」，让路与日志都读这一个数', async () => {
    const plugin = mockBusyPlugin();
    const adapter = await makeAdapter();
    const source = makeSource();

    await hangResolve(adapter, source, plugin, 'probe');
    expect(adapter.busyStateOf(source.id).foregroundInFlight).toBe(false);
    plugin.state.hang = false;
    plugin.held[plugin.held.length - 1]?.release();

    const adapter2 = await makeAdapter();
    const { running: playing } = await hangResolve(adapter2, source, plugin, 'foreground');
    expect(adapter2.busyStateOf(source.id).foregroundInFlight).toBe(true);
    expect(adapter2.busyStateOf(source.id).queueDepth).toBe(1);
    plugin.state.hang = false;
    plugin.held[plugin.held.length - 1]?.release();
    await expect(playing).resolves.toBeTruthy();
  });
});
