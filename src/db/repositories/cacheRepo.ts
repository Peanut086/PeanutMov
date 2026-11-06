/**
 * 带 TTL 的缓存仓储（v1.7 / CHG-22 / CHG-23）
 *
 * `danmakuCache`（弹幕匹配）与 `epgCache`（节目单）共用同一读写模式：
 * key 寻址、fetchedAt 时间戳、读时过期即删。纯缓存——清空不影响功能正确性。
 */
import { getDb } from '@/db/index';
import { STORE_NAMES, type DanmakuCacheRecord, type EpgCacheRecord } from '@/db/schema';
import { DANMAKU_CACHE_TTL_MS, EPG_CACHE_TTL_MS } from '@/shared/constants';
import type { DanmakuMatch } from '@/types';

export const cacheRepo = {
  /* ---------- 弹幕（key = `${mediaId}:${episodeNumber}`） ---------- */

  async getDanmaku(key: string): Promise<DanmakuMatch | null> {
    const db = await getDb();
    const record = await db.get(STORE_NAMES.danmakuCache, key);
    if (!record) return null;
    if (Date.now() - record.fetchedAt > DANMAKU_CACHE_TTL_MS) {
      await db.delete(STORE_NAMES.danmakuCache, key);
      return null;
    }
    return record.match;
  },

  async putDanmaku(key: string, match: DanmakuMatch): Promise<void> {
    const db = await getDb();
    const record: DanmakuCacheRecord = { key, match, fetchedAt: Date.now() };
    await db.put(STORE_NAMES.danmakuCache, record);
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
};
