import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * StateView 接入收藏/历史（批次 22：骨架→内容硬切 + StateView 死代码）
 *
 * 两页原本各自手写 4 条 v-if/v-else-if 分支，切态时整块内容"啪"地换；
 * `StateView`（技术方案 8.2 的四态容器）带着进入动画却全仓库无人引用。
 * 这里验的是：页面确实把四态交给了 StateView，且分支优先级没被映射改掉。
 */

const routerPush = vi.fn();

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, query: {} }),
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
}));

import FavoritesView from '@/views/FavoritesView.vue';
import HistoryView from '@/views/HistoryView.vue';
import HistoryListItem from '@/components/media/HistoryListItem.vue';
import { favoriteService } from '@/services/favoriteService';
import { historyRepo } from '@/db/repositories/historyRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { historyIdOf } from '@/shared/id';
import type { FavoriteInput, HistoryRecord, Source } from '@/types';

import { resetAll, tick, FIXED_NOW } from '../unit/helpers';

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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await flushPromises();
    await tick(1);
  }
}

function stateOf(view: ReturnType<typeof mount>): string | undefined {
  return view.find('.state-view').attributes('data-state');
}

beforeEach(async () => {
  routerPush.mockClear();
  setActivePinia(createPinia());
  await resetAll();
  await sourceRepo.save(makeSource('src-1'));
});

describe('FavoritesView 四态交给 StateView', () => {
  it('空收藏走 empty 态，文案仍由页面自己的插槽提供', async () => {
    const view = mount(FavoritesView, { global: { stubs: { Teleport: true } } });
    await settle();

    expect(stateOf(view)).toBe('empty');
    expect(view.find('.state-view__panel').text()).toContain('还没有收藏');
    expect(view.find('.favorites-grid').exists()).toBe(false);
    view.unmount();
  });

  it('有收藏走 success 态并渲染卡片', async () => {
    await favoriteService.add(FAV_INPUT);
    const favorites = useFavoriteStore();
    await favorites.load();

    const view = mount(FavoritesView, { global: { stubs: { Teleport: true } } });
    await settle();

    expect(stateOf(view)).toBe('success');
    expect(view.findAll('.favorites-grid > *')).toHaveLength(1);
    view.unmount();
  });

  it('loading 态保留原「正在读取收藏…」，不是 StateView 的默认 spinner', async () => {
    const favorites = useFavoriteStore();
    const view = mount(FavoritesView, { global: { stubs: { Teleport: true } } });
    await settle();

    favorites.state = 'loading';
    await view.vm.$nextTick();

    expect(stateOf(view)).toBe('loading');
    expect(view.find('.favorites-loading').exists()).toBe(true);
    expect(view.find('.favorites-loading').text()).toContain('正在读取收藏…');
    view.unmount();
  });

  it('错误优先于空：读取失败且列表为空时不能退成「还没有收藏」', async () => {
    const favorites = useFavoriteStore();
    const view = mount(FavoritesView, { global: { stubs: { Teleport: true } } });
    await settle();

    favorites.state = 'error';
    favorites.error = {
      code: 'E_DB',
      message: '收藏读取失败',
      detail: null,
      retryable: true,
      httpStatus: null,
    };
    favorites.items = [];
    await view.vm.$nextTick();

    expect(stateOf(view)).toBe('error');
    expect(view.find('.state-view__panel').text()).toContain('收藏读取失败');
    view.unmount();
  });
});

describe('HistoryView 四态交给 StateView', () => {
  it('有 error 时走 error 态（与原 v-else-if="history.error" 的优先级一致）', async () => {
    const history = useHistoryStore();
    const view = mount(HistoryView, { global: { stubs: { Teleport: true } } });
    await settle();

    history.error = { code: 'E_DB', message: '历史读取失败', detail: null, retryable: true, httpStatus: null };
    history.items = [];
    history.state = 'success';
    await view.vm.$nextTick();

    expect(stateOf(view)).toBe('error');
    expect(view.find('.state-view__panel').text()).toContain('历史读取失败');
    view.unmount();
  });

  it('有记录走 success 态并按分组渲染', async () => {
    await historyRepo.save(HISTORY_RECORD);
    const history = useHistoryStore();
    await history.load();

    const view = mount(HistoryView, { global: { stubs: { Teleport: true } } });
    await settle();

    expect(stateOf(view)).toBe('success');
    expect(view.findAll('.history-group')).toHaveLength(1);
    view.unmount();
  });

  it('继续播放显式携带历史线路', async () => {
    const record = { ...HISTORY_RECORD, lineId: 'line-2' };
    await historyRepo.save(record);
    const view = mount(HistoryView, { global: { stubs: { Teleport: true } } });
    await settle();

    view.findComponent(HistoryListItem).vm.$emit('select', record);

    expect(routerPush).toHaveBeenCalledWith({
      name: 'player',
      params: { mediaId: record.mediaId, episodeId: record.episodeId },
      query: { lineId: 'line-2' },
    });
    view.unmount();
  });

  it('旧历史没有线路时不塞空 query，仍走 episode owner 回退', async () => {
    await historyRepo.save(HISTORY_RECORD);
    const view = mount(HistoryView, { global: { stubs: { Teleport: true } } });
    await settle();

    view.findComponent(HistoryListItem).vm.$emit('select', HISTORY_RECORD);

    expect(routerPush).toHaveBeenCalledWith({
      name: 'player',
      params: { mediaId: HISTORY_RECORD.mediaId, episodeId: HISTORY_RECORD.episodeId },
      query: {},
    });
    view.unmount();
  });
});

describe('状态切换走整块 keyed 替换（进入动画的挂点）', () => {
  it('切态后内容包装节点被换成新元素，而不是原地改文字', async () => {
    const favorites = useFavoriteStore();
    const view = mount(FavoritesView, { global: { stubs: { Teleport: true } } });
    await settle();
    expect(stateOf(view)).toBe('empty');

    const before = view.find('.state-view__content').element;

    favorites.state = 'loading';
    await view.vm.$nextTick();

    // Transition 靠 :key="state" 把旧节点换掉；happy-dom 里跑不出 CSS 类，
    // 但"换了元素"就是"有 enter 阶段"的结构前提——原地打补丁的话这里必然是同一节点。
    expect(view.find('.state-view__content').element).not.toBe(before);
    view.unmount();
  });
});
