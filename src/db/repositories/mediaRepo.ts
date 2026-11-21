/**
 * 媒体条目缓存仓储（`media` store，技术方案 5.1 / API-06）
 *
 * 查询约定：
 * - 列表按 `updatedAt` 倒序（同源）、分页索引 `by-source-updated`；
 * - 搜索走 `by-title` 前缀，中文子串回退全表过滤（缓存规模有限）；
 * - 批量写入按 200 条拆分事务（技术方案 5.2，避免长事务阻塞 UI）。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import { SEARCH_LOCAL_LIMIT } from '@/shared/constants';
import type { MediaItem, MediaType } from '@/types';

const BATCH_SIZE = 200;

/** 每 200 条让出事件循环后再开下一个事务 */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function putChunk(items: MediaItem[], tx?: CinemaTx): Promise<void> {
  if (tx) {
    const store = tx.objectStore(STORE_NAMES.media);
    for (const item of items) await store.put(item);
    return;
  }
  await withTx(['media'], 'readwrite', async (inner) => {
    const store = inner.objectStore(STORE_NAMES.media);
    for (const item of items) await store.put(item);
  });
}

export const mediaRepo = {
  async get(id: string): Promise<MediaItem | null> {
    return withTx(['media'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.media).get(id);
      return found ?? null;
    });
  },

  async getMany(ids: string[]): Promise<MediaItem[]> {
    if (ids.length === 0) return [];
    return withTx(['media'], 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.media);
      const out: MediaItem[] = [];
      for (const id of ids) {
        const found = await store.get(id);
        if (found) out.push(found);
      }
      return out;
    });
  },

  async save(item: MediaItem, tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.media).put(item);
      return;
    }
    await withTx(['media'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.media).put(item);
    });
  },

  /** 批量 upsert：每 200 条一个事务，事务间让出事件循环 */
  async upsertMany(items: MediaItem[]): Promise<void> {
    if (items.length === 0) return;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE);
      await putChunk(chunk);
      if (i + BATCH_SIZE < items.length) await yieldToLoop();
    }
  },

  /** 同源分页（updatedAt 倒序） */
  async listBySource(sourceId: string, opts?: { limit?: number; offset?: number }): Promise<MediaItem[]> {
    const limit = opts?.limit ?? 30;
    const offset = opts?.offset ?? 0;
    return withTx(['media'], 'readonly', async (tx) => {
      const range = IDBKeyRange.bound([sourceId, -Infinity], [sourceId, Infinity]);
      const index = tx.objectStore(STORE_NAMES.media).index('by-source-updated');
      const out: MediaItem[] = [];
      let skipped = 0;
      let cursor = await index.openCursor(range, 'prev');
      while (cursor) {
        if (skipped < offset) {
          skipped += 1;
        } else {
          out.push(cursor.value);
          if (out.length >= limit) break;
        }
        cursor = await cursor.continue();
      }
      return out;
    });
  },

  async countBySource(sourceId: string): Promise<number> {
    return withTx(['media'], 'readonly', (tx) =>
      tx.objectStore(STORE_NAMES.media).index('by-source').count(IDBKeyRange.only(sourceId)),
    );
  },

  /** 同源同类型（筛选用；缓存量小，内存过滤） */
  async listBySourceAndType(
    sourceId: string,
    type: MediaType,
    opts?: { limit?: number; offset?: number },
  ): Promise<MediaItem[]> {
    const all = await this.listBySource(sourceId, { limit: Number.MAX_SAFE_INTEGER, offset: 0 });
    return all
      .filter((m) => m.type === type)
      .slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? 30));
  },

  /**
   * 本地搜索：标题前缀优先（走 by-title 索引），不足再补子串匹配。
   * `matchActors`（搜索页开启，换源候选不开启）让子串那一趟顺带比主演——演员没有索引
   * （存量数据也没这列），共用同一次扫描，不另开游标。
   * `keyword` 会转为小写；空关键词返回空数组。
   */
  async searchByTitle(
    keyword: string,
    limit = SEARCH_LOCAL_LIMIT,
    opts?: { matchActors?: boolean },
  ): Promise<MediaItem[]> {
    const kw = keyword.trim().toLowerCase();
    if (kw.length === 0) return [];
    return withTx(['media'], 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.media);
      const seen = new Set<string>();
      const out: MediaItem[] = [];

      const prefixRange = IDBKeyRange.bound(kw, `${kw}\uffff`);
      let cursor = await store.index('by-title').openCursor(prefixRange);
      while (cursor && out.length < limit) {
        if (!seen.has(cursor.value.id)) {
          seen.add(cursor.value.id);
          out.push(cursor.value);
        }
        cursor = await cursor.continue();
      }

      if (out.length < limit) {
        // 单字查询不比主演：与 `matchesActor` 的 2 字门槛同口径，否则「王」会淹掉标题命中
        const actorKw = opts?.matchActors && kw.length >= 2 ? kw : null;
        let allCursor = await store.openCursor();
        while (allCursor && out.length < limit) {
          const value = allCursor.value;
          const matched =
            value.titleLower.includes(kw) ||
            (actorKw !== null && (value.actors ?? []).some((name) => name.toLowerCase().includes(actorKw)));
          if (!seen.has(value.id) && matched) {
            seen.add(value.id);
            out.push(value);
          }
          allCursor = await allCursor.continue();
        }
      }
      return out;
    });
  },

  /** 最近缓存（cachedAt 倒序，跨源） */
  async listRecent(limit = 20): Promise<MediaItem[]> {
    return withTx(['media'], 'readonly', async (tx) => {
      const index = tx.objectStore(STORE_NAMES.media).index('by-cached');
      const out: MediaItem[] = [];
      let cursor = await index.openCursor(null, 'prev');
      while (cursor && out.length < limit) {
        out.push(cursor.value);
        cursor = await cursor.continue();
      }
      return out;
    });
  },

  async listAll(): Promise<MediaItem[]> {
    return withTx(['media'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.media).getAll());
  },

  async listBySourceAll(sourceId: string): Promise<MediaItem[]> {
    return withTx(['media'], 'readonly', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.media);
      return store.index('by-source').getAll(IDBKeyRange.only(sourceId));
    });
  },

  async count(): Promise<number> {
    return withTx(['media'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.media).count());
  },

  async remove(id: string): Promise<void> {
    await withTx(['media'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.media).delete(id);
    });
  },

  async removeBySource(sourceId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.media);
      const keys = await store.index('by-source').getAllKeys(IDBKeyRange.only(sourceId));
      for (const key of keys) await store.delete(key);
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['media'], 'readwrite', run);
  },

  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.media).clear();
      return;
    }
    await withTx(['media'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.media).clear();
    });
  },
};

export type MediaRepo = typeof mediaRepo;

/** 供测试断言：批量写入的分片大小 */
export const MEDIA_BATCH_SIZE = BATCH_SIZE;
