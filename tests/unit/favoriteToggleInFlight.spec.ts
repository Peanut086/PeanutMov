import { beforeEach, describe, expect, it, vi } from 'vitest';

import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { favoriteService } from '@/services/favoriteService';
import { historyIdOf } from '@/shared/id';
import type { FavoriteInput, Source } from '@/types';

import { resetAll } from './helpers';

/**
 * 收藏切换的在飞守卫
 *
 * `toggle` 是「读存在性 → 删 / 读源 → 写」的三段式，每一步各开一个 IndexedDB 事务。
 * 缺陷形态：双击时两次都在对方的写提交前读到「不存在」，于是一次 delete 与一次 put
 * 交错提交，最终收藏态取决于提交顺序，而两次 toast 都按各自读到的旧状态说话。
 *
 * 修复：同一收藏主键的第二次 toggle 复用第一次的 Promise；`remove` 会先等待同 id 的
 * 在飞 toggle，避免 add 的 put 排在 delete 之后把收藏"复活"。
 */

const INPUT: FavoriteInput = {
  sourceId: 'src-1',
  mediaId: 'm-1',
  title: '肖申克的救赎',
  posterUrl: null,
  type: 'movie',
  year: 1994,
};

const OTHER: FavoriteInput = { ...INPUT, mediaId: 'm-2', title: '盗梦空间' };

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
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

async function ids(): Promise<string[]> {
  return (await favoriteRepo.listAll()).map((row) => row.id).sort();
}

describe('收藏 toggle 在飞守卫', () => {
  beforeEach(async () => {
    await resetAll();
    await sourceRepo.save(makeSource('src-1'));
  });

  it('双击同一收藏只产生一次写入，最终态与两次返回一致', async () => {
    const saveSpy = vi.spyOn(favoriteRepo, 'save');
    const removeSpy = vi.spyOn(favoriteRepo, 'remove');

    const [first, second] = await Promise.all([
      favoriteService.toggle(INPUT, true),
      favoriteService.toggle(INPUT, true),
    ]);

    expect(first.favorited).toBe(true);
    expect(second.favorited).toBe(true);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(await ids()).toEqual([historyIdOf(INPUT.sourceId, INPUT.mediaId)]);
  });

  it('在飞期间的第二次 toggle 复用同一个 Promise（不是重新排队一次写入）', async () => {
    const results = await Promise.all([
      favoriteService.toggle(INPUT, true),
      favoriteService.toggle(INPUT, true),
      favoriteService.toggle(INPUT, true),
    ]);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
    expect(await favoriteService.count()).toBe(1);
  });

  it('不同收藏互不阻塞：并发两次 toggle 都各自写入', async () => {
    const saveSpy = vi.spyOn(favoriteRepo, 'save');
    await Promise.all([favoriteService.toggle(INPUT, true), favoriteService.toggle(OTHER, true)]);
    expect(saveSpy).toHaveBeenCalledTimes(2);
    expect(await ids()).toEqual([
      historyIdOf(INPUT.sourceId, INPUT.mediaId),
      historyIdOf(OTHER.sourceId, OTHER.mediaId),
    ]);
  });

  it('上一轮 toggle 落地后，下一次 toggle 正常取消收藏（守卫不会永久吞掉点击）', async () => {
    await Promise.all([favoriteService.toggle(INPUT, true), favoriteService.toggle(INPUT, true)]);
    const removed = await favoriteService.toggle(INPUT, true);
    expect(removed.favorited).toBe(false);
    expect(await ids()).toEqual([]);
    // 队列已释放：再来一次仍然能收藏回去
    await favoriteService.toggle(INPUT, true);
    expect(await ids()).toHaveLength(1);
  });

  it('remove 等同 id 的在飞 toggle：put 不会排在 delete 之后复活收藏', async () => {
    const id = historyIdOf(INPUT.sourceId, INPUT.mediaId);
    const toggling = favoriteService.toggle(INPUT, true);
    const removing = favoriteService.remove(id);
    await Promise.all([toggling, removing]);
    expect(await ids()).toEqual([]);
  });

  it('toggle 在飞行内抛错后守卫释放，后续调用不会被卡住', async () => {
    const spy = vi.spyOn(sourceRepo, 'get').mockRejectedValueOnce(new Error('模拟读源失败'));
    await expect(favoriteService.toggle(INPUT, true)).rejects.toThrow('模拟读源失败');
    spy.mockRestore();

    await favoriteService.toggle(INPUT, true);
    expect(await ids()).toHaveLength(1);
  });
});
