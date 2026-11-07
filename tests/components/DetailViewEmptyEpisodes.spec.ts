import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Episode, MediaDetail, MediaItem, PlayLine } from '@/types';

/**
 * 详情页「源侧无播放数据」空态
 *
 * 网盘/盘搜源常返回只有元信息、没有线路与剧集的详情：此时不再留空壳，
 * 改为展示「当前来源暂无可播放线路」+ 换源/去源管理，并禁用播放/下载/投屏。
 */
const routerPush = vi.fn();
const routerReplace = vi.fn();
const routerBack = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { mediaId: 'netdisk:m1' }, query: {} }),
  useRouter: () => ({ push: routerPush, replace: routerReplace, back: routerBack }),
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
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: '尖峰时刻',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

function makePlayableDetail(): MediaDetail {
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

async function mountWithDetail(detail: MediaDetail) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const library = useLibraryStore();
  library.detail = detail;
  library.detailState = 'success';
  vi.spyOn(library, 'loadDetail').mockResolvedValue(undefined as never);
  const wrapper = mount(DetailView, { global: { plugins: [pinia] } });
  await Promise.resolve();
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe('DetailView 无剧集空态', () => {
  beforeEach(() => {
    routerPush.mockClear();
    routerReplace.mockClear();
  });

  it('详情 0 线路 0 集：展示空态与切换来源入口，播放/下载/投屏禁用', async () => {
    const wrapper = await mountWithDetail({ item: makeItem(), lines: [], episodes: [] });

    expect(wrapper.find('.detail-empty').exists()).toBe(true);
    expect(wrapper.text()).toContain('当前来源暂无可播放线路');
    expect(wrapper.text()).toContain('切换来源');
    expect(wrapper.text()).toContain('去源管理');

    const main = wrapper.find('.detail-actions__main');
    expect(main.attributes('disabled')).toBeDefined();
    expect(main.text()).toContain('暂无可播放');
    expect(wrapper.find('[aria-label^="选择集数下载"], [aria-label="下载"]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[aria-label^="投屏"]').attributes('disabled')).toBeDefined();
  });

  it('有可播剧集时不展示空态，主按钮可点击', async () => {
    const wrapper = await mountWithDetail(makePlayableDetail());

    expect(wrapper.find('.detail-empty').exists()).toBe(false);
    const main = wrapper.find('.detail-actions__main');
    expect(main.attributes('disabled')).toBeUndefined();
    expect(main.text()).toContain('播放');
    expect(wrapper.find('[aria-label^="投屏"]').exists()).toBe(true);
  });
});
