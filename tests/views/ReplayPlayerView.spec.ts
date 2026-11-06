/**
 * 回看播放页（ReplayPlayerView）单测 —— 覆盖 EXT-06 评审打回项 REV-09
 *
 * REV-09：禁止跨源回退。拿不到「该频道所属的直播源」时必须报错，
 * 不能静默取 `records[0]`（会拼出别的直播源的回看地址）；
 * 同样禁止「源内只有一个频道就直接用它」的单频道兜底。
 *
 * 服务层全部 mock：本文件只验证目标还原逻辑，不触网、不读写 IndexedDB。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  back: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));
const routeMocks = vi.hoisted(() => ({
  query: {} as Record<string, string>,
  params: {} as Record<string, string>,
}));

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => routeMocks,
}));

vi.mock('@/services/liveService', () => ({
  liveService: {
    list: vi.fn(),
    findSourceIdByChannelName: vi.fn(),
    channelsWithExtrasOf: vi.fn(),
  },
}));

vi.mock('@/services/epgService', () => ({
  epgService: { programmesFor: vi.fn() },
}));

vi.mock('@/services/replayService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/replayService')>();
  return {
    ...actual,
    replayService: {
      ...actual.replayService,
      plan: vi.fn(),
      resolve: vi.fn(),
    },
  };
});

import ReplayPlayerView from '@/views/ReplayPlayerView.vue';
import { epgService } from '@/services/epgService';
import { liveService } from '@/services/liveService';
import { replayService } from '@/services/replayService';
import type { LiveRecord } from '@/types';

const CHANNEL = 'CCTV-1 综合';
const OTHER_CHANNEL = 'CCTV-2 财经';
const SOURCE_ID = 'live-1';
const CHANNEL_URL = 'http://cdn.example.com/cctv1/index.m3u8';
const TEMPLATE = 'http://cdn.example.com/{channel}/{start|YmdHMS}.m3u8';
const RESOLVED_URL = 'http://cdn.example.com/cctv1/20261106120000.m3u8';
const WINDOW_DAYS = 5;
const START_AT = 1_760_000_000_000;
const END_AT = START_AT + 3_600_000;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

function makeRecord(id: string, name: string): LiveRecord {
  return {
    id,
    name,
    url: 'http://cdn.example.com/list.m3u',
    format: 'm3u',
    channelCount: 1,
    subscriptionId: null,
    catchup: { enabled: true, template: TEMPLATE, days: WINDOW_DAYS },
    createdAt: 1,
    updatedAt: 1,
  };
}

function channel(name: string, url: string): { name: string; url: string; group: string; logo: null } {
  return { name, url, group: '央视', logo: null };
}

const wrappers: VueWrapper[] = [];

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(ReplayPlayerView, {
    global: {
      stubs: {
        AppHeader: true,
        LoadingSpinner: true,
        ReplayPlayer: {
          props: ['url', 'channelName', 'programmeTitle', 'timeLabel', 'startAt'],
          template: '<div class="replay-player-stub">{{ url }}</div>',
        },
      },
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

beforeEach(() => {
  // REV-31：路由参数由 channelId 更名为 sourceId（实义为「直播源 id」）
  routeMocks.params = { sourceId: SOURCE_ID, programId: `${START_AT}:新闻联播` };
  routeMocks.query = {
    ch: CHANNEL,
    tvgId: 'cctv1',
    title: '新闻联播',
    start: String(START_AT),
    end: String(END_AT),
  };

  vi.mocked(liveService.list).mockResolvedValue([
    makeRecord('live-0', '源0'),
    makeRecord(SOURCE_ID, '源A'),
  ]);
  vi.mocked(liveService.findSourceIdByChannelName).mockReturnValue(null);
  vi.mocked(liveService.channelsWithExtrasOf).mockResolvedValue({
    groups: [],
    channels: [channel(CHANNEL, CHANNEL_URL)],
    extras: {
      [CHANNEL_URL]: {
        tvgId: 'cctv1',
        tvgName: null,
        catchupTemplate: TEMPLATE,
        catchupDays: WINDOW_DAYS,
        catchupCorrectionSec: 0,
      },
    },
  });
  vi.mocked(epgService.programmesFor).mockResolvedValue({
    channel: { name: CHANNEL, tvgId: 'cctv1', tvgName: null },
    channelKey: 'id:cctv1',
    date: '2026-11-06',
    programmes: [],
    matchedSource: null,
    stale: false,
    errors: [],
  });
  vi.mocked(replayService.plan).mockResolvedValue({
    supported: true,
    template: TEMPLATE,
    templateSource: 'source',
    days: WINDOW_DAYS,
  });
  vi.mocked(replayService.resolve).mockResolvedValue({
    url: RESOLVED_URL,
    template: TEMPLATE,
    templateSource: 'source',
    days: WINDOW_DAYS,
    withinWindow: true,
    tokens: {},
  });

  routerMocks.push.mockClear();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('ReplayPlayerView 跨源回退（REV-09）', () => {
  it('REV-09：源未知且频道名反查失败 → 报错，且不读取任何频道的频道表', async () => {
    routeMocks.params = { sourceId: 'ghost-source', programId: `${START_AT}:新闻联播` };
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('未找到该频道所属的直播源，请从直播页重新进入回看');
    const notice = wrapper.find('.replay-notice--error');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('未找到该频道所属的直播源，请从直播页重新进入回看');
    // 关键：不再静默回退到 records[0]（'live-0'），因此不会去拉频道表
    expect(vi.mocked(liveService.channelsWithExtrasOf)).not.toHaveBeenCalled();
    expect(vi.mocked(replayService.resolve)).not.toHaveBeenCalled();
    // 播放器拿到空地址（由 ReplayPlayer 自己渲染「地址尚未就绪」占位）
    expect(wrapper.find('.replay-player-stub').text()).toBe('');
  });

  it('REV-09：源内只有一个频道也不兜底（频道名不匹配即报错）', async () => {
    vi.mocked(liveService.channelsWithExtrasOf).mockResolvedValue({
      groups: [],
      channels: [channel(OTHER_CHANNEL, 'http://cdn.example.com/cctv2/index.m3u8')],
      extras: {},
    });
    const wrapper = await mountView();

    expect(wrapper.text()).toContain('未找到该频道，请从直播页重新进入回看');
    expect(vi.mocked(liveService.channelsWithExtrasOf)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replayService.resolve)).not.toHaveBeenCalled();
    expect(wrapper.find('.replay-player-stub').text()).toBe('');
  });

  it('频道名反查命中同一源时正常回看（未被 REV-09 误伤）', async () => {
    routeMocks.params = { sourceId: 'ghost-source', programId: `${START_AT}:新闻联播` };
    vi.mocked(liveService.findSourceIdByChannelName).mockReturnValue(SOURCE_ID);
    const wrapper = await mountView();

    expect(vi.mocked(liveService.findSourceIdByChannelName)).toHaveBeenCalledWith(CHANNEL);
    expect(vi.mocked(replayService.resolve)).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.replay-player-stub').text()).toBe(RESOLVED_URL);
  });

  it('正常路径：源与频道都能定位，渲染回看窗口天数与来源', async () => {
    const wrapper = await mountView();

    expect(wrapper.find('.replay-player-stub').text()).toBe(RESOLVED_URL);
    const meta = wrapper.find('.replay-meta');
    expect(meta.text()).toContain(CHANNEL);
    expect(meta.text()).toContain('新闻联播');
    expect(meta.text()).toContain(`回看窗口 ${WINDOW_DAYS} 天`);
    expect(meta.text()).toContain('来源：源A');
  });
});
