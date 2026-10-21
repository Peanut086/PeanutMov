/**
 * 源配置仓储（`sources` store，技术方案 5.1 / API-03）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaDB, type CinemaReadTx, type CinemaTx } from '@/db/schema';
import type { Source } from '@/types';

type SourceStore = CinemaDB['sources'];

function compareSource(a: Source, b: Source): number {
  // 演示源恒排最后（FR-01 / AC-01）
  if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.createdAt - b.createdAt;
}

async function listVia(tx: CinemaReadTx): Promise<Source[]> {
  const all = await tx.objectStore(STORE_NAMES.sources).getAll();
  return all.sort(compareSource);
}

export const sourceRepo = {
  /** 全部源，按 sort 升序；演示源恒最后 */
  async list(): Promise<Source[]> {
    return withTx(['sources'], 'readonly', (tx) => listVia(tx));
  },

  async get(id: string): Promise<Source | null> {
    return withTx(['sources'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.sources).get(id);
      return found ?? null;
    });
  },

  async getByKey(key: string): Promise<Source | null> {
    return withTx(['sources'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.sources).index('by-key').get(key);
      return found ?? null;
    });
  },

  async listEnabled(): Promise<Source[]> {
    return withTx(['sources'], 'readonly', async (tx) => {
      const all = await listVia(tx);
      return all.filter((s) => s.enabled);
    });
  },

  async count(): Promise<number> {
    return withTx(['sources'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.sources).count());
  },

  /** 单条写入（新增或整体覆盖） */
  async save(source: Source): Promise<void> {
    await withTx(['sources'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.sources).put(source);
    });
  },

  /** 批量写入（导入用；调用方负责开启事务以保证原子性） */
  async saveMany(sources: Source[]): Promise<void> {
    await withTx(['sources'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.sources);
      for (const source of sources) await store.put(source);
    });
  },

  async remove(id: string): Promise<void> {
    await withTx(['sources'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.sources).delete(id);
    });
  },

  /** 清空全部源；`tx` 由调用方提供时并入外层事务（清空全部数据用，REV-02） */
  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.sources).clear();
      return;
    }
    await withTx(['sources'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.sources).clear();
    });
  },
};

export type SourceRepo = typeof sourceRepo;
export type { SourceStore };
