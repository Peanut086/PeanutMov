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
 */
import type { IDBPDatabase } from 'idb';

import type { CinemaDB } from '@/db/schema';

export function upgrade(db: IDBPDatabase<CinemaDB>, oldVersion: number, _newVersion: number): void {
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
  // 未来：if (oldVersion < 3) { db.createObjectStore('xxx', ...) }
}
