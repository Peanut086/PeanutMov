import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { deleteDatabase, getDb, resetDbConnection } from '@/db/index';
import { upgrade } from '@/db/migrations';
import type { CinemaDB } from '@/db/schema';
import { STORE_NAMES } from '@/db/schema';
import { cacheRepo } from '@/db/repositories/cacheRepo';
import { DANMAKU_CACHE_TTL_MS, DB_NAME, DB_VERSION, EPG_CACHE_TTL_MS } from '@/shared/constants';
import type { DanmakuMatch } from '@/types';

import { dropNewerStores, tick } from './helpers';

/**
 * DB v6（danmakuCache / epgCache 的 by-fetched）升级链路。
 *
 * OPT-10 的淘汰与清扫全部走这个索引；索引没建上 = 启动清扫抛错、缓存只涨不降。
 * 这里用「v5 老库 → 当前版本」的真实路径验证：索引存在、老数据没被动过、
 * `sweep()` 能在升级后的库上跑通。
 */

/** 按 v5 建库，再抹掉 v6 才新增的索引，还原成「真实老库」形态（同 dbMigrationV5 的理由） */
function upgradeToV5(...args: Parameters<typeof upgrade>): void {
  const [db, oldVersion, newVersion, tx] = args;
  upgrade(db, oldVersion, newVersion, tx);
  tx.objectStore(STORE_NAMES.danmakuCache).deleteIndex('by-fetched');
  tx.objectStore(STORE_NAMES.epgCache).deleteIndex('by-fetched');
  dropNewerStores(db, 5);
}

describe('DB v6：缓存表 by-fetched', () => {
  beforeEach(async () => {
    await deleteDatabase();
    resetDbConnection();
  });

  it('v5 库升到当前版本后两张缓存表都有 by-fetched，且原有条目保留', async () => {
    const db5 = await openDB<CinemaDB>(DB_NAME, 5, { upgrade: upgradeToV5 });
    // 两张表 TTL 不同，各自按自己的 TTL 判定过期
    const epgStale = Date.now() - EPG_CACHE_TTL_MS - 60_000;
    const danmakuStale = Date.now() - DANMAKU_CACHE_TTL_MS - 60_000;
    await db5.put(STORE_NAMES.epgCache, {
      key: 'epgv2:src1:c1:2026-11-15',
      programmes: [{ start: '20:00', end: '21:00', title: '老节目单', desc: null, startSec: 72000, endSec: 75600 }],
      fetchedAt: epgStale,
    });
    await db5.put(STORE_NAMES.danmakuCache, {
      key: 'm1:1',
      match: { provider: 'local-xml', matchedTitle: 'm1:1', offsetSec: 0, comments: [] } as DanmakuMatch,
      fetchedAt: danmakuStale,
    });
    expect([...db5.transaction(STORE_NAMES.epgCache, 'readonly').objectStore(STORE_NAMES.epgCache).indexNames]).not.toContain(
      'by-fetched',
    );
    db5.close();
    await tick();

    const db6 = await openDB<CinemaDB>(DB_NAME, DB_VERSION, { upgrade });
    for (const store of [STORE_NAMES.danmakuCache, STORE_NAMES.epgCache] as const) {
      const tx = db6.transaction(store, 'readonly');
      const names = [...tx.objectStore(store).indexNames];
      await tx.done;
      expect(names).toContain('by-fetched');
    }
    // 升级只加索引，不碰数据
    expect(await db6.count(STORE_NAMES.epgCache)).toBe(1);
    expect(await db6.count(STORE_NAMES.danmakuCache)).toBe(1);
    db6.close();
    await tick();

    // 升级后的库上 sweep 能跑通：过期的那条按索引被清掉
    resetDbConnection();
    const swept = await cacheRepo.sweep();
    expect(swept.epg).toBe(1);
    expect(swept.danmaku).toBe(1);
    expect(await cacheRepo.getEpgRecord('epgv2:src1:c1:2026-11-15', { allowExpired: true })).toBeNull();
  });

  it('全新建库（oldVersion 0）两张缓存表同样带 by-fetched', async () => {
    const db = await getDb();
    for (const store of [STORE_NAMES.danmakuCache, STORE_NAMES.epgCache] as const) {
      const tx = db.transaction(store, 'readonly');
      const names = [...tx.objectStore(store).indexNames];
      await tx.done;
      expect(names).toContain('by-fetched');
    }
  });
});
