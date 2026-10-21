/**
 * 本地缓存管理 Store（PKG-A，评审返工 REV-12 / REV-13）
 *
 * 设置页「清理缓存」与详情页「删除本地缓存」此前只是 UI 假动作。这里把
 * "真正的删除"落到一个 UI 可依赖的入口上，避免 UI 直接 import `@/db/**`：
 *
 * - `clearMetadataCache()`：清空 `media/lines/episodes/categories`（元数据缓存），
 *   **保留** `history` / `favorites` / `downloads` / `blobs`（AC-91 要求条数不变）；
 * - `removeMediaCache(mediaId)`：按媒体删除其缓存条目（media + 该媒体的 lines/episodes）。
 *
 * 释放字节用 `navigator.storage.estimate()` 清理前后差值度量；浏览器不支持或
 * 差值 ≤ 0 时返回 `null`（不编造数字），调用方只展示条数。
 *
 * 注：本 Store 属缓存运维能力，后续若由 PKG-B 在 `services/**` 收敛为 `cacheService`，
 * 可整体替换实现，`SettingsView` / `DetailView` 调用签名不变。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { withTx } from '@/db/index';
import { STORE_NAMES } from '@/db/schema';
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { toAppError, toErrorShape } from '@/shared/errors';
import type { AppErrorShape } from '@/types';

export interface CacheClearResult {
  media: number;
  lines: number;
  episodes: number;
  categories: number;
  /** 删除条数合计 */
  total: number;
  /** 清理前后 `navigator.storage.estimate()` 差值；不可度量时为 null */
  freedBytes: number | null;
}

export interface MediaCacheClearResult {
  media: number;
  lines: number;
  episodes: number;
  total: number;
  freedBytes: number | null;
}

async function estimateUsage(): Promise<number | null> {
  try {
    const storage = navigator.storage;
    if (!storage || typeof storage.estimate !== 'function') return null;
    const estimate = await storage.estimate();
    return typeof estimate.usage === 'number' ? estimate.usage : null;
  } catch {
    return null;
  }
}

function freedBetween(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  const delta = before - after;
  return delta > 0 ? delta : null;
}

export const useCacheStore = defineStore('cache', () => {
  const clearing = ref(false);
  const error = ref<AppErrorShape | null>(null);

  /** 清理元数据缓存（媒体/线路/剧集/分类），保留历史、收藏、下载与媒体文件 */
  async function clearMetadataCache(): Promise<CacheClearResult> {
    clearing.value = true;
    error.value = null;
    const before = await estimateUsage();
    try {
      const counts = await withTx(
        ['media', 'lines', 'episodes', 'categories'],
        'readwrite',
        async (tx) => {
          const [media, lines, episodes, categories] = await Promise.all([
            tx.objectStore(STORE_NAMES.media).count(),
            tx.objectStore(STORE_NAMES.lines).count(),
            tx.objectStore(STORE_NAMES.episodes).count(),
            tx.objectStore(STORE_NAMES.categories).count(),
          ]);
          await mediaRepo.clear(tx);
          await lineRepo.clear(tx);
          await episodeRepo.clear(tx);
          await categoryRepo.clear(tx);
          return { media, lines, episodes, categories };
        },
      );
      const freedBytes = freedBetween(before, await estimateUsage());
      return {
        ...counts,
        total: counts.media + counts.lines + counts.episodes + counts.categories,
        freedBytes,
      };
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw toAppError(e, 'E_DB');
    } finally {
      clearing.value = false;
    }
  }

  /** 删除单个媒体的缓存条目（`media` 行 + 其全部 `lines`/`episodes`） */
  async function removeMediaCache(mediaId: string): Promise<MediaCacheClearResult> {
    error.value = null;
    const before = await estimateUsage();
    try {
      const counts = await withTx(['media', 'lines', 'episodes'], 'readwrite', async (tx) => {
        const lineCount = await tx
          .objectStore(STORE_NAMES.lines)
          .index('by-media')
          .count(IDBKeyRange.only(mediaId));
        const episodeCount = await tx
          .objectStore(STORE_NAMES.episodes)
          .index('by-media')
          .count(IDBKeyRange.only(mediaId));
        const mediaCount = await tx.objectStore(STORE_NAMES.media).count(mediaId);
        await lineRepo.removeByMedia(mediaId, tx);
        await episodeRepo.removeByMedia(mediaId, tx);
        if (mediaCount > 0) await tx.objectStore(STORE_NAMES.media).delete(mediaId);
        return { media: mediaCount, lines: lineCount, episodes: episodeCount };
      });
      const freedBytes = freedBetween(before, await estimateUsage());
      return {
        ...counts,
        total: counts.media + counts.lines + counts.episodes,
        freedBytes,
      };
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw toAppError(e, 'E_DB');
    }
  }

  function $dispose(): void {
    error.value = null;
    clearing.value = false;
  }

  return { clearing, error, clearMetadataCache, removeMediaCache, $dispose };
});

export type CacheStore = ReturnType<typeof useCacheStore>;
