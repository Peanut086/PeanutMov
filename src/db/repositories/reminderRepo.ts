/**
 * 节目提醒仓储（`reminders` store，DB v4 / EXT-06 FR-71）
 *
 * `id = r_${hash(channelKey:startAt)}` 由服务层保证确定性；此处只做读写与批量。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type ReminderRecord } from '@/db/schema';

function toStorable(record: ReminderRecord): ReminderRecord {
  return JSON.parse(JSON.stringify(record)) as ReminderRecord;
}

function compareNotifyAt(a: ReminderRecord, b: ReminderRecord): number {
  return a.notifyAt - b.notifyAt;
}

export const reminderRepo = {
  async list(): Promise<ReminderRecord[]> {
    return withTx(['reminders'], 'readonly', async (tx) => {
      const all = await tx.objectStore(STORE_NAMES.reminders).getAll();
      return all.sort(compareNotifyAt);
    });
  },

  async get(id: string): Promise<ReminderRecord | null> {
    return withTx(['reminders'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.reminders).get(id);
      return found ?? null;
    });
  },

  async save(record: ReminderRecord): Promise<void> {
    await withTx(['reminders'], 'readwrite', (tx) =>
      tx.objectStore(STORE_NAMES.reminders).put(toStorable(record)),
    );
  },

  async remove(id: string): Promise<void> {
    await withTx(['reminders'], 'readwrite', (tx) =>
      tx.objectStore(STORE_NAMES.reminders).delete(id),
    );
  },

  /** 按频道批量删除，返回删除条数 */
  async removeByChannel(channelKey: string): Promise<number> {
    return withTx(['reminders'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.reminders);
      const targets = await store.index('by-channel').getAll(channelKey);
      for (const record of targets) await store.delete(record.id);
      return targets.length;
    });
  },

  /** 按直播源批量删除（直播源删除时级联），返回删除条数 */
  async removeBySource(liveSourceId: string): Promise<number> {
    return withTx(['reminders'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.reminders);
      const all = await store.getAll();
      const targets = all.filter((record) => record.liveSourceId === liveSourceId);
      for (const record of targets) await store.delete(record.id);
      return targets.length;
    });
  },

  /** 批量写状态（reconcile 用），返回更新条数 */
  async saveMany(records: ReminderRecord[]): Promise<void> {
    await withTx(['reminders'], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE_NAMES.reminders);
      for (const record of records) await store.put(toStorable(record));
    });
  },
};

export type ReminderRepo = typeof reminderRepo;
