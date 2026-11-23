/**
 * 订阅实体仓储（`subscriptions` store，DB v7 / P1-2）
 *
 * 一条记录 = 一份导入的订阅本身（不是它派生出的源）。
 * 主键由来源标识派生：`stableId('sub', key)`，`key` 与 `Source.subscriptionId` 同口径（URL 或文件名），
 * 所以重复导入同一地址天然落在同一条上，不需要唯一索引，也不需要"先查后插"的竞态处理。
 */
import { withTx } from '@/db/index';
import { STORE_NAMES, type CinemaTx } from '@/db/schema';
import { stableId } from '@/shared/id';
import type { Subscription } from '@/types';

/** 来源标识 → 订阅实体主键（唯一口径，别处不要再自己拼） */
export function subscriptionIdOf(key: string): string {
  return stableId('sub', key);
}

export interface SubscriptionUpsertInput {
  /** 来源标识（URL 或文件名） */
  key: string;
  url: string | null;
  fileName: string | null;
  /** 解析器给出的订阅名称；空串按 null 处理 */
  name: string | null;
}

async function findByKeyVia(tx: CinemaTx, key: string): Promise<Subscription | null> {
  const found = await tx.objectStore(STORE_NAMES.subscriptions).get(subscriptionIdOf(key));
  return found ?? null;
}

export const subscriptionRepo = {
  /** 按来源标识找回订阅；老库未补建时返回 null */
  async findByKey(key: string, tx?: CinemaTx): Promise<Subscription | null> {
    if (tx) return findByKeyVia(tx, key);
    return withTx(['subscriptions'], 'readonly', async (inner) => {
      const found = await inner.objectStore(STORE_NAMES.subscriptions).get(subscriptionIdOf(key));
      return found ?? null;
    });
  },

  async get(id: string): Promise<Subscription | null> {
    return withTx(['subscriptions'], 'readonly', async (tx) => {
      const found = await tx.objectStore(STORE_NAMES.subscriptions).get(id);
      return found ?? null;
    });
  },

  async save(entity: Subscription, tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.subscriptions).put(entity);
      return;
    }
    await withTx(['subscriptions'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.subscriptions).put(entity);
    });
  },

  /**
   * 按来源标识落一条订阅实体（导入与懒式补建共用）。
   *
   * 名称只在解析器真给出时才覆盖：重新导入一份没带名称的订阅不该把已知名称擦掉。
   * 同地址第二次导入保留首次的 `createdAt`，排序口径（订阅页按导入时间）才不会跳。
   */
  async upsertKeyed(input: SubscriptionUpsertInput, tx?: CinemaTx): Promise<Subscription> {
    const now = Date.now();
    const existing = await this.findByKey(input.key, tx);
    const name = input.name?.trim() ?? '';
    const next: Subscription = {
      id: subscriptionIdOf(input.key),
      key: input.key,
      url: input.url,
      fileName: input.fileName,
      name: name.length > 0 ? name : (existing?.name ?? null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.save(next, tx);
    return next;
  },

  /** 全部订阅，按更新时间倒序（供列表与「改名后整体看」用） */
  async list(): Promise<Subscription[]> {
    return withTx(['subscriptions'], 'readonly', async (tx) => {
      const all = await tx.objectStore(STORE_NAMES.subscriptions).getAll();
      return all.sort((a, b) => b.updatedAt - a.updatedAt);
    });
  },

  /** 该来源标识已不贡献任何源时收掉实体（避免每次换订阅都留一条孤儿） */
  async removeByKey(key: string, tx?: CinemaTx): Promise<void> {
    if (tx) {
      await tx.objectStore(STORE_NAMES.subscriptions).delete(subscriptionIdOf(key));
      return;
    }
    await withTx(['subscriptions'], 'readwrite', async (inner) => {
      await inner.objectStore(STORE_NAMES.subscriptions).delete(subscriptionIdOf(key));
    });
  },

  async count(): Promise<number> {
    return withTx(['subscriptions'], 'readonly', (tx) =>
      tx.objectStore(STORE_NAMES.subscriptions).count(),
    );
  },
};

export type SubscriptionRepo = typeof subscriptionRepo;
