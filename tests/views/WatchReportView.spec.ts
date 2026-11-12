/**
 * 观影报告页装配与交互（D2）
 *
 * 只做装配级验证：真实播种 history / media / source（fake-indexeddb），
 * 路由与系统分享面板被替换。聚合口径本身由 tests/unit/watchReport.spec.ts 覆盖。
 */
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }));
const shareMocks = vi.hoisted(() => ({ share: vi.fn() }));

vi.mock('vue-router', () => ({ useRouter: () => routerMocks }));
vi.mock('@capacitor/share', () => ({ Share: shareMocks }));

import WatchReportView from '@/views/WatchReportView.vue';
import { historyRepo } from '@/db/repositories/historyRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { useUiStore } from '@/stores/uiStore';
import type { HistoryRecord, MediaItem, Source } from '@/types';

import { resetAll } from '../unit/helpers';

const NOW = Date.now();
const DAY = 86_400_000;

let wrapper: VueWrapper | null = null;

function makeSource(id: string, name: string): Source {
  return {
    id,
    key: id,
    name,
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'ok',
    healthCheckedAt: NOW,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeMedia(id: string, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    sourceId: 's1',
    sourceItemId: id,
    title: `片 ${id}`,
    originalTitle: null,
    type: 'movie',
    year: 2024,
    area: '内地',
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: 3600,
    episodeCount: null,
    titleLower: `片 ${id}`,
    isDemo: false,
    cachedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeHistory(mediaId: string, overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: `s1:${mediaId}`,
    sourceId: 's1',
    mediaId,
    episodeId: null,
    episodeNumber: null,
    title: `片 ${mediaId}`,
    posterUrl: null,
    positionSec: 0,
    durationSec: 3600,
    progress: 0,
    finished: false,
    totalEpisodes: null,
    createdAt: NOW - 5 * DAY,
    updatedAt: NOW,
    ...overrides,
  };
}

/** 3 部：完播悬疑片 / 看到一半的动作剧 / 上个月看的科幻片 */
async function seed(): Promise<void> {
  await sourceRepo.save(makeSource('s1', '花生源'));
  await mediaRepo.upsertMany([
    makeMedia('m1', { genres: ['悬疑', '犯罪'] }),
    makeMedia('m2', { type: 'series', genres: ['动作'], episodeCount: 8 }),
    makeMedia('m3', { genres: ['科幻'] }),
  ]);
  await historyRepo.saveMany([
    makeHistory('m1', { finished: true, progress: 1 }),
    makeHistory('m2', { episodeNumber: 3, totalEpisodes: 8, durationSec: 1800, positionSec: 900, progress: 0.5 }),
    makeHistory('m3', { positionSec: 2700, progress: 0.75, updatedAt: NOW - 40 * DAY }),
  ]);
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** 头部数字是 900ms 的 rAF 滚动，断言终值必须等它跑完 */
async function settleCountUp(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

async function mountPage(): Promise<VueWrapper> {
  wrapper = mount(WatchReportView, { global: { plugins: [createPinia()] } });
  // 汇总要走 history / sources / 媒体缓存三轮 IDB，机器负载高时固定 tick 数不够，等 loading 真正消失
  for (let i = 0; i < 200 && wrapper.find('.report-loading').exists(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settle();
  return wrapper;
}

function buttonByText(page: VueWrapper, text: string): DOMWrapper<Element> {
  const found = page.findAll('button').find((node) => node.text().trim() === text);
  if (!found) throw new Error(`未找到按钮：${text}`);
  return found;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await resetAll();
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('WatchReportView 装配', () => {
  it('无记录时给出空态与去媒体库入口', async () => {
    const page = await mountPage();
    expect(page.text()).toContain('还没有可统计的记录');
    await buttonByText(page, '去媒体库').trigger('click');
    expect(routerMocks.push).toHaveBeenCalledWith('/library');
  });

  it('有记录时渲染报告单与四个统计面板，并读出真实源名', async () => {
    await seed();
    const page = await mountPage();
    expect(page.find('.hero').exists()).toBe(true);
    const titles = page.findAll('.panel__title').map((n) => n.text());
    expect(titles).toEqual(['口味画像', '观影节奏', '差一点就看完', '常看的源', '片单']);
    expect(page.find('.sources__name').text()).toBe('花生源');
    expect(page.findAll('.titles__row')).toHaveLength(3);
    // m1 完播 1 小时 + m2 三集看到一半 1.25 小时 + m3 0.75 小时 = 3 小时
    await settleCountUp();
    expect(page.find('.hero__num').text()).toBe('3.0');
    expect(page.find('.hero__ring-text strong').text()).toBe('33%');
  });

  it('切换口味维度到题材后列出缓存里的题材名', async () => {
    await seed();
    const page = await mountPage();
    expect(page.find('.taste__label').text()).toBe('电影');

    await buttonByText(page, '题材').trigger('click');
    const labels = page.findAll('.taste__label').map((n) => n.text());
    expect(labels).toContain('悬疑');
    expect(labels).toContain('动作');
    expect(labels).toContain('科幻');
  });

  it('切换统计口径为时长后，口味与节奏两处同时改用小时', async () => {
    await seed();
    const page = await mountPage();
    expect(page.find('.taste__value').text()).toContain('部');

    await buttonByText(page, '时长').trigger('click');
    expect(page.find('.taste__value').text()).toContain('小时');
    expect(page.findAll('.panel__hint').some((n) => n.text().includes('小时'))).toBe(true);
  });

  it('切到时长口径后榜单重排：部数第一的类型不一定是时长第一', async () => {
    await sourceRepo.save(makeSource('s1', '花生源'));
    await mediaRepo.upsertMany([
      makeMedia('short1', { durationSec: 60 }),
      makeMedia('short2', { durationSec: 60 }),
      makeMedia('long', { type: 'series', episodeCount: 1, durationSec: 7200 }),
    ]);
    await historyRepo.saveMany([
      makeHistory('short1', { finished: true, progress: 1, durationSec: 60 }),
      makeHistory('short2', { finished: true, progress: 1, durationSec: 60 }),
      makeHistory('long', { finished: true, progress: 1, durationSec: 7200, episodeNumber: 1, totalEpisodes: 1 }),
    ]);
    const page = await mountPage();
    expect(page.find('.taste__label').text()).toBe('电影');

    await buttonByText(page, '时长').trigger('click');
    expect(page.find('.taste__label').text()).toBe('剧集');
  });

  it('点月份柱筛选片单，再点清除 chip 恢复全部', async () => {
    await seed();
    const page = await mountPage();
    const cols = page.findAll('.rhythm__col');
    expect(cols).toHaveLength(6);

    await cols[5]!.trigger('click');
    expect(cols[5]!.attributes('aria-pressed')).toBe('true');
    expect(page.findAll('.titles__row')).toHaveLength(2);
    expect(page.find('.chip--month').exists()).toBe(true);

    await page.find('.chip--month').trigger('click');
    expect(page.findAll('.titles__row')).toHaveLength(3);
    expect(page.find('.chip--month').exists()).toBe(false);
  });

  it('片单筛选「已看完」只留完播条，切筛选会重置分页', async () => {
    await seed();
    const page = await mountPage();
    await buttonByText(page, '已看完').trigger('click');
    const rows = page.findAll('.titles__row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('片 m1');
    expect(rows[0]!.find('.titles__state--done').exists()).toBe(true);
  });

  it('分享在 Web 环境落到剪贴板，并给出提示', async () => {
    await seed();
    const page = await mountPage();
    const ui = useUiStore();
    await page.find('.report-share').trigger('click');
    await settle(4);
    expect(navigator.clipboard.writeText).toHaveBeenCalledOnce();
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] ?? '';
    expect(text).toContain('PeanutMov 观影报告');
    expect(ui.toasts.some((t) => t.text.includes('剪贴板'))).toBe(true);
  });

  it('系统减少动态效果时所有分段直接可见，不做进场动画', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    await seed();
    const page = await mountPage();
    const sections = page.findAll('[data-reveal]');
    expect(sections.length).toBeGreaterThan(3);
    expect(sections.every((node) => node.attributes('data-reveal') === 'in')).toBe(true);
    expect(page.find('.hero__num').text()).toBe('3.0');
  });
});