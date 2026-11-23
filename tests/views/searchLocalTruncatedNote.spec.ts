/**
 * OPT-21：本地扫描被时间预算截断这件事，最后要落到屏幕上那行字
 *
 * store 层的 `searchLocalTruncated` 只是数据；用户看得见的是搜索页两处文案：
 * 空结果时它顶替「换个关键词」，有结果时它和「剩余 N 个源未搜索」并排各说各的。
 * 两处都只在一个标志位为真时出现，且不能盖掉既有披露——这里把口径钉住。
 */
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { routeLocationKey, routerKey } from 'vue-router';
import { nextTick } from 'vue';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import SearchView from '@/views/SearchView.vue';
import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSourceStore } from '@/stores/sourceStore';
import type { MediaItem, SearchResult, Source } from '@/types';
import { resetAll } from '../unit/helpers';

const NOTE = '本地缓存只扫描了前面一部分记录';
const SKIPPED_NOTE = '因超时未搜索';

function makeItem(title: string): MediaItem {
  const now = Date.now();
  return {
    id: `demo:${title}`,
    sourceId: 'demo',
    sourceItemId: title,
    title,
    originalTitle: null,
    type: 'movie',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: title.toLowerCase(),
    isDemo: false,
    cachedAt: now,
    updatedAt: now,
  } as MediaItem;
}

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    items: [],
    sourceIds: [],
    failed: [],
    candidates: 1,
    filteredOut: 0,
    skippedSourceIds: [],
    localTruncated: false,
    ...overrides,
  };
}

/** 结果并入上屏列表的前提是「源仍存在且启用」，所以要用一个真实存在于库里的源 */
function makeSource(): Source {
  const now = Date.now();
  return {
    id: 'demo',
    key: 'demo',
    name: '演示源',
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: 'https://demo.example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    autoDisabledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

/** 搜索页挂在真实路由之外：只提供 `useRoute` / `useRouter` 需要的注入键 */
function mountView(): VueWrapper {
  return mount(SearchView, {
    global: {
      provide: {
        [routerKey as unknown as symbol]: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), go: vi.fn() },
        [routeLocationKey as unknown as symbol]: {
          query: {},
          params: {},
          path: '/search',
          fullPath: '/search',
          hash: '',
          matched: [],
        },
      },
    },
  });
}

describe('SearchView 本地扫描截断披露（OPT-21）', () => {
  // 整份库重置只做一次：`resetAll()` 里的 `downloadService.__resetQueue()` 在同一 worker 里
  // 第二次跑会撞上未提交改动引入的 `resetDownloadNotices`（模块图里的符号此时取不到）。
  // 用例之间靠「新建 pinia + 重置设置缓存」隔离，数据面只有 demo 源一处写入。
  beforeAll(async () => {
    await resetAll();
  });

  beforeEach(async () => {
    settingsService.__resetCache();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 先搜（结果写进 store），再挂载：屏幕读的就是这份状态 */
  async function searchAndMount(overrides: Partial<SearchResult>): Promise<VueWrapper> {
    await sourceRepo.save(makeSource());
    await useSourceStore().load();
    vi.spyOn(libraryService, 'search').mockResolvedValue(result(overrides));
    await useLibraryStore().search('庆余年');
    await flush();
    const wrapper = mountView();
    await flush();
    return wrapper;
  }

  it('空结果：截断说明顶替「换个关键词」', async () => {
    const wrapper = await searchAndMount({ localTruncated: true });
    expect(wrapper.text()).toContain(NOTE);
    expect(wrapper.text()).not.toContain('换个关键词，或检查源是否启用');
    wrapper.unmount();
  });

  it('空结果：没截断时不出现这句话', async () => {
    const wrapper = await searchAndMount({ localTruncated: false });
    expect(wrapper.text()).not.toContain(NOTE);
    expect(wrapper.text()).toContain('换个关键词，或检查源是否启用');
    wrapper.unmount();
  });

  it('空结果：远程覆盖缺口在前，本地截断不抢话', async () => {
    const wrapper = await searchAndMount({ localTruncated: true, skippedSourceIds: ['s9'], candidates: 3 });
    expect(wrapper.text()).toContain(SKIPPED_NOTE);
    expect(wrapper.text()).not.toContain(NOTE);
    wrapper.unmount();
  });

  it('有结果：截断说明与「剩余源未搜索」并排各说一条', async () => {
    const wrapper = await searchAndMount({
      items: [makeItem('庆余年')],
      sourceIds: ['demo'],
      localTruncated: true,
      skippedSourceIds: ['s9'],
      candidates: 3,
    });
    const notes = [
      wrapper.find('.search-skipped-disclosure__text').text(),
      wrapper.find('.search-expanded-note').text(),
    ];
    expect(notes.some((t) => t.includes(SKIPPED_NOTE))).toBe(true);
    expect(notes.some((t) => t.includes(NOTE))).toBe(true);
    wrapper.unmount();
  });

  it('有结果：没截断时只剩远程那条', async () => {
    const wrapper = await searchAndMount({
      items: [makeItem('庆余年')],
      sourceIds: ['demo'],
      localTruncated: false,
      skippedSourceIds: ['s9'],
      candidates: 3,
    });
    expect(wrapper.text()).toContain(SKIPPED_NOTE);
    // 结果态而非空态：远程那条走的是披露组件，不是空态描述文案
    expect(wrapper.find('.search-skipped-disclosure__text').exists()).toBe(true);
    expect(wrapper.find('.search-expanded-note').exists()).toBe(false);
    expect(wrapper.text()).not.toContain(NOTE);
    wrapper.unmount();
  });
});