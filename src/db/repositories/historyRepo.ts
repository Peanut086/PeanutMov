/**
 * 观看历史仓储（`history` store，技术方案 5.2 / API-07）
 *
 * 历史上限 `HISTORY_MAX = 500`：save 后若超限，同一事务内按 updatedAt 升序淘汰最旧。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import { HISTORY_MAX } from '@/shared/constants';
import type { HistoryRecord } from '@/types';

/**
 * 写入一条历史并在超限时淘汰最旧（在给定事务内完成）。
 *
 * 迁移到 `tx` 时只能 await 本事务的请求：因此先 `count()` 再按需开游标，
 * 不调用任何会自开事务的方法（REV-01）。
 */
async function saveVia(tx: CinemaTx, record: HistoryRecord): Promise<void> {
  const store = tx.objectStore(STORE_NAMES.history);
  await store.put(record);
  const total = await store.count();
  if (total <= HISTORY_MAX) return;
  let overflow = total - HISTORY_MAX;
  let cursor = await store.index('by-updated').openCursor(null, 'next');
  while (cursor && overflow > 0) {
    await cursor.delete();
    overflow -= 1;
    cursor = await cursor.continue();
  }
}

export const historyRepo = {
  async get(id: string): Promise<HistoryRecord | null> {
    return withTx(['history'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.history).get(id);
      return found ?? null;
    });
  },

  /** 全部历史，updatedAt 倒序 */
  async listAll(limit = HISTORY_MAX): Promise<HistoryRecord[]> {
    return withTx(['history'], 'readonly', async (tx) => {
      const index = tx.objectStore(STORE_NAMES.history).index('by-updated');
      const out: HistoryRecord[] = [];
      let cursor = await index.openCursor(null, 'prev');
      while (cursor && out.length < limit) {
        out.push(cursor.value);
        cursor = await cursor.continue();
      }
      return out;
    });
  },

  async listAllRaw(): Promise<HistoryRecord[]> {
    return withTx(['history'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.history).getAll());
  },

  /**
   * 按 mediaId 取一条历史（v5 `by-media` 索引）。
   * 详情自愈只需要「有没有 + 任意一条快照」，不该把最多 500 条带快照的记录全读出来。
   */
  async getByMedia(mediaId: string): Promise<HistoryRecord | null> {
    return withTx(['history'], 'readonly', async (tx) => {
      const rows = await tx
        .objectStore(STORE_NAMES.history)
        .index('by-media')
        .getAll(IDBKeyRange.only(mediaId), 1);
      return rows[0] ?? null;
    });
  },

  async count(): Promise<number> {
    return withTx(['history'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.history).count());
  },

  /**
   * 写入一条历史（覆盖同 id），并在超限时淘汰最旧。
   * 整个过程在一个读写事务内完成，保证条数不会超过上限。
   *
   * `tx` 由调用方（如备份导入）提供时，写入并入外层事务，保证跨表原子性（REV-01）。
   */
  async save(record: HistoryRecord, tx?: CinemaTx): Promise<void> {
    if (tx) {
      await saveVia(tx, record);
      return;
    }
    await withTx(['history'], 'readwrite', (inner) => saveVia(inner, record));
  },

  /** 批量写入（导入用；`tx` 缺省时同一事务内写完全部记录） */
  async saveMany(records: HistoryRecord[], tx?: CinemaTx): Promise<void> {
    if (records.length === 0) return;
    if (tx) {
      for (const record of records) await saveVia(tx, record);
      return;
    }
    await withTx(['history'], 'readwrite', async (inner) => {
      for (const record of records) await saveVia(inner, record);
    });
  },

  async remove(id: string): Promise<void> {
    await withTx(['history'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.history).delete(id);
    });
  },

  async removeBySource(sourceId: string): Promise<void> {
    await withTx(['history'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.history);
      const keys = await store.index('by-source').getAllKeys(IDBKeyRange.only(sourceId));
      for (const key of keys) await store.delete(key);
    });
  },

  /** 清空（`sourceId` 缺省清全部） */
  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.history).clear();
      return;
    }
    await withTx(['history'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.history).clear();
    });
  },
};

export type HistoryRepo = typeof historyRepo;
