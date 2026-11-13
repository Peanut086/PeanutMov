import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerPush = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, query: {} }),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
}));

import FavoriteCard from '@/components/media/FavoriteCard.vue';
import FavoritesView from '@/views/FavoritesView.vue';
import HistoryListItem from '@/components/media/HistoryListItem.vue';
import HistoryView from '@/views/HistoryView.vue';
import ToastHost from '@/components/common/ToastHost.vue';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { favoriteService } from '@/services/favoriteService';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useUiStore } from '@/stores/uiStore';
import { historyIdOf } from '@/shared/id';
import type { FavoriteInput, HistoryRecord, Source } from '@/types';

import { resetAll, tick, FIXED_NOW } from '../unit/helpers';

/**
 * 「删一条 → 点撤销」整条链路（P3-18 + P3-19）
 *
 * 单测各段都能过，链路仍可能断：撤销按钮渲染不出（旧 `<span>` 拿不到焦点）、
 * 服务恢复了但列表不刷新（少发事件）、恢复的记录时间戳被重算（分组/排序错位）。
 * 这里从列表页点下去，一直验到 Toast 里的撤销按钮把记录放回列表。
 */

const FAV_INPUT: FavoriteInput = {
  sourceId: 'src-1',
  mediaId: 'm-1',
  title: '肖申克的救赎',
  posterUrl: null,
  type: 'movie',
  year: 1994,
};

const HISTORY_RECORD: HistoryRecord = {
  id: historyIdOf('src-1', 'm-9'),
  sourceId: 'src-1',
  mediaId: 'm-9',
  episodeId: 'ep-3',
  episodeNumber: 3,
  title: '绝命毒师',
  posterUrl: null,
  positionSec: 1_234,
  durationSec: 3_000,
  progress: 1_234 / 3_000,
  finished: false,
  totalEpisodes: 62,
  createdAt: FIXED_NOW - 900_000,
  updatedAt: FIXED_NOW - 60_000,
  mediaSnapshot: {
    sourceItemId: 'item-9',
    type: 'series',
    year: 2008,
    episodeCount: 62,
    originalTitle: 'Breaking Bad',
  },
};

const wrappers: Array<{ unmount: () => void }> = [];

function mountAll(component: object): VueWrapper {
  // ToastHost 与页面各挂一个：同一个 pinia 才能把「点了撤销 → Toast 消失」跑通
  const toastHost = mount(ToastHost, { attachTo: document.body, global: { stubs: { Teleport: true } } });
  wrappers.push(toastHost);
  const view = mount(component, { global: { stubs: { Teleport: true } } });
  wrappers.push(view);
  return view;
}

function actionButton(): DOMWrapper<Element> {
  const el = document.querySelector('.toast__action');
  if (!el) throw new Error('撤销按钮没渲染出来');
  return new DOMWrapper(el);
}

/** 让 IndexedDB（fake-indexeddb 走宏任务）真正跑完一轮，再看界面 */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await tick(1);
  }
}

function makeSource(id: string): Source {
  return {
    id,
    key: id,
    name: `源 ${id}`,
    type: 'alist',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: 'https://alist.example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  };
}

let ui: ReturnType<typeof useUiStore>;

beforeEach(async () => {
  setActivePinia(createPinia());
  ui = useUiStore();
  await resetAll();
  await sourceRepo.save(makeSource('src-1'));
});

afterEach(() => {
  for (const wrapper of wrappers.reverse()) wrapper.unmount();
  wrappers.length = 0;
});

describe('取消收藏 → 撤销', () => {
  it('撤销按钮把整条收藏放回列表，收藏时间不变', async () => {
    const created = await favoriteService.add(FAV_INPUT);
    const aged = { ...created, createdAt: FIXED_NOW - 86_400_000 };
    await favoriteRepo.save(aged);
    const favorites = useFavoriteStore();
    await favorites.load();

    const view = mountAll(FavoritesView);
    await settle();
    expect(favorites.items).toHaveLength(1);

    view.findComponent(FavoriteCard).vm.$emit('longpress', aged);
    await view.vm.$nextTick();
    const danger = view.findAll('.sheet-list__item--danger')[0];
    expect(danger?.text()).toContain('取消收藏');
    await danger?.trigger('click');
    await settle();

    expect(favorites.items).toHaveLength(0);
    expect(ui.toasts[0]?.action?.label).toBe('撤销');

    await actionButton().trigger('click');
    await settle();

    expect(await favoriteRepo.get(aged.id)).toEqual(aged);
    expect(favorites.items.map((row) => row.id)).toEqual([aged.id]);
    expect(ui.toasts).toHaveLength(0);
  });
});

describe('删除历史记录 → 撤销', () => {
  it('撤销按原样写回：进度与所属分组（updatedAt）都不重算', async () => {
    await historyRepo.save(HISTORY_RECORD);
    const history = useHistoryStore();
    await history.load();

    const view = mountAll(HistoryView);
    await settle();
    expect(history.items).toHaveLength(1);

    view.findComponent(HistoryListItem).vm.$emit('menu', HISTORY_RECORD);
    await view.vm.$nextTick();
    const danger = view.findAll('.sheet-list__item--danger')[0];
    expect(danger?.text()).toContain('删除这条记录');
    await danger?.trigger('click');
    await settle();

    expect(history.items).toHaveLength(0);
    expect(ui.toasts[0]?.action?.label).toBe('撤销');

    await actionButton().trigger('click');
    await settle();

    expect(await historyRepo.get(HISTORY_RECORD.id)).toEqual(HISTORY_RECORD);
    expect(history.items.map((row) => row.id)).toEqual([HISTORY_RECORD.id]);
  });
});
