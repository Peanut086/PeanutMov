/**
 * 剧集仓储（`episodes` store）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import type { Episode } from '@/types';

const BATCH_SIZE = 200;

export const episodeRepo = {
  async get(id: string): Promise<Episode | null> {
    return withTx(['episodes'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.episodes).get(id);
      return found ?? null;
    });
  },

  /** 某媒体全部剧集，按 number 升序 */
  async listByMedia(mediaId: string): Promise<Episode[]> {
    return withTx(['episodes'], 'readonly', async (tx) => {
      const rows = await tx
        .objectStore(STORE_NAMES.episodes)
        .index('by-media')
        .getAll(IDBKeyRange.only(mediaId));
      return rows.sort((a, b) => a.number - b.number);
    });
  },

  /** 某线路全部剧集，按 number 升序 */
  async listByLine(lineId: string): Promise<Episode[]> {
    return withTx(['episodes'], 'readonly', async (tx) => {
      const rows = await tx
        .objectStore(STORE_NAMES.episodes)
        .index('by-line')
        .getAll(IDBKeyRange.only(lineId));
      return rows.sort((a, b) => a.number - b.number);
    });
  },

  async saveMany(episodes: Episode[], tx?: CinemaTx): Promise<void> {
    if (episodes.length === 0) return;
    if (tx) {
      const store = tx.objectStore(STORE_NAMES.episodes);
      for (const ep of episodes) await store.put(ep);
      return;
    }
    for (let i = 0; i < episodes.length; i += BATCH_SIZE) {
      const chunk = episodes.slice(i, i + BATCH_SIZE);
      await withTx(['episodes'], 'readwrite', async (inner) => {
        const store = inner.objectStore(STORE_NAMES.episodes);
        for (const ep of chunk) await store.put(ep);
      });
      if (i + BATCH_SIZE < episodes.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  },

  async removeByMedia(mediaId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.episodes);
      const keys = await store.index('by-media').getAllKeys(IDBKeyRange.only(mediaId));
      for (const key of keys) await store.delete(key);
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['episodes'], 'readwrite', run);
  },

  async removeBySource(sourceId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.episodes);
      const keys = await store.index('by-source').getAllKeys(IDBKeyRange.only(sourceId));
      for (const key of keys) await store.delete(key);
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['episodes'], 'readwrite', run);
  },

  async count(): Promise<number> {
    return withTx(['episodes'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.episodes).count());
  },

  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.episodes).clear();
      return;
    }
    await withTx(['episodes'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.episodes).clear();
    });
  },
};

export type EpisodeRepo = typeof episodeRepo;
