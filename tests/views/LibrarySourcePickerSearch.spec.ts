/**
 * 媒体库源选择搜索防抖（EXT 批次 23）
 *
 * 定制订阅常有几十上百个源，`filteredSources` 每敲一个键都要重跑一遍过滤 + `localeCompare`
 * 全表重排。这里把生效关键词延后 300ms（`committedSourceKeyword`），输入框本身仍然跟手。
 *
 * 页面装配用真 store（sourceStore / libraryStore），只把网络层（sourceService /
 * libraryService 的分页拉取）与路由、Toast 换掉；弹层用薄壳替代真 BottomSheet。
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

vi.mock('vue-router', () => ({
  useRouter: () => routerMocks,
  useRoute: () => routeMocks,
  onBeforeRouteLeave: () => undefined,
}));

vi.mock('@/composables/useToast', () => ({ useToast: () => toastMocks }));

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
      browse: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false })),
      listCategories: vi.fn(async () => []),
      listAreas: vi.fn(async () => []),
      listRecent: vi.fn(async () => []),
      pickFallbackSource: vi.fn(async () => null),
    },
  };
});

import LibraryView from '@/views/LibraryView.vue';
import { sourceService } from '@/services/sourceService';
import { useSourceStore } from '@/stores/sourceStore';
import type { Source } from '@/types';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await flush();
}

function makeSource(id: string, name: string): Source {
  const now = Date.now();
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
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

const NAMES = ['阿尔法源', '贝塔源', '芒果源', '豆瓣热榜源'];

const wrappers: VueWrapper[] = [];

async function mountView(): Promise<VueWrapper> {
  const wrapper = mount(LibraryView, {
    global: {
      stubs: {
        AppHeader: true,
        SafeArea: { template: '<div><slot /></div>' },
        OfflineBanner: true,
        PosterGrid: true,
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

function pickerItems(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.source-picker__list li button .truncate-1')
    .map((node) => node.text());
}

beforeEach(async () => {
  setActivePinia(createPinia());
  routeMocks.query = {};
  vi.mocked(sourceService.list).mockResolvedValue(
    NAMES.map((name, index) => makeSource(`src-${index}`, name)),
  );
});

afterEach(() => {
  for (const wrapper of wrappers.splice(0)) wrapper.unmount();
});

describe('LibraryView 源搜索防抖（批次 23）', () => {
  async function openPicker(wrapper: VueWrapper): Promise<void> {
    await wrapper.find('.library-toolbar__btn').trigger('click');
    await settle(2);
  }

  it('防抖窗口内不重排，300ms 后一次到位', async () => {
    const wrapper = await mountView();
    await openPicker(wrapper);
    expect(pickerItems(wrapper)).toHaveLength(4);

    await wrapper.find('.source-picker__search-input').setValue('芒果');

    await settle(2);
    expect(pickerItems(wrapper), '未到防抖窗口不应重排').toHaveLength(4);

    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(pickerItems(wrapper)).toEqual(['芒果源']);
  });

  it('输入框跟手：防抖期间显示值已是最终输入', async () => {
    const wrapper = await mountView();
    await openPicker(wrapper);
    const input = wrapper.find('.source-picker__search-input');
    await input.setValue('豆瓣热');

    await settle(2);
    expect((input.element as HTMLInputElement).value).toBe('豆瓣热');
    expect(pickerItems(wrapper)).toHaveLength(4);
  });

  it('点「清除」立即恢复全表，不等一个防抖周期', async () => {
    const wrapper = await mountView();
    await openPicker(wrapper);
    const input = wrapper.find('.source-picker__search-input');

    await input.setValue('阿尔法');
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(pickerItems(wrapper)).toEqual(['阿尔法源']);

    await wrapper.find('.source-picker__search-clear').trigger('click');
    await settle(2);
    expect(pickerItems(wrapper)).toHaveLength(4);
    expect((input.element as HTMLInputElement).value).toBe('');
  });

  it('关键词删回空同样立即生效', async () => {
    const wrapper = await mountView();
    await openPicker(wrapper);
    const input = wrapper.find('.source-picker__search-input');

    await input.setValue('贝塔');
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(pickerItems(wrapper)).toEqual(['贝塔源']);

    await input.setValue('');
    await settle(2);
    expect(pickerItems(wrapper)).toHaveLength(4);
  });

  it('选中源后关键词作废：再次打开弹层回到全表', async () => {
    const wrapper = await mountView();
    await openPicker(wrapper);

    await wrapper.find('.source-picker__search-input').setValue('芒果');
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    await wrapper.find('.source-picker__list li button').trigger('click');
    await settle();

    await openPicker(wrapper);
    expect(pickerItems(wrapper)).toHaveLength(4);
    expect((wrapper.find('.source-picker__search-input').element as HTMLInputElement).value).toBe(
      '',
    );
    // 挂起的提交（若有）也不能在新一次打开后再把列表压回去
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(pickerItems(wrapper)).toHaveLength(4);
  });

  it('源列表为空时搜索不炸，并给出「没有匹配的源」', async () => {
    vi.mocked(sourceService.list).mockResolvedValue([]);
    const wrapper = await mountView();
    await openPicker(wrapper);

    await wrapper.find('.source-picker__search-input').setValue('不存在');
    await new Promise((resolve) => setTimeout(resolve, 350));
    await settle();
    expect(pickerItems(wrapper)).toHaveLength(0);
    expect(wrapper.find('.sheet-empty').text()).toBe('没有匹配的源');
    expect(useSourceStore().sources).toHaveLength(0);
  });
});
