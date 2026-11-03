/**
 * 契约级 Mock（SCF 交付，PKG-A / PKG-B 均只读）
 *
 * 目的：在数据包（PKG-B）尚未就绪时，让 UI 包能按 API-14 契约跑通全部页面。
 * 约束（技术方案 3.9）：
 * - **不得** import `src/data/**`、`src/db/**`、`src/services/**`，避免跨包耦合；
 * - 数据为内置最小示例（6 条），不是演示源，也不是最终 UI 数据；
 * - 集成完成后 UI 改为真实 Store，此文件不再被引用（可保留供组件测试使用）。
 *
 * 命名：`useMockXxxStore` / `mockXxxService`，与真实 Store 的 `useXxxStore` 区分，
 * 避免同时 import 时 Pinia id 冲突。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type {
  AppErrorShape,
  AppSettings,
  Category,
  CreateDownloadInput,
  DownloadSummary,
  DownloadTask,
  FavoriteInput,
  FavoriteRecord,
  HistoryRecord,
  LibraryFilters,
  LoadState,
  MediaDetail,
  MediaItem,
  PlaybackSource,
  SaveProgressInput,
  Source,
} from '@/types';
import { COMPLIANCE_VERSION, PAGE_SIZE } from '@/shared/constants';
import { AppError, toErrorShape } from '@/shared/errors';
import { categoryIdOf, episodeIdOf, historyIdOf, lineIdOf, mediaIdOf, newId } from '@/shared/id';

/* =========================================================
 * 1. 内置示例数据（6 条，含 1 部剧 3 集）
 * =======================================================*/

const NOW = Date.now();

/** 用内联 SVG 生成真实可渲染的海报（非占位色块，避免"假截图"） */
function posterSvg(title: string, hue: number): string {
  const safeTitle = title.replace(/[<>&]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 42% 26%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 28) % 360} 38% 12%)"/>
    </linearGradient>
  </defs>
  <rect width="300" height="450" fill="url(#g)"/>
  <circle cx="248" cy="64" r="88" fill="hsl(${hue} 60% 60%)" opacity="0.16"/>
  <text x="24" y="392" fill="#f5f5f7" font-family="system-ui, sans-serif" font-size="26" font-weight="600">${safeTitle}</text>
  <text x="24" y="420" fill="#a1a1aa" font-family="system-ui, sans-serif" font-size="14">MOCK DATA</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

interface MockSeed {
  sourceItemId: string;
  title: string;
  type: MediaItem['type'];
  year: number;
  area: string;
  genres: string[];
  description: string;
  durationSec: number | null;
  episodeCount: number | null;
  hue: number;
}

const MOCK_SEEDS: MockSeed[] = [
  {
    sourceItemId: 'demo-001',
    title: 'Big Buck Bunny',
    type: 'movie',
    year: 2008,
    area: '美国',
    genres: ['动画', '喜剧'],
    description: '一只大兔子的日常被三只小动物打断，随后展开反击。公开版权样片，用于验证播放链路。',
    durationSec: 596,
    episodeCount: null,
    hue: 24,
  },
  {
    sourceItemId: 'demo-002',
    title: 'Sintel',
    type: 'movie',
    year: 2010,
    area: '荷兰',
    genres: ['动画', '奇幻'],
    description: '少女与幼龙的故事。公开版权样片，用于验证 HLS 通路。',
    durationSec: 888,
    episodeCount: null,
    hue: 200,
  },
  {
    sourceItemId: 'demo-003',
    title: 'Tears of Steel',
    type: 'movie',
    year: 2012,
    area: '荷兰',
    genres: ['科幻'],
    description: '阿姆斯特丹的未来，人类与机器人的冲突。公开版权样片。',
    durationSec: 734,
    episodeCount: null,
    hue: 268,
  },
  {
    sourceItemId: 'demo-101',
    title: '示例剧集：四季',
    type: 'series',
    year: 2021,
    area: '中国',
    genres: ['剧情'],
    description: 'Mock 数据：一部三集的示例剧，用于验证剧集列表、续播、自动连播。',
    durationSec: null,
    episodeCount: 3,
    hue: 150,
  },
  {
    sourceItemId: 'demo-102',
    title: '示例动漫：星轨',
    type: 'anime',
    year: 2023,
    area: '日本',
    genres: ['动画', '科幻'],
    description: 'Mock 数据：用于验证分类 Tab 与筛选组合。',
    durationSec: null,
    episodeCount: 3,
    hue: 320,
  },
  {
    sourceItemId: 'demo-201',
    title: '示例综艺：厨房时间',
    type: 'variety',
    year: 2024,
    area: '中国',
    genres: ['真人秀'],
    description: 'Mock 数据：用于验证综艺类型与年份筛选。',
    durationSec: null,
    episodeCount: 2,
    hue: 40,
  },
];

const MOCK_SOURCE_ID = 'mock';

function buildMockItems(): MediaItem[] {
  return MOCK_SEEDS.map((seed) => ({
    id: mediaIdOf(MOCK_SOURCE_ID, seed.sourceItemId),
    sourceId: MOCK_SOURCE_ID,
    sourceItemId: seed.sourceItemId,
    title: seed.title,
    originalTitle: null,
    type: seed.type,
    year: seed.year,
    area: seed.area,
    genres: seed.genres,
    tags: ['mock'],
    rating: null,
    posterUrl: posterSvg(seed.title, seed.hue),
    backdropUrl: null,
    description: seed.description,
    durationSec: seed.durationSec,
    episodeCount: seed.episodeCount,
    titleLower: seed.title.toLowerCase(),
    isDemo: false,
    cachedAt: NOW,
    updatedAt: NOW,
  }));
}

const MOCK_ITEMS: MediaItem[] = buildMockItems();

function buildMockSource(): Source {
  return {
    id: MOCK_SOURCE_ID,
    key: 'mock',
    name: '示例数据（Mock）',
    type: 'demo',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: '',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'ok',
    healthCheckedAt: NOW,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const MOCK_CATEGORIES: Category[] = [
  { id: categoryIdOf(MOCK_SOURCE_ID, 'movie'), sourceId: MOCK_SOURCE_ID, name: '电影', value: 'movie', order: 0 },
  { id: categoryIdOf(MOCK_SOURCE_ID, 'series'), sourceId: MOCK_SOURCE_ID, name: '电视剧', value: 'series', order: 1 },
  { id: categoryIdOf(MOCK_SOURCE_ID, 'anime'), sourceId: MOCK_SOURCE_ID, name: '动漫', value: 'anime', order: 2 },
  { id: categoryIdOf(MOCK_SOURCE_ID, 'variety'), sourceId: MOCK_SOURCE_ID, name: '综艺', value: 'variety', order: 3 },
];

const EMPTY_FILTERS: LibraryFilters = { type: null, yearFrom: null, yearTo: null, area: null };

/** Mock 播放地址：公开版权样片（Blender 开放影片） */
const MOCK_PLAYBACK_URL = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

function filterMockItems(items: MediaItem[], categoryId: string | null, filters: LibraryFilters): MediaItem[] {
  const categoryValue = categoryId ? categoryId.split(':')[0] : null;
  return items.filter((it) => {
    if (categoryValue && it.type !== categoryValue) return false;
    if (filters.type && it.type !== filters.type) return false;
    if (filters.yearFrom !== null && (it.year === null || it.year < filters.yearFrom)) return false;
    if (filters.yearTo !== null && (it.year === null || it.year > filters.yearTo)) return false;
    if (filters.area && it.area !== filters.area) return false;
    return true;
  });
}

function buildMockDetail(item: MediaItem): MediaDetail {
  const lineId = lineIdOf(item.id, 0);
  const count = item.episodeCount ?? 1;
  const episodes = Array.from({ length: count }, (_, i) => ({
    id: episodeIdOf(item.id, lineId, i + 1),
    mediaId: item.id,
    sourceId: item.sourceId,
    lineId,
    number: i + 1,
    title: count === 1 ? item.title : `第 ${i + 1} 集`,
    durationSec: item.durationSec ?? 600,
    subtitles: [],
    updatedAt: NOW,
  }));
  return {
    item,
    lines: [
      {
        id: lineId,
        mediaId: item.id,
        sourceId: item.sourceId,
        name: '默认线路',
        quality: '720p',
        format: 'mp4',
        index: 0,
      },
    ],
    episodes,
  };
}

/* =========================================================
 * 2. 假 SettingsService（路由守卫与合规门禁用，非 Store）
 * =======================================================*/

function defaultSettings(): AppSettings {
  return {
    schemaVersion: 1,
    theme: 'dark',
    locale: 'zh-CN',
    complianceVersion: COMPLIANCE_VERSION,
    complianceAcceptedAt: null,
    defaultSourceId: null,
    hideDemoContent: false,
    player: {
      defaultRate: 1,
      defaultQuality: 'auto',
      autoPlayNext: true,
      seekStepSec: 10,
      longPressRate: 2,
      subtitle: {
        enabled: false,
        size: 'medium',
        color: 'white',
        background: 'black',
        offsetSec: 0,
        preferredLang: null,
      },
      rememberVolumeBrightness: true,
      lastVolume: 100,
      lastBrightness: 100,
    },
    gesture: { sensitivity: 'medium', seekMaxSec: 90 },
    download: { concurrency: 2, wifiOnly: false, autoResume: true, speedLimit: 'unlimited' },
    searchHistory: [],
    updatedAt: NOW,
  };
}

/** 合规门禁所需的最小契约（router 只依赖这部分） */
export interface ComplianceGate {
  get(): Promise<AppSettings>;
  isComplianceAccepted(version: number): Promise<boolean>;
}

let mockSettingsState: AppSettings = defaultSettings();

export const mockSettingsService = {
  async get(): Promise<AppSettings> {
    return structuredClone(mockSettingsState);
  },
  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    mockSettingsState = { ...mockSettingsState, ...patch, updatedAt: Date.now() };
    return structuredClone(mockSettingsState);
  },
  async acceptCompliance(version: number): Promise<void> {
    mockSettingsState = {
      ...mockSettingsState,
      complianceVersion: version,
      complianceAcceptedAt: Date.now(),
      updatedAt: Date.now(),
    };
  },
  async isComplianceAccepted(version: number): Promise<boolean> {
    return (
      mockSettingsState.complianceAcceptedAt !== null && mockSettingsState.complianceVersion >= version
    );
  },
  /** 测试辅助：重置合规状态（组件测试用） */
  __reset(): void {
    mockSettingsState = defaultSettings();
  },
};

/* =========================================================
 * 3. 假 Store（API-14 形状）
 * =======================================================*/

/* -------- sourceStore -------- */
export const useMockSourceStore = defineStore('mock/source', () => {
  const sources = ref<Source[]>([buildMockSource()]);
  const currentSourceId = ref<string | null>(MOCK_SOURCE_ID);
  const loading = ref(false);
  const healthChecking = ref(false);
  const error = ref<AppErrorShape | null>(null);

  const enabledSources = computed(() => sources.value.filter((s) => s.enabled));
  const currentSource = computed(
    () => sources.value.find((s) => s.id === currentSourceId.value) ?? enabledSources.value[0] ?? null,
  );
  const defaultSource = computed(() => enabledSources.value[0] ?? null);

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      sources.value = [buildMockSource()];
    } catch (e) {
      error.value = toErrorShape(e);
    } finally {
      loading.value = false;
    }
  }

  async function select(sourceId: string | null): Promise<void> {
    currentSourceId.value = sourceId;
  }

  async function setEnabled(id: string, v: boolean): Promise<void> {
    const target = sources.value.find((s) => s.id === id);
    if (!target) throw new AppError('E_NOT_FOUND');
    target.enabled = v;
    target.updatedAt = Date.now();
  }

  async function reorder(ids: string[]): Promise<void> {
    sources.value.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  }

  async function refreshHealth(): Promise<void> {
    healthChecking.value = true;
    try {
      sources.value = sources.value.map((s) => ({
        ...s,
        health: 'ok' as const,
        healthCheckedAt: Date.now(),
      }));
    } finally {
      healthChecking.value = false;
    }
  }

  return {
    sources,
    currentSourceId,
    loading,
    healthChecking,
    error,
    enabledSources,
    currentSource,
    defaultSource,
    load,
    select,
    setEnabled,
    reorder,
    refreshHealth,
  };
});

/* -------- libraryStore -------- */
export const useMockLibraryStore = defineStore('mock/library', () => {
  const categories = ref<Category[]>([...MOCK_CATEGORIES]);
  const currentCategoryId = ref<string | null>(null);
  const filters = ref<LibraryFilters>({ ...EMPTY_FILTERS });
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

  async function openSource(sourceId: string | null): Promise<void> {
    await (sourceId === null ? Promise.resolve() : Promise.resolve());
    await loadCategories(false);
    await loadFirstPage(false);
  }

  async function loadCategories(refresh = false): Promise<void> {
    if (refresh || categories.value.length === 0) categories.value = [...MOCK_CATEGORIES];
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
    filters.value = { ...EMPTY_FILTERS };
    await loadFirstPage(false);
  }

  async function loadPage(targetPage: number): Promise<void> {
    const all = filterMockItems(MOCK_ITEMS, currentCategoryId.value, filters.value);
    const start = (targetPage - 1) * PAGE_SIZE;
    const slice = all.slice(start, start + PAGE_SIZE);
    items.value = targetPage === 1 ? slice : [...items.value, ...slice];
    page.value = targetPage;
    hasMore.value = start + PAGE_SIZE < all.length;
    state.value = items.value.length === 0 ? 'empty' : 'success';
  }

  async function loadFirstPage(refresh = false): Promise<void> {
    state.value = refresh ? 'refreshing' : 'loading';
    error.value = null;
    try {
      await loadPage(1);
    } catch (e) {
      error.value = toErrorShape(e);
      state.value = 'error';
    }
  }

  async function loadNextPage(): Promise<void> {
    if (!hasMore.value) return;
    state.value = 'refreshing';
    try {
      await loadPage(page.value + 1);
    } catch (e) {
      error.value = toErrorShape(e);
      state.value = 'error';
    }
  }

  async function retry(): Promise<void> {
    await loadFirstPage(false);
  }

  async function search(keyword: string): Promise<void> {
    searchKeyword.value = keyword;
    searchState.value = 'loading';
    const kw = keyword.trim().toLowerCase();
    if (kw.length === 0) {
      searchResults.value = [];
      searchState.value = 'idle';
      return;
    }
    await Promise.resolve();
    searchResults.value = MOCK_ITEMS.filter((it) => it.titleLower.includes(kw));
    searchFailed.value = [];
    searchState.value = searchResults.value.length === 0 ? 'empty' : 'success';
  }

  function clearSearch(): void {
    searchKeyword.value = '';
    searchResults.value = [];
    searchState.value = 'idle';
    searchFailed.value = [];
  }

  async function loadDetail(mediaId: string, refresh = false): Promise<void> {
    detailState.value = refresh ? 'refreshing' : 'loading';
    error.value = null;
    try {
      await Promise.resolve();
      const item = MOCK_ITEMS.find((it) => it.id === mediaId) ?? null;
      if (!item) throw new AppError('E_NOT_FOUND');
      detail.value = buildMockDetail(item);
      detailState.value = 'success';
    } catch (e) {
      error.value = toErrorShape(e);
      detailState.value = 'error';
      detail.value = null;
    }
  }

  async function resolvePlay(
    mediaId: string,
    _episodeId: string,
    lineId?: string | null,
  ): Promise<PlaybackSource> {
    const item = MOCK_ITEMS.find((it) => it.id === mediaId);
    if (!item) throw new AppError('E_NOT_FOUND');
    const resolvedLine = lineId ?? lineIdOf(mediaId, 0);
    return {
      url: MOCK_PLAYBACK_URL,
      format: 'mp4',
      headers: {},
      subtitles: [],
      lineId: resolvedLine,
      quality: '720p',
      expiresAt: null,
      isLocal: false,
    };
  }

  async function toDownloadInputs(mediaId: string, episodeIds: string[]): Promise<CreateDownloadInput[]> {
    const item = MOCK_ITEMS.find((it) => it.id === mediaId);
    if (!item) throw new AppError('E_NOT_FOUND');
    return episodeIds.map((episodeId, idx) => ({
      sourceId: item.sourceId,
      mediaId,
      episodeId,
      episodeNumber: idx + 1,
      title: item.title,
      episodeTitle: `第 ${idx + 1} 集`,
      posterUrl: item.posterUrl,
      url: MOCK_PLAYBACK_URL,
      headers: {},
      format: 'mp4' as const,
      quality: '720p',
    }));
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

/* -------- historyStore -------- */
export const useMockHistoryStore = defineStore('mock/history', () => {
  const items = ref<HistoryRecord[]>([]);
  const continueWatching = ref<HistoryRecord[]>([]);
  const state = ref<LoadState>('idle');
  const error = ref<AppErrorShape | null>(null);

  async function load(): Promise<void> {
    state.value = items.value.length === 0 ? 'empty' : 'success';
  }

  async function save(input: SaveProgressInput): Promise<HistoryRecord> {
    const id = historyIdOf(input.sourceId, input.mediaId);
    const progress = input.durationSec > 0 ? input.positionSec / input.durationSec : 0;
    const record: HistoryRecord = {
      id,
      sourceId: input.sourceId,
      mediaId: input.mediaId,
      episodeId: input.episodeId,
      episodeNumber: input.episodeNumber,
      title: input.title,
      posterUrl: input.posterUrl,
      positionSec: input.positionSec,
      durationSec: input.durationSec,
      progress,
      finished: progress >= 0.95,
      totalEpisodes: input.totalEpisodes,
      createdAt: NOW,
      updatedAt: Date.now(),
    };
    items.value = [record, ...items.value.filter((r) => r.id !== id)];
    continueWatching.value = items.value.filter((r) => r.progress > 0.05 && r.progress < 0.95);
    state.value = 'success';
    return record;
  }

  async function remove(id: string): Promise<void> {
    items.value = items.value.filter((r) => r.id !== id);
    continueWatching.value = continueWatching.value.filter((r) => r.id !== id);
    state.value = items.value.length === 0 ? 'empty' : 'success';
  }

  async function clear(): Promise<void> {
    items.value = [];
    continueWatching.value = [];
    state.value = 'empty';
  }

  function progressOf(sourceId: string, mediaId: string): HistoryRecord | null {
    return items.value.find((r) => r.sourceId === sourceId && r.mediaId === mediaId) ?? null;
  }

  return { items, continueWatching, state, error, load, save, remove, clear, progressOf };
});

/* -------- favoriteStore -------- */
export const useMockFavoriteStore = defineStore('mock/favorite', () => {
  const items = ref<FavoriteRecord[]>([]);
  const state = ref<LoadState>('idle');
  const order = ref<'created' | 'title'>('created');

  async function load(nextOrder?: 'created' | 'title'): Promise<void> {
    if (nextOrder) order.value = nextOrder;
    state.value = items.value.length === 0 ? 'empty' : 'success';
  }

  function isFavorite(sourceId: string, mediaId: string): boolean {
    const id = historyIdOf(sourceId, mediaId);
    return items.value.some((f) => f.id === id);
  }

  async function toggle(input: FavoriteInput): Promise<boolean> {
    const id = historyIdOf(input.sourceId, input.mediaId);
    if (items.value.some((f) => f.id === id)) {
      items.value = items.value.filter((f) => f.id !== id);
      state.value = items.value.length === 0 ? 'empty' : 'success';
      return false;
    }
    items.value = [
      {
        id,
        sourceId: input.sourceId,
        mediaId: input.mediaId,
        title: input.title,
        posterUrl: input.posterUrl,
        type: input.type,
        year: input.year,
        sourceRemoved: false,
        createdAt: Date.now(),
      },
      ...items.value,
    ];
    state.value = 'success';
    return true;
  }

  async function remove(id: string): Promise<void> {
    items.value = items.value.filter((f) => f.id !== id);
    state.value = items.value.length === 0 ? 'empty' : 'success';
  }

  return { items, state, order, load, isFavorite, toggle, remove };
});

/* -------- downloadStore -------- */
export const useMockDownloadStore = defineStore('mock/download', () => {
  const tasks = ref<DownloadTask[]>([]);
  const summary = ref<DownloadSummary>({
    total: 0,
    queued: 0,
    downloading: 0,
    paused: 0,
    completed: 0,
    failed: 0,
    totalBytes: 0,
    downloadedBytes: 0,
  });
  const state = ref<LoadState>('idle');
  const error = ref<AppErrorShape | null>(null);

  function recompute(): void {
    const next: DownloadSummary = {
      total: tasks.value.length,
      queued: 0,
      downloading: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      totalBytes: 0,
      downloadedBytes: 0,
    };
    for (const t of tasks.value) {
      if (t.status === 'queued') next.queued += 1;
      else if (t.status === 'downloading') next.downloading += 1;
      else if (t.status === 'paused') next.paused += 1;
      else if (t.status === 'completed') next.completed += 1;
      else if (t.status === 'failed') next.failed += 1;
      next.totalBytes += t.totalBytes ?? 0;
      next.downloadedBytes += t.downloadedBytes;
    }
    summary.value = next;
    state.value = tasks.value.length === 0 ? 'empty' : 'success';
  }

  async function load(): Promise<void> {
    recompute();
  }

  async function create(input: CreateDownloadInput): Promise<void> {
    const now = Date.now();
    tasks.value = [
      ...tasks.value,
      {
        id: newId(),
        sourceId: input.sourceId,
        mediaId: input.mediaId,
        episodeId: input.episodeId,
        episodeNumber: input.episodeNumber,
        title: input.title,
        episodeTitle: input.episodeTitle,
        posterUrl: input.posterUrl,
        url: input.url,
        headers: input.headers ?? {},
        format: input.format,
        quality: input.quality ?? null,
        status: 'queued',
        priority: now,
        totalBytes: null,
        downloadedBytes: 0,
        speedBps: 0,
        retries: 0,
        maxRetries: 2,
        resumable: true,
        sink: 'idb-blob',
        filePath: null,
        blobKey: null,
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      },
    ];
    recompute();
  }

  async function createMany(inputs: CreateDownloadInput[]): Promise<void> {
    for (const input of inputs) await create(input);
  }

  function patchTask(id: string, patch: Partial<DownloadTask>): void {
    tasks.value = tasks.value.map((t) => (t.id === id ? { ...t, ...patch, updatedAt: Date.now() } : t));
    recompute();
  }

  async function pause(id: string): Promise<void> {
    patchTask(id, { status: 'paused', speedBps: 0 });
  }
  async function resume(id: string): Promise<void> {
    patchTask(id, { status: 'queued' });
  }
  async function cancel(id: string): Promise<void> {
    patchTask(id, { status: 'canceled', speedBps: 0 });
  }
  async function retry(id: string): Promise<void> {
    patchTask(id, { status: 'queued', retries: 0, errorCode: null, errorMessage: null });
  }
  async function remove(id: string, _deleteFile?: boolean): Promise<void> {
    tasks.value = tasks.value.filter((t) => t.id !== id);
    recompute();
  }
  async function pauseAll(): Promise<void> {
    tasks.value = tasks.value.map((t) =>
      t.status === 'downloading' ? { ...t, status: 'paused', speedBps: 0 } : t,
    );
    recompute();
  }
  async function resumeAll(): Promise<void> {
    tasks.value = tasks.value.map((t) => (t.status === 'paused' ? { ...t, status: 'queued' } : t));
    recompute();
  }
  async function clearCompleted(): Promise<void> {
    tasks.value = tasks.value.filter((t) => t.status !== 'completed');
    recompute();
  }

  return {
    tasks,
    summary,
    state,
    error,
    load,
    create,
    createMany,
    pause,
    resume,
    cancel,
    retry,
    remove,
    pauseAll,
    resumeAll,
    clearCompleted,
  };
});

/* -------- settingsStore -------- */
export const useMockSettingsStore = defineStore('mock/settings', () => {
  const settings = ref<AppSettings | null>(null);
  const ready = ref(false);

  const theme = computed(() => settings.value?.theme ?? 'dark');
  const player = computed(() => settings.value?.player ?? defaultSettings().player);
  const gesture = computed(() => settings.value?.gesture ?? defaultSettings().gesture);
  const download = computed(() => settings.value?.download ?? defaultSettings().download);

  async function load(): Promise<void> {
    settings.value = await mockSettingsService.get();
    ready.value = true;
  }

  async function update(patch: Partial<AppSettings>): Promise<void> {
    settings.value = await mockSettingsService.update(patch);
    ready.value = true;
  }

  async function acceptCompliance(): Promise<void> {
    await mockSettingsService.acceptCompliance(COMPLIANCE_VERSION);
    settings.value = await mockSettingsService.get();
  }

  async function resetAllData(_keepDemo: boolean): Promise<void> {
    /** mock 不持有业务数据，仅作接口占位 */
  }

  return { settings, ready, theme, player, gesture, download, load, update, acceptCompliance, resetAllData };
});

/* =========================================================
 * 4. 其它契约假实现（供 UI 在集成前验证交互）
 * =======================================================*/

export const mockCastService = {
  async isSupported(): Promise<boolean> {
    return false;
  },
  async cast(): Promise<{ started: boolean; reason: 'unsupported-platform'; error: null }> {
    return { started: false, reason: 'unsupported-platform', error: null };
  },
};

export const mockBackupService = {
  async exportData(): Promise<Blob> {
    const payload = {
      schemaVersion: 1,
      appVersion: 'mock',
      exportedAt: Date.now(),
      sources: [],
      favorites: [],
      history: [],
      settings: mockSettingsState,
      downloads: [],
    };
    return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  },
  async exportToFile(): Promise<{ path: string | null; fileName: string }> {
    return { path: null, fileName: 'peanutmov-backup-mock.json' };
  },
};

/** 便捷汇总，便于 UI 一次性按需取用 */
export const mockServices = {
  settings: mockSettingsService,
  cast: mockCastService,
  backup: mockBackupService,
  items: MOCK_ITEMS,
  source: buildMockSource(),
};

/** 仅测试用：重置全部 mock 内存状态 */
export function resetMockState(): void {
  mockSettingsService.__reset();
}
