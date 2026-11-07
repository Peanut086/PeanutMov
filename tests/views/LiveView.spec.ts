/**
 * 直播页（LiveView）单测 —— EXT-06 P1 复审整改
 *
 * - REV-11：读取 `?source=&channel=` 定位频道（activeScope=all + 滚动高亮），**不自动播放**
 * - REV-12：同名多路频道（同 channelKey、不同 url）全部展示，不被去重吞掉
 * - REV-13：频道身份键统一走 `channelKeyFromLive`（有 tvgId 用 `id:`），与分组/节目单同口径
 * - REV-14：「完整节目单」跳转带上 tvgName（L2 匹配需要）
 * - REV-18：频道列表就绪后预取 EPG（收藏 + 当前作用域前 N，封顶 30）
 * - REV-23：空自定义分组保留 chip，并提供「从源分组添加频道」（复用 assign）
 *
 * 分组/排序服务使用真实实现（fake-indexeddb），仅 mock 网络与路由。
 */
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { channelPrefsService } from '@/services/channelPrefsService';
import { AppError } from '@/shared/errors';
import { kvRepo } from '@/db/repositories/kvRepo';
import type { LiveChannel } from '@/sources/live/liveParsers';
import type { LiveChannelExtrasMap, LiveRecord } from '@/types';

import { resetAll } from '../unit/helpers';

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
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

vi.mock('@/services/liveService', () => ({
  liveService: {
    list: vi.fn(),
    channelsWithExtrasOf: vi.fn(),
    findSourceIdByChannelName: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    updateCatchup: vi.fn(),
  },
}));

vi.mock('@/services/epgService', () => ({
  epgService: {
    programmesFor: vi.fn(async () => ({
      channel: { name: '', tvgId: null, tvgName: null },
      channelKey: '',
      date: '2026-11-06',
      programmes: [],
      matchedSource: null,
      stale: false,
      errors: [],
    })),
    nowPlaying: vi.fn(() => null),
    upNext: vi.fn(() => []),
    prefetch: vi.fn(async () => ({ requested: 0, ok: 0, failed: 0, elapsedMs: 0 })),
  },
}));

import LiveView from '@/views/LiveView.vue';
import { liveService } from '@/services/liveService';
import { epgService } from '@/services/epgService';

const SOURCE_ID = 'live-1';
const CCTV = 'CCTV-1 综合';
const HUNAN = '湖南卫视';
const U1 = 'http://cdn.example.com/cctv1/a.m3u8';
const U2 = 'http://cdn.example.com/cctv1/b.m3u8';
const U3 = 'http://cdn.example.com/hunan/a.m3u8';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

const wrappers: VueWrapper[] = [];

function record(): LiveRecord {
  return {
    id: SOURCE_ID,
    name: '源A',
    url: 'http://cdn.example.com/list.m3u',
    format: 'm3u',
    channelCount: 3,
    subscriptionId: null,
    catchup: undefined,
    createdAt: 1,
    updatedAt: 1,
  };
}

function channels(): LiveChannel[] {
  return [
    { name: CCTV, url: U1, group: '央视', logo: null },
    { name: CCTV, url: U2, group: '央视', logo: null },
    { name: HUNAN, url: U3, group: '卫视', logo: null },
  ];
}

function extrasOf(): LiveChannelExtrasMap {
  return {
    [U1]: {
      tvgId: 'cctv1',
      tvgName: 'CCTV-1 综合',
      catchupTemplate: null,
      catchupDays: null,
      catchupCorrectionSec: null,
    },
    [U2]: {
      tvgId: 'cctv1',
      tvgName: 'CCTV-1 综合',
      catchupTemplate: null,
      catchupDays: null,
      catchupCorrectionSec: null,
    },
    [U3]: {
      tvgId: 'hunan',
      tvgName: '湖南卫视',
      catchupTemplate: null,
      catchupDays: null,
      catchupCorrectionSec: null,
    },
  };
}

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(LiveView, {
    global: {
      stubs: {
        AppHeader: true,
        BottomSheet: {
          props: ['modelValue'],
          template: '<div class="sheet" v-if="modelValue"><slot /></div>',
        },
        EmptyState: true,
        ErrorState: true,
        LoadingSpinner: true,
        LivePlayer: {
          props: ['url', 'title', 'loading'],
          template: '<div class="live-player-stub">{{ url }}</div>',
        },
        ChannelGroupSheet: true,
        // REV-34：排序列表只需能向上抛出 reorder（含 origin），用带 emits 的薄壳替代真实拖拽实现
        ChannelSortList: {
          name: 'ChannelSortList',
          props: ['items', 'busy', 'emptyText'],
          emits: ['reorder'],
          template: '<div class="sort-list-stub" />',
        },
      },
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

function rowNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.live-channel__name').map((node) => node.text());
}

beforeEach(async () => {
  await resetAll();
  routeMocks.query = {};
  routeMocks.params = {};
  routerMocks.push.mockClear();
  toastMocks.info.mockClear();
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();

  vi.mocked(liveService.list).mockResolvedValue([record()]);
  vi.mocked(liveService.channelsWithExtrasOf).mockResolvedValue({
    groups: [
      { name: '央视', channels: channels().filter((c) => c.group === '央视') },
      { name: '卫视', channels: channels().filter((c) => c.group === '卫视') },
    ],
    channels: channels(),
    extras: extrasOf(),
  });
  vi.mocked(liveService.findSourceIdByChannelName).mockImplementation((name: string) =>
    name === HUNAN || name === CCTV ? SOURCE_ID : null,
  );
  vi.mocked(epgService.programmesFor).mockResolvedValue({
    channel: { name: '', tvgId: null, tvgName: null },
    channelKey: '',
    date: '2026-11-06',
    programmes: [],
    matchedSource: null,
    stale: false,
    errors: [],
  });
  vi.mocked(epgService.nowPlaying).mockReturnValue(null);
  vi.mocked(epgService.upNext).mockReturnValue([]);
  vi.mocked(epgService.prefetch).mockResolvedValue({
    requested: 0,
    ok: 0,
    failed: 0,
    elapsedMs: 0,
  });
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('LiveView 频道列表（REV-12 / REV-13）', () => {
  it('REV-12：同名多路频道全部保留（同 key 不同 url 都渲染）', async () => {
    const wrapper = await mountView();
    // 默认作用域是源分组「央视」（2 路同名频道都保留）
    expect(rowNames(wrapper)).toEqual([CCTV, CCTV]);
    // 切到「全部」后三路都在
    const allChip = wrapper.findAll('.live-group-chip').find((node) => node.text() === '全部');
    await allChip!.trigger('click');
    await settle();
    expect(rowNames(wrapper)).toEqual([CCTV, CCTV, HUNAN]);
    expect(wrapper.findAll('.live-channel-row')).toHaveLength(3);
  });

  it('REV-12：自定义分组展开时同样保留每一路', async () => {
    const group = await channelPrefsService.createGroup(SOURCE_ID, '央视频道');
    await channelPrefsService.assign(SOURCE_ID, 'id:cctv1', group.id);

    const wrapper = await mountView();
    const chip = wrapper.findAll('.live-group-chip').find((node) => node.text() === '央视频道');
    expect(chip).toBeTruthy();
    await chip!.trigger('click');
    await settle();
    expect(rowNames(wrapper)).toEqual([CCTV, CCTV]);
  });

  it('REV-13：分组归属用 id: 身份键（带 tvgId），不是 nm:', async () => {
    const group = await channelPrefsService.createGroup(SOURCE_ID, '央视频道');
    await channelPrefsService.assign(SOURCE_ID, 'id:cctv1', group.id);

    const wrapper = await mountView();
    const chip = wrapper.findAll('.live-group-chip').find((node) => node.text() === '央视频道');
    await chip!.trigger('click');
    await settle();
    // 若身份键仍是 nm:CCTV-1 综合，该分组会是空的（0 行）
    expect(rowNames(wrapper)).toEqual([CCTV, CCTV]);
    const prefs = await channelPrefsService.get(SOURCE_ID);
    expect(prefs.assignments['id:cctv1']).toBe(group.id);
  });
});

describe('LiveView 查询参数定位（REV-11）', () => {
  it('带 ?source=&channel= → 选中该源、切到「全部」、高亮该行，且不自动播放', async () => {
    routeMocks.query = { source: SOURCE_ID, channel: HUNAN };
    const wrapper = await mountView();

    // 不自动播放（AC-168：只定位）
    expect(wrapper.find('.live-player-stub').text()).toBe('');
    const focused = wrapper.findAll('.live-channel').filter((node) =>
      node.classes().includes('live-channel--focus'),
    );
    expect(focused).toHaveLength(1);
    expect(focused[0]!.text()).toContain(HUNAN);
    // 作用域固定为「全部」
    const activeChip = wrapper.findAll('.live-group-chip').find((node) =>
      node.classes().includes('live-group-chip--active'),
    );
    expect(activeChip?.text()).toBe('全部');
  });

  it('只有 ?channel= 时用 findSourceIdByChannelName 反查直播源', async () => {
    routeMocks.query = { channel: HUNAN };
    const wrapper = await mountView();
    expect(liveService.findSourceIdByChannelName).toHaveBeenCalledWith(HUNAN);
    expect(wrapper.findAll('.live-channel')).toHaveLength(3);
    expect(wrapper.findAll('.live-channel--focus')).toHaveLength(1);
  });

  it('无查询参数时仍自动播放第一个频道（回归不受影响）', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.live-player-stub').text()).toBe(U1);
    expect(wrapper.findAll('.live-channel--focus')).toHaveLength(0);
  });
});

describe('LiveView EPG 预取（REV-18）', () => {
  it('频道列表就绪后调用 prefetch（收藏 + 当前作用域前 N，上限 30）', async () => {
    await kvRepo.set('live-channel-favorites', [HUNAN]);
    await mountView();
    expect(vi.mocked(epgService.prefetch)).toHaveBeenCalled();
    const [refs, , limit] = vi.mocked(epgService.prefetch).mock.calls.at(-1)!;
    expect(limit).toBe(30);
    expect(refs.map((ref) => ref.name)).toContain(CCTV);
    // 收藏频道即使不在当前作用域也会预取
    expect(refs.map((ref) => ref.name)).toContain(HUNAN);
    // 每个引用都带 tvgId / tvgName（L1/L2 匹配需要）
    expect(refs.find((ref) => ref.name === CCTV)?.tvgId).toBe('cctv1');
    expect(refs.find((ref) => ref.name === HUNAN)?.tvgName).toBe('湖南卫视');
  });
});

describe('LiveView 完整节目单跳转（REV-14）', () => {
  it('openEpgFull 透传 ch/source/tvgId/tvgName', async () => {
    vi.mocked(epgService.nowPlaying).mockReturnValue({
      start: '20:00',
      end: '21:00',
      title: '新闻联播',
      desc: null,
      startSec: 0,
      endSec: 3600,
    });
    const wrapper = await mountView();
    await wrapper.find('.live-epg__full').trigger('click');
    expect(routerMocks.push).toHaveBeenCalledWith({
      name: 'epg',
      query: {
        ch: CCTV,
        source: SOURCE_ID,
        tvgId: 'cctv1',
        tvgName: 'CCTV-1 综合',
      },
    });
  });
});

describe('LiveView 排序提示合并（REV-34）', () => {
  /** 打开排序弹层并取到 ChannelSortList 薄壳 */
  async function openSortSheet(wrapper: VueWrapper) {
    await wrapper.findAll('.live-tool')[0]!.trigger('click');
    await settle(2);
    const list = wrapper.findComponent({ name: 'ChannelSortList' });
    expect(list.exists(), '排序弹层应渲染 ChannelSortList').toBe(true);
    return list;
  }

  it('按钮连点（origin=button）：提示被合并，300ms 内不提示、之后只提示一次', async () => {
    const wrapper = await mountView();
    const list = await openSortSheet(wrapper);

    // 连点两次 ↑/↓：接口各存一次（不丢操作），但提示要合并
    list.vm.$emit('reorder', ['id:hunan', 'id:cctv1'], 'button');
    await settle(6);
    list.vm.$emit('reorder', ['id:hunan', 'id:cctv1'], 'button');
    await settle(6);

    expect(toastMocks.success).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).toHaveBeenCalledWith('已保存频道顺序');

    const prefs = await channelPrefsService.get(SOURCE_ID);
    // 两次点击都真的落了库（只合并提示，不丢操作）
    expect(Object.values(prefs.orders)).toContainEqual(['id:hunan', 'id:cctv1']);
  });

  it('拖拽松手（origin=drag）：立即提示，不等合并窗口', async () => {
    const wrapper = await mountView();
    const list = await openSortSheet(wrapper);

    list.vm.$emit('reorder', ['id:hunan', 'id:cctv1'], 'drag');
    await settle(6);

    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).toHaveBeenCalledWith('已保存频道顺序');
  });

  it('保存失败：错误提示立刻出现，且不被后续合并窗口吞掉', async () => {
    const wrapper = await mountView();
    const list = await openSortSheet(wrapper);

    const spy = vi
      .spyOn(channelPrefsService, 'setOrder')
      .mockRejectedValueOnce(new Error('disk full'));
    list.vm.$emit('reorder', ['id:hunan', 'id:cctv1'], 'button');
    await settle(6);

    expect(toastMocks.error).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(toastMocks.success).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('LiveView 空自定义分组（REV-23）', () => {
  it('空分组 chip 保留，空态给出「从源分组添加频道」并可通过 assign 加入', async () => {
    const group = await channelPrefsService.createGroup(SOURCE_ID, '待整理');
    const wrapper = await mountView();

    const chip = wrapper.findAll('.live-group-chip').find((node) => node.text() === '待整理');
    expect(chip, '空自定义分组 chip 不应被过滤').toBeTruthy();
    await chip!.trigger('click');
    await settle();

    expect(wrapper.findAll('.live-channel-row')).toHaveLength(0);
    const addBtn = wrapper.find('.live-empty-scope__add');
    expect(addBtn.exists()).toBe(true);
    expect(addBtn.text()).toContain('从源分组添加频道');

    await addBtn.trigger('click');
    await settle();
    // 弹层列出全部频道，点「加入」写入归属
    const joinButtons = wrapper.findAll('.live-manage__row button');
    expect(joinButtons.length).toBe(3);
    await joinButtons[2]!.trigger('click');
    await settle();

    const prefs = await channelPrefsService.get(SOURCE_ID);
    expect(prefs.assignments['id:hunan']).toBe(group.id);
    // 加入后分组立即可见
    expect(rowNames(wrapper)).toEqual([HUNAN]);
    expect(toastMocks.success).toHaveBeenCalled();
  });
});

describe('LiveView 源级回看设置（P1-01 / FR-68）', () => {
  const TEMPLATE = 'https://cdn.example.com/{channelId}/{dateDash}/{start}-{end}.m3u8';

  async function openCatchupSheet(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('.live-add').trigger('click');
    await settle();
    const entry = wrapper
      .findAll('.live-manage__actions button')
      .find((node) => node.text() === '回看');
    expect(entry, '直播源行应有「回看」入口').toBeTruthy();
    await entry!.trigger('click');
    await settle();
  }

  it('直播源行提供「回看」入口，弹层含模板输入与合法占位符清单', async () => {
    const wrapper = await mountView();
    await openCatchupSheet(wrapper);

    expect(wrapper.find('#catchup-template').exists()).toBe(true);
    expect(wrapper.find('#catchup-days').exists()).toBe(true);
    const tokens = wrapper.find('.live-catchup__tokens').text();
    expect(tokens).toContain('{base}');
    expect(tokens).toContain('{startSec}');
    expect(tokens).toContain('{durationSec}');
  });

  it('未知占位符 → 行内报错并列出合法清单，且不调用保存', async () => {
    const wrapper = await mountView();
    await openCatchupSheet(wrapper);

    await wrapper.find('#catchup-template').setValue('https://cdn.example.com/{base}/{foo}');
    await settle();
    expect(wrapper.find('.field__error').text()).toContain('{foo}');
    expect(wrapper.find('.field__error').text()).toContain('{base}');

    await wrapper.find('.live-catchup__actions .btn--primary').trigger('click');
    await settle();
    expect(vi.mocked(liveService.updateCatchup)).not.toHaveBeenCalled();
  });

  it('合法模板 + 天数 → 调用 updateCatchup 并提示成功', async () => {
    vi.mocked(liveService.updateCatchup).mockResolvedValue({
      ...record(),
      catchup: { enabled: true, template: TEMPLATE, days: 5 },
    });
    const wrapper = await mountView();
    await openCatchupSheet(wrapper);

    await wrapper.find('#catchup-template').setValue(TEMPLATE);
    await wrapper.find('#catchup-days').setValue('5');
    await settle();
    await wrapper.find('.live-catchup__actions .btn--primary').trigger('click');
    await settle();

    expect(vi.mocked(liveService.updateCatchup)).toHaveBeenCalledWith(SOURCE_ID, {
      enabled: true,
      template: TEMPLATE,
      days: 5,
    });
    expect(toastMocks.success).toHaveBeenCalled();
  });

  it('保存失败（服务层拒绝）→ 错误展示在行内，不弹成功提示', async () => {
    vi.mocked(liveService.updateCatchup).mockRejectedValue(
      new AppError('E_INVALID_INPUT', '回看模板不能为空'),
    );
    const wrapper = await mountView();
    await openCatchupSheet(wrapper);

    await wrapper.find('#catchup-template').setValue(TEMPLATE);
    await settle();
    await wrapper.find('.live-catchup__actions .btn--primary').trigger('click');
    await settle();

    expect(wrapper.text()).toContain('回看模板不能为空');
    expect(toastMocks.success).not.toHaveBeenCalled();
  });
});
