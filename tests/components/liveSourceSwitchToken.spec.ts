import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveGroup, LiveRecord } from '@/types';
import type { LiveChannel } from '@/sources/live/liveParsers';

/**
 * OPT-27 直播快切源请求令牌
 *
 * 两处独立的缺陷：
 *
 * 1. `LiveView.selectRecord` 拉频道列表是网络请求，慢源先点、快源后点时先点的那次会后落库，
 *    把频道列表、分组与「自动播第一个频道」整体盖回旧源（高亮却仍停在后点的源）。
 *    修复：递增号 `sourceToken` 在每次写入前复核。
 * 2. `HlsEngine` 的 fatal 分支既 `settle(false)`（→ `load()` reject）又回调 `onError`，
 *    两个出口都发 `timeout`；外层 `failStreak` 一次加 2，而 `LIVE_DEAD_STREAK = 2`，
 *    第一次真实失败就把频道判死沉底。修复：一次加载只上报一次。
 */

const routeQuery: Record<string, string> = {};

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: routeQuery, params: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const list = vi.fn();
const channelsWithExtrasOf = vi.fn<(record: LiveRecord) => Promise<unknown>>();
const findSourceIdByChannelName = vi.fn<(name: string) => string | null>(() => null);

/* EPG 三个入口都是可编程的桩：OPT-15 用它们观察「观看中」的刷新节奏 */
const programmesFor = vi
  .fn<(channel: unknown, date: unknown) => Promise<unknown>>()
  .mockResolvedValue({ programmes: [] });
const nowPlaying = vi.fn<(programmes: unknown, now?: Date) => unknown>(() => null);
const upNext = vi.fn<(programmes: unknown) => unknown[]>(() => []);

vi.mock('@/services/liveService', () => ({
  liveService: {
    list: () => list(),
    channelsWithExtrasOf: (record: LiveRecord) => channelsWithExtrasOf(record),
    findSourceIdByChannelName: (name: string) => findSourceIdByChannelName(name),
    add: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@/services/epgService', () => ({
  epgService: {
    programmesFor: (channel: unknown, date: unknown) => programmesFor(channel, date),
    nowPlaying: (programmes: unknown, now?: Date) => nowPlaying(programmes, now),
    upNext: (programmes: unknown) => upNext(programmes),
    prefetch: vi.fn().mockResolvedValue(undefined),
  },
}));

// buildScopes / emptyPrefs 必须用真实实现（LiveView 的 scopeList 依赖它），
// 只把落库读取换掉：本用例不验证偏好持久化
vi.mock('@/services/channelPrefsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/channelPrefsService')>();
  return {
    ...actual,
    channelPrefsService: { ...actual.channelPrefsService, get: () => Promise.resolve(null) },
  };
});

vi.mock('@/db/repositories/kvRepo', () => ({
  kvRepo: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
}));

import LiveView from '@/views/LiveView.vue';

function makeRecord(id: string, name: string): LiveRecord {
  return {
    id,
    name,
    url: `https://example.com/${id}.m3u8`,
    format: 'm3u',
    channelCount: 1,
    subscriptionId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makePayload(id: string): { groups: LiveGroup[]; channels: LiveChannel[]; extras: {} } {
  const channel: LiveChannel = { name: `${id} 台`, url: `https://live.example/${id}.m3u8`, group: '央视', logo: null };
  return { groups: [{ name: '央视', channels: [channel] }], channels: [channel], extras: {} };
}

function defer<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 只关心「当前播的是哪一路」，真实引擎在 LivePlayer 自己的用例里测 */
const PlayerStub = {
  name: 'LivePlayer',
  props: ['url', 'title', 'logo', 'loading'],
  emits: ['timeout', 'canplay'],
  template: '<div class="player-stub">{{ url }}|{{ title }}</div>',
};

function mountView() {
  return mount(LiveView, {
    global: {
      plugins: [createPinia()],
      stubs: {
        LivePlayer: PlayerStub,
        ChannelGroupSheet: true,
        ChannelSortList: true,
        ChannelLogo: true,
        BottomSheet: true,
      },
    },
  });
}

describe('OPT-27 LiveView 切源令牌', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
  });

  it('先点的慢源后返回，不再覆盖后点的快源', async () => {
    list.mockResolvedValue([makeRecord('A', '慢源'), makeRecord('B', '快源')]);
    channelsWithExtrasOf.mockResolvedValue(makePayload('B'));
    const wrapper = mountView();
    await flushPromises();
    // 挂载即自动选中并播完一路，源 chips 已就绪
    expect(wrapper.find('.player-stub').text()).toBe('https://live.example/B.m3u8|B 台');

    // A 变成慢源：先点 A（请求在飞），立刻改点 B（秒回）
    const slow = defer<ReturnType<typeof makePayload>>();
    channelsWithExtrasOf.mockImplementation((record: LiveRecord) =>
      record.id === 'A' ? slow.promise : Promise.resolve(makePayload('A')),
    );
    await wrapper.findAll('.live-source-chip')[0]!.trigger('click');
    await wrapper.findAll('.live-source-chip')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.find('.player-stub').text()).toBe('https://live.example/A.m3u8|A 台');

    // 慢的 A 此刻才返回：旧实现会把 groups/allChannels/playing 整体盖回 B
    slow.resolve(makePayload('B'));
    await flushPromises();

    expect(wrapper.find('.player-stub').text()).toBe('https://live.example/A.m3u8|A 台');
    expect(wrapper.text()).toContain('A 台');
    expect(wrapper.text()).not.toContain('B 台');
    // loading 由最新一次请求拥有，不该被过期请求提前撤掉或永久挂住
    expect(wrapper.find('.live-loading').exists()).toBe(false);
  });

  it('过期 timeout 不再污染失效名单：稍后真正的失败仍能正常切路', async () => {
    const twoChannels: LiveChannel[] = [
      { name: '第一路', url: 'https://live.example/1.m3u8', group: '央视', logo: null },
      { name: '第二路', url: 'https://live.example/2.m3u8', group: '央视', logo: null },
    ];
    list.mockResolvedValue([makeRecord('A', '源A')]);
    channelsWithExtrasOf.mockResolvedValue({
      groups: [{ name: '央视', channels: twoChannels }],
      channels: twoChannels,
      extras: {},
    });
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.find('.player-stub').text()).toBe('https://live.example/1.m3u8|第一路');

    /*
     * 上一路（第二路）引擎销毁后才回报失败，连发两次：旧实现照样记 failStreak，
     * `LIVE_DEAD_STREAK = 2` 之下第二路被判死沉底。
     */
    const player = wrapper.findComponent(PlayerStub);
    player.vm.$emit('timeout', 'https://live.example/2.m3u8');
    player.vm.$emit('timeout', 'https://live.example/2.m3u8');
    await flushPromises();
    expect(wrapper.find('.player-stub').text()).toBe('https://live.example/1.m3u8|第一路');

    // 当前这路真的失败：第二路必须还是可切候选（若被上面的过期失败判死，这里会直接判定全源不可用）
    player.vm.$emit('timeout', 'https://live.example/1.m3u8');
    await flushPromises();

    expect(wrapper.find('.live-dead-guide').exists()).toBe(false);
    expect(wrapper.find('.player-stub').text()).toBe('https://live.example/2.m3u8|第二路');
  });

  it('当前播放流的 timeout 仍会切到下一路（守卫没有关掉切路能力）', async () => {
    const twoChannels: LiveChannel[] = [
      { name: '第一路', url: 'https://live.example/1.m3u8', group: '央视', logo: null },
      { name: '第二路', url: 'https://live.example/2.m3u8', group: '央视', logo: null },
    ];
    list.mockResolvedValue([makeRecord('A', '源A')]);
    channelsWithExtrasOf.mockResolvedValue({
      groups: [{ name: '央视', channels: twoChannels }],
      channels: twoChannels,
      extras: {},
    });
    const wrapper = mountView();
    await flushPromises();

    wrapper.findComponent(PlayerStub).vm.$emit('timeout', 'https://live.example/1.m3u8');
    await flushPromises();

    expect(wrapper.find('.player-stub').text()).toBe('https://live.example/2.m3u8|第二路');
  });
});

/* ---------- LivePlayer：一次失败只上报一次 timeout ---------- */

vi.mock('@/native/exoPlayerPlugin', () => ({
  isExoPlayerAvailable: () => Promise.resolve(false),
  exoPlayerPlugin: { setUrl: vi.fn(), prepare: vi.fn(), play: vi.fn(), pause: vi.fn(), release: vi.fn() },
}));

vi.mock('@/native/playerUi', () => ({ setPlayerImmersive: vi.fn() }));

vi.mock('@/services/deviceService', () => ({
  deviceService: { keepAwake: vi.fn(), setStatusBarVisible: vi.fn() },
}));

vi.mock('@/player/FullscreenController', () => ({
  FullscreenController: class {
    constructor() {}
    setElement() {}
    toggle() {
      return Promise.resolve(false);
    }
    destroy() {}
  },
}));

vi.mock('@/player/OrientationController', () => ({
  OrientationController: class {
    lock() {
      return Promise.resolve();
    }
  },
}));

type FakeEngine = {
  loadedUrl: string;
  destroyed: boolean;
  events: Record<string, (arg?: unknown) => void>;
};

const engineInstances: FakeEngine[] = [];

vi.mock('@/player/HlsEngine', () => {
  class FakeHlsEngine {
    loadedUrl = '';
    destroyed = false;
    events: Record<string, (arg?: unknown) => void>;

    constructor(events: Record<string, (arg?: unknown) => void>) {
      this.events = events;
      engineInstances.push(this);
    }

    attach(): void {}

    async load(source: { url: string }): Promise<void> {
      this.loadedUrl = source.url;
      // 复刻真实 fatal 分支（HlsEngine.ts 的 ERROR 处理）：settle(false) 让 load() reject，
      // 紧接着又调用一次 onError —— 两个出口都是 timeout 的来源
      this.events.onError?.({ message: '视频加载失败，请检查网络' });
      throw new Error('视频加载失败，请检查网络');
    }

    async play(): Promise<void> {}

    destroy(): void {
      this.destroyed = true;
    }
  }
  return { HlsEngine: FakeHlsEngine };
});

import LivePlayer from '@/components/live/LivePlayer.vue';

describe('OPT-27 LivePlayer 失败上报单次化', () => {
  beforeEach(() => {
    engineInstances.length = 0;
  });

  it('HLS fatal（reject + onError）只发一次 timeout', async () => {
    const wrapper = mount(LivePlayer, {
      props: { url: null, title: '', logo: null, loading: false },
      global: { stubs: { ChannelLogo: true } },
    });

    await wrapper.setProps({ url: 'https://live.example/dead.m3u8' });
    await flushPromises();

    expect(wrapper.emitted('timeout')).toHaveLength(1);
    expect(wrapper.emitted('timeout')?.[0]).toEqual(['https://live.example/dead.m3u8']);
  });

  it('上一路引擎的异步 error 不再改写当前这路的状态', async () => {
    const wrapper = mount(LivePlayer, {
      props: { url: null, title: '', logo: null, loading: false },
      global: { stubs: { ChannelLogo: true } },
    });

    await wrapper.setProps({ url: 'https://live.example/a.m3u8' });
    await flushPromises();
    const staleEngine = engineInstances[0]!;
    expect(wrapper.emitted('timeout')).toHaveLength(1);

    await wrapper.setProps({ url: 'https://live.example/b.m3u8' });
    await flushPromises();
    expect(wrapper.emitted('timeout')?.[1]).toEqual(['https://live.example/b.m3u8']);

    // a 的引擎销毁后仍投递了失败：它属于过期代次，既不该补发 timeout，也不该改写 b 的错误文案
    staleEngine.events.onError({ message: '稍后到达的失败' });
    await flushPromises();

    expect(wrapper.emitted('timeout')).toHaveLength(2);
    expect(wrapper.text()).not.toContain('稍后到达的失败');
  });
});

/**
 * OPT-15 观看中的节目单周期刷新
 *
 * 旧实现只在换台时取一次节目单，"正在播 / 下一档"跨过节目边界甚至过了零点都不动。
 * 现在下一次重取落在「当前节目结束时刻」，最迟 15 分钟兜底；卸载即停表。
 */
describe('OPT-15 观看中节目单周期刷新', () => {
  const MINUTE = 60_000;

  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    programmesFor.mockResolvedValue({ programmes: [] });
    nowPlaying.mockReturnValue(null);
    list.mockResolvedValue([makeRecord('A', '源A')]);
    channelsWithExtrasOf.mockResolvedValue(makePayload('B'));
    for (const key of Object.keys(routeQuery)) delete routeQuery[key];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 让"当前节目"在 `ms` 之后结束 */
  function programmeEndingIn(ms: number, title: string): void {
    const startAt = Date.now();
    const prog = {
      start: '20:00',
      end: '20:12',
      title,
      desc: null,
      startSec: 0,
      endSec: 0,
      startAt,
      endAt: startAt + ms,
    };
    programmesFor.mockResolvedValue({ programmes: [prog] });
    nowPlaying.mockReturnValue(prog);
  }

  it('跨过节目结束时刻就重取，不必等换台', async () => {
    vi.useFakeTimers();
    programmeEndingIn(2 * MINUTE, '节目一');
    const wrapper = mountView();
    // 挂载 → 自动选台 → watch 触发首取
    await vi.advanceTimersByTimeAsync(90_000);
    expect(programmesFor).toHaveBeenCalledTimes(1);

    // 越过 2 分钟边界后自动再取一次
    await vi.advanceTimersByTimeAsync(45_000);
    expect(programmesFor).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('超长节目按 15 分钟上限兜底', async () => {
    vi.useFakeTimers();
    programmeEndingIn(3 * 60 * MINUTE, '马拉松直播');
    const wrapper = mountView();
    await vi.advanceTimersByTimeAsync(14 * MINUTE);
    expect(programmesFor).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(programmesFor).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('卸载后定时器不再触发', async () => {
    vi.useFakeTimers();
    programmeEndingIn(2 * MINUTE, '节目一');
    const wrapper = mountView();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(programmesFor).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(programmesFor).toHaveBeenCalledTimes(1);
  });
});
