/**
 * 源配置仓储（`sources` store，技术方案 5.1 / API-03）
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaDB, type CinemaReadTx, type CinemaTx } from '@/db/schema';
import type { Source } from '@/types';

type SourceStore = CinemaDB['sources'];

/**
 * 写入前把 `Source` 还原成纯 JSON 值。
 *
 * `Source.ext` / `headers` 常来自订阅预览，而预览存在 Vue 的 `ref` 里，
 * 深层字段会被包成响应式 Proxy；IndexedDB 的结构化克隆无法克隆 Proxy，
 * 会抛 `DataCloneError`（表现为整批导入失败并报「本地数据读写失败」）。
 * 用 JSON 往返去掉 Proxy，同时顺带保证存进库的只有可序列化数据。
 */
export function toStorableSource(source: Source): Source {
  return JSON.parse(JSON.stringify(source)) as Source;
}

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
      await tx.objectStore(STORE_NAMES.sources).put(toStorableSource(source));
    });
  },

  /** 批量写入（导入用；调用方负责开启事务以保证原子性） */
  async saveMany(sources: Source[]): Promise<void> {
    await withTx(['sources'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.sources);
      for (const source of sources) await store.put(toStorableSource(source));
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
