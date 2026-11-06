/**
 * 节目单页（EpgView）单测 —— 覆盖 EXT-06 评审打回项
 *
 * - REV-02：回看入口只在节目单页（直播页已删除入口，见 `LiveView.vue` 顶部说明）
 * - REV-03：回看判定直接用节目行自带的 `startAt`/`endAt`，不再「只查今天」
 * - REV-04：点击回看先渲染地址再探测能力（AC-162），按 available / auth_required /
 *   not_found 分支处理
 * - REV-05：节目单来源显示命中级别 `（L1/L2/L3）`，未命中提示「未匹配到节目单源」
 *
 * 服务层全部 mock：本文件只验证页面装配与交互，不触网、不读写 IndexedDB。
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
const toastMocks = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => routeMocks,
}));

vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }));

vi.mock('@/services/epgService', () => ({
  epgService: {
    programmesFor: vi.fn(),
    nowPlaying: vi.fn(() => null),
  },
}));

vi.mock('@/services/epgSourceService', () => ({
  epgSourceService: { list: vi.fn() },
}));

vi.mock('@/services/reminderService', () => ({
  reminderService: { list: vi.fn(), upsert: vi.fn(), cancel: vi.fn() },
}));

vi.mock('@/services/liveService', () => ({
  liveService: {
    list: vi.fn(),
    channelsWithExtrasOf: vi.fn(),
    findSourceIdByChannelName: vi.fn(),
  },
}));

vi.mock('@/services/replayService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/replayService')>();
  return {
    ...actual,
    replayService: {
      ...actual.replayService,
      plan: vi.fn(),
      resolve: vi.fn(),
      capabilityOf: vi.fn(),
    },
  };
});

import EpgView from '@/views/EpgView.vue';
import type { EpgProgramme } from '@/services/epgService';
import { epgService } from '@/services/epgService';
import { epgSourceService } from '@/services/epgSourceService';
import { liveService } from '@/services/liveService';
import { reminderService } from '@/services/reminderService';
import { replayService } from '@/services/replayService';
import type { CatchupCapability, ChannelEpgResult, LiveRecord } from '@/types';

const CHANNEL = 'CCTV-1 综合';
const TVG_ID = 'cctv1';
const SOURCE_ID = 'live-1';
const CHANNEL_URL = 'http://cdn.example.com/cctv1/index.m3u8';
const TEMPLATE = 'http://cdn.example.com/{channel}/{start|YmdHMS}.m3u8';
const RESOLVED_URL = 'http://cdn.example.com/cctv1/20261106120000.m3u8';
/** 回看窗口 3 天：2 小时前结束的节目可回看，10 天前的不可 */
const WINDOW_DAYS = 3;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 等页面内多次 await（liveService → epgService → replayService.plan）落定 */
async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

function hhmm(ms: number): string {
  const date = new Date(ms);
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function secOfDay(ms: number): number {
  const date = new Date(ms);
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

function makeProgramme(title: string, startAt: number, durationMs: number): EpgProgramme {
  const endAt = startAt + durationMs;
  return {
    start: hhmm(startAt),
    end: hhmm(endAt),
    title,
    desc: null,
    startSec: secOfDay(startAt),
    endSec: secOfDay(endAt),
    startAt,
    endAt,
    key: `${startAt}:${title}`,
  };
}

interface ProgrammeSet {
  ended: EpgProgramme;
  live: EpgProgramme;
  expired: EpgProgramme;
  all: EpgProgramme[];
}

/** 三条节目：2h 前结束（窗口内）/ 正在播 / 10 天前结束（超窗口） */
function makeProgrammes(): ProgrammeSet {
  const now = Date.now();
  const hour = 3_600_000;
  const ended = makeProgramme('新闻联播', now - 3 * hour, hour);
  const live = makeProgramme('焦点访谈', now - hour / 2, hour);
  const expired = makeProgramme('十年前的节目', now - 10 * 24 * hour, hour);
  return { ended, live, expired, all: [ended, live, expired] };
}

function epgResult(
  programmes: EpgProgramme[],
  matched: ChannelEpgResult['matchedSource'] = { id: 'epg-1', name: '示例 EPG 源', matchLevel: 3 },
): ChannelEpgResult {
  return {
    channel: { name: CHANNEL, tvgId: TVG_ID, tvgName: null },
    channelKey: `id:${TVG_ID}`,
    date: '2026-11-06',
    programmes,
    matchedSource: matched,
    stale: false,
    errors: [],
  };
}

function makeRecord(): LiveRecord {
  return {
    id: SOURCE_ID,
    name: '源A',
    url: 'http://cdn.example.com/list.m3u',
    format: 'm3u',
    channelCount: 1,
    subscriptionId: null,
    catchup: { enabled: true, template: TEMPLATE, days: WINDOW_DAYS },
    createdAt: 1,
    updatedAt: 1,
  };
}

function capability(
  state: CatchupCapability['state'],
  status: number | null,
  reason: string | null = null,
): CatchupCapability {
  return {
    key: `${SOURCE_ID}:id:${TVG_ID}`,
    state,
    checkedAt: Date.now(),
    days: WINDOW_DAYS,
    status,
    reason,
  };
}

const wrappers: VueWrapper[] = [];
let programmes: ProgrammeSet;

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(EpgView, {
    global: {
      stubs: {
        AppHeader: true,
        SafeArea: { template: '<div><slot /></div>' },
        LoadingSpinner: true,
        EpgSourceSheet: true,
        ReminderSheet: true,
      },
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

beforeEach(() => {
  routeMocks.query = { ch: CHANNEL, tvgId: TVG_ID, source: SOURCE_ID };
  routeMocks.params = {};
  programmes = makeProgrammes();

  vi.mocked(liveService.list).mockResolvedValue([makeRecord()]);
  vi.mocked(liveService.channelsWithExtrasOf).mockResolvedValue({
    groups: [],
    channels: [{ name: CHANNEL, url: CHANNEL_URL, group: '央视', logo: null }],
    extras: {
      [CHANNEL_URL]: {
        tvgId: TVG_ID,
        tvgName: null,
        catchupTemplate: TEMPLATE,
        catchupDays: WINDOW_DAYS,
        catchupCorrectionSec: 0,
      },
    },
  });
  vi.mocked(liveService.findSourceIdByChannelName).mockReturnValue(null);

  vi.mocked(replayService.plan).mockResolvedValue({
    supported: true,
    template: TEMPLATE,
    templateSource: 'channel',
    days: WINDOW_DAYS,
  });
  vi.mocked(replayService.resolve).mockResolvedValue({
    url: RESOLVED_URL,
    template: TEMPLATE,
    templateSource: 'channel',
    days: WINDOW_DAYS,
    withinWindow: true,
    tokens: {},
  });
  vi.mocked(replayService.capabilityOf).mockResolvedValue(capability('available', 200));

  vi.mocked(epgService.programmesFor).mockResolvedValue(epgResult(programmes.all));
  vi.mocked(epgSourceService.list).mockResolvedValue([]);
  vi.mocked(reminderService.list).mockResolvedValue({ reminders: [] });

  routerMocks.push.mockClear();
  toastMocks.info.mockClear();
  toastMocks.error.mockClear();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('EpgView 回看入口（REV-02 / REV-03）', () => {
  it('REV-02/REV-03：只有「已结束且落在回看窗口内」的节目出现「回看」', async () => {
    const wrapper = await mountView();
    const items = wrapper.findAll('.epg-item');
    expect(items).toHaveLength(3);

    // 2h 前结束（窗口 3 天）→ 有入口
    expect(items[0].find('.epg-item__replay').exists()).toBe(true);
    expect(items[0].text()).toContain('新闻联播');
    // 正在播 → 无入口
    expect(items[1].find('.epg-item__replay').exists()).toBe(false);
    // 10 天前结束（超窗口）→ 无入口
    expect(items[2].find('.epg-item__replay').exists()).toBe(false);
    expect(wrapper.findAll('.epg-item__replay')).toHaveLength(1);
  });

  it('REV-03：判定使用节目行自带的 startAt/endAt（窗口由源级天数决定）', async () => {
    await mountView();
    const planArg = vi.mocked(replayService.plan).mock.calls[0][0];
    expect(planArg.liveSourceId).toBe(SOURCE_ID);
    expect(planArg.channel).toEqual({ name: CHANNEL, tvgId: TVG_ID, url: CHANNEL_URL });
    expect(planArg.extrasDays).toBe(WINDOW_DAYS);
  });
});

describe('EpgView 能力探测（REV-04 / AC-162）', () => {
  it('available：先渲染地址再探测，可用时跳转 /replay 并带全套查询串', async () => {
    const wrapper = await mountView();
    await wrapper.find('.epg-item__replay').trigger('click');
    await settle();

    expect(vi.mocked(replayService.resolve)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replayService.resolve).mock.calls[0][0]).toMatchObject({
      liveSourceId: SOURCE_ID,
      programme: { startAt: programmes.ended.startAt, endAt: programmes.ended.endAt },
    });

    expect(vi.mocked(replayService.capabilityOf)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replayService.capabilityOf).mock.calls[0][0]).toEqual({
      liveSourceId: SOURCE_ID,
      channelKey: `id:${TVG_ID}`,
      url: RESOLVED_URL,
      days: WINDOW_DAYS,
    });

    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith({
      name: 'replay',
      params: {
        channelId: SOURCE_ID,
        programId: `${programmes.ended.startAt}:新闻联播`,
      },
      query: {
        source: SOURCE_ID,
        ch: CHANNEL,
        title: '新闻联播',
        start: String(programmes.ended.startAt),
        end: String(programmes.ended.endAt),
        tvgId: TVG_ID,
      },
    });
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('auth_required：提示鉴权（403）且不跳转', async () => {
    vi.mocked(replayService.capabilityOf).mockResolvedValue(
      capability('auth_required', 403, 'forbidden'),
    );
    const wrapper = await mountView();
    await wrapper.find('.epg-item__replay').trigger('click');
    await settle();

    expect(toastMocks.error).toHaveBeenCalledWith('该源可能不支持回看（403：可能需要鉴权）');
    expect(routerMocks.push).not.toHaveBeenCalled();
  });

  it('not_found：入口置灰并在列表头给出原因', async () => {
    vi.mocked(replayService.capabilityOf).mockResolvedValue(
      capability('not_found', 404, 'missing'),
    );
    const wrapper = await mountView();
    const button = wrapper.find('.epg-item__replay');
    await button.trigger('click');
    await settle();

    expect(toastMocks.error).toHaveBeenCalledWith('该源可能不支持回看（地址不存在）');
    expect(routerMocks.push).not.toHaveBeenCalled();

    const blocked = wrapper.find('.epg-replay-blocked');
    expect(blocked.exists()).toBe(true);
    expect(blocked.text()).toContain('回看不可用：该源可能不支持回看（地址不存在）');

    const disabled = wrapper.find('.epg-item__replay');
    expect(disabled.attributes('disabled')).toBeDefined();
    expect(disabled.classes()).toContain('epg-item__replay--disabled');
  });

  it('unreachable：同样置灰且原因为「地址不可达」', async () => {
    vi.mocked(replayService.capabilityOf).mockResolvedValue(
      capability('unreachable', null, 'network'),
    );
    const wrapper = await mountView();
    await wrapper.find('.epg-item__replay').trigger('click');
    await settle();

    expect(wrapper.find('.epg-replay-blocked').text()).toContain(
      '回看不可用：该源可能不支持回看（地址不可达）',
    );
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});

describe('EpgView 节目单来源（REV-05）', () => {
  it('命中来源显示名称与命中级别', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.epg-source-line').text()).toContain('来源：示例 EPG 源（L3）');
  });

  it('L1 命中同样带级别标记', async () => {
    vi.mocked(epgService.programmesFor).mockResolvedValue(
      epgResult(programmes.all, { id: 'epg-2', name: '精确源', matchLevel: 1 }),
    );
    const wrapper = await mountView();
    expect(wrapper.find('.epg-source-line').text()).toContain('来源：精确源（L1）');
  });

  it('未命中来源时提示「未匹配到节目单源」', async () => {
    vi.mocked(epgService.programmesFor).mockResolvedValue(epgResult(programmes.all, null));
    const wrapper = await mountView();
    const line = wrapper.find('.epg-source-line');
    expect(line.text()).toContain('未匹配到节目单源');
    expect(line.text()).not.toContain('（L');
  });
});
