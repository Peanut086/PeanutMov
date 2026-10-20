/**
 * 通用键值仓储（`kv` store：设置、演示种子标记、导入记录）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES } from '@/db/schema';

export const kvRepo = {
  async get<T>(key: string): Promise<T | null> {
    return withTx(['kv'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.kv).get(key);
      return found ? (found.value as T) : null;
    });
  },

  async set(key: string, value: unknown): Promise<void> {
    await withTx(['kv'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.kv).put({ key, value, updatedAt: Date.now() });
    });
  },

  async delete(key: string): Promise<void> {
    await withTx(['kv'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.kv).delete(key);
    });
  },

  async keys(): Promise<string[]> {
    return withTx(['kv'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.kv).getAllKeys());
  },

  async clear(): Promise<void> {
    await withTx(['kv'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.kv).clear();
    });
  },
};

export type KvRepo = typeof kvRepo;
