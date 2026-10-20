/**
 * 媒体库 Store（API-14）
 *
 * 页面四态（LoadState）与分页由 Store 维护，数据请求全部经 `libraryService`。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { libraryService } from '@/services/libraryService';
import { EMPTY_LIBRARY_FILTERS } from '@/services/libraryService';
import { useSourceStore } from '@/stores/sourceStore';
import { PAGE_SIZE } from '@/shared/constants';
import { AppError, isCanceled, toErrorShape } from '@/shared/errors';
import type {
  AppErrorShape,
  Category,
  CreateDownloadInput,
  LibraryFilters,
  LoadState,
  MediaDetail,
  MediaItem,
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
  const sourceStore = useSourceStore();

  function activeSourceId(): string | null {
    return sourceStore.currentSource?.id ?? null;
  }

  async function openSource(sourceId: string | null): Promise<void> {
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
      const result = await libraryService.browse({
        sourceId,
        categoryId: currentCategoryId.value,
        filters: filters.value,
        page: 1,
        pageSize: PAGE_SIZE,
        refresh,
      });
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
    if (trimmed.length === 0) {
      searchResults.value = [];
      searchFailed.value = [];
      searchState.value = 'idle';
      return;
    }
    searchState.value = 'loading';
    try {
      const result = await libraryService.search({ keyword: trimmed });
      searchResults.value = result.items;
      searchFailed.value = result.failed;
      searchState.value = result.items.length === 0 ? 'empty' : 'success';
    } catch (e) {
      if (isCanceled(e)) return;
      searchResults.value = [];
      searchFailed.value = [];
      searchState.value = 'error';
      error.value = toErrorShape(e);
    }
  }

  function clearSearch(): void {
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
