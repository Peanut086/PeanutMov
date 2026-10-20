/**
 * 收藏服务（API-08）
 *
 * - 主键 `${sourceId}:${mediaId}`（`historyIdOf`），重复 add 幂等返回已有记录；
 * - 源被删除后记录保留并标记 `sourceRemoved`（AC-35）；
 * - 事件：`favorites:changed`。
 */
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { appEvents } from '@/services/events';
import { AppError } from '@/shared/errors';
import { historyIdOf } from '@/shared/id';
import type { FavoriteInput, FavoriteRecord } from '@/types';

export interface FavoriteService {
  toggle(input: FavoriteInput, sourceExists: boolean): Promise<{ favorited: boolean; record: FavoriteRecord | null }>;
  add(input: FavoriteInput): Promise<FavoriteRecord>;
  remove(id: string): Promise<void>;
  isFavorite(sourceId: string, mediaId: string): Promise<boolean>;
  list(order?: 'created' | 'title'): Promise<FavoriteRecord[]>;
  count(): Promise<number>;
  markSourceRemoved(sourceId: string): Promise<void>;
}

function titleCompare(a: FavoriteRecord, b: FavoriteRecord): number {
  return a.title.localeCompare(b.title, 'zh-CN', { sensitivity: 'base' });
}

function validate(input: FavoriteInput): void {
  if (typeof input.sourceId !== 'string' || input.sourceId.trim().length === 0) {
    throw new AppError('E_INVALID_INPUT', '缺少源 ID');
  }
  if (typeof input.mediaId !== 'string' || input.mediaId.trim().length === 0) {
    throw new AppError('E_INVALID_INPUT', '缺少媒体 ID');
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new AppError('E_INVALID_INPUT', '缺少标题');
  }
}

export const favoriteService: FavoriteService = {
  async toggle(
    input: FavoriteInput,
    sourceExists: boolean,
  ): Promise<{ favorited: boolean; record: FavoriteRecord | null }> {
    validate(input);
    const id = historyIdOf(input.sourceId, input.mediaId);
    const existing = await favoriteRepo.get(id);
    if (existing) {
      await favoriteRepo.remove(id);
      appEvents.emit('favorites:changed', { id });
      return { favorited: false, record: null };
    }
    const record = await this.add(input);
    return { favorited: true, record: sourceExists ? record : { ...record, sourceRemoved: true } };
  },

  async add(input: FavoriteInput): Promise<FavoriteRecord> {
    validate(input);
    const id = historyIdOf(input.sourceId, input.mediaId);
    const existing = await favoriteRepo.get(id);
    if (existing) return existing;

    const source = await sourceRepo.get(input.sourceId);
    const record: FavoriteRecord = {
      id,
      sourceId: input.sourceId,
      mediaId: input.mediaId,
      title: input.title,
      posterUrl: input.posterUrl,
      type: input.type,
      year: input.year,
      sourceRemoved: source === null,
      createdAt: Date.now(),
    };
    await favoriteRepo.save(record);
    appEvents.emit('favorites:changed', { id });
    return record;
  },

  async remove(id: string): Promise<void> {
    await favoriteRepo.remove(id);
    appEvents.emit('favorites:changed', { id });
  },

  async isFavorite(sourceId: string, mediaId: string): Promise<boolean> {
    const record = await favoriteRepo.get(historyIdOf(sourceId, mediaId));
    return record !== null;
  },

  async list(order: 'created' | 'title' = 'created'): Promise<FavoriteRecord[]> {
    if (order === 'title') {
      const all = await favoriteRepo.listAll();
      return all.sort(titleCompare);
    }
    return favoriteRepo.listByCreated();
  },

  async count(): Promise<number> {
    return favoriteRepo.count();
  },

  async markSourceRemoved(sourceId: string): Promise<void> {
    await favoriteRepo.markSourceRemoved(sourceId);
    appEvents.emit('favorites:changed', { id: null });
  },
};

export type { FavoriteService as FavoriteServiceContract };
