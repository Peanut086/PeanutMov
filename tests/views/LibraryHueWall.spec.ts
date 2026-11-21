/**
 * 媒体库「色相墙」的页面接线（G-B01）
 *
 * 单测覆盖的是 composable，这里盯的是**视图层那几处绑没绑对**——
 * 开关、面板、`PosterGrid` 收到的顺序，以及关掉后回到进入前的顺序。
 * 模板里绑错一个名字，vue-tsc 是查不出来的（历史上踩过），所以这层要有真渲染。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
  back: vi.fn(),
  replace: vi.fn(),
}));

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => ({ query: {}, params: {} }),
  onBeforeRouteLeave: () => undefined,
}));

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/services/sourceService', () => ({
  sourceService: {
    list: vi.fn(async () => [
      {
        id: 'mock',
        key: 'mock',
        name: '演示源',
        type: 'spider',
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
        health: 'unknown',
        healthCheckedAt: null,
        lastErrorCode: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
    ]),
    getDefault: vi.fn(async () => null),
    get: vi.fn(async () => null),
    save: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@/services/paletteService', () => ({
  peekPalette: vi.fn(async (url: string | null | undefined) => {
    const hues: Record<string, number> = { p0: 10, p1: 215, p2: 200 };
    const key = /\/(p\d)\.jpg$/.exec(String(url))?.[1];
    if (key === undefined || hues[key] === undefined) return { known: false, seed: null };
    return { known: true, seed: { h: hues[key]!, s: 0.6, l: 0.5 } };
  }),
  paletteForPoster: vi.fn(async () => null),
}));

const browseItems = vi.hoisted(() =>
  Array.from({ length: 4 }, (_, i) => ({
    id: `m${i}`,
    sourceId: 'mock',
    sourceItemId: `s${i}`,
    title: `影片 ${i}`,
    originalTitle: null,
    type: 'movie' as const,
    year: 2020,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: `https://cdn/p${i}.jpg`,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: `影片 ${i}`,
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  })),
);

vi.mock('@/services/libraryService', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/services/libraryService')>();
  return {
    ...mod,
    libraryService: {
      ...mod.libraryService,
      browse: vi.fn(async () => ({
        items: browseItems,
        total: browseItems.length,
        page: 1,
        pageSize: 20,
        hasMore: false,
      })),
      listCategories: vi.fn(async () => []),
      listAreas: vi.fn(async () => []),
      listRecent: vi.fn(async () => []),
      pickFallbackSource: vi.fn(async () => null),
    },
  };
});

import LibraryView from '@/views/LibraryView.vue';
import { paletteForPoster } from '@/services/paletteService';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

const wrappers: VueWrapper[] = [];

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(LibraryView, {
    global: {
      stubs: {
        AppHeader: true,
        SafeArea: { template: '<div><slot /></div>' },
        OfflineBanner: true,
        CategoryTabs: { props: ['modelValue'], template: '<div />' },
        FilterSheet: true,
        PullToRefresh: { template: '<div><slot /></div>' },
        LoadMoreFooter: true,
        EmptyState: true,
        ErrorState: true,
        BottomSheet: { props: ['modelValue'], template: '<div class="sheet" v-if="modelValue"><slot /></div>' },
      },
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

/** 墙上的实际顺序：按 DOM 里的 `data-flip-key` 读，不看 store */
function wallOrder(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.poster-grid__cell')
    .map((cell) => (cell.element as HTMLElement).dataset.flipKey as string);
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(paletteForPoster).mockClear();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('LibraryView 色相墙', () => {
  it('默认关闭：顺序就是数据顺序，面板不占位', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.library-hue-panel').exists()).toBe(false);
    expect(wallOrder(wrapper)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(paletteForPoster).not.toHaveBeenCalled();
  });

  it('开启后按色相重排：命中在前、窗外其次、没结论的最后', async () => {
    const wrapper = await mountView();
    await wrapper.find('.library-hue__toggle').trigger('click');
    await settle();

    expect(wrapper.find('.library-hue-panel').exists()).toBe(true);
    expect(wrapper.find('[role="slider"]').exists()).toBe(true);
    expect(wallOrder(wrapper)).toEqual(['m2', 'm1', 'm0', 'm3']);
    expect(wrapper.find('.library-hue-panel__stats').text()).toContain('命中 2');
  });

  it('开关的 aria-pressed 跟着状态走', async () => {
    const wrapper = await mountView();
    const toggle = wrapper.find('.library-hue__toggle');
    expect(toggle.attributes('aria-pressed')).toBe('false');

    await toggle.trigger('click');
    await settle(2);
    expect(wrapper.find('.library-hue__toggle').attributes('aria-pressed')).toBe('true');

    await wrapper.find('.library-hue__toggle').trigger('click');
    await settle(2);
    expect(wrapper.find('.library-hue__toggle').attributes('aria-pressed')).toBe('false');
    expect(wrapper.find('.library-hue-panel').exists()).toBe(false);
    expect(wallOrder(wrapper)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('色相模式下关掉卡片入场动画，避免重排时整屏闪空', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.poster-grid').classes()).not.toContain('poster-grid--no-enter');

    await wrapper.find('.library-hue__toggle').trigger('click');
    await settle(2);
    expect(wrapper.find('.poster-grid').classes()).toContain('poster-grid--no-enter');
  });
});
