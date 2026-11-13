import { createPinia, setActivePinia } from 'pinia';
import { nextTick, reactive } from 'vue';
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Episode, MediaDetail, MediaItem, PlayLine } from '@/types';
import type { ProbeResult } from '@/services/lineProbeService';

/**
 * 详情页自动链路的「晚到结果」竞态
 *
 * `backgroundProbeAndSwitch`（探测预算 15s）与 `autoSwitchToPlayableSource` 都是
 * fire-and-forget：完成后原本直接写线路、弹 toast、`router.replace`，不复核用户
 * 此刻还看不看这部片子。最坏的表现是从正在看的详情页被硬拽到另一部影片。
 *
 * 每个反例都配一个正例：否则「什么都没发生」可能只是链路压根没跑起来。
 */

const routeState = reactive<{ params: Record<string, string>; query: Record<string, string> }>({
  params: { mediaId: 'src-a:m1' },
  query: {},
});

const routerReplace = vi.fn();
const probeQueue: Array<(result: ProbeResult) => void> = [];
const alternateQueue: Array<(alternate: unknown) => void> = [];
const mounted: Array<() => void> = [];
const loadQueue: Array<() => void> = [];
let loadCall = 0;

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push: vi.fn(), replace: routerReplace, back: vi.fn() }),
}));

vi.mock('@/services/castService', () => ({
  castService: { isSupported: vi.fn().mockResolvedValue(false) },
}));

// 评分选线固定返回第一条，让「探测想切到第二条」这件事可断言
vi.mock('@/services/lineRanking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/lineRanking')>();
  return {
    ...actual,
    pickBestLine: ({ lines }: { lines: PlayLine[] }): PlayLine | null => lines[0] ?? null,
  };
});

vi.mock('@/services/lineProbeService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/lineProbeService')>();
  return {
    ...actual,
    probeLines: () =>
      new Promise<ProbeResult>((resolve) => {
        probeQueue.push(resolve);
      }),
  };
});

vi.mock('@/services/libraryService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/libraryService')>();
  return {
    ...actual,
    libraryService: {
      ...actual.libraryService,
      findAlternateByTitle: () =>
        new Promise((resolve) => {
          alternateQueue.push(resolve);
        }),
    },
  };
});

// `record` 是 load() 后半段的指纹：晚到的详情响应若继续跑完，它会多被调一次
const recordCalls: string[] = [];

vi.mock('@/services/playabilityService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/playabilityService')>();
  return {
    ...actual,
    playabilityService: {
      ...actual.playabilityService,
      record: (mediaId: string): void => {
        recordCalls.push(mediaId);
      },
    },
  };
});

import DetailView from '@/views/DetailView.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useUiStore } from '@/stores/uiStore';

function makeItem(mediaId: string): MediaItem {
  const [sourceId = 'src-a', sourceItemId = 'm1'] = mediaId.split(':');
  return {
    id: mediaId,
    sourceId,
    sourceItemId,
    title: `影片 ${mediaId}`,
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
    titleLower: mediaId,
    isDemo: false,
    cachedAt: 0,
    updatedAt: 0,
  };
}

function makeLine(mediaId: string, index: number): PlayLine {
  return {
    id: `${mediaId}:${index}`,
    mediaId,
    sourceId: mediaId.split(':')[0] ?? 'src-a',
    name: `线路 ${index + 1}`,
    quality: null,
    format: 'mp4',
    index,
  };
}

/** 有线路有集：挂载后会启动后台探测 */
function makePlayableDetail(mediaId: string): MediaDetail {
  const line = makeLine(mediaId, 0);
  const episode: Episode = {
    id: `${line.id}:1`,
    mediaId,
    sourceId: line.sourceId,
    lineId: line.id,
    number: 1,
    title: '第 1 集',
    durationSec: null,
    subtitles: [],
    updatedAt: 0,
  };
  return { item: makeItem(mediaId), lines: [line, makeLine(mediaId, 1)], episodes: [episode] };
}

/** 0 线路 0 集：挂载后会启动自动换源 */
function makeEmptyDetail(mediaId: string): MediaDetail {
  return { item: makeItem(mediaId), lines: [], episodes: [] };
}

/** 详情页的链路要穿过 onMounted 里的三个 store load + IDB，需要多轮宏任务才落地 */
async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }
}

async function mountDetail(mediaId: string, detail: MediaDetail, deferFirstLoad = false) {
  routeState.params.mediaId = mediaId;
  routeState.query = {};
  const pinia = createPinia();
  setActivePinia(pinia);
  const library = useLibraryStore();
  library.detail = detail;
  library.detailState = 'success';
  // onMounted 先串了三个 store load（走 IDB），冷启动时它们要几百毫秒才落地，
  // 用例里等不到就会把上一条链漏到下一个用例的队列里。这里直接掐掉。
  vi.spyOn(useHistoryStore(), 'load').mockResolvedValue(undefined as never);
  vi.spyOn(useFavoriteStore(), 'load').mockResolvedValue(undefined as never);
  vi.spyOn(useDownloadStore(), 'load').mockResolvedValue(undefined as never);
  vi.spyOn(library, 'loadDetail').mockImplementation(() => {
    loadCall += 1;
    const defer = deferFirstLoad && loadCall === 1;
    return new Promise<void>((resolve) => {
      loadQueue.push(resolve);
      if (!defer) resolve();
    });
  });
  const wrapper = mount(DetailView, { global: { plugins: [pinia] } });
  // 共享的 routeState 会被上一个用例里仍然挂载的实例监听到，
  // 它们各自的 watch(mediaId) 会再发起一次换源请求，把队列数量搞乱。
  mounted.push(() => wrapper.unmount());
  await settle();
  return { wrapper, library, ui: useUiStore() };
}

function toastTexts(ui: ReturnType<typeof useUiStore>): string {
  return ui.toasts.map((record) => record.text).join('|');
}

describe('DetailView 自动链路晚到结果', () => {
  beforeEach(() => {
    probeQueue.length = 0;
    alternateQueue.length = 0;
    loadQueue.length = 0;
    recordCalls.length = 0;
    loadCall = 0;
    routerReplace.mockClear();
  });

  afterEach(() => {
    for (const dispose of mounted.splice(0)) dispose();
  });

  it('正例：探测到的可播线路在当前影片上会真的切换并提示', async () => {
    const { ui } = await mountDetail('src-a:m1', makePlayableDetail('src-a:m1'));
    expect(probeQueue.length).toBe(1);

    probeQueue[0]?.({ probedCount: 2, successLineId: 'src-a:m1:1', allFailed: false });
    await settle(4);

    expect(toastTexts(ui)).toContain('已选到可播线路');
  });

  it('离开详情页后晚到的探测结果不再改写线路', async () => {
    const { wrapper, ui } = await mountDetail('src-a:m1', makePlayableDetail('src-a:m1'));
    expect(probeQueue.length).toBe(1);

    wrapper.unmount();
    probeQueue[0]?.({ probedCount: 2, successLineId: 'src-a:m1:1', allFailed: false });
    await settle(4);

    expect(toastTexts(ui)).not.toContain('已选到可播线路');
  });

  it('正例：0 集影片自动换源成功后跳到候选媒体', async () => {
    await mountDetail('src-a:m1', makeEmptyDetail('src-a:m1'));
    expect(alternateQueue.length).toBe(1);

    alternateQueue[0]?.({ mediaId: 'src-b:m9', sourceName: '备用源' });
    await settle(4);

    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace.mock.calls[0]?.[0]).toMatchObject({ params: { mediaId: 'src-b:m9' } });
  });

  it('用户已翻到别的影片时，晚到的换源结果不再劫持路由', async () => {
    const { library } = await mountDetail('src-a:m1', makeEmptyDetail('src-a:m1'));
    expect(alternateQueue.length).toBe(1);

    // 用户在探测期间点开了另一部影片（A→B，换源请求 #0 仍在飞）
    library.detail = makeEmptyDetail('src-a:m2');
    library.detailState = 'success';
    routeState.params.mediaId = 'src-a:m2';
    await settle();
    expect(alternateQueue.length).toBe(2);

    alternateQueue[0]?.({ mediaId: 'src-b:m9', sourceName: '备用源' });
    await settle(4);

    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('已退出详情页时，晚到的换源结果不再跳转', async () => {
    const { wrapper } = await mountDetail('src-a:m1', makeEmptyDetail('src-a:m1'));
    expect(alternateQueue.length).toBe(1);

    wrapper.unmount();
    alternateQueue[0]?.({ mediaId: 'src-b:m9', sourceName: '备用源' });
    await settle(4);

    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('线路全挂触发的兜底换源同样受身份校验约束', async () => {
    const { wrapper, ui } = await mountDetail('src-a:m1', makePlayableDetail('src-a:m1'));
    expect(probeQueue.length).toBe(1);

    // allFailed → 走 autoSwitchToPlayableSource（换源请求 #0）
    probeQueue[0]?.({ probedCount: 2, successLineId: null, allFailed: true });
    await settle(4);
    expect(alternateQueue.length).toBe(1);

    wrapper.unmount();
    alternateQueue[0]?.({ mediaId: 'src-b:m9', sourceName: '备用源' });
    await settle(4);

    expect(routerReplace).not.toHaveBeenCalled();
    expect(toastTexts(ui)).not.toContain('已自动切换到');
  });

  it('换到别的影片又翻回本片时，最早那次换源结果同样作废', async () => {
    const { library } = await mountDetail('src-a:m1', makeEmptyDetail('src-a:m1'));
    expect(alternateQueue.length).toBe(1);

    // A → B → A：媒体 ID 回到发起时的值，光比 ID 已经查不出过期
    library.detail = makeEmptyDetail('src-a:m2');
    routeState.params.mediaId = 'src-a:m2';
    await settle();
    library.detail = makeEmptyDetail('src-a:m1');
    routeState.params.mediaId = 'src-a:m1';
    await settle();
    expect(alternateQueue.length).toBe(3);

    alternateQueue[0]?.({ mediaId: 'src-b:m9', sourceName: '备用源' });
    await settle(4);

    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('详情响应晚到时不再跑完后半段（选线 / 回填 / 触发自动换源）', async () => {
    const { library } = await mountDetail('src-a:m1', makePlayableDetail('src-a:m1'), true);
    expect(loadQueue.length).toBe(1);
    expect(recordCalls).toEqual([]);

    // 详情还没回来，用户已经点开了另一部 0 集的影片
    library.detail = makeEmptyDetail('src-a:m2');
    routeState.params.mediaId = 'src-a:m2';
    await settle();
    expect(recordCalls).toEqual(['src-a:m2']);
    expect(alternateQueue.length).toBe(1);

    loadQueue[0]?.();
    await settle(4);

    expect(recordCalls).toEqual(['src-a:m2']);
    expect(alternateQueue.length).toBe(1);
  });
});
