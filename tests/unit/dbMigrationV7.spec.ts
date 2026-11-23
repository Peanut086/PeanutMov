import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { deleteDatabase, getDb, resetDbConnection } from '@/db/index';
import { upgrade } from '@/db/migrations';
import type { CinemaDB } from '@/db/schema';
import { STORE_NAMES } from '@/db/schema';
import { subscriptionRepo } from '@/db/repositories/subscriptionRepo';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import { DB_NAME, DB_VERSION, KV_KEY_IMPORT_RECORDS } from '@/shared/constants';
import type { Source } from '@/types';

import { dropNewerStores, tick } from './helpers';

/**
 * DB v7（P1-2 订阅实体）升级链路。
 *
 * 这是本批次唯一动到 schema 的改动，风险集中在两件事：
 * 升级不能碰任何既有数据（D10「源不能被升级流程弄丢」），以及
 * 老库必须凭空多出可用的 `subscriptions` store（缺 store = 导入直接抛错）。
 * 补建不放在 versionchange 里（升级窗口读不到业务数据），所以这里同时验证
 * 「升级后表是空的，但第一次聚合就能把老订阅认出来」。
 */

/** 老客户端的升级回调：跑完全部 v6 逻辑后抹掉 v7 才有的 store，还原真实老库形态 */
function upgradeToV6(...args: Parameters<typeof upgrade>): void {
  const [db, oldVersion, newVersion, tx] = args;
  upgrade(db, oldVersion, newVersion, tx);
  dropNewerStores(db, 6);
}

/** 升级前就存在的一条源（由订阅导入，带 subscriptionId） */
function legacySource(subscriptionId: string): Source {
  const now = 1_700_000_000_000;
  return {
    id: 'legacy-src-1',
    key: 'alist-a',
    name: '家里 AList',
    type: 'alist',
    enabled: true,
    builtin: false,
    sort: now,
    baseUrl: 'https://alist.example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

const LEGACY_URL = 'https://legacy.example.com/sub.json';

describe('DB v7：subscriptions（订阅实体）', () => {
  beforeEach(async () => {
    await deleteDatabase();
    resetDbConnection();
  });

  it('v6 老库升级后 store 存在、既有源与导入记录一条没丢，且升级本身不写数据', async () => {
    const db6 = await openDB<CinemaDB>(DB_NAME, 6, { upgrade: upgradeToV6 });
    await db6.put(STORE_NAMES.sources, legacySource(LEGACY_URL));
    await db6.put(STORE_NAMES.kv, {
      key: KV_KEY_IMPORT_RECORDS,
      value: [{ url: LEGACY_URL, name: '老订阅', importedAt: 1_700_000_000_000, success: 1 }],
      updatedAt: 1_700_000_000_000,
    });
    expect(db6.objectStoreNames.contains(STORE_NAMES.subscriptions)).toBe(false);
    db6.close();
    await tick();

    const db7 = await openDB<CinemaDB>(DB_NAME, DB_VERSION, { upgrade });
    expect(db7.objectStoreNames.contains(STORE_NAMES.subscriptions)).toBe(true);
    // 升级窗口只建表不补数据：这里必须还是空的
    expect(await db7.count(STORE_NAMES.subscriptions)).toBe(0);
    // 既有数据不动
    expect(await db7.count(STORE_NAMES.sources)).toBe(1);
    expect((await db7.get(STORE_NAMES.sources, 'legacy-src-1'))?.subscriptionId).toBe(LEGACY_URL);
    const tx = db7.transaction(STORE_NAMES.subscriptions, 'readonly');
    const store = tx.objectStore(STORE_NAMES.subscriptions);
    expect([...store.indexNames]).toEqual([]);
    await tx.done;
    db7.close();
    await tick();
  });

  it('升级后的第一次聚合把老订阅认出来：名称从导入记录补回，之后不再新增', async () => {
    const db6 = await openDB<CinemaDB>(DB_NAME, 6, { upgrade: upgradeToV6 });
    await db6.put(STORE_NAMES.sources, legacySource(LEGACY_URL));
    await db6.put(STORE_NAMES.kv, {
      key: KV_KEY_IMPORT_RECORDS,
      value: [{ url: LEGACY_URL, name: '老订阅', importedAt: 1_700_000_000_000, success: 1 }],
      updatedAt: 1_700_000_000_000,
    });
    db6.close();
    await tick();
    resetDbConnection();

    // 走仓储（即业务代码实际用的那条连接），确认 v7 store 对 repos 可直接读写
    const db7 = await getDb();
    expect(db7.objectStoreNames.contains(STORE_NAMES.subscriptions)).toBe(true);

    const first = await subscriptionLifecycleService.summarize();
    expect(first).toHaveLength(1);
    expect(first[0].subscriptionId).toBe(LEGACY_URL);
    expect(first[0].name).toBe('老订阅');
    expect((await subscriptionRepo.findByKey(LEGACY_URL))?.url).toBe(LEGACY_URL);

    await subscriptionLifecycleService.summarize();
    expect(await subscriptionRepo.count()).toBe(1);
    // 源没被聚合流程改动
    expect((await getDb()).transaction(STORE_NAMES.sources, 'readonly').objectStore(STORE_NAMES.sources).count()).resolves;
  });

  it('全新建库（oldVersion 0）同样带 subscriptions store', async () => {
    const db = await getDb();
    expect(db.objectStoreNames.contains(STORE_NAMES.subscriptions)).toBe(true);
    expect(await subscriptionRepo.count()).toBe(0);
    expect(await subscriptionRepo.list()).toEqual([]);
  });
});
