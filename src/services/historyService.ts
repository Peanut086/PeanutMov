/**
 * 观看历史服务（API-07）
 *
 * 规则：
 * - `durationSec > 0` 才写入；`positionSec` 收敛到 [0, duration]；
 * - `progress >= 0.95` → `finished = true`，`positionSec` 归零（下次从头）；
 * - 同一 `sourceId:mediaId` 只保留一条（主键覆盖，`createdAt` 保持不变）；
 * - 上限 500 条，超出按 `updatedAt` 淘汰；
 * - 不节流（节流由 PlayerController 负责）。
 */
import { historyRepo } from '@/db/repositories/historyRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { appEvents } from '@/services/events';
import { settingsService } from '@/services/settingsService';
import { CONTINUE_WATCHING_LIMIT, HISTORY_MAX, PROGRESS_FINISHED_THRESHOLD } from '@/shared/constants';
import { AppError } from '@/shared/errors';
import { historyIdOf } from '@/shared/id';
import type { HistoryRecord, SaveProgressInput } from '@/types';

export interface HistoryService {
  saveProgress(input: SaveProgressInput): Promise<HistoryRecord>;
  get(sourceId: string, mediaId: string): Promise<HistoryRecord | null>;
  list(opts?: { limit?: number; offset?: number }): Promise<HistoryRecord[]>;
  listContinueWatching(limit?: number): Promise<HistoryRecord[]>;
  getSeriesProgress(
    sourceId: string,
    mediaId: string,
  ): Promise<{ episodeNumber: number | null; positionSec: number; finished: boolean } | null>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export const historyService: HistoryService = {
  async saveProgress(input: SaveProgressInput): Promise<HistoryRecord> {
    const durationSec = Number(input.durationSec);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new AppError('E_INVALID_INPUT', '时长必须大于 0');
    }
    const position = clamp(Number(input.positionSec) || 0, 0, durationSec);
    const progress = position / durationSec;
    const finished = progress >= PROGRESS_FINISHED_THRESHOLD;
    const id = historyIdOf(input.sourceId, input.mediaId);
    const existing = await historyRepo.get(id);
    const now = Date.now();

    const record: HistoryRecord = {
      id,
      sourceId: input.sourceId,
      mediaId: input.mediaId,
      episodeId: input.episodeId,
      episodeNumber: input.episodeNumber,
      title: input.title,
      posterUrl: input.posterUrl,
      positionSec: finished ? 0 : position,
      durationSec,
      progress: finished ? 1 : progress,
      finished,
      totalEpisodes: input.totalEpisodes,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await historyRepo.save(record);
    appEvents.emit('history:changed', { id });
    return record;
  },

  async get(sourceId: string, mediaId: string): Promise<HistoryRecord | null> {
    return historyRepo.get(historyIdOf(sourceId, mediaId));
  },

  async list(opts): Promise<HistoryRecord[]> {
    const limit = Math.min(opts?.limit ?? HISTORY_MAX, HISTORY_MAX);
    const offset = Math.max(opts?.offset ?? 0, 0);
    const all = await historyRepo.listAll(limit + offset);
    return all.slice(offset, offset + limit);
  },

  async listContinueWatching(limit = CONTINUE_WATCHING_LIMIT): Promise<HistoryRecord[]> {
    const all = await historyRepo.listAll(HISTORY_MAX);
    const pending = all.filter(
      (record) =>
        !record.finished &&
        record.progress > 0.05 &&
        record.progress < PROGRESS_FINISHED_THRESHOLD,
    );

    // 「隐藏演示内容」必须同时作用于继续观看（AC-98 / REV-24）。
    // `HistoryRecord` 不含 `isDemo`，按 mediaId 回查 `media` 表取 isDemo；
    // 媒体缓存已被清理（查不到条目）时按"非演示"处理，避免把真实历史误隐藏。
    const settings = await settingsService.get();
    if (!settings.hideDemoContent) return pending.slice(0, limit);

    const demoIds = new Set<string>();
    for (const record of pending) {
      const item = await mediaRepo.get(record.mediaId);
      if (item?.isDemo) demoIds.add(record.mediaId);
    }
    return pending.filter((record) => !demoIds.has(record.mediaId)).slice(0, limit);
  },

  async getSeriesProgress(
    sourceId: string,
    mediaId: string,
  ): Promise<{ episodeNumber: number | null; positionSec: number; finished: boolean } | null> {
    const record = await this.get(sourceId, mediaId);
    if (!record) return null;
    return {
      episodeNumber: record.episodeNumber,
      positionSec: record.positionSec,
      finished: record.finished,
    };
  },

  async remove(id: string): Promise<void> {
    await historyRepo.remove(id);
    appEvents.emit('history:changed', { id });
  },

  async clear(): Promise<void> {
    await historyRepo.clear();
    appEvents.emit('history:changed', { id: null });
  },

  async count(): Promise<number> {
    return historyRepo.count();
  },
};

export type { HistoryService as HistoryServiceContract };
