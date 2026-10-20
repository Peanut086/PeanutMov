/**
 * 分类仓储（`categories` store）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import type { Category } from '@/types';

export const categoryRepo = {
  /** 某源全部分类，按 order 升序 */
  async listBySource(sourceId: string): Promise<Category[]> {
    return withTx(['categories'], 'readonly', async (tx) => {
      const rows = await tx
        .objectStore(STORE_NAMES.categories)
        .index('by-source')
        .getAll(IDBKeyRange.only(sourceId));
      return rows.sort((a, b) => a.order - b.order);
    });
  },

  async get(id: string): Promise<Category | null> {
    return withTx(['categories'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.categories).get(id);
      return found ?? null;
    });
  },

  /** 全量替换某源分类（同一事务内删除旧值再写入） */
  async replaceForSource(sourceId: string, categories: Category[], tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.categories);
      const keys = await store.index('by-source').getAllKeys(IDBKeyRange.only(sourceId));
      for (const key of keys) await store.delete(key);
      for (const category of categories) await store.put(category);
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['categories'], 'readwrite', run);
  },

  async removeBySource(sourceId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.categories);
      const keys = await store.index('by-source').getAllKeys(IDBKeyRange.only(sourceId));
      for (const key of keys) await store.delete(key);
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['categories'], 'readwrite', run);
  },

  async count(): Promise<number> {
    return withTx(['categories'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.categories).count());
  },

  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.categories).clear();
      return;
    }
    await withTx(['categories'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.categories).clear();
    });
  },
};

export type CategoryRepo = typeof categoryRepo;
