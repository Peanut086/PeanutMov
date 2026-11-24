import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';

import type { DownloadTask, HistoryRecord, MediaItem } from '@/types';

/**
 * 首页「继续观看」补帧接线（G-B08）
 *
 * 抽帧与"哪条历史对应哪个成品"的判定都在 `resumeFrameService`（有独立单测），
 * 这里只锁首页的编排：
 * 1. 只有对得上本机成品的历史才排队，在线源 / blob 落盘 / 集号不符 / 停在 0 秒都不排；
 * 2. 位置推进（看完一集回首页）会再排一次，不复用半分钟前的画面；
 * 3. 下载状态变化也会补排（新下完的那集不该一直显示海报）；
 * 4. 抽到的帧按历史 id 交给横滑区，没有就是空对象（卡片继续用海报）；
 * 5. 没有抽帧桥时完全不碰这个能力。
 */

const film = vi.hoisted(() => ({
  supported: { value: true },
  request: vi.fn(),
  frames: new Map<string, string>(),
}));

vi.mock('@/services/resumeFrameService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/resumeFrameService')>();
  return {
    ...actual,
    resumeFrameSupported: () => film.supported.value,
    requestResumeFrames: film.request,
    resumeFrameOf: (key: string | null | undefined) => (key ? film.frames.get(key) ?? null : null),
  };
});

const routerPush = vi.fn();
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/', query: {} }),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
  RouterLink: defineComponent({
    name: 'RouterLink',
    props: { to: { type: [String, Object], default: '' } },
    template: '<a><slot /></a>',
  }),
}));

import HomeView from '@/views/HomeView.vue';
import { resumeFrameKey } from '@/services/resumeFrameService';
import { useDownloadStore } from '@/stores/downloadStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';

const ROW = defineComponent({
  name: 'ContinueWatchingRow',
  props: {
    items: { type: Array, default: () => [] },
    frames: { type: Object, default: () => ({}) },
    compact: { type: Boolean, default: false },
  },
  template: '<div class="row-stub" />',
});

function makeRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 'h1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:0:2',
    episodeNumber: 2,
    title: '影片一',
    posterUrl: 'https://example.test/p.jpg',
    positionSec: 102.6,
    durationSec: 600,
    progress: 0.17,
    finished: false,
    totalEpisodes: 12,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as HistoryRecord;
}

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: 't1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:0:2',
    episodeNumber: 2,
    title: '影片一',
    episodeTitle: '第 2 集',
    posterUrl: null,
    url: 'https://example.test/v.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'completed',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 1000,
    speedBps: 0,
    retries: 0,
    maxRetries: 3,
    resumable: true,
    sink: 'filesystem',
    filePath: 'downloads/m1/e2.mp4',
    blobKey: null,
    ...overrides,
  } as DownloadTask;
}

async function mountHome(records: HistoryRecord[], tasks: DownloadTask[], recent: MediaItem[] = []) {
  const pinia = createPinia();
  setActivePinia(pinia);
  useHistoryStore().continueWatching = records;
  useDownloadStore().tasks = tasks;
  const library = useLibraryStore();
  library.homeRecent = recent;
  library.homeState = 'success';

  const wrapper = mount(HomeView, { global: { plugins: [pinia], stubs: { ContinueWatchingRow: ROW } } });
  await flushPromises();
  return wrapper;
}

/** 最近一次排队请求里的目标（首页只调一次，之后每次变化再调一次） */
function lastTargets(): { path: string; positionSec: number }[] {
  const call = film.request.mock.calls.at(-1);
  return (call?.[0] ?? []) as { path: string; positionSec: number }[];
}

function framesPropOf(wrapper: Awaited<ReturnType<typeof mountHome>>): Record<string, string> {
  return wrapper.findComponent(ROW).props('frames') as Record<string, string>;
}

beforeEach(() => {
  film.supported.value = true;
  film.request.mockReset();
  film.frames.clear();
  routerPush.mockClear();
});

describe('HomeView KeepAlive 入场动画', () => {
  it('首次进入播放卡片入场动画，回插首页时不重播', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const library = useLibraryStore();
    library.homeRecent = [
      {
        id: 'demo:m1',
        sourceId: 'demo',
        title: '影片一',
        posterUrl: 'https://example.test/p.jpg',
        year: 2024,
        type: 'movie',
        episodeCount: null,
        isDemo: false,
      } as MediaItem,
    ];
    library.homeState = 'success';

    const Host = defineComponent({
      components: { HomeView },
      setup() {
        const showHome = ref(true);
        return { showHome };
      },
      template: '<KeepAlive><HomeView v-if="showHome" /></KeepAlive>',
    });
    const wrapper = mount(Host, {
      global: { plugins: [pinia], stubs: { ContinueWatchingRow: ROW } },
    });
    await flushPromises();

    expect(wrapper.find('.home-grid__item').classes()).toContain('home-grid__item--enter');

    wrapper.vm.showHome = false;
    await nextTick();
    wrapper.vm.showHome = true;
    await flushPromises();

    expect(wrapper.find('.home-grid__item').classes()).not.toContain('home-grid__item--enter');
  });
});

describe('HomeView 续播帧补队', () => {
  it('对得上本机成品的历史：排一帧，位置就是记录里的位置', async () => {
    await mountHome([makeRecord()], [makeTask()]);

    expect(film.request).toHaveBeenCalledTimes(1);
    expect(lastTargets()).toEqual([{ path: 'downloads/m1/e2.mp4', positionSec: 102.6 }]);
  });

  it('在线源（没有下载任务）：一个都不排', async () => {
    await mountHome([makeRecord()], []);
    expect(lastTargets()).toEqual([]);
  });

  it('blob 落盘 / 集号对不上 / 停在 0 秒：都不排', async () => {
    await mountHome(
      [
        makeRecord({ id: 'hBlob', positionSec: 100 }),
        makeRecord({ id: 'hOther', episodeId: 'demo:m1:0:9', positionSec: 100 }),
        makeRecord({ id: 'hZero', positionSec: 0 }),
      ],
      [makeTask({ id: 'tBlob', sink: 'idb-blob', filePath: null, blobKey: 'b' })],
    );

    expect(lastTargets()).toEqual([]);
  });

  it('没有抽帧桥：完全不碰这个能力', async () => {
    film.supported.value = false;
    await mountHome([makeRecord()], [makeTask()]);
    expect(film.request).not.toHaveBeenCalled();
  });

  it('多条历史一起排，顺序按列表来', async () => {
    const second = makeRecord({ id: 'h2', mediaId: 'demo:m2', episodeId: 'demo:m2:0:1', positionSec: 40 });
    await mountHome(
      [makeRecord(), second],
      [makeTask(), makeTask({ id: 't2', mediaId: 'demo:m2', episodeId: 'demo:m2:0:1', filePath: 'downloads/m2/e1.mp4' })],
    );

    expect(lastTargets()).toEqual([
      { path: 'downloads/m1/e2.mp4', positionSec: 102.6 },
      { path: 'downloads/m2/e1.mp4', positionSec: 40 },
    ]);
  });

  it('看完一集回首页（位置推进）会再排一次，不复用旧位置', async () => {
    await mountHome([makeRecord()], [makeTask()]);
    expect(film.request).toHaveBeenCalledTimes(1);

    useHistoryStore().continueWatching = [makeRecord({ positionSec: 220 })];
    await flushPromises();

    expect(film.request).toHaveBeenCalledTimes(2);
    expect(lastTargets()).toEqual([{ path: 'downloads/m1/e2.mp4', positionSec: 220 }]);
  });

  it('新下完一集也会补排（那集不该一直显示海报）', async () => {
    await mountHome([makeRecord()], []);
    expect(film.request).toHaveBeenCalledTimes(1);
    expect(lastTargets()).toEqual([]);

    useDownloadStore().tasks = [makeTask()];
    await flushPromises();

    expect(film.request).toHaveBeenCalledTimes(2);
    expect(lastTargets()).toEqual([{ path: 'downloads/m1/e2.mp4', positionSec: 102.6 }]);
  });

  it('抽到的帧按历史 id 交给横滑区', async () => {
    film.frames.set(resumeFrameKey('downloads/m1/e2.mp4', 102.6), 'data:image/jpeg;base64,AAA');

    const wrapper = await mountHome([makeRecord()], [makeTask()]);

    expect(framesPropOf(wrapper)).toEqual({ h1: 'data:image/jpeg;base64,AAA' });
  });

  it('没抽到帧时 frames 是空对象（卡片继续用海报）', async () => {
    const wrapper = await mountHome([makeRecord()], [makeTask()]);
    expect(framesPropOf(wrapper)).toEqual({});
  });
});
