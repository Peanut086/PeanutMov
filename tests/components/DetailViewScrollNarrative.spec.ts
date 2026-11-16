import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import type { Episode, MediaDetail, MediaItem, PlayLine } from '@/types';

/**
 * C-10 详情页滚动叙事的接线校验
 *
 * 效果本身由 `useScrollNarrative` 驱动（已在 `tests/unit/useScrollNarrative.spec.ts` 覆盖），
 * 这里只锁住模板契约：缺了 `data-narrative*` 标记，滚动会静默退化成「什么都没发生」，
 * 而这种退化在真机上很难被肉眼发现。
 */
const routerPush = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { mediaId: 'netdisk:m1' }, query: {} }),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  onBeforeRouteLeave: () => undefined,
}));

vi.mock('@/services/castService', () => ({
  castService: { isSupported: vi.fn().mockResolvedValue(false) },
}));

import DetailView from '@/views/DetailView.vue';
import { useLibraryStore } from '@/stores/libraryStore';

function makeItem(): MediaItem {
  return {
    id: 'netdisk:m1',
    sourceId: 'netdisk',
    sourceItemId: 'm1',
    title: '尖峰时刻',
    originalTitle: null,
    type: 'movie',
    year: 1998,
    area: '美国',
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: '两支时间线在同一座城里撞车。',
    durationSec: null,
    episodeCount: 1,
    titleLower: '尖峰时刻',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

function makeDetail(): MediaDetail {
  const line: PlayLine = {
    id: 'netdisk:m1:0',
    mediaId: 'netdisk:m1',
    sourceId: 'netdisk',
    name: '线路 1',
    quality: null,
    format: 'mp4',
    index: 0,
  };
  const episode: Episode = {
    id: 'netdisk:m1:0:1',
    mediaId: 'netdisk:m1',
    sourceId: 'netdisk',
    lineId: line.id,
    number: 1,
    title: '第 1 集',
    durationSec: null,
    subtitles: [],
    updatedAt: 0,
  };
  return { item: makeItem(), lines: [line], episodes: [episode] };
}

async function mountDetail() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const library = useLibraryStore();
  library.detail = makeDetail();
  library.detailState = 'success';
  vi.spyOn(library, 'loadDetail').mockResolvedValue(undefined as never);
  const wrapper = mount(DetailView, { global: { plugins: [pinia] } });
  await Promise.resolve();
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe('DetailView 滚动叙事接线', () => {
  it('滚动容器、头部大标题、顶栏标题、段落标记齐备', async () => {
    const wrapper = await mountDetail();

    const scroller = wrapper.find('.detail__scroll');
    expect(scroller.exists()).toBe(true);
    expect(scroller.find('.detail-hero [data-narrative-title]').exists()).toBe(true);
    expect(wrapper.find('.detail__nav [data-narrative-nav-title]').exists()).toBe(true);

    const sections = wrapper.findAll('[data-narrative]');
    expect(sections.length).toBeGreaterThan(0);
    // 段落必须挂在滚动容器内部，否则判定线永远量不到
    for (const section of sections) {
      expect(scroller.element.contains(section.element)).toBe(true);
    }
  });

  it('顶栏标题对读屏隐藏，避免与段落标题重复播报', async () => {
    const wrapper = await mountDetail();

    expect(wrapper.find('[data-narrative-nav-title]').attributes('aria-hidden')).toBe('true');
  });
});
