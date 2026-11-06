/**
 * 频道偏好仓储（`channelPrefs` store，DB v4 / EXT-06 FR-69 FR-70）
 *
 * keyPath = `liveSourceId`：分组与排序按直播源隔离（不同源互不影响）。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type ChannelPrefsRecord } from '@/db/schema';

function toStorable(record: ChannelPrefsRecord): ChannelPrefsRecord {
  return JSON.parse(JSON.stringify(record)) as ChannelPrefsRecord;
}

export const channelPrefsRepo = {
  async get(liveSourceId: string): Promise<ChannelPrefsRecord | null> {
    return withTx(['channelPrefs'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.channelPrefs).get(liveSourceId);
      return found ?? null;
    });
  },

  /** 整条覆盖写入（排序为整表覆盖语义，不做增量 merge） */
  async save(record: ChannelPrefsRecord): Promise<void> {
    await withTx(['channelPrefs'], 'readwrite', (tx) =>
      tx.objectStore(STORE_NAMES.channelPrefs).put(toStorable(record)),
    );
  },

  /** 直播源删除时的级联清理 */
  async remove(liveSourceId: string): Promise<void> {
    await withTx(['channelPrefs'], 'readwrite', (tx) =>
      tx.objectStore(STORE_NAMES.channelPrefs).delete(liveSourceId),
    );
  },

  async list(): Promise<ChannelPrefsRecord[]> {
    return withTx(['channelPrefs'], 'readonly', (tx) =>
      tx.objectStore(STORE_NAMES.channelPrefs).getAll(),
    );
  },
};

export type ChannelPrefsRepo = typeof channelPrefsRepo;
