import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';

import type { DownloadTask, Episode, MediaDetail, MediaItem, PlayLine } from '@/types';

/**
 * 详情页「选集胶片墙」接线（G-B07）
 *
 * 抽帧本身由 `episodeFilmService` 负责（有独立单测），这里只锁详情页的四件事：
 * 1. 只有「已下载 + 落盘成文件 + 时长已知」的集才算数，且至少 2 集才给开关；
 * 2. 开关打开才排队，关掉一帧都不抽；
 * 3. 服务给出的画面按集 id 透传给列表，等待态同理；
 * 4. 选择记在本地，下次进详情页还在。
 */

const film = vi.hoisted(() => ({
  supported: { value: true },
  request: vi.fn(),
  frames: new Map<string, string[]>(),
  waiting: new Set<string>(),
}));

vi.mock('@/services/episodeFilmService', () => ({
  episodeFilmSupported: () => film.supported.value,
  requestEpisodeFilms: film.request,
  episodeFilmOf: (path: string | null | undefined) => (path ? film.frames.get(path) ?? [] : []),
  episodeFilmWaiting: (path: string | null | undefined) => (path ? film.waiting.has(path) : false),
}));

const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { mediaId: 'demo:m1' }, query: {} }),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  onBeforeRouteLeave: () => undefined,
}));

vi.mock('@/services/castService', () => ({
  castService: { isSupported: vi.fn().mockResolvedValue(false) },
}));

import DetailView from '@/views/DetailView.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useLibraryStore } from '@/stores/libraryStore';

const LINE: PlayLine = {
  id: 'demo:m1:0',
  mediaId: 'demo:m1',
  sourceId: 'demo',
  name: '线路 1',
  quality: null,
  format: 'mp4',
  index: 0,
};

function makeItem(): MediaItem {
  return {
    id: 'demo:m1',
    sourceId: 'demo',
    sourceItemId: 'm1',
    title: '胶片测试剧',
    originalTitle: null,
    type: 'series',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: 3,
    titleLower: '胶片测试剧',
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

function makeEpisode(number: number, durationSec: number | null): Episode {
  return {
    id: `demo:m1:0:${number}`,
    mediaId: 'demo:m1',
    sourceId: 'demo',
    lineId: LINE.id,
    number,
    title: `第 ${number} 集`,
    durationSec,
    subtitles: [],
    updatedAt: 0,
  };
}

/** 已完成下载的任务：默认落盘成文件，路径可由 `finalFilePathOf` 直接推出 */
function makeTask(number: number, overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: `task-${number}`,
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: `demo:m1:0:${number}`,
    episodeNumber: number,
    title: '胶片测试剧',
    episodeTitle: `第 ${number} 集`,
    posterUrl: null,
    url: 'https://example.test/v.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'completed',
    priority: number,
    totalBytes: 1000,
    downloadedBytes: 1000,
    speedBps: 0,
    retries: 0,
    maxRetries: 3,
    resumable: true,
    sink: 'filesystem',
    filePath: `downloads/m1/e${number}.mp4`,
    blobKey: null,
    ...overrides,
  } as DownloadTask;
}

/** 抓住详情页传给列表的胶片三件套，避免依赖 EpisodeList 的真实渲染 */
const ListStub = defineComponent({
  name: 'EpisodeList',
  props: {
    episodes: { type: Array, default: () => [] },
    film: { type: Boolean, default: false },
    filmFrames: { type: Object, default: () => ({}) },
    filmWaiting: { type: Array, default: () => [] },
  },
  template: '<div class="list-stub" />',
});

function propsOf(wrapper: Awaited<ReturnType<typeof mountDetail>>) {
  const stub = wrapper.findComponent(ListStub);
  return {
    film: stub.props('film') as boolean,
    frames: stub.props('filmFrames') as Record<string, string>,
    waiting: stub.props('filmWaiting') as string[],
  };
}

async function mountDetail(detail: MediaDetail, tasks: DownloadTask[]) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const library = useLibraryStore();
  library.detail = detail;
  library.detailState = 'success';
  vi.spyOn(library, 'loadDetail').mockResolvedValue(undefined as never);
  const downloads = useDownloadStore();
  downloads.tasks = tasks;

  const wrapper = mount(DetailView, {
    global: { plugins: [pinia], stubs: { EpisodeList: ListStub } },
  });
  await flushPromises();
  return wrapper;
}

function detailWith(episodes: Episode[]): MediaDetail {
  return { item: makeItem(), lines: [LINE], episodes };
}

beforeEach(() => {
  localStorage.clear();
  film.supported.value = true;
  film.request.mockReset();
  film.frames.clear();
  film.waiting.clear();
  routerPush.mockClear();
});

describe('DetailView 选集胶片墙', () => {
  it('两集以上「已下载 + 时长已知」才给开关', async () => {
    const episodes = [makeEpisode(1, 600), makeEpisode(2, 600), makeEpisode(3, 600)];
    const wrapper = await mountDetail(
      detailWith(episodes),
      [makeTask(1), makeTask(2)],
    );

    const switchBtn = wrapper.find('.film-switch');
    expect(switchBtn.exists()).toBe(true);
    expect(switchBtn.attributes('aria-pressed')).toBe('false');
    expect(propsOf(wrapper).film).toBe(false);
  });

  it('只下载了一集：没有开关（单格墙比数字芯片更空）', async () => {
    const wrapper = await mountDetail(detailWith([makeEpisode(1, 600), makeEpisode(2, 600)]), [makeTask(1)]);
    expect(wrapper.find('.film-switch').exists()).toBe(false);
  });

  it('时长未知的下载集不算数；没下载的集也不算', async () => {
    const wrapper = await mountDetail(
      detailWith([makeEpisode(1, null), makeEpisode(2, 600), makeEpisode(3, 600)]),
      [makeTask(1), makeTask(2)],
    );
    // 只有第 2 集可抽 → 1 个目标 → 不给开关
    expect(wrapper.find('.film-switch').exists()).toBe(false);
  });

  it('blob 落盘没有文件可随机读，不进胶片目标', async () => {
    const wrapper = await mountDetail(
      detailWith([makeEpisode(1, 600), makeEpisode(2, 600)]),
      [makeTask(1, { sink: 'idb-blob', filePath: null, blobKey: 'b1' }), makeTask(2, { sink: 'idb-blob', filePath: null, blobKey: 'b2' })],
    );
    expect(wrapper.find('.film-switch').exists()).toBe(false);
  });

  it('这台机器没有抽帧桥时不给开关，也不排队抽帧', async () => {
    film.supported.value = false;
    const wrapper = await mountDetail(
      detailWith([makeEpisode(1, 600), makeEpisode(2, 600)]),
      [makeTask(1), makeTask(2)],
    );
    expect(wrapper.find('.film-switch').exists()).toBe(false);
    expect(film.request).not.toHaveBeenCalled();
  });

  it('打开开关：按集排一次队，并把画面与等待态交给列表', async () => {
    film.frames.set('downloads/m1/e1.mp4', ['data:image/jpeg;base64,AAA']);
    film.waiting.add('downloads/m1/e2.mp4');
    const wrapper = await mountDetail(
      detailWith([makeEpisode(1, 600), makeEpisode(2, 600)]),
      [makeTask(1), makeTask(2)],
    );

    await wrapper.find('.film-switch').trigger('click');
    await flushPromises();

    expect(film.request).toHaveBeenCalledTimes(1);
    expect(film.request.mock.calls[0]?.[0]).toEqual([
      { episodeId: 'demo:m1:0:1', path: 'downloads/m1/e1.mp4', durationSec: 600 },
      { episodeId: 'demo:m1:0:2', path: 'downloads/m1/e2.mp4', durationSec: 600 },
    ]);
    const state = propsOf(wrapper);
    expect(state.film).toBe(true);
    expect(state.frames).toEqual({ 'demo:m1:0:1': 'data:image/jpeg;base64,AAA' });
    expect(state.waiting).toEqual(['demo:m1:0:2']);
  });

  it('关掉开关后不再排队，列表退回数字芯片', async () => {
    const wrapper = await mountDetail(
      detailWith([makeEpisode(1, 600), makeEpisode(2, 600)]),
      [makeTask(1), makeTask(2)],
    );
    await wrapper.find('.film-switch').trigger('click');
    await flushPromises();
    expect(propsOf(wrapper).film).toBe(true);

    await wrapper.find('.film-switch').trigger('click');
    await flushPromises();

    expect(propsOf(wrapper).film).toBe(false);
    // 一共只排过一轮：关→开→关，第二次开之后没有新的请求
    expect(film.request).toHaveBeenCalledTimes(1);
  });

  it('下载状态变化会补排队，但只在开关打开时', async () => {
    const episodes = [makeEpisode(1, 600), makeEpisode(2, 600)];
    const tasks = [makeTask(1)];
    const wrapper = await mountDetail(detailWith(episodes), tasks);
    expect(wrapper.find('.film-switch').exists()).toBe(false);

    // 第 2 集下载完：够两集了，开关出现，但用户没开 → 一帧都不抽
    const downloads = useDownloadStore();
    downloads.tasks = [...tasks, makeTask(2)];
    await flushPromises();
    expect(wrapper.find('.film-switch').exists()).toBe(true);
    expect(film.request).not.toHaveBeenCalled();

    await wrapper.find('.film-switch').trigger('click');
    await flushPromises();
    expect(film.request).toHaveBeenCalledTimes(1);
  });

  it('选择记在本地：下次进详情页还是胶片墙', async () => {
    const episodes = [makeEpisode(1, 600), makeEpisode(2, 600)];
    const tasks = [makeTask(1), makeTask(2)];
    const first = await mountDetail(detailWith(episodes), tasks);
    await first.find('.film-switch').trigger('click');
    await flushPromises();
    expect(localStorage.getItem('detail.episodeFilm')).toBe('1');

    const again = await mountDetail(detailWith(episodes), tasks);
    expect(again.find('.film-switch').attributes('aria-pressed')).toBe('true');
    expect(propsOf(again).film).toBe(true);

    await again.find('.film-switch').trigger('click');
    await flushPromises();
    expect(localStorage.getItem('detail.episodeFilm')).toBe('0');
  });
});
