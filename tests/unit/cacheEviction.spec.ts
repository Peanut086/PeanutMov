/**
 * OPT-10：缓存 LRU 上限 + 启动清扫
 *
 * 此前 `danmakuCache` / `epgCache` 只有「读时过期」：没人再读到的键（换过关键词的弹幕匹配、
 * 看过一次的频道节目单）永久留在 IndexedDB 里，单条弹幕缓存抽稀后仍可到 MB 级。
 *
 * 现在：写入超过条目上限就地按 `fetchedAt` 淘汰最旧；启动 `sweep()` 先清过期再收上限。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '@/db/index';
import { cacheRepo } from '@/db/repositories/cacheRepo';
import { STORE_NAMES } from '@/db/schema';
import { DANMAKU_CACHE_MAX, EPG_CACHE_TTL_MS } from '@/shared/constants';
import type { DanmakuMatch } from '@/types';

import { resetAll } from './helpers';

function makeMatch(title: string): DanmakuMatch {
  return { provider: 'local-xml', matchedTitle: title, offsetSec: 0, comments: [] } as DanmakuMatch;
}

/** 绕过写入路径直接落库，用于构造"存量已过期/已超上限"的形态 */
async function putRawDanmaku(key: string, fetchedAt: number): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAMES.danmakuCache, { key, match: makeMatch(key), fetchedAt });
}

async function danmakuKeys(): Promise<string[]> {
  const db = await getDb();
  return (await db.getAllKeys(STORE_NAMES.danmakuCache)) as string[];
}

describe('缓存淘汰（OPT-10）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('写入超过条目上限：最旧的按 fetchedAt 被淘汰，总数收在上限内', async () => {
    // 先铺满到上限（时间戳递增），再超额写入触发淘汰
    for (let i = 0; i < DANMAKU_CACHE_MAX; i += 1) {
      await putRawDanmaku(`old-${i}`, Date.now() - (DANMAKU_CACHE_MAX - i) * 1000);
    }
    expect(await danmakuKeys()).toHaveLength(DANMAKU_CACHE_MAX);

    await cacheRepo.putDanmaku('new-1', makeMatch('new-1'));
    await cacheRepo.putDanmaku('new-2', makeMatch('new-2'));

    const keys = await danmakuKeys();
    expect(keys).toHaveLength(DANMAKU_CACHE_MAX);
    expect(keys).toContain('new-1');
    expect(keys).toContain('new-2');
    // 被淘汰的是最旧的两条，而不是任意两条
    expect(keys).not.toContain('old-0');
    expect(keys).not.toContain('old-1');
    expect(keys).toContain(`old-${DANMAKU_CACHE_MAX - 1}`);
  });

  it('sweep 删除过期条目，保留未过期与刚写入的', async () => {
    const now = Date.now();
    await cacheRepo.putEpgRecord({
      key: 'epgv2:src:chA:2026-11-15',
      programmes: [{ start: '', end: '', title: '旧', desc: null, startSec: 0, endSec: 0 }],
      fetchedAt: now - EPG_CACHE_TTL_MS - 60_000,
    });
    await cacheRepo.putEpg('epgv2:src:chB:2026-11-16', [
      { start: '', end: '', title: '新', desc: null, startSec: 0, endSec: 0 },
    ]);

    const swept = await cacheRepo.sweep();

    expect(swept.epg).toBe(1);
    expect(await cacheRepo.getEpgRecord('epgv2:src:chA:2026-11-15')).toBeNull();
    expect(await cacheRepo.getEpgRecord('epgv2:src:chB:2026-11-16')).not.toBeNull();
  });

  it('sweep 同时收敛存量超限条目（写入路径被绕过的历史数据）', async () => {
    for (let i = 0; i < DANMAKU_CACHE_MAX + 3; i += 1) {
      await putRawDanmaku(`legacy-${i}`, Date.now() - (DANMAKU_CACHE_MAX + 3 - i) * 1000);
    }

    const swept = await cacheRepo.sweep();

    expect(swept.danmaku).toBe(3);
    const keys = await danmakuKeys();
    expect(keys).toHaveLength(DANMAKU_CACHE_MAX);
    expect(keys).not.toContain('legacy-0');
    expect(keys).toContain(`legacy-${DANMAKU_CACHE_MAX + 2}`);
  });

  it('未过期且未超限时 sweep 不误删（缓存命中仍然可用）', async () => {
    await cacheRepo.putDanmaku('keep-1', makeMatch('keep-1'));
    await cacheRepo.putEpg('epgv2:src:chK:2026-11-16', [
      { start: '', end: '', title: '保留', desc: null, startSec: 0, endSec: 0 },
    ]);

    const swept = await cacheRepo.sweep();

    expect(swept).toEqual({ danmaku: 0, epg: 0 });
    expect(await cacheRepo.getDanmaku('keep-1')).not.toBeNull();
    expect(await cacheRepo.getEpg('epgv2:src:chK:2026-11-16')).not.toBeNull();
  });
});
