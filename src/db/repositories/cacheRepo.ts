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

  /* ---------- EPG（key = `${channel}:${date}`） ---------- */

  async getEpg(key: string): Promise<EpgCacheRecord['programmes'] | null> {
    const db = await getDb();
    const record = await db.get(STORE_NAMES.epgCache, key);
    if (!record) return null;
    if (Date.now() - record.fetchedAt > EPG_CACHE_TTL_MS) {
      await db.delete(STORE_NAMES.epgCache, key);
      return null;
    }
    return record.programmes;
  },

  async putEpg(key: string, programmes: EpgCacheRecord['programmes']): Promise<void> {
    const db = await getDb();
    const record: EpgCacheRecord = { key, programmes, fetchedAt: Date.now() };
    await db.put(STORE_NAMES.epgCache, record);
  },
};
