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
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
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
  /** 因被历史/收藏/下载引用而保留的 media 条数 */
  retained: number;
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

  /**
   * 清理元数据缓存（媒体/线路/剧集/分类），保留历史、收藏、下载与媒体文件。
   *
   * REV-24：被 history/favorites/downloads 引用的 media 行**不删除**，
   * 否则清缓存后历史记录会全部变成 404（PlayerView 依赖 mediaRepo.get）。
   * lines/episodes 只删「引用 media 之外的」，引用内的保留（下次详情刷新会覆盖）。
   */
  async function clearMetadataCache(): Promise<CacheClearResult> {
    clearing.value = true;
    error.value = null;
    const before = await estimateUsage();
    try {
      // 在事务外构建引用集合（各自开只读事务，避免嵌套事务）
      const [historyRows, favorites, downloads] = await Promise.all([
        historyRepo.listAllRaw(),
        favoriteRepo.listAll(),
        downloadRepo.listAll(),
      ]);
      const pinnedMediaIds = new Set<string>();
      for (const r of historyRows) pinnedMediaIds.add(r.mediaId);
      for (const f of favorites) pinnedMediaIds.add(f.mediaId);
      for (const t of downloads) pinnedMediaIds.add(t.mediaId);

      const counts = await withTx(
        ['media', 'lines', 'episodes', 'categories'],
        'readwrite',
        async (tx) => {
          const categoryCount = await tx.objectStore(STORE_NAMES.categories).count();
          await categoryRepo.clear(tx);

          // media：游标遍历，只删未引用的
          const mediaStore = tx.objectStore(STORE_NAMES.media);
          const unpinnedMediaIds: string[] = [];
          let mediaTotal = 0;
          let mediaDeleted = 0;
          let cursor = await mediaStore.openCursor();
          while (cursor) {
            mediaTotal += 1;
            const id = cursor.key as string;
            if (pinnedMediaIds.has(id)) {
              cursor = await cursor.continue();
              continue;
            }
            unpinnedMediaIds.push(id);
            await cursor.delete();
            mediaDeleted += 1;
            cursor = await cursor.continue();
          }

          // lines/episodes：只删未引用 media 的；引用内的保留
          const lineStore = tx.objectStore(STORE_NAMES.lines);
          const episodeStore = tx.objectStore(STORE_NAMES.episodes);
          let linesDeleted = 0;
          let episodesDeleted = 0;

          // 对未引用的 mediaId 批量删除其 lines/episodes
          for (const mediaId of unpinnedMediaIds) {
            const lineKeys = await lineStore.index('by-media').getAllKeys(IDBKeyRange.only(mediaId));
            for (const k of lineKeys) {
              await lineStore.delete(k);
              linesDeleted += 1;
            }
            const epKeys = await episodeStore.index('by-media').getAllKeys(IDBKeyRange.only(mediaId));
            for (const k of epKeys) {
              await episodeStore.delete(k);
              episodesDeleted += 1;
            }
          }

          // 引用的 media 的 lines/episodes 保留
          return {
            media: mediaDeleted,
            lines: linesDeleted,
            episodes: episodesDeleted,
            categories: categoryCount,
            retained: mediaTotal - mediaDeleted,
          };
        },
      );
      const freedBytes = freedBetween(before, await estimateUsage());
      return {
        media: counts.media,
        lines: counts.lines,
        episodes: counts.episodes,
        categories: counts.categories,
        total: counts.media + counts.lines + counts.episodes + counts.categories,
        freedBytes,
        retained: counts.retained,
      };
    } catch (e) {
      error.value = toErrorShape(e, 'E_DB');
      throw toAppError(e, 'E_DB');
    } finally {
      clearing.value = false;
    }
  }

  /**
   * 删除单个媒体的缓存条目（`media` 行 + 其全部 `lines`/`episodes`）。
   *
   * REV-24：若该媒体仍有下载任务（含进行中的），保留 media 行，只清 lines/episodes。
   * 否则清缓存后下载页的已完成任务无法播放（resolvePlay 先要 mediaRepo.get）。
   */
  async function removeMediaCache(mediaId: string): Promise<MediaCacheClearResult> {
    error.value = null;
    const before = await estimateUsage();
    try {
      // 检查是否有下载任务引用该媒体
      const downloads = await downloadRepo.listAll();
      const hasDownloadRef = downloads.some((t) => t.mediaId === mediaId);

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
        // 有下载引用时保留 media 行，否则删除
        if (mediaCount > 0 && !hasDownloadRef) {
          await tx.objectStore(STORE_NAMES.media).delete(mediaId);
        }
        return { media: hasDownloadRef ? 0 : mediaCount, lines: lineCount, episodes: episodeCount };
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
