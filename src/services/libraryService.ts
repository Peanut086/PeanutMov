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
import { healthService } from '@/services/healthService';
import { settingsService } from '@/services/settingsService';
import { sourceRegistry } from '@/sources/registry';
import { healthOfError } from '@/sources/base/BaseAdapter';
import {
  PAGE_SIZE,
  SEARCH_LOCAL_LIMIT,
  TIMEOUT_SEARCH_MS,
} from '@/shared/constants';
import { AppError, isCanceled, toErrorShape } from '@/shared/errors';
import { HEALTH_TIER_ORDER, healthTierOf } from '@/shared/healthTier';
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
  /**
   * 失效源的最佳替代源；无候选返回 null（CHG-05 / 17.6.3）。
   * 只读查询，**不切换**：切换编排在 `libraryStore`（必须告知用户）。
   */
  pickFallbackSource(failedSourceId: string): Promise<Source | null>;
  search(params: {
    keyword: string;
    sourceIds?: string[];
    page?: number;
    pageSize?: number;
    signal?: AbortSignal;
    /** CHG-15：跳过体检结论过滤（unreachable/bad_config/auth_failed），用户在空态显式要求重试时用 */
    forceAll?: boolean;
    /**
     * 单源完成即回调（CHG-12 渐进搜索）：先到先显示，不必等全部源结束。
     * `error` 非 null 表示该源失败；`done/total` 供进度展示。取消后不再回调。
     */
    onPartial?: (event: {
      sourceId: string;
      items: MediaItem[];
      error: AppErrorShape | null;
      done: number;
      total: number;
    }) => void;
  }): Promise<SearchResult>;
  /**
   * CHG-28：`item` 为调用方已持有的条目（如渐进搜索结果）。条目尚未落库时
   * 以它兜底直接回源刷新，而不是立刻抛 E_NOT_FOUND——修复「渐进搜索期间
   * 点击结果 → 详情加载失败」的竞态（落库原本要等全部源 settle）。
   */
  getDetail(mediaId: string, opts?: { refresh?: boolean; item?: MediaItem }): Promise<MediaDetail>;
  getItem(mediaId: string): Promise<MediaItem | null>;
  listCached(sourceId?: string | null, limit?: number): Promise<MediaItem[]>;
  listRecent(limit?: number): Promise<MediaItem[]>;
  /** 该源缓存中出现过的地区（筛选面板地区选项推导用） */
  listAreas(sourceId: string): Promise<string[]>;
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

const EMPTY_FILTERS: LibraryFilters = { type: null, yearFrom: null, yearTo: null, area: null, ext: null };

function filtersAreEmpty(filters: LibraryFilters): boolean {
  return (
    filters.type === null &&
    filters.yearFrom === null &&
    filters.yearTo === null &&
    filters.area === null &&
    (filters.ext === null || filters.ext === undefined || Object.keys(filters.ext).length === 0)
  );
}

/** 是否带本地筛选维度（需要在服务层聚合凑页的类型/年代/地区） */
function hasLocalFilters(filters: LibraryFilters): boolean {
  return (
    filters.type !== null ||
    filters.yearFrom !== null ||
    filters.yearTo !== null ||
    filters.area !== null
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

/* ---------- 本地筛选的聚合分页（P0-筛选优化） ----------
 *
 * 本地维度（类型/年代/地区）只能过滤已取回的行；单页过滤会让一页剩几条甚至 0 条，
 * 且 hasMore 仍按原始页推进（CHG-14 同类问题）。这里按「聚合游标」连续拉原始页、
 * 本地过滤后凑满一页返回：游标记录该 (源|分类|筛选) 组合已消费到的原始页，
 * 溢出的过滤结果缓存在 buffer，下一页（page=2,3…）先吃 buffer 再回源，
 * 保证翻页不重复不丢条。均为会话内存态，不落库。
 */
const AGGREGATE_MAX_RAW_PAGES = 10;
const aggregateCursor = new Map<string, number>();
const aggregateBuffer = new Map<string, MediaItem[]>();

function aggregateKey(query: BrowseQuery): string {
  return `${query.sourceId}|${query.categoryId ?? ''}|${JSON.stringify(query.filters)}`;
}

async function aggregateBrowse(
  adapter: { browse(params: BrowseParams): Promise<PageResult<MediaItem>> },
  params: BrowseParams,
  query: BrowseQuery,
): Promise<PageResult<MediaItem>> {
  const key = aggregateKey(query);
  const pageSize = params.pageSize;
  if (query.page <= 1) {
    aggregateCursor.set(key, 0);
    aggregateBuffer.set(key, []);
  }

  const collected: MediaItem[] = [];
  const seen = new Set<string>();
  const takeFrom = (rows: MediaItem[]): void => {
    for (const item of rows) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      collected.push(item);
    }
  };

  // 先吃上次溢出的过滤结果
  const buffered = aggregateBuffer.get(key) ?? [];
  takeFrom(buffered);

  let rawPage = aggregateCursor.get(key) ?? 0;
  let rawHasMore = true;
  for (let i = 0; i < AGGREGATE_MAX_RAW_PAGES && collected.length < pageSize; i++) {
    rawPage += 1;
    const res = await adapter.browse({ ...params, page: rawPage });
    rawHasMore = res.hasMore;
    aggregateCursor.set(key, rawPage);
    takeFrom(applyFiltersLocally(res.items, query.filters));
    if (!res.hasMore) break;
  }

  aggregateBuffer.set(key, collected.slice(pageSize));
  return {
    items: collected.slice(0, pageSize),
    page: query.page,
    pageSize,
    total: null,
    // 原始页未拉尽、或凑满一页后仍有剩余/原始还有更多 → 允许继续翻页
    hasMore:
      collected.length > pageSize ||
      (rawHasMore && collected.length >= pageSize) ||
      (aggregateBuffer.get(key)?.length ?? 0) > 0,
  };
}

/** 清空聚合分页的会话态（测试用） */
export function resetAggregateState(): void {
  aggregateCursor.clear();
  aggregateBuffer.clear();
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

/** 单源远程搜索，超时按适配器区分（CHG-15）：site 8s / spider 20s，缺省 5s（AC-24） */
async function searchOneSource(
  source: Source,
  keyword: string,
  signal: AbortSignal | undefined,
  pageSize: number,
): Promise<MediaItem[]> {
  const adapter = await adapterFor(source);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), adapter.searchTimeoutMs ?? TIMEOUT_SEARCH_MS);
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

/**
 * 搜索扇出前过滤：跳过「确定失效」的源（体检结论；timeout 保留——可能是瞬时网络慢）、
 * 关闭搜索的源（`ext.searchable === false`）。
 * 订阅导入动辄上百源、大半已死，全部扇出是「搜索特别慢」的主因之一。
 * （CHG-16：drpy JS 爬虫已由内置引擎执行，不再排除）
 */
function searchCandidate(source: Source): boolean {
  if (
    source.health === 'unreachable' ||
    source.health === 'bad_config' ||
    source.health === 'auth_failed'
  ) {
    return false;
  }
  const ext = (source.ext ?? {}) as { kind?: string; searchable?: boolean };
  if (ext.searchable === false) return false;
  return true;
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
      // 本地筛选维度走聚合分页（凑满一页 + 游标续拉）；纯服务端筛选（ext）分页天然对齐
      result = hasLocalFilters(query.filters)
        ? await aggregateBrowse(adapter, params, query)
        : await adapter.browse(params);
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

  async pickFallbackSource(failedSourceId: string): Promise<Source | null> {
    const sources = await sourceRepo.list();
    // CHG-08：排除内置演示源——它对「找片看」没有替代价值，且其它源全挂时
    // 它会成为唯一候选，把用户反复切进演示片单掩盖失效。无健康候选时返回
    // null，由调用方就地抛出原始错误（显示「该源暂不可用」）。
    const candidates = sources.filter(
      (source) =>
        source.enabled &&
        source.health === 'ok' &&
        source.type !== 'demo' &&
        source.id !== failedSourceId,
    );
    if (candidates.length === 0) return null;

    const latencyOf = (sourceId: string): number | null => healthService.latencyOf(sourceId);
    const ranked = [...candidates].sort((a, b) => {
      // ① 质量档位升序
      const tierA = healthTierOf(a.health, latencyOf(a.id));
      const tierB = healthTierOf(b.health, latencyOf(b.id));
      if (tierA !== tierB) return HEALTH_TIER_ORDER[tierA] - HEALTH_TIER_ORDER[tierB];
      // ② 延迟升序（null 最后）
      const latencyA = latencyOf(a.id);
      const latencyB = latencyOf(b.id);
      const rankA = latencyA === null || !Number.isFinite(latencyA) ? Number.POSITIVE_INFINITY : latencyA;
      const rankB = latencyB === null || !Number.isFinite(latencyB) ? Number.POSITIVE_INFINITY : latencyB;
      if (rankA !== rankB) return rankA - rankB;
      // ③ 手动顺序 → ④ id（确定性兜底）
      if (a.sort !== b.sort) return a.sort - b.sort;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    });

    return ranked[0] ?? null;
  },

  async search(params): Promise<SearchResult> {
    const keyword = params.keyword.trim();
    if (keyword.length === 0) return { items: [], sourceIds: [], failed: [], candidates: 0, filteredOut: 0 };
    const pageSize = params.pageSize ?? SEARCH_LOCAL_LIMIT;
    const hideDemo = await hideDemoEnabled();

    const localRaw = await mediaRepo.searchByTitle(keyword, SEARCH_LOCAL_LIMIT);
    const local = hideDemo ? localRaw.filter((item) => !item.isDemo) : localRaw;

    const allSources = await sourceRepo.list();
    const eligible = allSources.filter(
      (source) =>
        source.enabled &&
        (params.sourceIds === undefined || params.sourceIds.includes(source.id)),
    );
    // CHG-15：被过滤的数量透出给 UI（candidates=0 时给诊断而不是"没搜到"）；
    // forceAll 跳过体检结论过滤（用户显式重试），js 爬虫/关闭搜索仍排除
    const enabled = params.forceAll
      ? eligible
      : eligible.filter((source) => searchCandidate(source));
    const filteredOut = eligible.length - enabled.length;

    const failed: Array<{ sourceId: string; error: AppErrorShape }> = [];
    const remoteResults: Array<MediaItem[] | null> = [];

    if (isOnline()) {
      const total = enabled.length;
      let done = 0;
      /** 单源完成即通知（CHG-12 渐进搜索）；取消的源不计入失败、不回调 */
      const settleOne = async (source: Source, index: number): Promise<void> => {
        try {
          const items = await searchOneSource(source, keyword, params.signal, pageSize);
          const visible = hideDemo ? items.filter((item) => !item.isDemo) : items;
          remoteResults[index] = visible;
          done += 1;
          // CHG-28：单源结果先落库再上屏——渐进结果立即可点，详情不再因
          // 「等全部源 settle 才批量落库」的窗口报 E_NOT_FOUND（真机 P1）
          if (visible.length > 0) {
            await mediaRepo.upsertMany(visible).catch((e: unknown) => {
              logger.warn('搜索结果即时落库失败（不影响上屏）', { sourceId: source.id, error: toErrorShape(e) });
            });
          }
          params.onPartial?.({ sourceId: source.id, items: visible, error: null, done, total });
        } catch (e) {
          done += 1;
          if (isCanceled(e)) return;
          const shape = toErrorShape(e);
          failed.push({ sourceId: source.id, error: shape });
          params.onPartial?.({ sourceId: source.id, items: [], error: shape, done, total });
        }
      };
      await Promise.all(enabled.map((source, index) => settleOne(source, index)));
    } else {
      for (const source of enabled) {
        failed.push({ sourceId: source.id, error: toErrorShape(new AppError('E_NETWORK')) });
      }
    }

    const remote = remoteResults
      .filter((rows): rows is MediaItem[] => Array.isArray(rows))
      .flat()
      .filter((item) => (hideDemo ? !item.isDemo : true));
    // 落库已在 settleOne 单源完成时即时执行（CHG-28），此处不再批量重写

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
    return { items: merged.slice(0, pageSize), sourceIds, failed, candidates: enabled.length, filteredOut };
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

    // CHG-28：条目未落库时用调用方持有的条目兜底（渐进搜索结果即时点击场景），
    // 直接回源刷新；两者都没有才是真正的「不存在」
    const item = cachedItem ?? opts?.item ?? null;
    if (!item) throw new AppError('E_NOT_FOUND');

    if (!isOnline()) {
      const cached = await loadCachedDetail(item);
      if (cached) return cached;
      throw new AppError('E_NETWORK');
    }

    try {
      return await refreshDetail(item);
    } catch (e) {
      const cached = await loadCachedDetail(item);
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

  async listAreas(sourceId: string): Promise<string[]> {
    const rows = await mediaRepo.listBySource(sourceId, { limit: 2000, offset: 0 });
    const areas = new Set<string>();
    for (const row of rows) {
      if (row.area && row.area.trim().length > 0) areas.add(row.area.trim());
    }
    return [...areas];
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
        await markSourceFailed(source.id, error);
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

/** 播放/浏览失败时标记源健康（按 `healthOfError` 映射，不阻断错误抛出） */
async function markSourceFailed(sourceId: string, error: AppError): Promise<void> {
  const { sourceService } = await import('@/services/sourceService');
  await sourceService.markHealth(sourceId, healthOfError(error), error.toShape()).catch(() => undefined);
}

/** 供 `libraryStore` 在自动切换前落库失败态（CHG-05 / 17.6.4 第 1 步） */
export async function markSourceFailedByError(sourceId: string, error: unknown): Promise<void> {
  const appError = error instanceof AppError ? error : new AppError('E_SOURCE_UNAVAILABLE', undefined, { detail: String(error) });
  await markSourceFailed(sourceId, appError);
}

/** 空筛选常量（供 store 复用） */
export const EMPTY_LIBRARY_FILTERS: LibraryFilters = EMPTY_FILTERS;

export type { LibraryFilters };
