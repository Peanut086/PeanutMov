/**
 * 媒体库 Store（API-14）
 *
 * 页面四态（LoadState）与分页由 Store 维护，数据请求全部经 `libraryService`。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { libraryService } from '@/services/libraryService';
import { EMPTY_LIBRARY_FILTERS, markSourceFailedByError } from '@/services/libraryService';
import { groupSearchResults, sortByRelevance, titleDedupKey } from '@/services/searchAggregate';
import { appEvents } from '@/services/events';
import { useSourceStore } from '@/stores/sourceStore';
import { PAGE_SIZE, SEARCH_LOCAL_LIMIT } from '@/shared/constants';
import { AppError, isCanceled, toErrorShape } from '@/shared/errors';
import { isOnline } from '@/native/network';
import type {
  AppErrorShape,
  Category,
  CreateDownloadInput,
  LibraryFilters,
  LoadState,
  MediaDetail,
  MediaItem,
  PageResult,
  PlaybackSource,
  SearchScope,
  SearchResultGroup,
  SourceType,
} from '@/types';

export const useLibraryStore = defineStore('library', () => {
  const categories = ref<Category[]>([]);
  const currentCategoryId = ref<string | null>(null);
  const filters = ref<LibraryFilters>({ ...EMPTY_LIBRARY_FILTERS });
  const items = ref<MediaItem[]>([]);
  const page = ref(0);
  const hasMore = ref(false);
  const state = ref<LoadState>('idle');
  const error = ref<AppErrorShape | null>(null);

  /** 当前源缓存推导的地区选项（筛选面板用；源侧 filter 配置优先，此处兜底） */
  const areaOptions = ref<string[]>([]);

  const searchKeyword = ref('');
  const searchResults = ref<MediaItem[]>([]);
  const searchState = ref<LoadState>('idle');
  const searchFailed = ref<Array<{ sourceId: string; error: AppErrorShape }>>([]);
  /** P2-9：只重试失败源时的进行中标记（不打断已上屏结果） */
  const searchRetrying = ref(false);
  /** CHG-15：最近一次搜索实际参与的源数 / 被过滤掉的启用源数（空态诊断用） */
  const searchCandidates = ref(0);
  const searchFilteredOut = ref(0);
  /* ---------- v1.7/CHG-20：聚合检索 ---------- */
  /** 未去重的完整结果（分组视图的数据源；`searchResults` 是片名去重后的平铺视图） */
  const searchResultsAll = ref<MediaItem[]>([]);
  /** 组卡视图（默认）/ 按源平铺视图 */
  const searchViewMode = ref<'grouped' | 'flat'>('grouped');
  /** 检索范围：全部 / 仅站点 / 仅爬虫 / 仅豆瓣 / 选定源 */
  const searchScope = ref<SearchScope>('all');
  const searchSelectedSourceIds = ref<string[]>([]);
  /** 慢源晚到提示：「+N 条新结果」计数（第一波上屏之后到达的条数） */
  const searchLateCount = ref(0);
  /** 聚合分组（按源健康 tier → 延迟 → 来源数排序） */
  const searchGroups = computed<SearchResultGroup[]>(() => {
    if (searchResultsAll.value.length === 0) return [];
    return groupSearchResults(
      searchResultsAll.value,
      searchKeyword.value,
      (sourceId) => sourceStore.sources.find((s) => s.id === sourceId)?.health ?? 'unknown',
      (sourceId) => sourceStore.latencyOf(sourceId),
    );
  });

  const detail = ref<MediaDetail | null>(null);
  const detailState = ref<LoadState>('idle');

  const posterItems = computed(() => items.value);
  const isEmpty = computed(() => items.value.length === 0 && state.value === 'success');

  /* ---------- 首页（P0-4 跨源聚合） ---------- */

  /** 首页「最近添加」条数 */
  const HOME_RECENT_LIMIT = 20;

  const homeRecent = ref<MediaItem[]>([]);
  const homeState = ref<LoadState>('idle');
  const homeError = ref<AppErrorShape | null>(null);

  /**
   * 首页加载：直接读跨源缓存（毫秒级上屏，离线也能出内容）；有缓存时后台预热
   * 当前源首页并静默刷新（stale-while-revalidate）。无缓存才回源当前源首屏——
   * 适配层有超时兜底，失败进错误态而非永远骨架屏。
   */
  async function loadHome(): Promise<void> {
    homeError.value = null;
    homeState.value = homeRecent.value.length > 0 ? 'refreshing' : 'loading';
    try {
      homeRecent.value = await libraryService.listRecent(HOME_RECENT_LIMIT);
      if (homeRecent.value.length > 0) {
        homeState.value = 'success';
        void warmCurrentSource();
      } else {
        await openSource(null);
        homeRecent.value = await libraryService.listRecent(HOME_RECENT_LIMIT);
        if (homeRecent.value.length > 0) {
          homeState.value = 'success';
        } else if (error.value) {
          // 无缓存且回源失败：错误态（而非「还没有内容」，避免掩盖源故障）
          homeError.value = error.value;
          homeState.value = 'error';
        } else {
          homeState.value = 'empty';
        }
      }
    } catch (e) {
      homeError.value = toErrorShape(e);
      homeState.value = homeRecent.value.length > 0 ? 'success' : 'error';
    }
  }

  /** 后台预热当前源首页（只写 mediaRepo 缓存，不触碰媒体库页状态），完成后刷新最近列表 */
  async function warmCurrentSource(): Promise<void> {
    try {
      await sourceStore.load();
      const sourceId = sourceStore.currentSource?.id ?? null;
      if (!sourceId || !isOnline()) return;
      await libraryService.browse({
        sourceId,
        categoryId: null,
        filters: { ...EMPTY_LIBRARY_FILTERS },
        page: 1,
        pageSize: PAGE_SIZE,
      });
      homeRecent.value = await libraryService.listRecent(HOME_RECENT_LIMIT);
    } catch {
      /* 预热失败静默：首页继续展示缓存 */
    }
  }

  let requestSeq = 0;
  /** 进行中的搜索控制器：新搜索前 abort 旧的，避免旧请求继续占用源（REV-06） */
  let searchController: AbortController | null = null;
  /** 渐进搜索进度（CHG-12）：已完成的源 / 总源数，结束为 null */
  const searchProgress = ref<{ done: number; total: number } | null>(null);
  const sourceStore = useSourceStore();

  /** 源侧故障码（17.6.2 条件 2）：只有这些错误才考虑自动换源 */
  const FALLBACK_ERROR_CODES: ReadonlySet<string> = new Set([
    'E_SOURCE_UNAVAILABLE',
    'E_NETWORK',
    'E_TIMEOUT',
    'E_HTTP_5XX',
    // 地址失效的典型表现（AC-109「B（地址失效）」）：404 属源侧故障，必须参与自动跳过。
    // 契约 17.6.2 的枚举漏列，按 AC 原文补入（CHG-05 勘误，不改错误码语义）。
    'E_HTTP_404',
    'E_PARSE',
    'E_UNSUPPORTED_FORMAT',
  ]);

  /**
   * 会话内已尝试过的 `(fromId → toId)` 组合（内存态，不落库、不进备份）。
   * 同一组合最多自动切换一次，避免源连环失效导致页面反复跳变。
   */
  const fallbackPairs = new Set<string>();

  function pairKey(fromId: string, toId: string): string {
    return `${fromId}→${toId}`;
  }

  /** 用户手动切源时清空该源相关的组合记录（17.6.4 防抖重置） */
  function clearFallbackPairsOf(sourceId: string): void {
    const prefix = `${sourceId}→`;
    for (const key of [...fallbackPairs]) {
      if (key.startsWith(prefix)) fallbackPairs.delete(key);
    }
  }

  function activeSourceId(): string | null {
    return sourceStore.currentSource?.id ?? null;
  }

  async function openSource(sourceId: string | null): Promise<void> {
    if (sourceId !== null) clearFallbackPairsOf(sourceId);
    await sourceStore.load();
    await sourceStore.select(sourceId);
    currentCategoryId.value = null;
    filters.value = { ...EMPTY_LIBRARY_FILTERS };
    items.value = [];
    page.value = 0;
    hasMore.value = false;
    categories.value = [];
    areaOptions.value = [];
    await loadCategories(false);
    void loadAreaOptions();
    await loadFirstPage(false);
  }

  /** 从同源缓存收集地区选项；失败静默（筛选面板回退到当前页数据推导） */
  async function loadAreaOptions(): Promise<void> {
    const sourceId = activeSourceId();
    if (!sourceId) return;
    try {
      areaOptions.value = await libraryService.listAreas(sourceId);
    } catch {
      areaOptions.value = [];
    }
  }

  async function loadCategories(refresh = false): Promise<void> {
    const sourceId = activeSourceId();
    if (!sourceId) {
      categories.value = [];
      return;
    }
    try {
      categories.value = await libraryService.listCategories(sourceId, { refresh });
      if (currentCategoryId.value && !categories.value.some((c) => c.id === currentCategoryId.value)) {
        currentCategoryId.value = null;
      }
    } catch (e) {
      // 分类失败不改变列表状态，仅记录错误（页面仍可展示"全部"）
      error.value = toErrorShape(e);
      categories.value = [];
    }
  }

  async function setCategory(id: string | null): Promise<void> {
    currentCategoryId.value = id;
    // 服务端筛选维度按分类不同而不同，选中值不能跨分类保留
    if (filters.value.ext) filters.value = { ...filters.value, ext: null };
    await loadFirstPage(false);
  }

  async function setFilters(f: Partial<LibraryFilters>): Promise<void> {
    filters.value = { ...filters.value, ...f };
    await loadFirstPage(false);
  }

  async function resetFilters(): Promise<void> {
    filters.value = { ...EMPTY_LIBRARY_FILTERS };
    await loadFirstPage(false);
  }

  /**
   * 失效自动跳过（CHG-05 / 17.6.2）
   *
   * 全部条件满足才返回替代源 id：在线、源侧故障码、会话内该组合未尝试过、存在候选。
   * 副作用：落库失败态 → 选中替代源 → 发 Toast（**必须**，不得静默切换）。
   * 返回 null 时调用方**原样抛出原始错误**（不改 code、不包装）。
   */
  async function tryFallbackSource(failedSourceId: string, cause: unknown): Promise<string | null> {
    if (!isOnline()) return null;
    const code = cause instanceof AppError ? cause.code : null;
    if (code === null || !FALLBACK_ERROR_CODES.has(code)) return null;

    // ① 先落库失败态（E_PARSE / E_UNSUPPORTED_FORMAT → bad_config，网络类 → unreachable）
    await markSourceFailedByError(failedSourceId, cause);

    // ② 只读查询候选；无候选不切换
    const fallback = await libraryService.pickFallbackSource(failedSourceId);
    if (!fallback) return null;

    // ③ 同一 (from → to) 组合在本次会话内最多切一次
    const key = pairKey(failedSourceId, fallback.id);
    if (fallbackPairs.has(key)) return null;
    fallbackPairs.add(key);

    const failed = sourceStore.sources.find((source) => source.id === failedSourceId);
    await sourceStore.select(fallback.id);

    // ④ 必须告知（bootstrap.bindAppToasts 已把 toast 事件桥接到 uiStore）
    appEvents.emit('toast', {
      text: `「${failed?.name ?? '当前源'}」暂不可用，已自动切换到「${fallback.name}」`,
      type: 'info',
    });

    return fallback.id;
  }

  async function loadFirstPage(refresh = false): Promise<void> {
    const sourceId = activeSourceId();
    if (!sourceId) {
      items.value = [];
      page.value = 0;
      hasMore.value = false;
      state.value = 'empty';
      return;
    }
    const seq = ++requestSeq;
    state.value = refresh ? 'refreshing' : 'loading';
    error.value = null;
    try {
      let result: PageResult<MediaItem>;
      try {
        result = await libraryService.browse({
          sourceId,
          categoryId: currentCategoryId.value,
          filters: filters.value,
          page: 1,
          pageSize: PAGE_SIZE,
          refresh,
        });
      } catch (e) {
        if (seq !== requestSeq) return;
        const fallbackId = await tryFallbackSource(sourceId, e);
        // 无候选 / 防抖命中 / 非源侧故障 → 原样抛出，保持既有错误语义
        if (fallbackId === null) throw e;
        // 切换后重跑分类 + 第 1 页，**只重试一次**（第二次失败不再切换）
        await loadCategories(false);
        result = await libraryService.browse({
          sourceId: fallbackId,
          categoryId: currentCategoryId.value,
          filters: filters.value,
          page: 1,
          pageSize: PAGE_SIZE,
          refresh,
        });
      }
      if (seq !== requestSeq) return;
      items.value = result.items;
      page.value = 1;
      hasMore.value = result.hasMore;
      state.value = result.items.length === 0 ? 'empty' : 'success';
    } catch (e) {
      if (seq !== requestSeq) return;
      error.value = toErrorShape(e);
      state.value = error.value.code === 'E_NETWORK' ? 'offline' : 'error';
    }
  }

  async function loadNextPage(): Promise<void> {
    const sourceId = activeSourceId();
    if (!sourceId || !hasMore.value || state.value === 'loading' || state.value === 'refreshing') return;
    const seq = ++requestSeq;
    const nextPage = page.value + 1;
    state.value = 'refreshing';
    error.value = null;
    try {
      const result = await libraryService.browse({
        sourceId,
        categoryId: currentCategoryId.value,
        filters: filters.value,
        page: nextPage,
        pageSize: PAGE_SIZE,
      });
      if (seq !== requestSeq) return;
      const seen = new Set(items.value.map((item) => item.id));
      const fresh = result.items.filter((item) => !seen.has(item.id));
      items.value = [...items.value, ...fresh];
      page.value = nextPage;
      // CHG-14：去重后新增 0 条（服务端忽略 pg 重复返回/已到底）→ 强制停止，
      // 防止无限滚动对同一页反复请求
      hasMore.value = result.hasMore && fresh.length > 0;
      state.value = items.value.length === 0 ? 'empty' : 'success';
    } catch (e) {
      if (seq !== requestSeq) return;
      error.value = toErrorShape(e);
      state.value = items.value.length > 0 ? 'success' : 'error';
    }
  }

  async function retry(): Promise<void> {
    await loadFirstPage(false);
  }

  async function search(
    keyword: string,
    opts?: { forceAll?: boolean; sourceIds?: string[] },
  ): Promise<void> {
    const trimmed = keyword.trim();
    searchKeyword.value = keyword;
    searchController?.abort();
    searchController = null;
    if (trimmed.length === 0) {
      searchResults.value = [];
      searchResultsAll.value = [];
      searchFailed.value = [];
      searchState.value = 'idle';
      return;
    }
    searchState.value = 'loading';
    const controller = new AbortController();
    searchController = controller;
    searchResults.value = [];
    searchResultsAll.value = [];
    searchFailed.value = [];
    searchLateCount.value = 0;
    /** 本次搜索已上屏的片名（P1-8 聚合去重：不同源的同名条目只显示一条） */
    const titleSeen = new Set<string>();
    /** 第一波（首源完成）之后到达的条目计为「晚到」（CHG-20 慢源提示） */
    let firstBatchSeen = false;
    try {
      const result = await libraryService.search({
        keyword: trimmed,
        signal: controller.signal,
        // CHG-15：空态"仍要搜索全部源"重试时跳过体检结论过滤
        forceAll: opts?.forceAll === true,
        // CHG-20：范围筛选 + 会话级退避源排除
        sourceIds: opts?.sourceIds ?? scopeSourceIds(),
        // CHG-12 渐进搜索：单源完成即上屏，先到先显示
        onPartial: ({ sourceId, items, error: sourceError, done, total }) => {
          if (controller.signal.aborted) return;
          searchProgress.value = { done, total };
          if (sourceError) {
            searchFailed.value = [...searchFailed.value, { sourceId, error: sourceError }];
            recordTimeoutStreak(sourceId, sourceError.code);
            return;
          }
          if (items.length > 0) {
            searchResultsAll.value = [...searchResultsAll.value, ...items];
            if (firstBatchSeen) searchLateCount.value += items.length;
            firstBatchSeen = true;
            const seenIds = new Set(searchResults.value.map((item) => item.id));
            const fresh = items.filter((item) => {
              const titleKey = titleDedupKey(item.title, item.year);
              if (seenIds.has(item.id) || titleSeen.has(titleKey)) return false;
              seenIds.add(item.id);
              titleSeen.add(titleKey);
              return true;
            });
            if (fresh.length > 0) {
              searchResults.value = [...searchResults.value, ...fresh];
            }
          } else {
            firstBatchSeen = true;
          }
        },
      });
      if (controller.signal.aborted) return;
      // 终态列表同样按 id + 片名(含年份)去重（保持与渐进上屏一致的展示口径），并按相关度排序
      const seenIds = new Set<string>();
      const seenTitles = new Set<string>();
      searchResults.value = sortByRelevance(
        result.items.filter((item) => {
          const titleKey = titleDedupKey(item.title, item.year);
          if (seenIds.has(item.id) || seenTitles.has(titleKey)) return false;
          seenIds.add(item.id);
          seenTitles.add(titleKey);
          return true;
        }),
        trimmed,
      );
      for (const failure of result.failed) recordTimeoutStreak(failure.sourceId, failure.error.code);
      searchFailed.value = result.failed;
      // CHG-15：诊断信息——0 源参与时 UI 给出原因与行动项，而不是"没搜到"
      searchCandidates.value = result.candidates;
      searchFilteredOut.value = result.filteredOut;
      searchState.value = searchResults.value.length === 0 ? 'empty' : 'success';
    } catch (e) {
      if (isCanceled(e) || controller.signal.aborted) return;
      searchResults.value = [];
      searchResultsAll.value = [];
      searchFailed.value = [];
      searchState.value = 'error';
      error.value = toErrorShape(e);
    } finally {
      if (searchController === controller) searchController = null;
      searchProgress.value = null;
    }
  }

  /* ---------- v1.7/CHG-20：范围筛选与会话级退避 ---------- */

  /**
   * P2-9：只重试失败的源。
   *
   * 真机实测一轮全量聚合搜索有 40+ 源失败，用户看到「N 个源失败」后没有下一步动作；
   * 全量重搜又要等 20~30s。这里只对失败源再扇出一次，并把结果并入当前列表
   * （已上屏内容不闪空、不重排）。
   */
  async function retryFailedSources(): Promise<void> {
    const kw = searchKeyword.value.trim();
    const ids = [...new Set(searchFailed.value.map((failure) => failure.sourceId))];
    if (kw.length === 0 || ids.length === 0 || searchRetrying.value) return;
    searchRetrying.value = true;
    try {
      const result = await libraryService.search({
        keyword: kw,
        // 失败源多半带着体检结论（unreachable 等），必须跳过过滤才有机会翻案
        forceAll: true,
        sourceIds: ids,
        pageSize: SEARCH_LOCAL_LIMIT,
      });
      const seenIds = new Set(searchResultsAll.value.map((item) => item.id));
      const seenTitles = new Set(searchResults.value.map((item) => titleDedupKey(item.title, item.year)));
      const fresh = result.items.filter((item) => {
        const titleKey = titleDedupKey(item.title, item.year);
        if (seenIds.has(item.id) || seenTitles.has(titleKey)) return false;
        seenIds.add(item.id);
        seenTitles.add(titleKey);
        return true;
      });
      if (result.items.length > 0) searchResultsAll.value = [...searchResultsAll.value, ...result.items];
      if (fresh.length > 0) searchResults.value = sortByRelevance([...searchResults.value, ...fresh], kw);
      searchFailed.value = result.failed;
      searchState.value = searchResults.value.length === 0 ? 'empty' : 'success';
    } catch (e) {
      if (!isCanceled(e)) error.value = toErrorShape(e);
    } finally {
      searchRetrying.value = false;
    }
  }

  /** 同源连续超时阈值（会话内记忆；达到后本次会话跳过该源） */
  const SEARCH_BACKOFF_STREAK = 3;
  const searchTimeoutStreak = new Map<string, number>();

  function recordTimeoutStreak(sourceId: string, code: string): void {
    if (code !== 'E_TIMEOUT') {
      searchTimeoutStreak.delete(sourceId);
      return;
    }
    const streak = (searchTimeoutStreak.get(sourceId) ?? 0) + 1;
    searchTimeoutStreak.set(sourceId, streak);
    if (streak >= SEARCH_BACKOFF_STREAK) searchBackoffSources.value.add(sourceId);
  }

  const searchBackoffSources = ref(new Set<string>());

  /** 范围筛选 + 退避排除 → libraryService 的 sourceIds（undefined = 全部） */
  function scopeSourceIds(): string[] | undefined {
    const all = sourceStore.sources;
    const scopeType: Partial<Record<SearchScope, SourceType[]>> = {
      site: ['site'],
      spider: ['spider'],
      douban: ['douban'],
    };
    let ids: string[] | undefined;
    if (searchScope.value === 'selected') {
      ids = searchSelectedSourceIds.value;
    } else if (scopeType[searchScope.value]) {
      const types = scopeType[searchScope.value]!;
      ids = all.filter((s) => types.includes(s.type)).map((s) => s.id);
    }
    if (searchBackoffSources.value.size === 0) return ids;
    const exclude = (list: string[]): string[] => list.filter((id) => !searchBackoffSources.value.has(id));
    return ids === undefined ? exclude(all.map((s) => s.id)) : exclude(ids);
  }

  function setSearchScope(scope: SearchScope, selectedIds?: string[]): void {
    searchScope.value = scope;
    if (selectedIds) searchSelectedSourceIds.value = selectedIds;
  }

  function setSearchViewMode(mode: 'grouped' | 'flat'): void {
    searchViewMode.value = mode;
  }

  function clearSearch(): void {
    searchController?.abort();
    searchController = null;
    searchProgress.value = null;
    searchKeyword.value = '';
    searchResults.value = [];
    searchResultsAll.value = [];
    searchFailed.value = [];
    searchLateCount.value = 0;
    searchState.value = 'idle';
  }

  async function loadDetail(mediaId: string, refresh = false): Promise<void> {
    detailState.value = refresh ? 'refreshing' : 'loading';
    error.value = null;
    try {
      // CHG-28：渐进搜索结果可能尚未落库，把本会话已有的条目作为兜底传入，
      // 避免「点进详情 → E_NOT_FOUND」的竞态（见 libraryService.getDetail）
      const hint = searchResultsAll.value.find((item) => item.id === mediaId) ?? undefined;
      const result = await libraryService.getDetail(mediaId, { refresh, item: hint });
      detail.value = result;
      detailState.value = 'success';
    } catch (e) {
      detail.value = null;
      detailState.value = 'error';
      error.value = toErrorShape(e);
      // B3：详情失败也落健康态（与 browse 一致），让源管理可见异常源
      const code = error.value.code;
      if (
        code === 'E_PARSE' ||
        code === 'E_SOURCE_UNAVAILABLE' ||
        code === 'E_NOT_FOUND' ||
        code === 'E_HTTP_404' ||
        code === 'E_HTTP_5XX'
      ) {
        const cachedItem = await libraryService.getItem(mediaId);
        if (cachedItem) {
          await markSourceFailedByError(cachedItem.sourceId, e);
        }
      }
    }
  }

  async function resolvePlay(
    mediaId: string,
    episodeId: string,
    lineId?: string | null,
  ): Promise<PlaybackSource> {
    return libraryService.resolvePlay({ mediaId, episodeId, lineId: lineId ?? null });
  }

  async function toDownloadInputs(
    mediaId: string,
    episodeIds: string[],
    lineId?: string | null,
  ): Promise<CreateDownloadInput[]> {
    const result = await libraryService.toDownloadInputs({ mediaId, episodeIds, lineId: lineId ?? null });
    if (result.inputs.length === 0 && result.failed.length > 0) {
      const first = result.failed[0];
      throw new AppError(first?.error.code ?? 'E_NO_PLAY_URL', first?.error.message);
    }
    return result.inputs;
  }

  return {
    categories,
    currentCategoryId,
    filters,
    items,
    page,
    hasMore,
    state,
    error,
    searchKeyword,
    searchResults,
    searchResultsAll,
    searchState,
    searchFailed,
    searchRetrying,
    searchProgress,
    searchCandidates,
    searchFilteredOut,
    searchViewMode,
    searchScope,
    searchSelectedSourceIds,
    searchGroups,
    searchLateCount,
    setSearchScope,
    setSearchViewMode,
    detail,
    detailState,
    posterItems,
    isEmpty,
    areaOptions,
    homeRecent,
    homeState,
    homeError,
    openSource,
    loadCategories,
    setCategory,
    setFilters,
    resetFilters,
    loadFirstPage,
    loadNextPage,
    retry,
    search,
    retryFailedSources,
    clearSearch,
    loadDetail,
    resolvePlay,
    toDownloadInputs,
    loadHome,
  };
});

export type LibraryStore = ReturnType<typeof useLibraryStore>;
