/**
 * 备份服务（API-13）
 *
 * - 导出：`schemaVersion = 1`，默认脱敏 `auth.password` / `auth.token`；
 * - 导入：校验 `schemaVersion`（缺失/过高 → `E_VERSION_UNSUPPORTED`），
 *   单事务写 sources/favorites/history（可选 settings），失败全回滚。
 */
import { withTx } from '@/db/index';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { settingsService } from '@/services/settingsService';
import { appEvents } from '@/services/events';
import { APP_VERSION, BACKUP_SCHEMA_VERSION, HISTORY_MAX } from '@/shared/constants';
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { formatDateStamp } from '@/shared/time';
import { Share } from '@capacitor/share';
import { isNative } from '@/shared/platform';
import { writeTextFile } from '@/native/fs';
import type {
  BackupFile,
  BackupImportReport,
  BackupMode,
  DownloadTask,
  FavoriteRecord,
  HistoryRecord,
  Source,
} from '@/types';

export interface BackupService {
  exportData(opts: { includeCredentials: boolean }): Promise<Blob>;
  exportToFile(opts: { includeCredentials: boolean; fileName?: string }): Promise<{ path: string | null; fileName: string }>;
  parseBackup(file: File): Promise<BackupFile>;
  importData(backup: BackupFile, mode: BackupMode): Promise<BackupImportReport>;
}

function redactSource(source: Source): Source {
  return {
    ...source,
    auth: {
      ...source.auth,
      password: null,
      token: null,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function validateSource(value: unknown): Source | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['name'] !== 'string') return null;
  if (typeof value['type'] !== 'string') return null;
  const auth = isRecord(value['auth']) ? value['auth'] : {};
  return {
    ...(value as unknown as Source),
    key: typeof value['key'] === 'string' ? value['key'] : value['id'],
    enabled: value['enabled'] !== false,
    builtin: Boolean(value['builtin']),
    sort: typeof value['sort'] === 'number' ? value['sort'] : 0,
    baseUrl: typeof value['baseUrl'] === 'string' ? value['baseUrl'] : '',
    pathPrefix: typeof value['pathPrefix'] === 'string' ? value['pathPrefix'] : null,
    auth: {
      mode: auth['mode'] === 'basic' || auth['mode'] === 'token' ? auth['mode'] : 'none',
      username: typeof auth['username'] === 'string' ? auth['username'] : null,
      password: typeof auth['password'] === 'string' ? auth['password'] : null,
      token: typeof auth['token'] === 'string' ? auth['token'] : null,
    },
    headers: isRecord(value['headers']) ? (value['headers'] as Record<string, string>) : {},
    ext: isRecord(value['ext']) ? (value['ext'] as Record<string, unknown>) : null,
    subscriptionId: typeof value['subscriptionId'] === 'string' ? value['subscriptionId'] : null,
    warning: typeof value['warning'] === 'string' ? value['warning'] : null,
    health: typeof value['health'] === 'string' ? (value['health'] as Source['health']) : 'unknown',
    healthCheckedAt: typeof value['healthCheckedAt'] === 'number' ? value['healthCheckedAt'] : null,
    lastErrorCode: null,
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

function validateFavorite(value: unknown): FavoriteRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['sourceId'] !== 'string') return null;
  if (typeof value['mediaId'] !== 'string' || typeof value['title'] !== 'string') return null;
  return {
    ...(value as unknown as FavoriteRecord),
    posterUrl: typeof value['posterUrl'] === 'string' ? value['posterUrl'] : null,
    type: typeof value['type'] === 'string' ? (value['type'] as FavoriteRecord['type']) : 'other',
    year: typeof value['year'] === 'number' ? value['year'] : null,
    sourceRemoved: Boolean(value['sourceRemoved']),
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
  };
}

function validateHistory(value: unknown): HistoryRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value['id'] !== 'string' || typeof value['sourceId'] !== 'string') return null;
  if (typeof value['mediaId'] !== 'string') return null;
  const durationSec = typeof value['durationSec'] === 'number' ? value['durationSec'] : 0;
  if (durationSec <= 0) return null;
  const positionSec = typeof value['positionSec'] === 'number' ? value['positionSec'] : 0;
  return {
    ...(value as unknown as HistoryRecord),
    episodeId: typeof value['episodeId'] === 'string' ? value['episodeId'] : null,
    episodeNumber: typeof value['episodeNumber'] === 'number' ? value['episodeNumber'] : null,
    title: typeof value['title'] === 'string' ? value['title'] : '未命名',
    posterUrl: typeof value['posterUrl'] === 'string' ? value['posterUrl'] : null,
    positionSec,
    durationSec,
    progress: typeof value['progress'] === 'number' ? value['progress'] : positionSec / durationSec,
    finished: Boolean(value['finished']),
    totalEpisodes: typeof value['totalEpisodes'] === 'number' ? value['totalEpisodes'] : null,
    createdAt: typeof value['createdAt'] === 'number' ? value['createdAt'] : Date.now(),
    updatedAt: typeof value['updatedAt'] === 'number' ? value['updatedAt'] : Date.now(),
  };
}

/** 校验并规范化备份文件结构（不发 IO） */
export function normalizeBackupFile(raw: unknown): BackupFile {
  if (!isRecord(raw)) {
    throw new AppError('E_PARSE', '备份文件格式不支持');
  }
  const schemaVersion = raw['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isFinite(schemaVersion)) {
    throw new AppError('E_VERSION_UNSUPPORTED', '备份文件缺少版本信息');
  }
  if (schemaVersion > BACKUP_SCHEMA_VERSION) {
    throw new AppError('E_VERSION_UNSUPPORTED', '备份版本不支持，请升级 App');
  }
  if (!Array.isArray(raw['sources']) && !Array.isArray(raw['favorites']) && !Array.isArray(raw['history'])) {
    throw new AppError('E_PARSE', '备份文件格式不支持');
  }

  return {
    schemaVersion,
    appVersion: typeof raw['appVersion'] === 'string' ? raw['appVersion'] : '未知版本',
    exportedAt: typeof raw['exportedAt'] === 'number' ? raw['exportedAt'] : Date.now(),
    sources: asArray<unknown>(raw['sources'])
      .map(validateSource)
      .filter((value): value is Source => value !== null),
    favorites: asArray<unknown>(raw['favorites'])
      .map(validateFavorite)
      .filter((value): value is FavoriteRecord => value !== null),
    history: asArray<unknown>(raw['history'])
      .map(validateHistory)
      .filter((value): value is HistoryRecord => value !== null),
    settings: isRecord(raw['settings']) ? (raw['settings'] as unknown as BackupFile['settings']) : null,
    downloads: asArray<unknown>(raw['downloads']).filter(isRecord) as BackupFile['downloads'],
  };
}

async function collectBackup(includeCredentials: boolean): Promise<BackupFile> {
  const [sources, favorites, history, settings] = await Promise.all([
    sourceRepo.list(),
    favoriteRepo.listByCreated(),
    historyRepo.listAll(HISTORY_MAX),
    settingsService.get(),
  ]);

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    sources: includeCredentials ? sources : sources.map(redactSource),
    favorites,
    history,
    settings,
    downloads: [],
  };
}

export const backupService: BackupService = {
  async exportData(opts: { includeCredentials: boolean }): Promise<Blob> {
    const payload = await collectBackup(opts.includeCredentials);
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  },

  async exportToFile(opts: {
    includeCredentials: boolean;
    fileName?: string;
  }): Promise<{ path: string | null; fileName: string }> {
    const fileName = opts.fileName ?? `peanutmov-backup-${formatDateStamp()}.json`;
    const blob = await this.exportData({ includeCredentials: opts.includeCredentials });
    const text = await blob.text();

    if (!isNative()) {
      return { path: null, fileName };
    }

    const path = `backup/${fileName}`;
    try {
      await writeTextFile(path, text);
      const { Capacitor } = await import('@capacitor/core');
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const uri = await Filesystem.getUri({ path, directory: Directory.Data });
      await Share.share({ title: 'PeanutMov 备份', url: Capacitor.convertFileSrc(uri.uri) });
      return { path, fileName };
    } catch (e) {
      logger.warn('备份导出到文件失败', e);
      throw toAppError(e, 'E_FILE_MISSING');
    }
  },

  async parseBackup(file: File): Promise<BackupFile> {
    if (file.size === 0) throw new AppError('E_INVALID_INPUT', '备份文件为空');
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      throw new AppError('E_PARSE', undefined, { detail: '无法读取备份文件', cause: e });
    }
    if (text.trim().length === 0) throw new AppError('E_INVALID_INPUT', '备份文件为空');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new AppError('E_PARSE', '备份文件格式不支持', { cause: e });
    }
    return normalizeBackupFile(raw);
  },

  async importData(backup: BackupFile, mode: BackupMode): Promise<BackupImportReport> {
    const normalized = normalizeBackupFile(backup);
    const now = Date.now();

    const sources = normalized.sources.map((source) => ({
      ...source,
      updatedAt: now,
    }));
    const favorites = normalized.favorites.map((record) => ({ ...record }));
    const history = normalized.history.slice(0, HISTORY_MAX).map((record) => ({ ...record }));

    try {
      await withTx(['sources', 'favorites', 'history'], 'readwrite', async (tx) => {
        if (mode === 'overwrite') {
          await tx.objectStore('sources').clear();
          await favoriteRepo.clear(tx);
          await historyRepo.clear(tx);
        }
        const sourceStore = tx.objectStore('sources');
        for (const source of sources) await sourceStore.put(source);
        await favoriteRepo.saveMany(favorites, tx);
        for (const record of history) await historyRepo.save(record);
      });
    } catch (e) {
      throw toAppError(e, 'E_DB');
    }

    let settingsRestored = false;
    if (normalized.settings) {
      try {
        await settingsService.update({
          theme: normalized.settings.theme,
          hideDemoContent: normalized.settings.hideDemoContent,
          player: normalized.settings.player,
          gesture: normalized.settings.gesture,
          download: normalized.settings.download,
          searchHistory: normalized.settings.searchHistory,
          complianceVersion: normalized.settings.complianceVersion,
          complianceAcceptedAt: normalized.settings.complianceAcceptedAt,
        });
        settingsRestored = true;
      } catch (e) {
        logger.warn('备份设置恢复失败（不影响数据导入）', e);
      }
    }

    appEvents.emit('sources:changed', { reason: 'import' });
    appEvents.emit('favorites:changed', { id: null });
    appEvents.emit('history:changed', { id: null });

    return {
      sources: sources.length,
      favorites: favorites.length,
      history: history.length,
      downloads: normalized.downloads.length,
      settingsRestored,
    };
  },
};

export type { BackupService as BackupServiceContract };

/** 备份预览用（UI 展示"源 N / 收藏 N / 历史 N"） */
export function summarizeBackup(backup: BackupFile): {
  sources: number;
  favorites: number;
  history: number;
  downloads: number;
  exportedAt: number;
} {
  return {
    sources: backup.sources.length,
    favorites: backup.favorites.length,
    history: backup.history.length,
    downloads: backup.downloads.length,
    exportedAt: backup.exportedAt,
  };
}

/** 下载任务元数据（备份不含 video 文件与 Blob，仅保留任务记录） */
export type BackupDownloadMeta = Omit<DownloadTask, 'sink' | 'filePath' | 'blobKey'>;
