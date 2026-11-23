/**
 * IndexedDB 版本升级（技术方案 5.3）
 *
 * 规则：
 * 1. 只做加法升级（新增 store / 索引）；禁止改名或删除既有索引。
 * 2. 字段变更走代码层兼容读取（`?? null`），不删数据。
 * 3. 版本高于当前客户端时不调用 `deleteDatabase`，由 db/index.ts 抛 E_VERSION_UNSUPPORTED。
 *
 * 变更登记：
 * - v1（2026-10-20）：创建 sources/media/lines/episodes/categories/history/favorites/
 *   downloads/blobs/kv 共 10 个 store 及技术方案 5.1 列出的全部索引。回滚方式：无（首版）。
 * - v2（2026-10-24，CHG-13）：新增 lives store（直播播放列表，直播源 ≠ 影片源，独立管理）。
 *   回滚方式：删除该 store 即回到 v1 数据形态（v1 客户端忽略多出的 store）。
 * - v4（2026-11-06，EXT-06）：新增 epgSources / channelPrefs / reminders 三个 store；
 *   `epgCache` 键空间由 `{channel}:{date}` 升级为 `epgv2:{sourceId}:{channelKey}:{date}`，
 *   因纯缓存且旧键无 sourceId 语义，升级时直接 clear()；同时写入内置默认 EPG 源。
 *   回滚方式：客户端降级时 v3 及以下忽略多出的 store；旧键缓存已清空但可重建。
 * - v5（2026-11-12）：`history` 新增 `by-media` 索引。详情自愈（`recoverItem`）此前只能
 *   `listAllRaw()` 读出最多 500 条（每条还带 `mediaSnapshot`）再在 JS 里 find；
 *   回滚方式：索引是派生数据，降级后旧客户端不读它即可，无需清表。
 * - v6（2026-11-16，OPT-10）：`danmakuCache` / `epgCache` 新增 `by-fetched` 索引，
 *   供缓存 TTL 清扫与 LRU 上限淘汰按时间遍历（此前只有全表 `getAll`）。
 *   回滚方式：同 v5，纯派生索引，降级后不读即可。
 * - v7（2026-11-22，P1-2）：新增 `subscriptions` store（订阅实体：来源标识 + 订阅自带名称）。
 *   既有链路一律不改口径：`Source.subscriptionId` 照旧写，台账 kv 照旧以 URL 为 key，
 *   新表只用于「找回名称」，读不到时界面回退 `subscriptionLabel()` 的主机名。
 *   回滚方式：`git revert` 后旧客户端忽略多出的 store；该表是可重建的派生数据，
 *   不必清空也不影响任何链路（无外键约束、无唯一约束）。
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';

import type { CinemaDB, EpgSourceRecord, StoreName } from '@/db/schema';
import { BUILTIN_EPG_SOURCE_ID, EPG_DEFAULT_ENDPOINT } from '@/shared/constants';

export function upgrade(
  db: IDBPDatabase<CinemaDB>,
  oldVersion: number,
  _newVersion: number,
  tx: IDBPTransaction<CinemaDB, StoreName[], 'versionchange'>,
): void {
  if (oldVersion < 1) {
    /* ---------- sources ---------- */
    const sources = db.createObjectStore('sources', { keyPath: 'id' });
    sources.createIndex('by-sort', 'sort');
    sources.createIndex('by-type', 'type');
    sources.createIndex('by-enabled', 'enabled');
    sources.createIndex('by-key', 'key', { unique: true });

    /* ---------- media ---------- */
    const media = db.createObjectStore('media', { keyPath: 'id' });
    media.createIndex('by-source', 'sourceId');
    media.createIndex('by-source-updated', ['sourceId', 'updatedAt']);
    media.createIndex('by-title', 'titleLower');
    media.createIndex('by-type', 'type');
    media.createIndex('by-demo', 'isDemo');
    media.createIndex('by-cached', 'cachedAt');

    /* ---------- lines ---------- */
    const lines = db.createObjectStore('lines', { keyPath: 'id' });
    lines.createIndex('by-media', 'mediaId');
    lines.createIndex('by-source', 'sourceId');

    /* ---------- episodes ---------- */
    const episodes = db.createObjectStore('episodes', { keyPath: 'id' });
    episodes.createIndex('by-media', 'mediaId');
    episodes.createIndex('by-media-number', ['mediaId', 'number']);
    episodes.createIndex('by-line', 'lineId');
    episodes.createIndex('by-source', 'sourceId');

    /* ---------- categories ---------- */
    const categories = db.createObjectStore('categories', { keyPath: 'id' });
    categories.createIndex('by-source', 'sourceId');
    categories.createIndex('by-source-order', ['sourceId', 'order']);

    /* ---------- history ---------- */
    const history = db.createObjectStore('history', { keyPath: 'id' });
    history.createIndex('by-updated', 'updatedAt');
    history.createIndex('by-source', 'sourceId');

    /* ---------- favorites ---------- */
    const favorites = db.createObjectStore('favorites', { keyPath: 'id' });
    favorites.createIndex('by-created', 'createdAt');
    favorites.createIndex('by-source', 'sourceId');

    /* ---------- downloads ---------- */
    const downloads = db.createObjectStore('downloads', { keyPath: 'id' });
    downloads.createIndex('by-status', 'status');
    downloads.createIndex('by-media', ['mediaId', 'episodeId']);
    downloads.createIndex('by-created', 'createdAt');
    downloads.createIndex('by-priority', 'priority');

    /* ---------- blobs / kv ---------- */
    db.createObjectStore('blobs', { keyPath: 'key' });
    db.createObjectStore('kv', { keyPath: 'key' });
  }
  if (oldVersion < 2) {
    const lives = db.createObjectStore('lives', { keyPath: 'id' });
    lives.createIndex('by-created', 'createdAt');
  }
  // v3（2026-10-25，CHG-22/23）：danmakuCache / epgCache。纯缓存 store（TTL 自清理），
  // 无既有数据迁移；回滚 = 客户端降级到 v2 时忽略多出的 store。
  if (oldVersion < 3) {
    db.createObjectStore('danmakuCache', { keyPath: 'key' });
    db.createObjectStore('epgCache', { keyPath: 'key' });
  }
  // v4（2026-11-06，EXT-06）：多 EPG 源 / 频道偏好 / 节目提醒。
  if (oldVersion < 4) {
    const epgSources = db.createObjectStore('epgSources', { keyPath: 'id' });
    epgSources.createIndex('by-priority', 'priority');
    // boolean 不是合法 IDB 键：占位索引，过滤在内存完成（同 v1 by-enabled）
    epgSources.createIndex('by-enabled', 'enabled');

    const prefs = db.createObjectStore('channelPrefs', { keyPath: 'liveSourceId' });
    prefs.createIndex('by-updated', 'updatedAt');

    const reminders = db.createObjectStore('reminders', { keyPath: 'id' });
    reminders.createIndex('by-notifyAt', 'notifyAt');
    reminders.createIndex('by-channel', 'channelKey');
    reminders.createIndex('by-state', 'state');

    // epgCache 键空间 v1(`ch:date`) → v2(`epgv2:src:chKey:date`)：纯缓存，直接清空
    if (oldVersion >= 3) {
      tx.objectStore('epgCache').clear();
    }

    // 内置默认源（不可删除）
    const now = Date.now();
    const builtin: EpgSourceRecord = {
      id: BUILTIN_EPG_SOURCE_ID,
      name: '内置默认源',
      endpoint: EPG_DEFAULT_ENDPOINT,
      protocol: 'auto',
      matchMode: 'auto',
      priority: 1,
      enabled: true,
      builtin: true,
      lastProbeAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    tx.objectStore('epgSources').put(builtin);
  }
  // v5：history.by-media（详情自愈按 mediaId 查历史，避免全表读）
  if (oldVersion < 5) {
    tx.objectStore('history').createIndex('by-media', 'mediaId');
  }
  // v6（OPT-10）：缓存表按 fetchedAt 建索引，LRU 淘汰/过期清扫不再需要把整表读进内存
  if (oldVersion < 6) {
    tx.objectStore('danmakuCache').createIndex('by-fetched', 'fetchedAt');
    tx.objectStore('epgCache').createIndex('by-fetched', 'fetchedAt');
  }
  // v7（P1-2）：subscriptions（订阅实体）。纯新增 store，不动任何既有数据；
  // 老库里的订阅不在这里补建——升级窗口里读不到业务数据（没有源可读），
  // 由 `subscriptionLifecycleService.summarize()` 首次聚合时按 `Source.subscriptionId` 懒式补。
  if (oldVersion < 7) {
    db.createObjectStore('subscriptions', { keyPath: 'id' });
  }
}
