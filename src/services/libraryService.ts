/**
 * 媒体库服务（API-06）
 *
 * 缓存策略（技术方案 6 章）：
 * - 分类：先读缓存，`refresh` 或缓存为空时回源并全量替换；
 * - 浏览：第 1 页「全部」+ 无筛选命中缓存 5 分钟内先返回；指定分类或带筛选必须回源；
 *   第 2+ 页必须回源；离线第 1 页「全部」返回缓存，离线指定分类给出明确离线态；
 * - 搜索：本地 by-title 检索（≤50）+ 各启用源并发远程（单源 5s，失败收集）；
 * - 详情：缓存优先并后台刷新；`refresh:true` 强制回源。
 */
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { appEvents } from '@/services/events';
import { downloadService } from '@/services/downloadService';
import { settingsService } from '@/services/settingsService';
import { sourceRegistry } from '@/sources/registry';
import {
  PAGE_SIZE,
  SEARCH_LOCAL_LIMIT,
  TIMEOUT_SEARCH_MS,
} from '@/shared/constants';
import { AppError, isCanceled, toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { isOnline } from '@/native/network';
import type {
  AppErrorShape,
  BrowseParams,
  Category,
  CreateDownloadInput,
  Episode,
  GetDetailParams,
  LibraryFilters,
  MediaDetail,
  MediaItem,
  PageResult,
  PlaybackSource,
  SearchResult,
  Source,
} from '@/types';

export interface BrowseQuery {
  sourceId: string;
  categoryId: string | null;
  filters: LibraryFilters;
  page: number;
  pageSize?: number;
  signal?: AbortSignal;
  /** 强制回源，忽略缓存 */
  refresh?: boolean;
}

export interface LibraryService {
  listCategories(sourceId: string, opts?: { refresh?: boolean }): Promise<Category[]>;
  browse(query: BrowseQuery): Promise<PageResult<MediaItem>>;
  search(params: {
    keyword: string;
    sourceIds?: string[];
    page?: number;
    pageSize?: number;
    signal?: AbortSignal;
  }): Promise<SearchResult>;
  getDetail(mediaId: string, opts?: { refresh?: boolean }): Promise<MediaDetail>;
  getItem(mediaId: string): Promise<MediaItem | null>;
  listCached(sourceId?: string | null, limit?: number): Promise<MediaItem[]>;
  listRecent(limit?: number): Promise<MediaItem[]>;
  resolvePlay(params: { mediaId: string; episodeId: string; lineId?: string | null }): Promise<PlaybackSource>;
  ensureEpisodes(mediaId: string, lineId?: string | null): Promise<Episode[]>;
  toDownloadInputs(params: {
    mediaId: string;
    episodeIds: string[];
    lineId?: string | null;
    signal?: AbortSignal;
  }): Promise<{ inputs: CreateDownloadInput[]; failed: Array<{ episodeId: string; error: AppErrorShape }> }>;
}

/** 首屏缓存有效期（技术方案 6 章：cachedAt < 5min） */
const BROWSE_CACHE_TTL_MS = 5 * 60 * 1000;

const EMPTY_FILTERS: LibraryFilters = { type: null, yearFrom: null, yearTo: null, area: null };

function filtersAreEmpty(filters: LibraryFilters): boolean {
  return (
    filters.type === null &&
    filters.yearFrom === null &&
    filters.yearTo === null &&
    filters.area === null
  );
}

function applyFiltersLocally(items: MediaItem[], filters: LibraryFilters): MediaItem[] {
  return items.filter((item) => {
    if (filters.type !== null && item.type !== filters.type) return false;
    if (filters.yearFrom !== null && (item.year === null || item.year < filters.yearFrom)) return false;
    if (filters.yearTo !== null && (item.year === null || item.year > filters.yearTo)) return false;
    if (filters.area !== null && item.area !== filters.area) return false;
    return true;
  });
}

/**
 * 离线 + 指定分类时的错误（BUG-01）
 *
 * `MediaItem` 无分类字段（分类只在 `Category` 上，`categoryId` 是源内任意值，
 * 如 `demo:movie`、`alist:/movies/动作`），缓存无法还原"该条目属于哪个分类"，
 * 因此离线时按分类浏览只能给出明确离线态，不能把同源全量缓存当分类结果返回。
 */
function offlineCategoryError(): AppError {
  return new AppError('E_NETWORK', '离线无法按分类浏览，请联网后重试或切回「全部」查看本地缓存');
}

async function requireSource(sourceId: string): Promise<Source> {
  const source = await sourceRepo.get(sourceId);
  if (!source) throw new AppError('E_NOT_FOUND', '源不存在');
  return source;
}

async function adapterFor(source: Source): Promise<ReturnType<typeof sourceRegistry.forSource>> {
  if (!source.enabled && source.type !== 'demo') throw new AppError('E_SOURCE_DISABLED');
  return sourceRegistry.forSource(source);
}

/** 是否为"离线/网络"类错误：离线时用于回退缓存 */
function isNetworkError(e: unknown): boolean {
  if (!(e instanceof AppError)) return false;
  return e.code === 'E_NETWORK' || e.code === 'E_TIMEOUT' || e.code === 'E_SOURCE_UNAVAILABLE';
}

/** 单源远程搜索，超时 5s（AC-24） */
async function searchOneSource(
  source: Source,
  keyword: string,
  signal: AbortSignal | undefined,
  pageSize: number,
): Promise<MediaItem[]> {
  const adapter = await adapterFor(source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_SEARCH_MS);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await adapter.search({ source, keyword, page: 1, pageSize, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** 隐藏演示内容开关（AC-98） */
async function hideDemoEnabled(): Promise<boolean> {
  const settings = await settingsService.get();
  return settings.hideDemoContent;
}

export const libraryService: LibraryService = {
  async listCategories(sourceId, opts): Promise<Category[]> {
    const source = await requireSource(sourceId);
    const cached = await categoryRepo.listBySource(sourceId);
    if (!opts?.refresh && cached.length > 0) return cached;

    const adapter = await adapterFor(source);
    try {
      const remote = await adapter.listCategories(source);
      await categoryRepo.replaceForSource(sourceId, remote);
      return remote;
    } catch (e) {
      if (cached.length > 0) {
        logger.warn('分类刷新失败，沿用缓存', { sourceId, error: toErrorShape(e) });
        return cached;
      }
      throw e;
    }
  },

  async browse(query): Promise<PageResult<MediaItem>> {
    const pageSize = query.pageSize ?? PAGE_SIZE;
    const source = await requireSource(query.sourceId);
    const adapter = await adapterFor(source);
    const hideDemo = await hideDemoEnabled();

    const params: BrowseParams = {
      source,
      categoryId: query.categoryId,
      filters: query.filters,
      page: query.page,
      pageSize,
      signal: query.signal,
    };

    // 第 1 页缓存快速路径：仅「全部」且无筛选时用同源缓存直接返回，再后台刷新。
    // 指定分类时必须回源适配器：缓存条目无分类字段，无法在本地还原分类维度（BUG-01）。
    const useFirstPageCache =
      query.page === 1 && !query.refresh && query.categoryId === null && filtersAreEmpty(query.filters);
    if (useFirstPageCache) {
      const cached = await mediaRepo.listBySource(query.sourceId, { limit: pageSize, offset: 0 });
      const filtered = hideDemo ? cached.filter((item) => !item.isDemo) : cached;
      const fresh =
        filtered.length > 0 &&
        filtered.every((item) => Date.now() - item.cachedAt < BROWSE_CACHE_TTL_MS);
      if (fresh) {
        const total = await mediaRepo.countBySource(query.sourceId);
        return {
          items: filtered,
          page: 1,
          pageSize,
          total,
          hasMore: total > filtered.length,
        };
      }
    }

    if (!isOnline()) {
      // 离线 + 指定分类：缓存无法按分类过滤，给明确离线态而不是全量（BUG-01）
      if (query.categoryId !== null) throw offlineCategoryError();
      const cached = await mediaRepo.listBySource(query.sourceId, { limit: pageSize, offset: 0 });
      const filtered = applyFiltersLocally(hideDemo ? cached.filter((item) => !item.isDemo) : cached, query.filters);
      if (filtered.length > 0) {
        return { items: filtered, page: 1, pageSize, total: filtered.length, hasMore: false };
      }
      throw new AppError('E_NETWORK');
    }

    let result: PageResult<MediaItem>;
    try {
      result = await adapter.browse(params);
    } catch (e) {
      if (query.page === 1 && isNetworkError(e)) {
        // AC-28：刷新失败保留旧数据；指定分类时缓存无法还原分类维度，不返回全量
        if (query.categoryId === null) {
          const cached = await mediaRepo.listBySource(query.sourceId, { limit: pageSize, offset: 0 });
          if (cached.length > 0) {
            return { items: applyFiltersLocally(cached, query.filters), page: 1, pageSize, total: cached.length, hasMore: false };
          }
        }
      }
      throw e;
    }

    const now = Date.now();
    const items = result.items.map((item) => ({
      ...item,
      cachedAt: now,
      updatedAt: now,
    }));

    // 第 1 页无筛选时标记缓存时间（仅首屏缓存）
    if (query.page === 1 && filtersAreEmpty(query.filters)) {
      await mediaRepo.upsertMany(items);
    } else {
      await mediaRepo.upsertMany(items.map((item) => ({ ...item })));
    }

    return {
      items: hideDemo ? items.filter((item) => !item.isDemo) : items,
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      hasMore: result.hasMore,
    };
  },

  async search(params): Promise<SearchResult> {
    const keyword = params.keyword.trim();
    if (keyword.length === 0) return { items: [], sourceIds: [], failed: [] };
    const pageSize = params.pageSize ?? SEARCH_LOCAL_LIMIT;
    const hideDemo = await hideDemoEnabled();

    const localRaw = await mediaRepo.searchByTitle(keyword, SEARCH_LOCAL_LIMIT);
    const local = hideDemo ? localRaw.filter((item) => !item.isDemo) : localRaw;

    const allSources = await sourceRepo.list();
    const enabled = allSources.filter(
      (source) => source.enabled && (params.sourceIds === undefined || params.sourceIds.includes(source.id)),
    );

    const failed: Array<{ sourceId: string; error: AppErrorShape }> = [];
    const remoteResults: MediaItem[][] = [];

    if (isOnline()) {
      const settled = await Promise.allSettled(
        enabled.map((source) => searchOneSource(source, keyword, params.signal, pageSize)),
      );
      settled.forEach((outcome, index) => {
        const source = enabled[index];
        if (!source) return;
        if (outcome.status === 'fulfilled') {
          remoteResults.push(outcome.value);
          return;
        }
        if (isCanceled(outcome.reason)) return;
        failed.push({ sourceId: source.id, error: toErrorShape(outcome.reason) });
      });
    } else {
      for (const source of enabled) {
        failed.push({ sourceId: source.id, error: toErrorShape(new AppError('E_NETWORK')) });
      }
    }

    const remote = remoteResults.flat().filter((item) => (hideDemo ? !item.isDemo : true));
    if (remote.length > 0) {
      await mediaRepo.upsertMany(remote);
    }

    const seen = new Set<string>();
    const merged: MediaItem[] = [];
    for (const item of [...local, ...remote]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }

    if (merged.length === 0 && failed.length > 0 && failed.length === enabled.length && enabled.length > 0) {
      const first = failed[0];
      if (first) {
        throw new AppError(first.error.code, first.error.message, {
          detail: first.error.detail,
          httpStatus: first.error.httpStatus,
        });
      }
    }

    const sourceIds = [...new Set(merged.map((item) => item.sourceId))];
    return { items: merged.slice(0, pageSize), sourceIds, failed };
  },

  async getDetail(mediaId, opts): Promise<MediaDetail> {
    const cachedItem = await mediaRepo.get(mediaId);
    if (cachedItem && !opts?.refresh) {
      const cached = await loadCachedDetail(cachedItem);
      if (cached) {
        // 后台刷新（不阻塞返回）
        void refreshDetail(cachedItem).catch((e: unknown) => {
          logger.debug('详情后台刷新失败', { mediaId, error: toErrorShape(e) });
        });
        return cached;
      }
    }

    if (!cachedItem) throw new AppError('E_NOT_FOUND');

    if (!isOnline()) {
      const cached = await loadCachedDetail(cachedItem);
      if (cached) return cached;
      throw new AppError('E_NETWORK');
    }

    try {
      return await refreshDetail(cachedItem);
    } catch (e) {
      const cached = await loadCachedDetail(cachedItem);
      if (cached) {
        logger.warn('详情刷新失败，使用缓存', { mediaId, error: toErrorShape(e) });
        return cached;
      }
      throw e;
    }
  },

  async getItem(mediaId): Promise<MediaItem | null> {
    return mediaRepo.get(mediaId);
  },

  async listCached(sourceId, limit = SEARCH_LOCAL_LIMIT): Promise<MediaItem[]> {
    const hideDemo = await hideDemoEnabled();
    const rows = sourceId
      ? await mediaRepo.listBySource(sourceId, { limit, offset: 0 })
      : await mediaRepo.listRecent(limit);
    return hideDemo ? rows.filter((item) => !item.isDemo) : rows;
  },

  async listRecent(limit = 20): Promise<MediaItem[]> {
    const hideDemo = await hideDemoEnabled();
    const rows = await mediaRepo.listRecent(limit);
    return hideDemo ? rows.filter((item) => !item.isDemo) : rows;
  },

  async resolvePlay(params): Promise<PlaybackSource> {
    const item = await mediaRepo.get(params.mediaId);
    if (!item) throw new AppError('E_NOT_FOUND');

    // 优先本地已下载（FR-34 / AC-77）
    const local = await downloadService.findLocalPlay(params.mediaId, params.episodeId);
    if (local) return local;

    // 任务已完成但本地文件/Blob 丢失 → 回退网络源时**明确告知**（AC-78 / REV-23）。
    // `PlaybackSource` 无"本地不可用"字段且类型冻结，故用事件把 taskId 透出：
    // UI 可提示"本地文件不可用，已切换网络源"，并调用 `downloadService.redownload(taskId)`。
    const missingTask = await downloadService.localMissingTaskOf(params.mediaId, params.episodeId);
    if (missingTask) {
      logger.warn('本地文件缺失，回退网络源', { taskId: missingTask.id, mediaId: params.mediaId });
      appEvents.emit('local:missing', {
        taskId: missingTask.id,
        mediaId: params.mediaId,
        episodeId: params.episodeId,
        text: '本地文件不可用，已切换网络源',
      });
    }

    const source = await sourceRepo.get(item.sourceId);
    if (!source) throw new AppError('E_SOURCE_UNAVAILABLE', '该源已被移除');
    const adapter = await adapterFor(source);

    const lines = await lineRepo.listByMedia(item.id);
    const lineId = params.lineId ?? lines[0]?.id;
    if (!lineId) throw new AppError('E_NO_PLAY_URL');

    try {
      return await adapter.resolvePlayUrl({
        source,
        mediaId: item.id,
        sourceItemId: item.sourceItemId,
        episodeId: params.episodeId,
        lineId,
      });
    } catch (e) {
      const error = e instanceof AppError ? e : new AppError('E_UNKNOWN', undefined, { detail: String(e) });
      if (error.code === 'E_NETWORK' || error.code === 'E_TIMEOUT' || error.code === 'E_HTTP_5XX') {
        await markSourceUnreachable(source.id, error);
        throw new AppError('E_SOURCE_UNAVAILABLE', undefined, { detail: error.message });
      }
      throw error;
    }
  },

  async ensureEpisodes(mediaId, lineId): Promise<Episode[]> {
    const all = await episodeRepo.listByMedia(mediaId);
    if (all.length > 0 && lineId === undefined) return all;
    if (lineId) {
      const byLine = all.filter((episode) => episode.lineId === lineId);
      if (byLine.length > 0) return byLine;
    }
    const detail = await libraryService.getDetail(mediaId, { refresh: all.length === 0 });
    return lineId ? detail.episodes.filter((episode) => episode.lineId === lineId) : detail.episodes;
  },

  async toDownloadInputs(params): Promise<{
    inputs: CreateDownloadInput[];
    failed: Array<{ episodeId: string; error: AppErrorShape }>;
  }> {
    const item = await mediaRepo.get(params.mediaId);
    if (!item) throw new AppError('E_NOT_FOUND');
    const episodes = await episodeRepo.listByMedia(params.mediaId);
    const inputs: CreateDownloadInput[] = [];
    const failed: Array<{ episodeId: string; error: AppErrorShape }> = [];

    for (const episodeId of params.episodeIds) {
      try {
        const play = await libraryService.resolvePlay({ mediaId: params.mediaId, episodeId, lineId: params.lineId });
        const episode = episodes.find((entry) => entry.id === episodeId) ?? null;
        inputs.push({
          sourceId: item.sourceId,
          mediaId: item.id,
          episodeId,
          episodeNumber: episode?.number ?? null,
          title: item.title,
          episodeTitle: episode?.title ?? null,
          posterUrl: item.posterUrl,
          url: play.url,
          headers: play.headers,
          format: play.format,
          quality: play.quality,
        });
      } catch (e) {
        failed.push({ episodeId, error: toErrorShape(e) });
      }
    }
    return { inputs, failed };
  },

};

/* ---------------- 内部工具 ---------------- */

/** 读缓存详情（无线路且无剧集时视为无缓存） */
async function loadCachedDetail(item: MediaItem): Promise<MediaDetail | null> {
  const [lines, episodes] = await Promise.all([
    lineRepo.listByMedia(item.id),
    episodeRepo.listByMedia(item.id),
  ]);
  if (lines.length === 0 && episodes.length === 0) return null;
  return { item, lines, episodes };
}

/** 回源刷新详情并写入 media/lines/episodes */
async function refreshDetail(item: MediaItem): Promise<MediaDetail> {
  const source = await sourceRepo.get(item.sourceId);
  if (!source) throw new AppError('E_SOURCE_UNAVAILABLE', '该源已被移除');
  const adapter = await adapterFor(source);
  const params: GetDetailParams = { source, sourceItemId: item.sourceItemId };
  const detail = await adapter.getDetail(params);

  const now = Date.now();
  const mediaItem: MediaItem = {
    ...detail.item,
    cachedAt: item.cachedAt,
    updatedAt: now,
    isDemo: item.isDemo,
  };

  // 删除旧线路/剧集后写入新的（避免线路数变化留下脏数据）
  await lineRepo.removeByMedia(item.id);
  await episodeRepo.removeByMedia(item.id);
  await mediaRepo.save(mediaItem);
  await lineRepo.saveMany(detail.lines);
  await episodeRepo.saveMany(detail.episodes);
  appEvents.emit('library:changed', { sourceId: item.sourceId });

  return { item: mediaItem, lines: detail.lines, episodes: detail.episodes };
}

/** 播放失败时标记源不可用（不阻断错误抛出） */
async function markSourceUnreachable(sourceId: string, error: AppError): Promise<void> {
  const { sourceService } = await import('@/services/sourceService');
  await sourceService.markHealth(sourceId, 'unreachable', error.toShape()).catch(() => undefined);
}

/** 空筛选常量（供 store 复用） */
export const EMPTY_LIBRARY_FILTERS: LibraryFilters = EMPTY_FILTERS;

export type { LibraryFilters };
