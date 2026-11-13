import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { appEvents } from '@/services/events';
import { favoriteService } from '@/services/favoriteService';
import { historyService } from '@/services/historyService';
import { historyIdOf } from '@/shared/id';
import type { FavoriteInput, FavoriteRecord, HistoryRecord, Source } from '@/types';

import { resetAll, FIXED_NOW } from './helpers';

/**
 * 删除撤销的落库原语（P3-19）
 *
 * 「已取消收藏 / 已删除该条记录」后面那个撤销按钮，背后必须是一条**原样写回**的路径：
 * 收藏走 `add(input)` 会重算 `createdAt` 并抹掉 `sourceRemoved`，撤销回来后排序位与
 * 源状态都变了；历史走 `saveProgress` 同理会按当前时间重算进度归属。
 * 所以撤销只能用 `restore(record)`，测的就是「字段一位不动」。
 */

const INPUT: FavoriteInput = {
  sourceId: 'src-1',
  mediaId: 'm-1',
  title: '肖申克的救赎',
  posterUrl: null,
  type: 'movie',
  year: 1994,
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

const HISTORY_RECORD: HistoryRecord = {
  id: historyIdOf('src-1', 'm-1'),
  sourceId: 'src-1',
  mediaId: 'm-1',
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

beforeEach(async () => {
  await resetAll();
  await sourceRepo.save(makeSource('src-1'));
});

describe('favoriteService.restore', () => {
  it('撤销删除：整条记录原样回来，收藏时间与源状态都不重算', async () => {
    const created = await favoriteService.add(INPUT);
    const aged: FavoriteRecord = {
      ...created,
      createdAt: FIXED_NOW - 86_400_000,
      sourceRemoved: true,
    };
    await favoriteRepo.save(aged);
    await favoriteService.remove(aged.id);
    expect(await favoriteService.list()).toEqual([]);

    await favoriteService.restore(aged);

    expect(await favoriteRepo.get(aged.id)).toEqual(aged);
  });

  it('restore 会广播 favorites:changed，列表因此自己刷新（不用调用方手动 reload）', async () => {
    const created = await favoriteService.add(INPUT);
    await favoriteService.remove(created.id);
    const spy = vi.fn();
    const off = appEvents.on('favorites:changed', spy);

    await favoriteService.restore(created);

    expect(spy).toHaveBeenCalledWith({ id: created.id });
    off();
  });

  it('反向对照：用 add 当撤销会把 createdAt 与 sourceRemoved 洗掉', async () => {
    const created = await favoriteService.add(INPUT);
    const aged: FavoriteRecord = { ...created, createdAt: FIXED_NOW - 86_400_000, sourceRemoved: true };
    await favoriteRepo.save(aged);
    await favoriteService.remove(aged.id);

    const reAdded = await favoriteService.add(INPUT);

    expect(reAdded.createdAt).toBeGreaterThan(aged.createdAt);
    expect(reAdded.sourceRemoved).toBe(false);
  });
});

describe('historyService.restore', () => {
  it('撤销删除：进度、分组时间戳与媒体快照一起回来', async () => {
    await historyRepo.save(HISTORY_RECORD);
    await historyService.remove(HISTORY_RECORD.id);
    expect(await historyService.get('src-1', 'm-1')).toBeNull();

    await historyService.restore(HISTORY_RECORD);

    expect(await historyRepo.get(HISTORY_RECORD.id)).toEqual(HISTORY_RECORD);
  });

  it('restore 会广播 history:changed', async () => {
    const spy = vi.fn();
    const off = appEvents.on('history:changed', spy);

    await historyService.restore(HISTORY_RECORD);

    expect(spy).toHaveBeenCalledWith({ id: HISTORY_RECORD.id });
    off();
  });
});

/**
 * 列表里的记录是响应式代理，而 IndexedDB 走结构化克隆：Proxy 直接进 put 会 DataCloneError，
 * `toErrorShape` 把它渲染成「本地数据读写失败，请重试」——撤销点了没反应，用户以为还能再点一次。
 * 浅拷贝 `{ ...record }` 也挡不住：嵌套的 `mediaSnapshot` 透过代理读出来仍是代理。
 */
describe('restore 接收列表里的响应式代理', () => {
  it('收藏：传 reactive(record) 也能落库', async () => {
    const created = await favoriteService.add(INPUT);
    await favoriteService.remove(created.id);

    await favoriteService.restore(reactive({ ...created, createdAt: FIXED_NOW - 86_400_000 }));

    expect(await favoriteRepo.get(created.id)).toEqual({
      ...created,
      createdAt: FIXED_NOW - 86_400_000,
    });
  });

  it('历史：嵌套的 mediaSnapshot 也是代理，浅拷贝挡不住', async () => {
    await historyRepo.save(HISTORY_RECORD);
    await historyService.remove(HISTORY_RECORD.id);

    await historyService.restore(reactive(HISTORY_RECORD));

    expect(await historyRepo.get(HISTORY_RECORD.id)).toEqual(HISTORY_RECORD);
  });
});
