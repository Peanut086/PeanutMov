import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaDetail, MediaItem } from '@/types';

const sharedCover = vi.hoisted(() => ({
  beginSharedCover: vi.fn(),
  cancelSharedCover: vi.fn(),
  finishSharedCover: vi.fn(),
  rewindSharedCover: vi.fn(),
}));

vi.mock('@/composables/useSharedElement', () => sharedCover);

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { mediaId: 'demo:m1' }, query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  onBeforeRouteLeave: () => undefined,
}));

vi.mock('@/services/castService', () => ({
  castService: { isSupported: vi.fn().mockResolvedValue(false) },
}));

import DetailView from '@/views/DetailView.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';

function makeItem(): MediaItem {
  return {
    id: 'demo:m1',
    sourceId: 'demo',
    sourceItemId: 'm1',
    title: '共享封面测试剧',
    originalTitle: null,
    type: 'series',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: 'https://cdn.example.com/poster.jpg',
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: 2,
    titleLower: '共享封面测试剧',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

function makeDetail(): MediaDetail {
  return { item: makeItem(), lines: [], episodes: [] };
}

function pendingLoad(): Promise<void> {
  return new Promise<void>(() => {});
}

const wrappers: Array<ReturnType<typeof mount>> = [];

async function mountDetail(configure: (library: ReturnType<typeof useLibraryStore>) => void) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const library = useLibraryStore();
  configure(library);
  vi.spyOn(useHistoryStore(), 'load').mockReturnValue(pendingLoad());
  vi.spyOn(useFavoriteStore(), 'load').mockReturnValue(pendingLoad());
  vi.spyOn(useDownloadStore(), 'load').mockReturnValue(pendingLoad());
  vi.spyOn(library, 'loadDetail').mockReturnValue(pendingLoad());

  const wrapper = mount(DetailView, { global: { plugins: [pinia] } });
  wrappers.push(wrapper);
  await flushPromises();
  return { wrapper, library };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
});

describe('DetailView 共享封面去程', () => {
  it('Hero 已就绪时，不被历史、收藏和下载加载阻塞收尾', async () => {
    const { wrapper } = await mountDetail((library) => {
      library.detail = makeDetail();
      library.detailState = 'success';
    });

    expect(wrapper.find('.detail-hero').exists()).toBe(true);
    expect(sharedCover.finishSharedCover).toHaveBeenCalledTimes(1);
    expect(sharedCover.finishSharedCover).toHaveBeenCalledWith(wrapper.find('.detail-hero__poster').element);
  });

  it('详情加载失败时撤掉待收尾转场，不用列表 hint 冒充成功页', async () => {
    const { wrapper } = await mountDetail((library) => {
      library.detail = null;
      library.detailState = 'error';
      library.searchResultsAll = [makeItem()];
    });

    expect(wrapper.find('.detail-hero').exists()).toBe(false);
    expect(sharedCover.cancelSharedCover).toHaveBeenCalledTimes(1);
    expect(sharedCover.finishSharedCover).not.toHaveBeenCalled();
  });

  it('详情未返回但列表已有条目时，先用 hint 渲染 Hero 并收尾转场', async () => {
    const { wrapper } = await mountDetail((library) => {
      library.detail = null;
      library.detailState = 'loading';
      library.searchResultsAll = [makeItem()];
    });

    expect(wrapper.find('.detail-hero').exists()).toBe(true);
    expect(wrapper.find('.detail-hero__title').text()).toBe('共享封面测试剧');
    expect(sharedCover.finishSharedCover).toHaveBeenCalledTimes(1);
    expect(sharedCover.finishSharedCover).toHaveBeenCalledWith(wrapper.find('.detail-hero__poster').element);
  });
});
