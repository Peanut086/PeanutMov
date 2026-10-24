/**
 * 直播播放列表仓储（`lives` store，CHG-13 / DB v2）
 *
 * 频道本身不落库：直播源更新频繁，频道列表由 liveService 按需拉取解析并做短 TTL 缓存。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaReadTx } from '@/db/schema';
import type { LiveRecord } from '@/types';

/** 写入前还原成纯值（同 sourceRepo.toStorableSource 的 Proxy 防护） */
function toStorableLive(record: LiveRecord): LiveRecord {
  return JSON.parse(JSON.stringify(record)) as LiveRecord;
}

function compareCreated(a: LiveRecord, b: LiveRecord): number {
  return a.createdAt - b.createdAt;
}

async function listVia(tx: CinemaReadTx): Promise<LiveRecord[]> {
  const all = await tx.objectStore(STORE_NAMES.lives).getAll();
  return all.sort(compareCreated);
}

export const liveRepo = {
  async list(): Promise<LiveRecord[]> {
    return withTx(['lives'], 'readonly', (tx) => listVia(tx));
  },

  async get(id: string): Promise<LiveRecord | null> {
    return withTx(['lives'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.lives).get(id);
      return found ?? null;
    });
  },

  async getByUrl(url: string): Promise<LiveRecord | null> {
    const all = await liveRepo.list();
    return all.find((record) => record.url === url) ?? null;
  },

  async save(record: LiveRecord): Promise<void> {
    await withTx(['lives'], 'readwrite', (tx) =>
      tx.objectStore(STORE_NAMES.lives).put(toStorableLive(record)),
    );
  },

  async remove(id: string): Promise<void> {
    await withTx(['lives'], 'readwrite', (tx) => tx.objectStore(STORE_NAMES.lives).delete(id));
  },
};
