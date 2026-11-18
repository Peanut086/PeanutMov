/**
 * 下载任务仓储（`downloads` store）
 *
 * 去重规则（技术方案 5.2）：`by-media(mediaId, episodeId)` 非唯一索引，
 * 查询时按状态优先级取"仍然有效"的一条（downloading > queued > paused > failed > completed > canceled）。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import { aggregateSummary } from '@/shared/downloadSummary';
import type { DownloadStatus, DownloadSummary, DownloadTask } from '@/types';

const STATUS_PRIORITY: Record<DownloadStatus, number> = {
  downloading: 0,
  queued: 1,
  paused: 2,
  failed: 3,
  completed: 4,
  canceled: 5,
};

export const downloadRepo = {
  async get(id: string): Promise<DownloadTask | null> {
    return withTx(['downloads'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.downloads).get(id);
      return found ?? null;
    });
  },

  /** 某集对应的全部任务（按状态优先级排序，首条为"当前有效任务"） */
  async listByEpisode(mediaId: string, episodeId: string): Promise<DownloadTask[]> {
    return withTx(['downloads'], 'readonly', async (tx) => {
      const rows = await tx
        .objectStore(STORE_NAMES.downloads)
        .index('by-media')
        .getAll(IDBKeyRange.only([mediaId, episodeId]));
      return rows.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
    });
  },

  /**
   * 某媒体下的全部任务（跨线路/跨集）。
   * 利用复合索引 `by-media: [mediaId, episodeId]` 的范围查询：
   * `bound([mediaId], [mediaId, '\uffff'])` 命中所有 episodeId。
   * 用于离线播放时按 episodeNumber 回退查找（线路不同 episodeId 不同）。
   */
  async listByMedia(mediaId: string): Promise<DownloadTask[]> {
    return withTx(['downloads'], 'readonly', async (tx) => {
      const rows = await tx
        .objectStore(STORE_NAMES.downloads)
        .index('by-media')
        .getAll(IDBKeyRange.bound([mediaId], [mediaId, '\uffff']));
      return rows.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status]);
    });
  },

  /** 全部任务：priority 升序（值小优先），同 priority 按 createdAt 升序 */
  async listAll(): Promise<DownloadTask[]> {
    return withTx(['downloads'], 'readonly', async (tx) => {
      const rows = await tx.objectStore(STORE_NAMES.downloads).getAll();
      return rows.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.createdAt - b.createdAt));
    });
  },

  async listByStatus(statuses: DownloadStatus[]): Promise<DownloadTask[]> {
    if (statuses.length === 0) return [];
    return withTx(['downloads'], 'readonly', async (tx) => {
      const index = tx.objectStore(STORE_NAMES.downloads).index('by-status');
      const out: DownloadTask[] = [];
      for (const status of statuses) {
        const rows = await index.getAll(IDBKeyRange.only(status));
        out.push(...rows);
      }
      return out.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
    });
  },

  async count(): Promise<number> {
    return withTx(['downloads'], 'readonly', (tx) => tx.objectStore(STORE_NAMES.downloads).count());
  },

  async save(task: DownloadTask, tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.downloads).put(task);
      return;
    }
    await withTx(['downloads'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.downloads).put(task);
    });
  },

  async remove(id: string): Promise<void> {
    await withTx(['downloads'], 'readwrite', async (tx) => {
      await tx.objectStore(STORE_NAMES.downloads).delete(id);
    });
  },

  async removeBySource(sourceId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.downloads);
      const rows = await store.getAll();
      for (const row of rows) {
        if (row.sourceId === sourceId) await store.delete(row.id);
      }
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['downloads'], 'readwrite', run);
  },

  async removeByMedia(mediaId: string, tx?: CinemaTx): Promise<void> {
    const run = async (inner: CinemaTx): Promise<void> => {
      const store = inner.objectStore(STORE_NAMES.downloads);
      const rows = await store.getAll();
      for (const row of rows) {
        if (row.mediaId === mediaId) await store.delete(row.id);
      }
    };
    if (tx) {
      await run(tx);
      return;
    }
    await withTx(['downloads'], 'readwrite', run);
  },

  async clear(tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.downloads).clear();
      return;
    }
    await withTx(['downloads'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.downloads).clear();
    });
  },

  /** 汇总统计（一次读取计算；任务量级为几十~几百，内存计算可接受） */
  async summary(): Promise<DownloadSummary> {
    return aggregateSummary(await this.listAll());
  },
};

export type DownloadRepo = typeof downloadRepo;
