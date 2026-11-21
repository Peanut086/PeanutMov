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
  ChannelGroupDef,
  DanmakuMatch,
  DownloadTask,
  Episode,
  EpgMatchMode,
  EpgProtocol,
  FavoriteRecord,
  HistoryRecord,
  LiveRecord,
  MediaItem,
  PlayLine,
  ReminderDeliveryTier,
  ReminderState,
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
  lives: 'lives',
  danmakuCache: 'danmakuCache',
  epgCache: 'epgCache',
  /** v4（EXT-06/FR-66）：多 EPG 源 */
  epgSources: 'epgSources',
  /** v4（EXT-06/FR-69）：按直播源隔离的分组/排序 */
  channelPrefs: 'channelPrefs',
  /** v4（EXT-06/FR-71）：节目提醒 */
  reminders: 'reminders',
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
    indexes: { 'by-updated': number; 'by-source': string; 'by-media': string };
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
  lives: {
    key: string;
    value: LiveRecord;
    indexes: { 'by-created': number };
  };
  /** v3（CHG-22）：弹幕匹配缓存，key = `${mediaId}:${episodeNumber}`；v6（OPT-10）加 by-fetched */
  danmakuCache: {
    key: string;
    value: DanmakuCacheRecord;
    indexes: { 'by-fetched': number };
  };
  /** v3（CHG-23）：EPG 节目单缓存，key = `epgv2:{sourceId}:{channelKey}:{yyyy-MM-dd}` */
  epgCache: {
    key: string;
    value: EpgCacheRecord;
    indexes: { 'by-fetched': number };
  };
  /** v4（EXT-06）：EPG 源（内置 1 条 + 用户源 ≤10） */
  epgSources: {
    key: string;
    value: EpgSourceRecord;
    indexes: {
      'by-priority': number;
      /** boolean 不是合法 IDB 键，仅占位（过滤在内存完成，同 v1 `by-enabled`） */
      'by-enabled': number;
    };
  };
  /** v4（EXT-06）：每直播源 1 条分组/排序记录 */
  channelPrefs: {
    key: string;
    value: ChannelPrefsRecord;
    indexes: { 'by-updated': number };
  };
  /** v4（EXT-06）：节目提醒（非终态 ≤50） */
  reminders: {
    key: string;
    value: ReminderRecord;
    indexes: { 'by-notifyAt': number; 'by-channel': string; 'by-state': string };
  };
}

/** 弹幕缓存记录（CHG-22：命中即离线可用，TTL 见 DANMAKU_CACHE_TTL_MS） */
export interface DanmakuCacheRecord {
  key: string;
  match: DanmakuMatch;
  fetchedAt: number;
  /**
   * 写入时的选片规则版本（`DANMAKU_MATCH_RULE_VER`）。
   * 缺省＝更早版本的存量，读到时一律作废：命中结果可能来自已修复的串片判据。
   */
  ruleVer?: number;
}

/** EPG 缓存记录（CHG-23：TTL 见 EPG_CACHE_TTL_MS；结构与 epgService.EpgProgramme 对齐） */
export interface EpgCacheRecord {
  key: string;
  programmes: Array<{
    start: string;
    end: string;
    title: string;
    desc: string | null;
    startSec: number;
    endSec: number;
    /** EXT-06：绝对时间（跨天/回看渲染用）；老缓存缺省 undefined */
    startAt?: number;
    endAt?: number;
    /** EXT-06：`${startAt}:${title}`，提醒唯一键 */
    key?: string;
    /** EXT-06：命中源 id */
    sourceId?: string;
  }>;
  /** EXT-06：该源的匹配级别（1/2/3），缓存命中时用于还原"来源（Lx）"标识 */
  matchLevel?: 1 | 2 | 3;
  fetchedAt: number;
}

/** EPG 源记录（v4 / EXT-06，字段与 `EpgSource` 一致，落库形态） */
export interface EpgSourceRecord {
  id: string;
  name: string;
  endpoint: string;
  protocol: EpgProtocol;
  matchMode: EpgMatchMode;
  priority: number;
  enabled: boolean;
  builtin: boolean;
  lastProbeAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 频道偏好记录（v4 / EXT-06，keyPath = liveSourceId，字段与 `ChannelPrefs` 一致） */
export interface ChannelPrefsRecord {
  liveSourceId: string;
  groups: ChannelGroupDef[];
  assignments: Record<string, string>;
  orders: Record<string, string[]>;
  updatedAt: number;
}

/** 节目提醒记录（v4 / EXT-06，字段与 `Reminder` 一致，落库形态） */
export interface ReminderRecord {
  id: string;
  liveSourceId: string;
  epgSourceId: string | null;
  channelKey: string;
  channelName: string;
  programmeKey: string;
  programmeTitle: string;
  startAt: number;
  endAt: number;
  leadMinutes: 0 | 5 | 10 | 15 | 30;
  notifyAt: number;
  state: ReminderState;
  nativeId: number;
  lastError: string | null;
  /**
   * P2-2：排期当时的投递档位与原因。两个字段都可选——本字段之前的历史记录没有它们，
   * 界面按「未记录」处理，不猜成"能准时提醒"。
   */
  delivery?: ReminderDeliveryTier;
  deliveryNote?: string | null;
  createdAt: number;
  updatedAt: number;
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
