/**
 * IndexedDB 结构定义（技术方案 5.1）
 *
 * - keyPath 与索引名是**契约**：升级只允许新增 store / 索引，禁止改名。
 * - `by-enabled` / `by-demo` 建在 boolean 字段上：IndexedDB 的合法键不含 boolean，
 *   因此这两个索引实际不产生条目（创建它们只为保持表结构与文档一致），
 *   启用状态与演示条目的过滤在内存中完成（数据量小，不影响性能）。
 */
import type { DBSchema, IDBPTransaction } from 'idb';

import type {
  Category,
  DownloadTask,
  Episode,
  FavoriteRecord,
  HistoryRecord,
  MediaItem,
  PlayLine,
  Source,
  SourceType,
} from '@/types';

/* ---------- store 名常量 ---------- */
export const STORE_NAMES = {
  sources: 'sources',
  media: 'media',
  lines: 'lines',
  episodes: 'episodes',
  categories: 'categories',
  history: 'history',
  favorites: 'favorites',
  downloads: 'downloads',
  blobs: 'blobs',
  kv: 'kv',
} as const;

/** Web 端下载内容（技术方案 5.1） */
export interface BlobRecord {
  key: string;
  blob: Blob;
  size: number;
  mime: string;
  createdAt: number;
}

/** 通用键值记录（设置、演示种子标记、导入记录） */
export interface KvRecord {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface CinemaDB extends DBSchema {
  sources: {
    key: string;
    value: Source;
    indexes: {
      'by-sort': number;
      'by-type': SourceType;
      /** boolean 不是合法 IDB 键，仅占位保持结构一致 */
      'by-enabled': number;
      'by-key': string;
    };
  };
  media: {
    key: string;
    value: MediaItem;
    indexes: {
      'by-source': string;
      'by-source-updated': [string, number];
      'by-title': string;
      'by-type': string;
      /** 同 by-enabled，boolean 键不产生条目 */
      'by-demo': number;
      'by-cached': number;
    };
  };
  lines: {
    key: string;
    value: PlayLine;
    indexes: { 'by-media': string; 'by-source': string };
  };
  episodes: {
    key: string;
    value: Episode;
    indexes: {
      'by-media': string;
      'by-media-number': [string, number];
      'by-line': string;
      'by-source': string;
    };
  };
  categories: {
    key: string;
    value: Category;
    indexes: { 'by-source': string; 'by-source-order': [string, number] };
  };
  history: {
    key: string;
    value: HistoryRecord;
    indexes: { 'by-updated': number; 'by-source': string };
  };
  favorites: {
    key: string;
    value: FavoriteRecord;
    indexes: { 'by-created': number; 'by-source': string };
  };
  downloads: {
    key: string;
    value: DownloadTask;
    indexes: {
      'by-status': string;
      'by-media': [string, string];
      'by-created': number;
      'by-priority': number;
    };
  };
  blobs: {
    key: string;
    value: BlobRecord;
  };
  kv: {
    key: string;
    value: KvRecord;
  };
}

/** store 名字面量联合（注意：`keyof CinemaDB` 含 DBSchema 的字符串索引，会退化为 string） */
export type StoreName = (typeof STORE_NAMES)[keyof typeof STORE_NAMES];

/**
 * 事务对象类型别名：repositories 的可选 `tx` 入参用它，
 * 便于服务层把多个 repo 写入合并到一个跨表事务（如导入、级联删除）。
 */
export type CinemaTx = IDBPTransaction<CinemaDB, StoreName[], 'readwrite'>;

/** 全 store 的只读事务 */
export type CinemaReadTx = IDBPTransaction<CinemaDB, StoreName[], 'readonly'>;
