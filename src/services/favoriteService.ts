/**
 * 收藏服务（API-08）
 *
 * - 主键 `${sourceId}:${mediaId}`（`historyIdOf`），重复 add 幂等返回已有记录；
 * - 源被删除后记录保留并标记 `sourceRemoved`（AC-35）；
 * - 事件：`favorites:changed`。
 */
import { toRaw } from 'vue';

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
  restore(record: FavoriteRecord): Promise<void>;
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

/**
 * 同一收藏主键的在飞 toggle（`favoriteRepo` 主键 = `${sourceId}:${mediaId}`）。
 *
 * `toggle` 是「读存在性 → 删 / 读源 → 写」的三段式，每一步各开一个事务，整串没有原子性：
 * 双击时两次都可能在对方的写提交前读到「不存在」，于是一次 delete、一次 put 交错提交，
 * 最终收藏态由提交顺序决定，而两次 toast 都按各自读到的旧状态说话。
 * 同一 id 的第二次调用复用第一次的 Promise；不同 id 照常并发。
 */
const toggleInFlight = new Map<string, Promise<{ favorited: boolean; record: FavoriteRecord | null }>>();

async function runToggle(
  input: FavoriteInput,
  sourceExists: boolean,
): Promise<{ favorited: boolean; record: FavoriteRecord | null }> {
  const id = historyIdOf(input.sourceId, input.mediaId);
  const existing = await favoriteRepo.get(id);
  if (existing) {
    await favoriteRepo.remove(id);
    appEvents.emit('favorites:changed', { id });
    return { favorited: false, record: null };
  }
  const record = await favoriteService.add(input);
  return { favorited: true, record: sourceExists ? record : { ...record, sourceRemoved: true } };
}

export const favoriteService: FavoriteService = {
  async toggle(
    input: FavoriteInput,
    sourceExists: boolean,
  ): Promise<{ favorited: boolean; record: FavoriteRecord | null }> {
    validate(input);
    const id = historyIdOf(input.sourceId, input.mediaId);
    const pending = toggleInFlight.get(id);
    if (pending) return pending;
    const task = runToggle(input, sourceExists).finally(() => {
      if (toggleInFlight.get(id) === task) toggleInFlight.delete(id);
    });
    toggleInFlight.set(id, task);
    return task;
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
    // 同一 id 的 toggle 仍在飞时先等它落地：否则 add 的 put 会排在这条 delete 之后提交，收藏"删不掉"
    await toggleInFlight.get(id)?.catch(() => undefined);
    await favoriteRepo.remove(id);
    appEvents.emit('favorites:changed', { id });
  },

  /**
   * 撤销删除：把整条记录原样写回。
   *
   * 不走 `add(input)`——那会重算 `createdAt` 并丢掉 `sourceRemoved` 标记，
   * 撤销回来后排序位置和时间都变了。
   * `toRaw`：调用方传的多半是列表里的响应式代理，Proxy 直接进 IndexedDB 会 DataCloneError。
   */
  async restore(record: FavoriteRecord): Promise<void> {
    await favoriteRepo.save(toRaw(record));
    appEvents.emit('favorites:changed', { id: record.id });
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
