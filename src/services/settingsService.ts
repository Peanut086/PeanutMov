/**
 * 设置服务（API-10）
 *
 * 存储：`kv` 表 key = `app-settings`（KV_KEY_SETTINGS）。
 * - `get()` 不存在时写入默认值（含 `complianceVersion = COMPLIANCE_VERSION`）；
 * - `update()` 深合并（仅 player.subtitle / player / gesture / download 走深合并，其余整体覆盖）；
 * - `schemaVersion` 禁止外部修改。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { blobRepo } from '@/db/repositories/blobRepo';
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { withTx } from '@/db/index';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { appEvents } from '@/services/events';
import { COMPLIANCE_VERSION, KV_KEY_SETTINGS, SEARCH_HISTORY_MAX } from '@/shared/constants';
import { AppError } from '@/shared/errors';
import type { AppSettings, DeepPartial, DownloadSettings, GestureSettings, PlayerSettings } from '@/types';

const SCHEMA_VERSION = 1;

export function defaultSettings(now: number = Date.now()): AppSettings {
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: 'dark',
    locale: 'zh-CN',
    complianceVersion: COMPLIANCE_VERSION,
    complianceAcceptedAt: null,
    defaultSourceId: null,
    hideDemoContent: false,
    player: {
      defaultRate: 1,
      defaultQuality: 'auto',
      autoPlayNext: true,
      seekStepSec: 10,
      longPressRate: 2,
      subtitle: {
        enabled: false,
        size: 'medium',
        color: 'white',
        background: 'black',
        offsetSec: 0,
        preferredLang: null,
      },
      rememberVolumeBrightness: true,
      lastVolume: 100,
      lastBrightness: 100,
    },
    gesture: { sensitivity: 'medium', seekMaxSec: 90 },
    download: { concurrency: 2, wifiOnly: false, autoResume: true },
    searchHistory: [],
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 仅对对象型字段做一层/多层深合并；数组与基本类型整体替换 */
function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined) return base;
  if (!isRecord(base) || !isRecord(patch)) {
    return patch as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

/** 校正设置的合法域（越界值回落到默认，避免 UI 崩溃） */
function sanitize(input: AppSettings): AppSettings {
  const defaults = defaultSettings(input.updatedAt);
  const playerPatch = input.player as Partial<PlayerSettings> | undefined;
  const gesturePatch = input.gesture as Partial<GestureSettings> | undefined;
  const downloadPatch = input.download as Partial<DownloadSettings> | undefined;

  const player: PlayerSettings = {
    ...defaults.player,
    ...(playerPatch ?? {}),
    subtitle: { ...defaults.player.subtitle, ...(playerPatch?.subtitle ?? {}) },
  };
  player.lastVolume = Math.max(0, Math.min(100, Number(player.lastVolume) || 0));
  player.lastBrightness = Math.max(0, Math.min(100, Number(player.lastBrightness) || 0));
  player.subtitle.offsetSec = Math.max(-5, Math.min(5, Number(player.subtitle.offsetSec) || 0));

  const gesture: GestureSettings = { ...defaults.gesture, ...(gesturePatch ?? {}) };
  gesture.seekMaxSec = Math.max(30, Math.min(180, Number(gesture.seekMaxSec) || defaults.gesture.seekMaxSec));

  const download: DownloadSettings = { ...defaults.download, ...(downloadPatch ?? {}) };
  download.concurrency = ([1, 2, 3] as const).includes(download.concurrency) ? download.concurrency : 2;

  return {
    ...defaults,
    ...input,
    schemaVersion: SCHEMA_VERSION,
    locale: 'zh-CN',
    complianceVersion:
      typeof input.complianceVersion === 'number' && Number.isFinite(input.complianceVersion)
        ? input.complianceVersion
        : defaults.complianceVersion,
    complianceAcceptedAt:
      typeof input.complianceAcceptedAt === 'number' && input.complianceAcceptedAt > 0
        ? input.complianceAcceptedAt
        : null,
    hideDemoContent: Boolean(input.hideDemoContent),
    searchHistory: Array.isArray(input.searchHistory)
      ? input.searchHistory.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, SEARCH_HISTORY_MAX)
      : [],
    player,
    gesture,
    download,
  };
}

let cached: AppSettings | null = null;

async function load(): Promise<AppSettings> {
  if (cached) return cached;
  const stored = await kvRepo.get<AppSettings>(KV_KEY_SETTINGS);
  if (!stored) {
    const fresh = defaultSettings();
    await kvRepo.set(KV_KEY_SETTINGS, fresh);
    cached = fresh;
    return fresh;
  }
  if (stored.schemaVersion !== SCHEMA_VERSION) {
    // 旧版本设置：代码层兼容（补默认值），不删数据
    const migrated = sanitize({ ...defaultSettings(), ...stored });
    await kvRepo.set(KV_KEY_SETTINGS, migrated);
    cached = migrated;
    return migrated;
  }
  const normalized = sanitize(stored);
  cached = normalized;
  return normalized;
}

async function persist(next: AppSettings): Promise<AppSettings> {
  await kvRepo.set(KV_KEY_SETTINGS, next);
  cached = next;
  return next;
}

export const settingsService = {
  async get(): Promise<AppSettings> {
    return load();
  },

  async update(patch: DeepPartial<AppSettings>): Promise<AppSettings> {
    const current = await load();
    if (isRecord(patch) && 'schemaVersion' in patch) {
      const incoming = (patch as { schemaVersion?: unknown }).schemaVersion;
      if (incoming !== undefined && incoming !== SCHEMA_VERSION) {
        throw new AppError('E_INVALID_INPUT', 'schemaVersion 不允许修改');
      }
    }
    const merged = sanitize(deepMerge(current, patch));
    merged.updatedAt = Date.now();
    const next = await persist(merged);
    appEvents.emit('settings:changed', { patch: (patch ?? {}) as Record<string, unknown> });
    return next;
  },

  async reset(): Promise<AppSettings> {
    const fresh = defaultSettings();
    const next = await persist(fresh);
    appEvents.emit('settings:changed', { patch: {} });
    return next;
  },

  async acceptCompliance(version: number): Promise<void> {
    const current = await load();
    const next: AppSettings = {
      ...current,
      complianceVersion: Math.max(current.complianceVersion, version),
      complianceAcceptedAt: Date.now(),
      updatedAt: Date.now(),
    };
    await persist(next);
    appEvents.emit('settings:changed', { patch: { complianceVersion: next.complianceVersion } });
  },

  async isComplianceAccepted(version: number): Promise<boolean> {
    const current = await load();
    return current.complianceAcceptedAt !== null && current.complianceVersion >= version;
  },

  async pushSearchHistory(keyword: string): Promise<string[]> {
    const trimmed = keyword.trim();
    if (trimmed.length === 0) return (await load()).searchHistory;
    const current = await load();
    const next = [trimmed, ...current.searchHistory.filter((k) => k !== trimmed)].slice(0, SEARCH_HISTORY_MAX);
    const updated = await persist({ ...current, searchHistory: next, updatedAt: Date.now() });
    return updated.searchHistory;
  },

  async clearSearchHistory(): Promise<void> {
    const current = await load();
    await persist({ ...current, searchHistory: [], updatedAt: Date.now() });
  },

  /**
   * 清空业务数据（源/媒体/线路/剧集/分类/历史/收藏/下载/Blob），可选保留演示源与演示条目。
   * 设置本身（主题、搜索历史、合规状态）保留；`keepDemo` 为 true 时重新种入演示数据。
   */
  async resetAllData(opts: { keepDemo: boolean }): Promise<void> {
    await withTx(
      ['sources', 'media', 'lines', 'episodes', 'categories', 'history', 'favorites', 'downloads', 'blobs'],
      'readwrite',
      async (tx) => {
        await sourceRepo.clear();
        await mediaRepo.clear(tx);
        await lineRepo.clear(tx);
        await episodeRepo.clear(tx);
        await categoryRepo.clear(tx);
        await historyRepo.clear(tx);
        await favoriteRepo.clear(tx);
        await downloadRepo.clear(tx);
        // blobs 也在此事务内（tx 已包含该 store）
        await tx.objectStore('blobs').clear();
      },
    ).catch((e: unknown) => {
      throw e instanceof AppError ? e : new AppError('E_DB', undefined, { detail: String(e) });
    });

    if (opts.keepDemo) {
      await seedDemoData({ sourceId: DEMO_SOURCE_ID, restore: true });
    }
    const current = await load();
    await persist({ ...current, defaultSourceId: null, updatedAt: Date.now() });
    appEvents.emit('sources:changed', { reason: 'remove' });
    appEvents.emit('history:changed', { id: null });
    appEvents.emit('favorites:changed', { id: null });
    appEvents.emit('downloads:changed', { id: null });
  },

  /** 存储统计（设置页展示；Web 端 blobs + 下载任务记录） */
  async storageStats(): Promise<{ blobsBytes: number; blobCount: number; downloadBytes: number; itemCount: number }> {
    const [blobsBytes, blobCount, summary, itemCount] = await Promise.all([
      blobRepo.totalBytes(),
      blobRepo.count(),
      downloadRepo.summary(),
      mediaRepo.count(),
    ]);
    return { blobsBytes, blobCount, downloadBytes: summary.downloadedBytes, itemCount };
  },

  /** 测试辅助：清空内存缓存 */
  __resetCache(): void {
    cached = null;
  },
};

export type SettingsService = typeof settingsService;
