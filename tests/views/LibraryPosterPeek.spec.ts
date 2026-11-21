/**
 * 媒体库长按放映的页面接线（G-B02）
 *
 * 卡片与放映台各自有独立测试，这里只锁「页面拿到什么就做什么」这四条：
 * 1. 量到了矩形才起幕；量不到必须退回原来的长按面板——入口不能被动效吃掉；
 * 2. 六种收起原因里只有 `release` 补开面板，`swipe` 已经就地执行了动作，补开等于多做一遍；
 * 3. 上滑播放走的是下载页同一口径（`local: '1'` + 当初那条线路），取不到帧才交给播放页自己找；
 * 4. 下滑收藏复用面板那条路（写库失败照样出声），且起幕时 grid 必须显式开着 peek。
 *
 * 装配沿用 `LibrarySourcePickerSearch.spec.ts` 的取舍：真 store、假网络层、薄壳弹层；
 * PosterGrid / PosterPeek 都换成会发声的壳子，免得为接线测试再拖进一套 WAAPI 桩。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const favoriteMocks = vi.hoisted(() => ({
  toggle: vi.fn(async () => true),
  isFavorite: vi.fn(() => false),
}));

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => routeMocks,
  onBeforeRouteLeave: () => undefined,
}));

vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }));
vi.mock('@/stores/favoriteStore', () => ({ useFavoriteStore: () => favoriteMocks }));

vi.mock('@/services/sourceService', () => ({
  sourceService: {
    list: vi.fn(),
    getDefault: vi.fn(async () => null),
    get: vi.fn(async () => null),
    save: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('@/services/libraryService', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/services/libraryService')>();
  return {
    ...mod,
    libraryService: {
      ...mod.libraryService,
      browse: vi.fn(async () => ({ items: [PEEK_ITEM], total: 1, page: 1, pageSize: 20, hasMore: false })),
      listCategories: vi.fn(async () => []),
      listAreas: vi.fn(async () => []),
      listRecent: vi.fn(async () => []),
      pickFallbackSource: vi.fn(async () => null),
    },
  };
});

import LibraryView from '@/views/LibraryView.vue';
import { sourceService } from '@/services/sourceService';
import type { MediaItem } from '@/types';

const PEEK_ITEM: MediaItem = {
  id: 'mock:m1~a',
  sourceId: 'mock',
  sourceItemId: 'm1',
  title: '影片一',
  originalTitle: null,
  type: 'series',
  year: 2024,
  area: null,
  genres: [],
  tags: [],
  rating: null,
  posterUrl: 'https://example.test/p.jpg',
  backdropUrl: null,
  description: null,
  durationSec: null,
  episodeCount: 3,
  titleLower: '影片一',
  isDemo: false,
  cachedAt: 0,
  updatedAt: 0,
};

const RECT = { top: 120, left: 24, width: 120, height: 180 };

/** 卡片墙壳子：只负责把「长按起了放映」这件事按页面收到的形状发出去 */
const GridStub = {
  name: 'PosterGridStub',
  props: {
    items: { type: Array, default: () => [] },
    peek: { type: Boolean, default: false },
  },
  emits: ['peek', 'longpress', 'select'],
  data: () => ({ rect: RECT, origin: { x: 60, y: 200 } }),
  template: `
    <div class="grid-stub" :data-peek="peek ? 'on' : 'off'">
      <button class="grid-peek" @click="$emit('peek', { item: items[0], rect, origin })">起幕</button>
      <button class="grid-peek-void" @click="$emit('peek', { item: items[0], rect: null, origin: null })">量不到</button>
      <button class="grid-old" @click="$emit('longpress', items[0])">原来的长按</button>
    </div>
  `,
};

/** 放映台壳子：把三种结局（播放 / 收藏 / 各种收起原因）做成可点的按钮 */
const PeekStub = {
  name: 'PosterPeekStub',
  props: {
    item: { type: Object, required: true },
    anchor: { type: Object, required: true },
    origin: { type: Object, default: null },
  },
  emits: ['play', 'favorite', 'dismiss'],
  template: `
    <div class="peek-stub" :data-top="anchor.top" :data-left="anchor.left" :data-width="anchor.width" :data-height="anchor.height" :data-origin="origin ? '1' : ''">
      <button class="peek-play-frameless" @click="$emit('play', null)">无帧播放</button>
      <button class="peek-play" @click="$emit('play', { episodeId: 'mock:m1:e2', lineId: 'line-a', episodeLabel: '第 2 集', durationSec: 600, frames: [] })">播放</button>
      <button class="peek-fav" @click="$emit('favorite')">收藏</button>
      <button class="peek-release" @click="$emit('dismiss', 'release')">松手</button>
      <button class="peek-swipe" @click="$emit('dismiss', 'swipe')">滑动</button>
      <button class="peek-scroll" @click="$emit('dismiss', 'scroll')">滚动</button>
      <button class="peek-key" @click="$emit('dismiss', 'key')">Esc</button>
      <button class="peek-scrim" @click="$emit('dismiss', 'scrim')">点外面</button>
    </div>
  `,
};

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
        PosterGrid: GridStub,
        PosterPeek: PeekStub,
        CategoryTabs: { props: ['modelValue'], template: '<div />' },
        FilterSheet: true,
        PullToRefresh: { template: '<div><slot /></div>' },
        LoadMoreFooter: true,
        EmptyState: true,
        ErrorState: true,
        BottomSheet: {
          props: ['modelValue'],
          template: '<div class="sheet" v-if="modelValue"><slot /></div>',
        },
      },
    },
  });
  wrappers.push(wrapper);
  await settle();
  return wrapper;
}

async function openPeek(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.grid-peek').trigger('click');
  await settle(2);
}

function sheetIsOpen(wrapper: VueWrapper): boolean {
  return wrapper.find('.sheet').exists();
}

beforeEach(async () => {
  setActivePinia(createPinia());
  routeMocks.query = {};
  favoriteMocks.toggle.mockClear();
  vi.mocked(sourceService.list).mockResolvedValue([
    {
      id: 'mock',
      key: 'mock',
      name: '演示源',
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
      health: 'unknown',
      healthCheckedAt: null,
      lastErrorCode: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ]);
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('LibraryView 长按放映接线', () => {
  it('媒体库把放映开着：卡片墙收到 peek=true', async () => {
    const wrapper = await mountView();
    expect(wrapper.find('.grid-stub').attributes('data-peek')).toBe('on');
  });

  it('量到矩形才起幕，起点与触点原样交给放映台', async () => {
    const wrapper = await mountView();
    await openPeek(wrapper);

    const stage = wrapper.find('.peek-stub');
    expect(stage.exists()).toBe(true);
    expect(stage.attributes('data-top')).toBe('120');
    expect(stage.attributes('data-left')).toBe('24');
    expect(stage.attributes('data-width')).toBe('120');
    expect(stage.attributes('data-height')).toBe('180');
    expect(stage.attributes('data-origin')).toBe('1');
    expect(sheetIsOpen(wrapper), '起幕时不该先把长按面板也弹出来').toBe(false);
  });

  it('量不到矩形就退回原来的长按面板：入口不能被动效吃掉', async () => {
    const wrapper = await mountView();
    await wrapper.find('.grid-peek-void').trigger('click');
    await settle(2);

    expect(wrapper.find('.peek-stub').exists()).toBe(false);
    expect(sheetIsOpen(wrapper)).toBe(true);
  });

  it('松手收起（没滑动）把原菜单接回来：看完还是那三件事', async () => {
    const wrapper = await mountView();
    await openPeek(wrapper);

    await wrapper.find('.peek-release').trigger('click');
    await settle(2);

    expect(wrapper.find('.peek-stub').exists()).toBe(false);
    expect(sheetIsOpen(wrapper)).toBe(true);
  });

  // 每轮重新装配：面板一旦开过就不会自己关，混在一个用例里会互相喂状态
  it.each(['scroll', 'key', 'scrim', 'swipe'] as const)
    ('收起原因 %s 只是关掉，不补开面板', async (reason) => {
      const wrapper = await mountView();
      await openPeek(wrapper);

      await wrapper.find(`.peek-${reason}`).trigger('click');
      await settle(2);

      expect(wrapper.find('.peek-stub').exists()).toBe(false);
      expect(sheetIsOpen(wrapper), `${reason} 不该补开长按面板`).toBe(false);
    });

  it('上滑播放走本地快路径：带集号、local=1 和当初那条线路', async () => {
    const wrapper = await mountView();
    await openPeek(wrapper);

    await wrapper.find('.peek-play').trigger('click');
    await settle(2);

    expect(routerMocks.push).toHaveBeenCalledWith({
      name: 'player',
      params: { mediaId: 'mock:m1~a', episodeId: 'mock:m1:e2' },
      query: { local: '1', lineId: 'line-a' },
    });
    expect(wrapper.find('.peek-stub').exists()).toBe(false);
    expect(sheetIsOpen(wrapper), '已经去播放了，不该再补一个菜单').toBe(false);
  });

  it('取不到帧时只带条目：让播放页自己按老路找线路', async () => {
    const wrapper = await mountView();
    await openPeek(wrapper);

    await wrapper.find('.peek-play-frameless').trigger('click');
    await settle(2);

    expect(routerMocks.push).toHaveBeenCalledWith({ name: 'player', params: { mediaId: 'mock:m1~a' } });
  });

  it('下滑收藏复用面板那条路：写库、出声、幕布收干净', async () => {
    const wrapper = await mountView();
    await openPeek(wrapper);

    await wrapper.find('.peek-fav').trigger('click');
    await settle(2);

    expect(favoriteMocks.toggle).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'mock', mediaId: 'mock:m1~a', title: '影片一' }),
    );
    expect(toastMocks.success).toHaveBeenCalledWith('已收藏');
    expect(wrapper.find('.peek-stub').exists()).toBe(false);
    expect(sheetIsOpen(wrapper), '收藏这条不该顺手再开菜单').toBe(false);
  });

  it('收藏写库失败照样出声，且不把幕布留在屏上', async () => {
    favoriteMocks.toggle.mockRejectedValueOnce(new Error('db down'));
    const wrapper = await mountView();
    await openPeek(wrapper);

    await wrapper.find('.peek-fav').trigger('click');
    await settle(2);

    expect(toastMocks.error).toHaveBeenCalled();
    expect(wrapper.find('.peek-stub').exists()).toBe(false);
  });

  it('原来的长按入口没被替换：没开放映的长按照旧开面板', async () => {
    const wrapper = await mountView();

    await wrapper.find('.grid-old').trigger('click');
    await settle(2);

    expect(sheetIsOpen(wrapper)).toBe(true);
    expect(wrapper.find('.peek-stub').exists()).toBe(false);
  });
});
