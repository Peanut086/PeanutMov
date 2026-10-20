/**
 * Blob 仓储（`blobs` store，Web 端下载内容）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type BlobRecord } from '@/db/schema';

export const blobRepo = {
  async get(key: string): Promise<BlobRecord | null> {
    return withTx(['blobs'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.blobs).get(key);
      return found ?? null;
    });
  },

  async has(key: string): Promise<boolean> {
    const count = await withTx(['blobs'], 'readonly', (tx) =>
      tx.objectStore(STORE_NAMES.blobs).count(IDBKeyRange.only(key)),
    );
    return count > 0;
  },

  async put(record: BlobRecord): Promise<void> {
    await withTx(['blobs'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.blobs).put(record);
    });
  },

  async delete(key: string): Promise<void> {
    await withTx(['blobs'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.blobs).delete(key);
    });
  },

  async listKeys(): Promise<string[]> {
    return withTx(['blobs'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.blobs).getAllKeys());
  },

  /** 已用字节数（存储统计用） */
  async totalBytes(): Promise<number> {
    return withTx(['blobs'], 'readonly', async (tx) => {
      const rows = await tx.objectStore(STORE_NAMES.blobs).getAll();
      return rows.reduce((sum, row) => sum + row.size, 0);
    });
  },

  async count(): Promise<number> {
    return withTx(['blobs'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.blobs).count());
  },

  async clear(): Promise<void> {
    await withTx(['blobs'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.blobs).clear();
    });
  },
};

export type BlobRepo = typeof blobRepo;
