/**
 * 媒体库 Store（API-14）
 *
 * 页面四态（LoadState）与分页由 Store 维护，数据请求全部经 `libraryService`。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { libraryService } from '@/services/libraryService';
import { EMPTY_LIBRARY_FILTERS, markSourceFailedByError } from '@/services/libraryService';
import { appEvents } from '@/services/events';
import { useSourceStore } from '@/stores/sourceStore';
import { PAGE_SIZE } from '@/shared/constants';
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

  const searchKeyword = ref('');
  const searchResults = ref<MediaItem[]>([]);
  const searchState = ref<LoadState>('idle');
  const searchFailed = ref<Array<{ sourceId: string; error: AppErrorShape }>>([]);

  const detail = ref<MediaDetail | null>(null);
  const detailState = ref<LoadState>('idle');

  const posterItems = computed(() => items.value);
  const isEmpty = computed(() => items.value.length === 0 && state.value === 'success');

  let requestSeq = 0;
  /** 进行中的搜索控制器：新搜索前 abort 旧的，避免旧请求继续占用源（REV-06） */
  let searchController: AbortController | null = null;
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
    await loadCategories(false);
    await loadFirstPage(false);
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
      items.value = [...items.value, ...result.items.filter((item) => !seen.has(item.id))];
      page.value = nextPage;
      hasMore.value = result.hasMore;
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

  async function search(keyword: string): Promise<void> {
    const trimmed = keyword.trim();
    searchKeyword.value = keyword;
    searchController?.abort();
    searchController = null;
    if (trimmed.length === 0) {
      searchResults.value = [];
      searchFailed.value = [];
      searchState.value = 'idle';
      return;
    }
    searchState.value = 'loading';
    const controller = new AbortController();
    searchController = controller;
    try {
      const result = await libraryService.search({ keyword: trimmed, signal: controller.signal });
      if (controller.signal.aborted) return;
      searchResults.value = result.items;
      searchFailed.value = result.failed;
      searchState.value = result.items.length === 0 ? 'empty' : 'success';
    } catch (e) {
      if (isCanceled(e) || controller.signal.aborted) return;
      searchResults.value = [];
      searchFailed.value = [];
      searchState.value = 'error';
      error.value = toErrorShape(e);
    } finally {
      if (searchController === controller) searchController = null;
    }
  }

  function clearSearch(): void {
    searchController?.abort();
    searchController = null;
    searchKeyword.value = '';
    searchResults.value = [];
    searchFailed.value = [];
    searchState.value = 'idle';
  }

  async function loadDetail(mediaId: string, refresh = false): Promise<void> {
    detailState.value = refresh ? 'refreshing' : 'loading';
    error.value = null;
    try {
      const result = await libraryService.getDetail(mediaId, { refresh });
      detail.value = result;
      detailState.value = 'success';
    } catch (e) {
      detail.value = null;
      detailState.value = 'error';
      error.value = toErrorShape(e);
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
    searchState,
    searchFailed,
    detail,
    detailState,
    posterItems,
    isEmpty,
    openSource,
    loadCategories,
    setCategory,
    setFilters,
    resetFilters,
    loadFirstPage,
    loadNextPage,
    retry,
    search,
    clearSearch,
    loadDetail,
    resolvePlay,
    toDownloadInputs,
  };
});

export type LibraryStore = ReturnType<typeof useLibraryStore>;
