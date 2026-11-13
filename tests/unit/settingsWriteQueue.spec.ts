import { beforeEach, describe, expect, it, vi } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { settingsService } from '@/services/settingsService';
import { KV_KEY_SETTINGS } from '@/shared/constants';
import type { AppSettings } from '@/types';

import { resetAll } from './helpers';

/**
 * 第二轮 / 项 6：并发写设置丢更新
 *
 * `update` 是「读全量 → 合并 → 整份落库」，两次并发调用读到同一份快照，
 * 后写的把先写的整份盖掉：丢的不是同一个字段，而是对方那一轮的改动。
 * 同理 `pushSearchHistory` 连续敲三个词只会留下一个。
 *
 * 修复：服务内写队列串行化。队列必须对失败免疫，否则一次落库抛错
 * 会让之后所有设置写请求永久挂在链上。
 */
describe('设置并发写不丢更新', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('三路并发 update 各改各的字段，结果三项都在', async () => {
    await Promise.all([
      settingsService.update({ theme: 'light' }),
      settingsService.update({ hideDemoContent: true }),
      settingsService.update({ searchBudget: 'fast' }),
    ]);

    const got = await settingsService.get();
    expect(got.theme).toBe('light');
    expect(got.hideDemoContent).toBe(true);
    expect(got.searchBudget).toBe('fast');
  });

  it('嵌套对象并发写不互相覆盖', async () => {
    await Promise.all([
      settingsService.update({ download: { concurrency: 1 } }),
      settingsService.update({ download: { wifiOnly: true } }),
      settingsService.update({ player: { defaultRate: 1.5 } }),
    ]);

    const got = await settingsService.get();
    expect(got.download.concurrency).toBe(1);
    expect(got.download.wifiOnly).toBe(true);
    expect(got.player.defaultRate).toBe(1.5);
  });

  it('连续推三个搜索词，三条都进历史', async () => {
    await Promise.all(['星汉', '长安', '繁花'].map((word) => settingsService.pushSearchHistory(word)));

    const history = (await settingsService.get()).searchHistory;
    expect([...history].sort()).toEqual(['繁花', '星汉', '长安'].sort());
  });

  it('update 与 pushSearchHistory 撞车时两边都生效', async () => {
    await Promise.all([settingsService.update({ theme: 'dark' }), settingsService.pushSearchHistory('三体')]);

    const got = await settingsService.get();
    expect(got.theme).toBe('dark');
    expect(got.searchHistory).toContain('三体');
  });

  it('一次落库失败不会把后续写请求永久卡死', async () => {
    // 先让缓存建立：否则首次 `load()` 的种库写入会吃掉这一次 mock 失败
    await settingsService.get();
    const spy = vi.spyOn(kvRepo, 'set').mockRejectedValueOnce(new Error('模拟 IDB 写入失败'));

    await expect(settingsService.update({ theme: 'light' })).rejects.toThrow();
    spy.mockRestore();

    const next = await settingsService.update({ theme: 'dark' });
    expect(next.theme).toBe('dark');
    expect((await settingsService.get()).theme).toBe('dark');
    // 队列真的排到了落库这一步，而不是只在内存里算完就返回
    expect((await kvRepo.get<AppSettings>(KV_KEY_SETTINGS))?.theme).toBe('dark');
  });
});
