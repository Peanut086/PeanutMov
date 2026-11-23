/**
 * 带 TTL 的缓存仓储（v1.7 / CHG-22 / CHG-23）
 *
 * `danmakuCache`（弹幕匹配）与 `epgCache`（节目单）共用同一读写模式：
 * key 寻址、fetchedAt 时间戳、读时过期即删。纯缓存——清空不影响功能正确性。
 *
 * OPT-10：只有 TTL「读时过期」等于永远不清扫——没人再读的那些条目（换过关键词的
 * 弹幕匹配、看过一次就再没打开的频道节目单）会一直占着盘。现在写入超上限就地按
 * `fetchedAt` 淘汰最旧，另外每次启动跑一次 `sweep()`（过期 + 上限）。
 */
import { getDb, withTx } from '@/db/index';
import { STORE_NAMES, type DanmakuCacheRecord, type EpgCacheRecord } from '@/db/schema';
import {
  DANMAKU_CACHE_MAX,
  DANMAKU_CACHE_TTL_MS,
  DANMAKU_MATCH_RULE_VER,
  EPG_CACHE_MAX,
  EPG_CACHE_TTL_MS,
} from '@/shared/constants';
import type { DanmakuMatch } from '@/types';

/** 两张缓存表共用同一套淘汰逻辑；上限与 TTL 按表配置 */
type CacheStore = typeof STORE_NAMES.danmakuCache | typeof STORE_NAMES.epgCache;

const CACHE_POLICY: Record<CacheStore, { max: number; ttlMs: number }> = {
  [STORE_NAMES.danmakuCache]: { max: DANMAKU_CACHE_MAX, ttlMs: DANMAKU_CACHE_TTL_MS },
  [STORE_NAMES.epgCache]: { max: EPG_CACHE_MAX, ttlMs: EPG_CACHE_TTL_MS },
};

/**
 * 沿 `by-fetched` 索引（升序＝最旧在前）删除条目，只取键不取值。
 * `before` 给出时间上界（严格小于），`limit` 给出条数上界，两者可叠加。
 */
async function evict(store: CacheStore, opts: { before?: number; limit?: number }): Promise<number> {
  const range = opts.before === undefined ? undefined : IDBKeyRange.upperBound(opts.before, true);
  return withTx([store], 'readwrite', async (tx) => {
    const objectStore = tx.objectStore(store);
    let removed = 0;
    // idb v8 核心不带 async iterator（那是 `idb/with-async-ittr`），按仓库既有写法手动步进
    let cursor = await objectStore.index('by-fetched').openCursor(range);
    while (cursor) {
      if (opts.limit !== undefined && removed >= opts.limit) break;
      await objectStore.delete(cursor.primaryKey);
      removed += 1;
      cursor = await cursor.continue();
    }
    return removed;
  });
}

/** 超出条目上限时淘汰最旧的，返回删除条数（`count()` 是 O(1)，每次写入都查得起） */
async function trimToCap(store: CacheStore): Promise<number> {
  const db = await getDb();
  const total = await db.count(store);
  const excess = total - CACHE_POLICY[store].max;
  if (excess <= 0) return 0;
  return evict(store, { limit: excess });
}

export const cacheRepo = {
  /* ---------- 弹幕（key = `${mediaId}:${episodeNumber}`） ---------- */

  async getDanmaku(key: string): Promise<DanmakuMatch | null> {
    const db = await getDb();
    const record = await db.get(STORE_NAMES.danmakuCache, key);
    if (!record) return null;
    // 选片规则改版后命中的可能是串来的弹幕（旧存量没有 ruleVer，同样作废）：删掉让上层按新规则重取
    if (record.ruleVer !== DANMAKU_MATCH_RULE_VER) {
      await db.delete(STORE_NAMES.danmakuCache, key);
      return null;
    }
    if (Date.now() - record.fetchedAt > DANMAKU_CACHE_TTL_MS) {
      await db.delete(STORE_NAMES.danmakuCache, key);
      return null;
    }
    return record.match;
  },

  async putDanmaku(key: string, match: DanmakuMatch): Promise<void> {
    const db = await getDb();
    const record: DanmakuCacheRecord = {
      key,
      match,
      fetchedAt: Date.now(),
      ruleVer: DANMAKU_MATCH_RULE_VER,
    };
    await db.put(STORE_NAMES.danmakuCache, record);
    await trimToCap(STORE_NAMES.danmakuCache);
  },

  /** 作废本集缓存（「重新匹配本集弹幕」：命中的是哪一条只有清掉才知道） */
  async deleteDanmaku(key: string): Promise<void> {
    const db = await getDb();
    await db.delete(STORE_NAMES.danmakuCache, key);
  },

  /* ---------- EPG（key = `epgv2:{sourceId}:{channelKey}:{yyyy-MM-dd}`） ---------- */

  async getEpg(key: string): Promise<EpgCacheRecord['programmes'] | null> {
    const record = await cacheRepo.getEpgRecord(key);
    return record ? record.programmes : null;
  },

  async putEpg(key: string, programmes: EpgCacheRecord['programmes']): Promise<void> {
    await cacheRepo.putEpgRecord({ key, programmes, fetchedAt: Date.now() });
  },

  /**
   * EXT-06：读整条缓存记录（含 `matchLevel`，供 UI 显示"来源 + L1/L2/L3"）。
   * `allowExpired` 为真时不做过期删除，用于"源不可达 → 返回过期缓存并置 stale"。
   */
  async getEpgRecord(
    key: string,
    opts?: { allowExpired?: boolean },
  ): Promise<EpgCacheRecord | null> {
    const db = await getDb();
    const record = await db.get(STORE_NAMES.epgCache, key);
    if (!record) return null;
    if (opts?.allowExpired) return record;
    if (Date.now() - record.fetchedAt > EPG_CACHE_TTL_MS) {
      await db.delete(STORE_NAMES.epgCache, key);
      return null;
    }
    return record;
  },

  async putEpgRecord(record: EpgCacheRecord): Promise<void> {
    const db = await getDb();
    await db.put(STORE_NAMES.epgCache, { ...record, fetchedAt: record.fetchedAt || Date.now() });
    await trimToCap(STORE_NAMES.epgCache);
  },

  /** EXT-06：按 key 前缀删除（`clearSourceCache` 用），返回删除条数 */
  async deleteEpgByPrefix(prefix: string): Promise<number> {
    const db = await getDb();
    const keys = await db.getAllKeys(STORE_NAMES.epgCache);
    let removed = 0;
    for (const key of keys) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        await db.delete(STORE_NAMES.epgCache, key);
        removed += 1;
      }
    }
    return removed;
  },

  /**
   * OPT-10：启动清扫——先按 TTL 删过期，再按条目上限淘汰最旧。
   *
   * 只在 App 启动时跑一次（`initCacheSweep()`，fire-and-forget）：写入路径只做
   * `count()` + 超限淘汰，正常浏览不会为清扫付出全表遍历的代价。
   */
  async sweep(): Promise<{ danmaku: number; epg: number }> {
    const sweepOne = async (store: CacheStore): Promise<number> => {
      const policy = CACHE_POLICY[store];
      const expired = await evict(store, { before: Date.now() - policy.ttlMs });
      return expired + (await trimToCap(store));
    };
    return { danmaku: await sweepOne(STORE_NAMES.danmakuCache), epg: await sweepOne(STORE_NAMES.epgCache) };
  },
};
