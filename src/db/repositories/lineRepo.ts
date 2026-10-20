/**
 * 播放线路仓储（`lines` store）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import type { PlayLine } from '@/types';

export const lineRepo = {
  async get(id: string): Promise<PlayLine | null> {
    return withTx(['lines'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.lines).get(id);
      return found ?? null;
    });
  },

  /** 某媒体全部线路，按 index 升序 */
  async listByMedia(mediaId: string): Promise<PlayLine[]> {
    return withTx(['lines'], 'readonly', async (tx) => {
      const rows = await tx.objectStore(STORE_NAMES.lines).index('by-media').getAll(IDBKeyRange.only(mediaId));
      return rows.sort((a, b) => a.index - b.index);
    });
  },

  async saveMany(lines: PlayLine[], tx?: CinemaTx): Promise<void> {
    if (tx) {
      const store = tx.objectStore(STORE_NAMES.lines);
      for (const line of lines) await store.put(line);
      return;
    }
    await withTx(['lines'], 'readwrite', async (inner) => {
      const store = inner.objectStore(STORE_NAMES.lines);
      for (const line of lines) await store.put(line);
    });
  },

  async removeByMedia(mediaId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.lines);
      const keys = await store.index('by-media').getAllKeys(IDBKeyRange.only(mediaId));
      for (const key of keys) await store.delete(key);
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['lines'], 'readwrite', run);
  },

  async removeBySource(sourceId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.lines);
      const keys = await store.index('by-source').getAllKeys(IDBKeyRange.only(sourceId));
      for (const key of keys) await store.delete(key);
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['lines'], 'readwrite', run);
  },

  async count(): Promise<number> {
    return withTx(['lines'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.lines).count());
  },

  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.lines).clear();
      return;
    }
    await withTx(['lines'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.lines).clear();
    });
  },
};

export type LineRepo = typeof lineRepo;
