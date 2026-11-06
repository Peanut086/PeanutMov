/**
 * EPG 源仓储（`epgSources` store，DB v4 / EXT-06 FR-66）
 *
 * 只用 repo 访问该 store（项目约定）；排序与过滤在服务层完成，
 * `by-enabled` 是 boolean 占位索引，不参与查询。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaReadTx, type EpgSourceRecord } from '@/db/schema';

function comparePriority(a: EpgSourceRecord, b: EpgSourceRecord): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return a.createdAt - b.createdAt;
}

async function listVia(tx: CinemaReadTx): Promise<EpgSourceRecord[]> {
  const all = await tx.objectStore(STORE_NAMES.epgSources).getAll();
  return all.sort(comparePriority);
}

/** 写入前还原为纯值（避免 Proxy/响应式对象落库） */
function toStorable(record: EpgSourceRecord): EpgSourceRecord {
  return JSON.parse(JSON.stringify(record)) as EpgSourceRecord;
}

export const epgSourceRepo = {
  /** 按 priority 升序返回全部源 */
  async list(): Promise<EpgSourceRecord[]> {
    return withTx(['epgSources'], 'readonly', (tx) => listVia(tx));
  },

  async get(id: string): Promise<EpgSourceRecord | null> {
    return withTx(['epgSources'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.epgSources).get(id);
      return found ?? null;
    });
  },

  async save(record: EpgSourceRecord): Promise<void> {
    await withTx(['epgSources'], 'readwrite', (tx) =>
      tx.objectStore(STORE_NAMES.epgSources).put(toStorable(record)),
    );
  },

  /** 整表覆盖优先级（reorder 一次事务写完，避免中间态） */
  async saveMany(records: EpgSourceRecord[]): Promise<void> {
    await withTx(['epgSources'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.epgSources);
      for (const record of records) {
        await store.put(toStorable(record));
      }
    });
  },

  async remove(id: string): Promise<void> {
    await withTx(['epgSources'], 'readwrite', (tx) =>
      tx.objectStore(STORE_NAMES.epgSources).delete(id),
    );
  },
};

export type EpgSourceRepo = typeof epgSourceRepo;
