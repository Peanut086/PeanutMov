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

vi.mock('@/services/reminderService', async (importOriginal) => {
  // 只桩掉服务本体；投递档位的纯函数（describeReminderDelivery / probe）用真实实现，
  // 免得视图测试和线上口径各说各话
  const actual = await importOriginal<typeof import('@/services/reminderService')>();
  return {
    ...actual,
    reminderService: { list: vi.fn(), upsert: vi.fn(), cancel: vi.fn() },
  };
});

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
import type { CatchupCapability, ChannelEpgResult, LiveRecord, Reminder } from '@/types';

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
        // REV-31：路径参数更名为 sourceId
        sourceId: SOURCE_ID,
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

/* =====================================================================
 * EXT-06 P1 复审整改：REV-14 / REV-21 / REV-26
 * ===================================================================== */

function reminderFor(startAt: number, state: string): Reminder {
  return {
    id: `r_${state}_${startAt}`,
    liveSourceId: SOURCE_ID,
    epgSourceId: null,
    channelKey: `id:${TVG_ID}`,
    channelName: CHANNEL,
    programmeKey: `${startAt}:节目`,
    programmeTitle: '节目',
    startAt,
    endAt: startAt + 3_600_000,
    leadMinutes: 5,
    notifyAt: startAt - 300_000,
    state: state as Reminder['state'],
    nativeId: 100,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('EpgView 频道身份（REV-14）', () => {
  it('查询串缺 tvgId/tvgName 时用 channelsWithExtrasOf 反查并补进 channelRef', async () => {
    routeMocks.query = { ch: CHANNEL, source: SOURCE_ID };
    vi.mocked(liveService.channelsWithExtrasOf).mockResolvedValue({
      groups: [],
      channels: [{ name: CHANNEL, url: CHANNEL_URL, group: '央视', logo: null }],
      extras: {
        [CHANNEL_URL]: {
          tvgId: TVG_ID,
          tvgName: 'CCTV-1 综合',
          catchupTemplate: TEMPLATE,
          catchupDays: WINDOW_DAYS,
          catchupCorrectionSec: 0,
        },
      },
    });

    await mountView();
    const lastRef = vi.mocked(epgService.programmesFor).mock.calls.at(-1)![0];
    expect(lastRef.tvgId).toBe(TVG_ID);
    expect(lastRef.tvgName).toBe('CCTV-1 综合');
  });

  it('查询串自带 tvgName 时直接透传（直播页「完整节目单」跳转路径）', async () => {
    routeMocks.query = { ch: CHANNEL, source: SOURCE_ID, tvgId: TVG_ID, tvgName: 'CCTV1 备用' };
    await mountView();
    const firstRef = vi.mocked(epgService.programmesFor).mock.calls[0]![0];
    expect(firstRef).toMatchObject({ tvgId: TVG_ID, tvgName: 'CCTV1 备用' });
  });
});

describe('EpgView 提醒状态（REV-21）', () => {
  it('已提醒 / 已错过 / 修改提醒三种文案与可点性', async () => {
    const hour = 3_600_000;
    const future = makeProgramme('晚间新闻', Date.now() + 2 * hour, hour);
    vi.mocked(epgService.programmesFor).mockResolvedValue(epgResult([...programmes.all, future]));
    vi.mocked(reminderService.list).mockResolvedValue({
      reminders: [
        reminderFor(programmes.ended.startAt!, 'fired'),
        reminderFor(programmes.expired.startAt!, 'missed'),
        reminderFor(future.startAt!, 'scheduled'),
      ],
    });

    const wrapper = await mountView();
    const items = wrapper.findAll('.epg-item');
    expect(items).toHaveLength(4);

    // 已提醒（fired）：文案 + 置灰
    const firedBtn = items[0].find('.epg-item__remind');
    expect(firedBtn.exists()).toBe(true);
    expect(firedBtn.text()).toBe('已提醒');
    expect(firedBtn.attributes('disabled')).toBeDefined();
    expect(firedBtn.classes()).toContain('epg-item__remind--fired');

    // 已错过（missed）：文案 + 置灰
    const missedBtn = items[2].find('.epg-item__remind');
    expect(missedBtn.text()).toBe('已错过');
    expect(missedBtn.attributes('disabled')).toBeDefined();
    expect(missedBtn.classes()).toContain('epg-item__remind--missed');

    // 待触发（scheduled）：可继续修改
    const scheduledBtn = items[3].find('.epg-item__remind');
    expect(scheduledBtn.text()).toBe('修改提醒');
    expect(scheduledBtn.attributes('disabled')).toBeUndefined();
  });

  it('未开播且未设提醒 → 「提醒」；已开播且无记录 → 不渲染按钮', async () => {
    const hour = 3_600_000;
    const future = makeProgramme('晚间新闻', Date.now() + 2 * hour, hour);
    vi.mocked(epgService.programmesFor).mockResolvedValue(epgResult([...programmes.all, future]));

    const wrapper = await mountView();
    const items = wrapper.findAll('.epg-item');
    expect(items[3].find('.epg-item__remind').text()).toBe('提醒');
    expect(items[1].find('.epg-item__remind').exists()).toBe(false);
  });

  it('按 (channelKey, startAt) 建索引：其它频道的同刻提醒不会串到本页', async () => {
    vi.mocked(reminderService.list).mockResolvedValue({
      reminders: [
        { ...reminderFor(programmes.ended.startAt!, 'fired'), channelKey: 'nm:别的频道' },
      ],
    });
    const wrapper = await mountView();
    expect(wrapper.find('.epg-item__remind').exists()).toBe(false);
  });
});

describe('EpgView 请求竞态（REV-26）', () => {
  it('早发出的请求晚返回时不覆盖新结果', async () => {
    const hour = 3_600_000;
    let resolveFirst: ((value: ChannelEpgResult) => void) | null = null;
    const pending = new Promise<ChannelEpgResult>((resolve) => {
      resolveFirst = resolve;
    });
    vi.mocked(epgService.programmesFor).mockReturnValueOnce(pending);

    const wrapper = await mountView();
    // 初始请求仍挂起时切到「前一天」，第二次请求立即返回新数据
    const fresh = makeProgramme('新节目', Date.now() + 2 * hour, hour);
    vi.mocked(epgService.programmesFor).mockResolvedValue(epgResult([fresh]));
    await wrapper.find('.epg-date-btn').trigger('click');
    await settle();
    expect(wrapper.text()).toContain('新节目');

    // 旧请求此刻才返回：必须被序列号丢弃
    resolveFirst!(epgResult([makeProgramme('旧节目', Date.now() + 5 * hour, hour)]));
    await settle();
    expect(wrapper.text()).not.toContain('旧节目');
    expect(wrapper.text()).toContain('新节目');
  });
});

describe('EpgView 日期栏回看窗口（P1-05 / FR-68）', () => {
  function dateKeyOf(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  function daysAgoKey(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return dateKeyOf(d);
  }

  function lastRequestedKey(): string | null {
    const calls = vi.mocked(epgService.programmesFor).mock.calls;
    const last = calls[calls.length - 1];
    if (!last) return null;
    return dateKeyOf(last[1] as Date);
  }

  it('回看窗口 3 天 → 可连续翻到 3 天前，再往前置灰且不再发请求', async () => {
    const wrapper = await mountView();
    const prev = (): ReturnType<VueWrapper['find']> => wrapper.find('.epg-date-btn');

    for (let i = 1; i <= WINDOW_DAYS; i += 1) {
      expect(prev().attributes('disabled')).toBeUndefined();
      await prev().trigger('click');
      await settle();
      expect(lastRequestedKey()).toBe(daysAgoKey(i));
    }

    expect(prev().attributes('disabled')).toBeDefined();
    const before = vi.mocked(epgService.programmesFor).mock.calls.length;
    await prev().trigger('click');
    await settle();
    expect(vi.mocked(epgService.programmesFor).mock.calls.length).toBe(before);
    expect(wrapper.find('.epg-date-label').text()).toContain(`${WINDOW_DAYS} 天前`);
  });

  it('无回看能力（plan.supported=false）→ 下限仍为 1 天', async () => {
    vi.mocked(replayService.plan).mockResolvedValue({
      supported: false,
      template: null,
      templateSource: 'source',
      days: 1,
    });
    const wrapper = await mountView();
    const prev = (): ReturnType<VueWrapper['find']> => wrapper.find('.epg-date-btn');

    await prev().trigger('click');
    await settle();
    expect(lastRequestedKey()).toBe(daysAgoKey(1));
    expect(prev().attributes('disabled')).toBeDefined();
  });

  it('日期选择器可在窗口内直接跳转，越界日期被钳到最早可回看日', async () => {
    const wrapper = await mountView();
    const picker = wrapper.find('.epg-date-picker');
    expect(picker.attributes('type')).toBe('date');
    expect(picker.attributes('min')).toBe(daysAgoKey(WINDOW_DAYS));
    expect(picker.attributes('max')).toBe(daysAgoKey(-1));

    (picker.element as HTMLInputElement).value = daysAgoKey(2);
    await picker.trigger('change');
    await settle();
    expect(lastRequestedKey()).toBe(daysAgoKey(2));

    // 越过窗口下限的日期（先摘掉原生 min 约束模拟异常输入）→ 被钳到最早可回看日
    picker.element.removeAttribute('min');
    (picker.element as HTMLInputElement).value = daysAgoKey(9);
    await picker.trigger('change');
    await settle();
    expect(lastRequestedKey()).toBe(daysAgoKey(WINDOW_DAYS));
  });

  it('未来仍只允许 +1 天（明天）', async () => {
    const wrapper = await mountView();
    const buttons = wrapper.findAll('.epg-date-btn');
    const next = buttons[buttons.length - 1]!;

    await next.trigger('click');
    await settle();
    expect(next.attributes('disabled')).toBeDefined();
    expect(wrapper.find('.epg-date-label').text()).toContain('明天');
  });
});
