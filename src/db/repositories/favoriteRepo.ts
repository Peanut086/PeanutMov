/**
 * 收藏仓储（`favorites` store，API-08）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import type { FavoriteRecord } from '@/types';

export const favoriteRepo = {
  async get(id: string): Promise<FavoriteRecord | null> {
    return withTx(['favorites'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.favorites).get(id);
      return found ?? null;
    });
  },

  /** createdAt 倒序 */
  async listByCreated(): Promise<FavoriteRecord[]> {
    return withTx(['favorites'], 'readonly', async (tx) => {
      const index = tx.objectStore(STORE_NAMES.favorites).index('by-created');
      const out: FavoriteRecord[] = [];
      let cursor = await index.openCursor(null, 'prev');
      while (cursor) {
        out.push(cursor.value);
        cursor = await cursor.continue();
      }
      return out;
    });
  },

  async listAll(): Promise<FavoriteRecord[]> {
    return withTx(['favorites'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.favorites).getAll());
  },

  async count(): Promise<number> {
    return withTx(['favorites'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.favorites).count());
  },

  async save(record: FavoriteRecord, tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.favorites).put(record);
      return;
    }
    await withTx(['favorites'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.favorites).put(record);
    });
  },

  async saveMany(records: FavoriteRecord[], tx?: CinemaTx): Promise<void> {
    if (records.length === 0) return;
    if (tx) {
      const store = tx.objectStore(STORE_NAMES.favorites);
      for (const record of records) await store.put(record);
      return;
    }
    await withTx(['favorites'], 'readwrite', async (inner) => {
      const store = inner.objectStore(STORE_NAMES.favorites);
      for (const record of records) await store.put(record);
    });
  },

  async remove(id: string): Promise<void> {
    await withTx(['favorites'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.favorites).delete(id);
    });
  },

  /** 标记某源的收藏为"源已移除"（不删除记录，AC-35） */
  async markSourceRemoved(sourceId: string): Promise<void> {
    await withTx(['favorites'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.favorites);
      const rows = await store.index('by-source').getAll(IDBKeyRange.only(sourceId));
      for (const row of rows) await store.put({ ...row, sourceRemoved: true });
    });
  },

  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.favorites).clear();
      return;
    }
    await withTx(['favorites'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.favorites).clear();
    });
  },
};

export type FavoriteRepo = typeof favoriteRepo;
