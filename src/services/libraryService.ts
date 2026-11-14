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
import { historyRepo } from '@/db/repositories/historyRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { appEvents } from '@/services/events';
import { downloadService } from '@/services/downloadService';
import { healthService } from '@/services/healthService';
import { settingsService } from '@/services/settingsService';
import { sourceRegistry } from '@/sources/registry';
import { healthOfError } from '@/sources/base/BaseAdapter';
import {
  PAGE_SIZE,
  SEARCH_LOCAL_LIMIT,
  TIMEOUT_SEARCH_LOAD_ALLOWANCE_MS,
  TIMEOUT_SEARCH_MS,
} from '@/shared/constants';
import { AppError, isCanceled, toAppError, toErrorShape } from '@/shared/errors';
import { HEALTH_TIER_ORDER, healthTierOf } from '@/shared/healthTier';
import { mediaIdOf } from '@/shared/id';
import { resolveSearchTimeoutMs } from '@/shared/searchBudget';
import type { SearchBudgetPreset } from '@/shared/searchBudget';
import { classifySourceFailure, isTransientFailure, sanitizeSourceMessage } from '@/shared/sourceFailure';
import { isKeywordIgnored } from '@/services/searchAggregate';
import { recordSearchPerf, type SearchPerfSource } from '@/services/searchPerf';
import { isLocalArtifactUrl, LOCAL_ARTIFACT_MESSAGE } from '@/player/sourceGuard';
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
  SubtitleTrack,
  PageResult,
  PlaybackSource,
  SearchPhasePerf,
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
  /** F7：批量预热爬虫源（启动后 / 导入完成后）；返回实际加载成功的源数 */
  warmupSources(opts?: { delayMs?: number }): Promise<number>;
  /**
   * CHG-28：`item` 为调用方已持有的条目（如渐进搜索结果）。条目尚未落库时
   * 以它兜底直接回源刷新，而不是立刻抛 E_NOT_FOUND——修复「渐进搜索期间
   * 点击结果 → 详情加载失败」的竞态（落库原本要等全部源 settle）。
   */
  getDetail(mediaId: string, opts?: { refresh?: boolean; item?: MediaItem }): Promise<MediaDetail>;
  /**
   * P0-FIX-1：轻量详情探活（可播性预检专用）。
   * 只调 adapter.getDetail() 网络请求，**不写入数据库、不发事件、不清缓存**——
   * 避免预检 12 条 × 5 次 SQLite 写阻塞主线程。
   */
  peekDetail(item: MediaItem): Promise<{ episodeCount: number; lineCount: number }>;
  getItem(mediaId: string): Promise<MediaItem | null>;
  /** REV-24：媒体缓存缺失时尝试自愈（从历史快照重建或按标题搜索） */
  recoverItem(mediaId: string): Promise<MediaItem | null>;
  listCached(sourceId?: string | null, limit?: number): Promise<MediaItem[]>;
  listRecent(limit?: number): Promise<MediaItem[]>;
  /** 该源缓存中出现过的地区（筛选面板地区选项推导用） */
  listAreas(sourceId: string): Promise<string[]>;
  /**
   * 解析播放地址。
   *
   * `prefer`（P0-1）：`'local'`（默认）本地已完成任务优先，离线可播；
   * `'network'` 跳过本地命中，只要可从网络拉取的直链——下载输入必须走这条，
   * 否则拿到的是 `https://localhost/_capacitor_file_/…` 文件桥地址，任务必然失败。
   */
  resolvePlay(params: {
    mediaId: string;
    episodeId: string;
    lineId?: string | null;
    prefer?: 'local' | 'network';
  }): Promise<PlaybackSource>;
  ensureEpisodes(mediaId: string, lineId?: string | null): Promise<Episode[]>;
  toDownloadInputs(params: {
    mediaId: string;
    episodeIds: string[];
    lineId?: string | null;
    signal?: AbortSignal;
  }): Promise<{ inputs: CreateDownloadInput[]; failed: Array<{ episodeId: string; error: AppErrorShape }> }>;
  /** B2：跨源同名搜索——在其它启用源里找同名同年的可播条目 */
  findAlternateByTitle(
    title: string,
    year: number | null,
    excludeSourceId: string,
    targetEpisodeId?: string,
  ): Promise<{ mediaId: string; sourceName: string } | null>;
  /**
   * 跨源候选列表（详情页切换来源用）
   *
   * scope='cache' 只查本地缓存（毫秒级、可离线）；scope='network' 扇出搜索（8-30s）。
   * 结果按源去重（每个源只保留一条，优先年份精确匹配），排除 douban/禁用源。
   */
  listSourceCandidates(
    target: { title: string; year: number | null },
    opts?: {
      scope?: 'cache' | 'network';
      excludeSourceId?: string;
      excludeMediaId?: string;
      forceAll?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<MediaItem[]>;
  /** P0-3：失效指定媒体的播放地址缓存（播放出错时调用，避免重试复用坏 URL） */
  invalidatePlayCache(mediaId: string): void;
}

/** 首屏缓存有效期（技术方案 6 章：cached < 5min） */
const BROWSE_CACHE_TTL_MS = 5 * 60 * 1000;

/** 候选列表缓存有效期（5 分钟） */
const CANDIDATE_CACHE_TTL_MS = 5 * 60 * 1000;
interface CandidateCacheEntry {
  at: number;
  items: MediaItem[];
}
const candidateCache = new Map<string, CandidateCacheEntry>();
const candidateInflight = new Map<string, Promise<MediaItem[]>>();

/** 播放地址内存缓存（避免每次播放都重跑 detailContent + playerContent） */
interface ResolvedPlayCacheEntry {
  playback: PlaybackSource;
  cachedAt: number;
}
const RESOLVED_PLAY_TTL_MS = 30 * 60 * 1000;
const resolvedPlayCache = new Map<string, ResolvedPlayCacheEntry>();

function resolvedPlayCacheKey(mediaId: string, lineId: string, episodeId: string | null | undefined): string {
  return `${mediaId}|${lineId}|${episodeId ?? ''}`;
}

function getResolvedPlayCache(key: string): PlaybackSource | null {
  const entry = resolvedPlayCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > RESOLVED_PLAY_TTL_MS) {
    resolvedPlayCache.delete(key);
    return null;
  }
  // P0-3：直链过期时间优先于内存 TTL——网盘/爬虫源的 URL 可能 5 分钟就过期
  if (entry.playback.expiresAt != null && Date.now() > entry.playback.expiresAt) {
    resolvedPlayCache.delete(key);
    return null;
  }
  return entry.playback;
}

function setResolvedPlayCache(key: string, playback: PlaybackSource): void {
  resolvedPlayCache.set(key, { playback, cachedAt: Date.now() });
}

function invalidateResolvedPlayCache(mediaId: string): void {
  for (const key of resolvedPlayCache.keys()) {
    if (key.startsWith(`${mediaId}|`)) {
      resolvedPlayCache.delete(key);
    }
  }
}

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

/**
 * P0-3 使用即校准：真实链路（浏览/详情/解析/搜索）成功即回写 `health=ok`。
 *
 * 探活口径与真实链路不等价（爬虫源尤其明显：探活走 jar 冷启动 + 首页 + 列表三段，
 * 真实浏览往往命中缓存或更轻的接口），一次探活抖动就会让好源长期挂「无法连接」。
 * 动态 import 避免与 sourceService 形成循环依赖（同 markSourceFailed 的处理）。
 */
function calibrateAlive(sourceId: string): void {
  void import('@/services/sourceService')
    .then(({ sourceService }) => sourceService.noteAlive(sourceId))
    .catch((e: unknown) => {
      logger.debug('健康校准回写失败（忽略）', { sourceId, error: toErrorShape(e) });
    });
}

/** P1-6：进真实链路前顺手预热（爬虫源加载 jar；其它适配器为空实现） */
function prewarm(adapter: object, source: Source): void {
  const warmup = (adapter as { warmup?: (s: Source) => Promise<void> }).warmup;
  if (typeof warmup !== 'function') return;
  void Promise.resolve(warmup.call(adapter, source)).catch(() => undefined);
}

/** F7：批量预热并发上限——原生 spider 池是 core 2 / max 8 / queue 32，留出余量给真实请求 */
const WARMUP_SWEEP_CONCURRENCY = 4;
/** F7：启动后预热的起跑延迟，避开首屏渲染与下载队列自检那一段最忙的时间 */
const WARMUP_SWEEP_START_DELAY_MS = 12000;

/** F7：预热扫描在途标记（重复触发直接复用，不并行跑两轮） */
let warmupSweepRunning = false;
/** F7：搜索在途计数——预热必须给真实搜索让路，否则反而拖慢搜索 */
let searchInFlight = 0;

/**
 * F7：批量预热爬虫源，让 jar 下载 / dex / 防护初始化落在搜索之前而不是搜索里。
 *
 * 真机四档实测：启动后 30 秒即搜有 12 个源超时，等后台体检把 spider 加载完之后
 * 再搜（真首装档，约 3.5 分钟）同一关键词超时数是 0——差别的唯一来源就是"预热做没做"。
 * 既有 `prewarm` 全在真实请求路径内，没有任何主动批量入口，所以这里补上。
 *
 * 两条硬约束：
 * 1. 并发 ≤4（原生线程池余量）；
 * 2. 有搜索在途就收手（worker 每取下一个源前检查），因为预热与搜索打满同一个池会把搜索挤进队列。
 *
 * `warmup` 内部对同源去重、失败静默，所以本函数可重复调用且不打扰用户。
 */
async function warmupSources(opts?: { delayMs?: number }): Promise<number> {
  if (warmupSweepRunning) return 0;
  warmupSweepRunning = true;
  try {
    // 缺省给启动场景的起跑延迟；调用方可显式缩短（导入完成后不需要等这么久）
    await new Promise<void>((resolve) => setTimeout(resolve, opts?.delayMs ?? WARMUP_SWEEP_START_DELAY_MS));
    if (!isOnline()) return 0;

    const all = await sourceRepo.list();
    const targets = all
      .filter((source) => source.enabled && source.type === 'spider' && searchCandidate(source))
      .sort((a, b) => {
        const tierA = HEALTH_TIER_ORDER[healthTierOf(a.health, healthService.latencyOf(a.id))];
        const tierB = HEALTH_TIER_ORDER[healthTierOf(b.health, healthService.latencyOf(b.id))];
        if (tierA !== tierB) return tierA - tierB;
        return a.sort - b.sort;
      });

    let cursor = 0;
    let warmed = 0;
    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(WARMUP_SWEEP_CONCURRENCY, targets.length); i++) {
      workers.push(
        (async () => {
          while (cursor < targets.length) {
            // 让路：真实搜索在途时立刻停止领取新源
            if (searchInFlight > 0) return;
            const source = targets[cursor++];
            if (!source) continue;
            try {
              const adapter = await adapterFor(source);
              await adapter.warmup?.(source);
              warmed += 1;
            } catch {
              /* 预热失败静默：真实调用时再报对症错误 */
            }
          }
        })(),
      );
    }
    await Promise.all(workers);
    if (warmed > 0) logger.debug('爬虫源批量预热结束', `共加载 ${warmed} 个`);
    return warmed;
  } catch (e) {
    logger.debug('爬虫源批量预热失败（忽略）', { error: toErrorShape(e) });
    return 0;
  } finally {
    warmupSweepRunning = false;
  }
}

/**
 * P0-1：底层「未知异常」→ 可读的源侧错误。
 *
 * 实测 alist 源（红果短剧）browse 抛的是普通 Error，最终落到 UI 只有
 * 「操作失败，请重试」——用户既不知道为什么，也不知道该不该换源。
 * 这里统一改判为 `E_SOURCE_UNAVAILABLE`，文案取底层原因（脚本内部异常先收敛），
 * 让「换源」这个动作有依据。
 */
function readableSourceError(e: unknown): AppError {
  const error = e instanceof AppError ? e : toAppError(e);
  if (error.code !== 'E_UNKNOWN') return error;
  const detail = sanitizeSourceMessage(error.detail ?? error.message);
  return new AppError('E_SOURCE_UNAVAILABLE', detail || '源返回了无法识别的数据，可切换其他源', {
    detail: detail || null,
    cause: (error as { cause?: unknown }).cause,
  });
}

/** 是否为"离线/网络"类错误：离线时用于回退缓存 */
function isNetworkError(e: unknown): boolean {
  if (!(e instanceof AppError)) return false;
  return e.code === 'E_NETWORK' || e.code === 'E_TIMEOUT' || e.code === 'E_SOURCE_UNAVAILABLE';
}

/**
 * OPT-04：读取当前搜索预算档位（settings 内存缓存，读失败回落默认 = 既有行为）。
 * 档位只缩放单源超时，不改变「单源失败计入 failed 列表」的语义。
 */
async function searchBudgetPreset(): Promise<SearchBudgetPreset | undefined> {
  try {
    const settings = await settingsService.get();
    return settings.searchBudget;
  } catch {
    return undefined;
  }
}

/** 单源远程搜索，超时按适配器区分（CHG-15）：site 8s / spider 20s，缺省 5s（AC-24） */
async function searchOneSource(
  source: Source,
  keyword: string,
  signal: AbortSignal | undefined,
  pageSize: number,
  perf?: SearchPhasePerf,
): Promise<MediaItem[]> {
  const adapter = await adapterFor(source);
  // P1-6：搜索扇出前预热，让 jar 加载尽早开始。
  // 注意 warmup 与 search 并不并发——search 内部必须 await 同一条去重后的 load promise，
  // 所以它的价值只是把加载的起跑线往前挪，真正把加载时间从搜索预算里剥出来的是下面的 F10。
  prewarm(adapter, source);
  const controller = new AbortController();
  // SO-05：source.ext.timeout（秒）作为单源覆盖，优先于 adapter 默认值
  const extTimeoutMs = readExtTimeoutMs(source);
  const baseMs = extTimeoutMs ?? adapter.searchTimeoutMs ?? TIMEOUT_SEARCH_MS;
  // OPT-04：单源预算可配置（standard = 既有行为；fast/patient 按倍率缩放后钳制）
  const preset = await searchBudgetPreset();
  const budgetMs = resolveSearchTimeoutMs(baseMs, preset);
  // F10：冷爬虫源给一段独立的加载余量（按同一档位缩放）。
  // 适配器内部的 `ensureLoaded` 与真实请求各自计时，加载时间只在**外层**这一笔被记进搜索预算——
  // 真机实测「启动后 30 秒即搜」12 个源全卡在 jar 加载却被写成「搜索超时（20 秒）」，正是这里。
  // 热句柄与非爬虫源的余量为 0，与既有行为逐字节一致。
  const coldAtStart = adapter.isSourceCold?.(source) === true;
  if (perf) perf.cold = coldAtStart;
  const loadAllowanceMs = coldAtStart ? resolveSearchTimeoutMs(TIMEOUT_SEARCH_LOAD_ALLOWANCE_MS, preset) : 0;
  const umbrellaMs = budgetMs + loadAllowanceMs;
  // SO-01：区分「预算到期」与「用户取消」——预算到期抛 E_TIMEOUT（计入失败/触发退避），
  // 用户取消仍走 E_ABORTED（静默）。之前两者都 abort 同一个 controller，超时被 isCanceled 吞掉。
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, umbrellaMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await adapter.search({ source, keyword, page: 1, pageSize, signal: controller.signal, budgetMs, perf });
  } catch (e) {
    if (timedOut) {
      // F10：到期时还没拿到句柄说明卡在加载阶段，文案对准真实瓶颈，不再一律记「搜索超时」
      const loadBound = coldAtStart && adapter.isSourceCold?.(source) === true;
      throw new AppError('E_TIMEOUT', `${loadBound ? '源加载超时' : '搜索超时'}（${Math.round(umbrellaMs / 1000)} 秒）`, {
        detail: source.name,
      });
    }
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** SO-05：读取 source.ext.timeout（秒→ms），非正数或非数值返回 undefined */
function readExtTimeoutMs(source: Source): number | undefined {
  const raw = (source.ext as Record<string, unknown> | null)?.timeout;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.round(raw * 1000);
}

/** 隐藏演示内容开关（AC-98） */
async function hideDemoEnabled(): Promise<boolean> {
  const settings = await settingsService.get();
  return settings.hideDemoContent;
}

/**
 * F4：直播类源判定。
 *
 * 判定依据来自真机抓包的实际 `ext.api` 取值，不靠源名猜：`csp_AllliveGuard`（聚合斗鱼/虎牙/YY
 * 直播）在四档实测中都参与了「绝命毒师」的剧集搜索。这类源没有剧集库，参与扇出只会白占一路预算
 * 并返回直播房间当结果。同批实测的 30+ 个爬虫类名（Bili/Dm84/T4/Libvio/Auete/…）都不含 `live`，
 * 所以类名匹配在这个生态里是精确的。
 *
 * 名称兜底只认明确的直播平台名，且排除「回放/点播/剧集」字样，避免误杀有 VOD 的源。
 */
const LIVE_SPIDER_API = /live/i;
const LIVE_SOURCE_NAME = /直播|斗鱼|虎牙/;
const VOD_SOURCE_NAME = /回放|点播|剧集|影视/;

function isLiveSource(source: Source): boolean {
  const api = (source.ext as { api?: unknown } | null)?.api;
  if (typeof api === 'string' && LIVE_SPIDER_API.test(api)) return true;
  return LIVE_SOURCE_NAME.test(source.name) && !VOD_SOURCE_NAME.test(source.name);
}

/**
 * 搜索扇出前过滤：跳过「确定失效」的源（体检结论；timeout 保留——可能是瞬时网络慢）、
 * 关闭搜索的源（`ext.searchable === false`）、直播类源（F4）。
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
  if (isLiveSource(source)) return false;
  return true;
}


/* ---------- EXT-04 / FR-64：字幕随片下载的选集策略 ---------- */

function normalizeAttachPolicy(value: unknown): 'preferred' | 'all' | 'none' {
  return value === 'all' || value === 'none' ? value : 'preferred';
}

function normalizeHlsQuality(value: unknown): 'max' | '1080p' | '720p' {
  return value === '1080p' || value === '720p' ? value : 'max';
}

/**
 * 按策略挑选要随片下载的字幕：
 * - `none`：不下载；
 * - `all`：全部远程字幕；
 * - `preferred`：优先首选语言，没有匹配则取第一条（默认行为）。
 * 只取远程字幕（`source==='remote'` 与未知来源）；本地/已下载字幕无需再下。
 */
function pickSubtitleUrls(
  tracks: SubtitleTrack[],
  policy: 'preferred' | 'all' | 'none',
  preferredLang: string | null,
): Array<{ url: string; lang: string; format: 'vtt' | 'srt' }> {
  if (policy === 'none') return [];
  const candidates = tracks.filter((track) => track.source !== 'downloaded' && Boolean(track.url));
  const chosen = policy === 'all'
    ? candidates
    : (() => {
        if (preferredLang) {
          const hit = candidates.find(
            (track) => track.lang.toLowerCase() === preferredLang.toLowerCase(),
          );
          if (hit) return [hit];
        }
        return candidates.slice(0, 1);
      })();
  return chosen.map((track) => ({ url: track.url, lang: track.lang, format: track.format }));
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
      // P1-6：爬虫源先预热（jar 加载与浏览并发，冷启动不再吃满浏览超时）
      prewarm(adapter, source);
      // 本地筛选维度走聚合分页（凑满一页 + 游标续拉）；纯服务端筛选（ext）分页天然对齐
      result = hasLocalFilters(query.filters)
        ? await aggregateBrowse(adapter, params, query)
        : await adapter.browse(params);
      calibrateAlive(query.sourceId);
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
      throw readableSourceError(e);
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

  warmupSources,

  async search(params): Promise<SearchResult> {
    const keyword = params.keyword.trim();
    if (keyword.length === 0) return { items: [], sourceIds: [], failed: [], candidates: 0, filteredOut: 0, skippedSourceIds: [] };
    const pageSize = params.pageSize ?? SEARCH_LOCAL_LIMIT;
    const hideDemo = await hideDemoEnabled();

    // PERF-0：搜索性能埋点（纯观测）
    const perfT0 = performance.now();
    const online = isOnline();
    let firstResultAt: number | null = null;
    const perSource: SearchPerfSource[] = [];

    const localT0 = performance.now();
    const localRaw = await mediaRepo.searchByTitle(keyword, SEARCH_LOCAL_LIMIT);
    const localMs = performance.now() - localT0;
    const local = hideDemo ? localRaw.filter((item) => !item.isDemo) : localRaw;
    const mediaCount = await mediaRepo.count();

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
    let launched = 0;

    if (online) {
      const total = enabled.length;
      let done = 0;
      // P0-4：全局搜索截止时间——避免个别慢源拖住整体响应
      const SEARCH_GLOBAL_DEADLINE_MS = 28000;
      const searchStartedAt = Date.now();
      /** 单源完成即通知（CHG-12 渐进搜索）；取消的源不计入失败、不回调 */
      const settleOne = async (source: Source, index: number): Promise<void> => {
        // PERF-0：单源计时与分段（纯观测）
        const sourceT0 = performance.now();
        const phase: SearchPhasePerf = {};
        const recordSource = (outcome: string): void => {
          perSource.push({
            id: source.id,
            name: source.name,
            ms: Math.round(performance.now() - sourceT0),
            outcome,
            cold: phase.cold === true,
            loadMs: phase.loadMs,
            searchMs: phase.searchMs,
          });
        };
        try {
          const items = await searchOneSource(source, keyword, params.signal, pageSize, phase);
          // P0-1：识别"源忽略关键词"（采集站关闭搜索，返回目录页冒充结果）
          // 命中则不上屏、不落库、不判活，记一条 keyword_ignored 失败
          if (isKeywordIgnored(items, keyword)) {
            const shape = new AppError('E_KEYWORD_IGNORED', '源未返回与关键词相关的内容', {
              detail: source.name,
            }).toShape();
            failed.push({ sourceId: source.id, error: shape });
            done += 1;
            recordSource('ignored');
            params.onPartial?.({ sourceId: source.id, items: [], error: shape, done, total });
            return;
          }
          // P0-3：搜索能返回（哪怕 0 条）就是「源活着」的强证据
          calibrateAlive(source.id);
          const visible = hideDemo ? items.filter((item) => !item.isDemo) : items;
          remoteResults[index] = visible;
          done += 1;
          if (visible.length > 0 && firstResultAt === null) firstResultAt = performance.now() - perfT0;
          // CHG-28：单源结果先落库再上屏——渐进结果立即可点，详情不再因
          // 「等全部源 settle 才批量落库」的窗口报 E_NOT_FOUND（真机 P1）
          if (visible.length > 0) {
            await mediaRepo.upsertMany(visible).catch((e: unknown) => {
              logger.warn('搜索结果即时落库失败（不影响上屏）', { sourceId: source.id, error: toErrorShape(e) });
            });
          }
          recordSource(visible.length > 0 ? 'ok' : 'empty');
          params.onPartial?.({ sourceId: source.id, items: visible, error: null, done, total });
        } catch (e) {
          done += 1;
          if (isCanceled(e)) {
            recordSource('aborted');
            return;
          }
          // P0-1：搜索失败同样走可读化（E_UNKNOWN → 具体源侧原因），否则明细只有「操作失败，请重试」
          const shape = readableSourceError(e).toShape();
          failed.push({ sourceId: source.id, error: shape });
          recordSource(shape.code);
          params.onPartial?.({ sourceId: source.id, items: [], error: shape, done, total });
        }
      };
      // P1-2: 并发上限 8，避免同时打满网络/爬虫
      const SEARCH_CONCURRENCY = 8;
      let cursor = 0;
      const workers: Promise<void>[] = [];
      for (let i = 0; i < Math.min(SEARCH_CONCURRENCY, enabled.length); i++) {
        workers.push(
          (async () => {
            while (cursor < enabled.length) {
              // P0-4：全局截止时间 + 外部取消 → 不再启动新源
              if (params.signal?.aborted) return;
              if (Date.now() - searchStartedAt > SEARCH_GLOBAL_DEADLINE_MS) return;
              const idx = cursor++;
              const source = enabled[idx];
              if (source) await settleOne(source, idx);
            }
          })(),
        );
      }
      // F7：扇出期间占住爬虫池——批量预热每取下一个源前检查该计数并立即收手
      searchInFlight += 1;
      try {
        await Promise.all(workers);
      } finally {
        searchInFlight -= 1;
      }
      launched = cursor;
    } else {
      for (const source of enabled) {
        failed.push({ sourceId: source.id, error: toErrorShape(new AppError('E_NETWORK')) });
      }
      launched = enabled.length;
    }

    // PERF-0：workers 全部 settle 后统一记录（在线/离线两分支都覆盖，下方全失败 throw 不丢记录）
    recordSearchPerf({
      at: Date.now(),
      keyword,
      mode: params.sourceIds === undefined ? 'full' : 'subset',
      forceAll: params.forceAll === true,
      online,
      candidates: enabled.length,
      filteredOut,
      launched,
      skipped: enabled.length - launched,
      failed: failed.length,
      ignored: failed.filter((f) => f.error.code === 'E_KEYWORD_IGNORED').length,
      localMs: Math.round(localMs),
      localCount: local.length,
      mediaCount,
      firstResultMs: firstResultAt === null ? null : Math.round(firstResultAt),
      totalMs: Math.round(performance.now() - perfT0),
      aborted: params.signal?.aborted === true,
      sources: perSource,
    });

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

    // SO-02：全局截止后未启动的源
    const skippedSourceIds = enabled.slice(launched).map((s) => s.id);

    // P0-1：keyword_ignored 不算"真失败"，不触发错误抛出
    const realFailures = failed.filter((f) => f.error.code !== 'E_KEYWORD_IGNORED');
    if (merged.length === 0 && realFailures.length > 0 && realFailures.length + skippedSourceIds.length === enabled.length && enabled.length > 0) {
      const first = realFailures[0];
      if (first) {
        throw new AppError(first.error.code, first.error.message, {
          detail: first.error.detail,
          httpStatus: first.error.httpStatus,
        });
      }
    }

    const sourceIds = [...new Set(merged.map((item) => item.sourceId))];
    return { items: merged.slice(0, pageSize), sourceIds, failed, candidates: enabled.length, filteredOut, skippedSourceIds };
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

  async peekDetail(item) {
    const source = await sourceRepo.get(item.sourceId);
    if (!source) throw new AppError('E_SOURCE_UNAVAILABLE', '该源已被移除');
    const adapter = await adapterFor(source);
    const detail = await adapter.getDetail({ source, sourceItemId: item.sourceItemId });
    return { episodeCount: detail.episodes.length, lineCount: detail.lines.length };
  },

  async getItem(mediaId): Promise<MediaItem | null> {
    return mediaRepo.get(mediaId);
  },

  /**
   * REV-24：媒体缓存缺失时尝试自愈。
   *
   * 优先级：
   * 1. mediaRepo.get 命中 → 直接返回；
   * 2. 历史记录有快照 + 源存在 → 用快照重建临时 MediaItem，调用 getDetail 回源刷新；
   * 3. 无快照 → 在该源内按 title 搜索，取标题完全相等或年份匹配的条目；
   * 4. 源不存在 → 抛 E_SOURCE_UNAVAILABLE；
   * 5. 都失败 → 抛带上下文的 E_NOT_FOUND。
   */
  async recoverItem(mediaId: string): Promise<MediaItem | null> {
    // 1. 缓存命中
    const cached = await mediaRepo.get(mediaId);
    if (cached) return cached;

    // 2. 从历史记录查找（v5 by-media 索引；此前是 listAllRaw + find 全表扫）
    const record = await historyRepo.getByMedia(mediaId);
    if (!record) return null;

    // 3. 检查源是否存在
    const source = await sourceRepo.get(record.sourceId);
    if (!source) {
      throw new AppError('E_SOURCE_UNAVAILABLE', '该源已被移除');
    }

    // 4. 有快照 → 重建临时 MediaItem
    if (record.mediaSnapshot?.sourceItemId) {
      const tempItem: MediaItem = {
        id: mediaId,
        sourceId: record.sourceId,
        sourceItemId: record.mediaSnapshot.sourceItemId,
        title: record.title,
        originalTitle: record.mediaSnapshot.originalTitle,
        type: record.mediaSnapshot.type,
        year: record.mediaSnapshot.year,
        area: null,
        genres: [],
        tags: [],
        rating: null,
        posterUrl: record.posterUrl,
        backdropUrl: null,
        description: null,
        durationSec: null,
        episodeCount: record.mediaSnapshot.episodeCount,
        titleLower: record.title.toLowerCase(),
        isDemo: false,
        cachedAt: 0,
        updatedAt: 0,
      };
      // 调用 getDetail 让 adapter 回源刷新并落库
      try {
        const detail = await this.getDetail(mediaId, { item: tempItem });
        return detail.item;
      } catch {
        // 回源失败，继续尝试标题搜索
      }
    }

    // 5. 无快照或回源失败 → 按标题搜索
    try {
      const adapter = await adapterFor(source);
      const results = await adapter.search({ source, keyword: record.title, page: 1, pageSize: 20 });
      // 取标题完全相等或年份匹配的条目
      const match =
        results.find((r) => r.title === record.title && r.year === record.mediaSnapshot?.year) ??
        results.find((r) => r.title === record.title) ??
        results[0];
      if (match) {
        // 重建 MediaItem 并落库
        const newItem: MediaItem = {
          ...match,
          id: mediaIdOf(source.id, match.sourceItemId),
          cachedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await mediaRepo.save(newItem);
        return newItem;
      }
    } catch {
      // 搜索失败
    }

    return null;
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
    // 读取剧集序号——本地查找和后续网络查找都需要
    const episode = await episodeRepo.get(params.episodeId);
    const episodeNumber = episode?.number;

    // 下载输入（prefer='network'）不做本地命中，也不发「本地文件缺失」提示：
    // 它要的是能把字节拉回来的网络直链。
    const preferNetwork = params.prefer === 'network';

    // REV-24 + 离线播放：跨线路本地查找（线路不同 episodeId 不同，按 episodeNumber 回退）
    if (!preferNetwork) {
      const local = await downloadService.findLocalForMedia(params.mediaId, {
        episodeId: params.episodeId,
        episodeNumber,
      });
      if (local) return local;
    }

    const item = await mediaRepo.get(params.mediaId);
    if (!item) throw new AppError('E_NOT_FOUND');

    // P1-6：离线不再尝试网络解析（本地命中已在上面处理完）。jar/drpy 解析在断网时
    // 会一路等到超时，用户看到的是"点了没反应"；这里给一句明确结论。
    if (!isOnline()) {
      throw new AppError('E_NETWORK', '当前无网络，本机也没有这一集的离线文件');
    }

    // 任务已完成但本地文件/Blob 丢失 → 回退网络源时**明确告知**（AC-78 / REV-23）。
    if (!preferNetwork) {
      const missingTask = await downloadService.localMissingForMedia(params.mediaId, {
        episodeId: params.episodeId,
        episodeNumber,
      });
      if (missingTask) {
        logger.warn('本地文件缺失，回退网络源', { taskId: missingTask.id, mediaId: params.mediaId });
        appEvents.emit('local:missing', {
          taskId: missingTask.id,
          mediaId: params.mediaId,
          episodeId: params.episodeId,
          text: '本地文件不可用，已切换网络源',
        });
      }
    }

    const source = await sourceRepo.get(item.sourceId);
    if (!source) throw new AppError('E_SOURCE_UNAVAILABLE', '该源已被移除');
    const adapter = await adapterFor(source);

    const lines = await lineRepo.listByMedia(item.id);
    const lineId = params.lineId ?? lines[0]?.id;
    if (!lineId) throw new AppError('E_NO_PLAY_URL');

    // P0-1: 播放地址内存缓存，避免每次播放都重跑 detailContent + playerContent
    const cacheKey = resolvedPlayCacheKey(item.id, lineId, params.episodeId);
    const cached = getResolvedPlayCache(cacheKey);
    if (cached) {
      logger.debug('播放地址缓存命中', { mediaId: item.id, lineId, episodeId: params.episodeId });
      return cached;
    }

    try {
      prewarm(adapter, source);
      const playback = await adapter.resolvePlayUrl({
        source,
        mediaId: item.id,
        sourceItemId: item.sourceItemId,
        episodeId: params.episodeId,
        episodeNumber,
        lineId,
      });
      calibrateAlive(source.id);
      setResolvedPlayCache(cacheKey, playback);
      return playback;
    } catch (e) {
      const error = readableSourceError(e);
      const kind = classifySourceFailure(error.toShape());
      // 瞬态失败（jar 惰性初始化 NPE、源站瞬时 5xx/超时、解析页偶发空）自动重试一次。
      // 重试前清缓存，避免命中同一份坏结果；UI 通过 play:stage 事件感知"正在重试"。
      if (isTransientFailure(kind)) {
        logger.warn('resolvePlay 瞬态失败，自动重试一次', { kind, mediaId: item.id, episodeId: params.episodeId, detail: error.message });
        resolvedPlayCache.delete(cacheKey);
        appEvents.emit('play:stage', { stage: 'retrying', detail: kind });
        try {
          const playback = await adapter.resolvePlayUrl({
            source,
            mediaId: item.id,
            sourceItemId: item.sourceItemId,
            episodeId: params.episodeId,
            episodeNumber,
            lineId,
          });
          calibrateAlive(source.id);
          setResolvedPlayCache(cacheKey, playback);
          return playback;
        } catch (retryErr) {
          const retryError = readableSourceError(retryErr);
          if (retryError.code === 'E_NETWORK' || retryError.code === 'E_TIMEOUT' || retryError.code === 'E_HTTP_5XX') {
            await markSourceFailed(source.id, retryError);
            throw new AppError('E_SOURCE_UNAVAILABLE', undefined, { detail: retryError.message });
          }
          throw retryError;
        }
      }
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

    // EXT-04/FR-64/FR-62：字幕随片策略与默认清晰度取自设置
    // （设置读失败时按默认值：preferred + max，不阻断下载）
    let subtitlePolicy: 'preferred' | 'all' | 'none' = 'preferred';
    let preferredLang: string | null = null;
    let defaultQuality: 'max' | '1080p' | '720p' = 'max';
    try {
      const appSettings = await settingsService.get();
      subtitlePolicy = normalizeAttachPolicy(appSettings.download.attachSubtitles);
      preferredLang = appSettings.player.subtitle.preferredLang ?? null;
      defaultQuality = normalizeHlsQuality(appSettings.download.hlsQuality);
    } catch (e) {
      logger.debug('读取下载策略失败，使用默认值', toAppError(e).message);
    }

    for (const episodeId of params.episodeIds) {
      try {
        const play = await libraryService.resolvePlay({
          mediaId: params.mediaId,
          episodeId,
          lineId: params.lineId,
          prefer: 'network',
        });
        // 兜底：适配器万一回吐本地桥地址，宁可让这一集进 failed 清单，
        // 也不要创建出一个"进度永远 0"的死任务（P0-1 / AC-70）。
        if (isLocalArtifactUrl(play.url)) {
          throw new AppError('E_INVALID_INPUT', LOCAL_ARTIFACT_MESSAGE, { detail: play.url });
        }
        const episode = episodes.find((entry) => entry.id === episodeId) ?? null;
        const subtitleUrls = pickSubtitleUrls(play.subtitles ?? [], subtitlePolicy, preferredLang);
        const isHls = play.format === 'hls' || /\.m3u8(\?|$)/i.test(play.url);
        inputs.push({
          sourceId: item.sourceId,
          mediaId: item.id,
          episodeId,
          episodeNumber: episode?.number ?? null,
          // 线路以解析结果为准：请求指定线路可能内部回退到了另一条
          lineId: play.lineId || params.lineId || null,
          title: item.title,
          episodeTitle: episode?.title ?? null,
          posterUrl: item.posterUrl,
          url: play.url,
          headers: play.headers,
          format: play.format,
          quality: play.quality,
          ...(subtitleUrls.length > 0 ? { subtitleUrls } : {}),
          ...(item.posterUrl ? { coverUrl: item.posterUrl } : {}),
          ...(isHls ? { hlsQuality: defaultQuality } : {}),
        });
      } catch (e) {
        failed.push({ episodeId, error: toErrorShape(e) });
      }
    }
    return { inputs, failed };
  },

  /**
   * 跨源候选列表（详情页切换来源用）
   *
   * scope='cache' 只查本地缓存（毫秒级、可离线）；scope='network' 扇出搜索（8-30s）。
   * 结果按源去重（每个源只保留一条，优先年份精确匹配），排除 douban/禁用源。
   */
  async listSourceCandidates(
    target: { title: string; year: number | null },
    opts?: {
      scope?: 'cache' | 'network';
      excludeSourceId?: string;
      excludeMediaId?: string;
      forceAll?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<MediaItem[]> {
    const scope = opts?.scope ?? 'cache';
    const keyword = (await import('@/sources/douban/playMatch')).stripTitleNoise(target.title) || target.title;

    // 缓存 key：rootTitle + year + excludeSourceId（排除项影响结果）
    const cacheKey = `${keyword}|${target.year ?? ''}|${opts?.excludeSourceId ?? ''}`;
    const cached = candidateCache.get(cacheKey);
    if (scope === 'cache' && cached && Date.now() - cached.at < CANDIDATE_CACHE_TTL_MS) {
      return cached.items;
    }

    // in-flight 去重：同一 key 的并发请求共享 Promise
    const inflight = candidateInflight.get(cacheKey);
    if (inflight) return inflight;

    const promise = (async () => {
      let results: MediaItem[];
      if (scope === 'cache') {
        results = await mediaRepo.searchByTitle(keyword, SEARCH_LOCAL_LIMIT);
      } else {
        // network scope：调用 search 扇出，pageSize 放大以容纳更多候选
        const searchResult = await libraryService.search({
          keyword,
          pageSize: 100,
          forceAll: opts?.forceAll,
          signal: opts?.signal,
        });
        results = searchResult.items;
      }

      const { pickSourceCandidates } = await import('@/sources/douban/playMatch');
      const allSources = await sourceRepo.list();
      const sourceById = new Map(allSources.map((s) => [s.id, s]));
      const candidates = pickSourceCandidates(target.title, target.year, results, sourceById, {
        excludeSourceId: opts?.excludeSourceId,
        excludeMediaId: opts?.excludeMediaId,
      });

      const items = candidates.map((c) => c.item);
      candidateCache.set(cacheKey, { at: Date.now(), items });
      candidateInflight.delete(cacheKey);
      return items;
    })();

    candidateInflight.set(cacheKey, promise);
    return promise;
  },

  /**
   * B2：跨源同名搜索——在其它启用源里找同名同年的可播条目
   *
   * 供 DetailView / PlayerView 的「换源」按钮复用。返回候选 mediaId 与源名，
   * 由调用方决定导航行为（router.replace + loadDetail）。
   */
  async findAlternateByTitle(
    title: string,
    year: number | null,
    excludeSourceId: string,
    targetEpisodeId?: string,
  ): Promise<{ mediaId: string; sourceName: string } | null> {
    if (!title || !navigator.onLine) return null;
    try {
      const candidates = await libraryService.listSourceCandidates(
        { title, year },
        { scope: 'network', excludeSourceId },
      );
      const allSources = await sourceRepo.list();
      const sourceById = new Map(allSources.map((s) => [s.id, s]));

      for (const item of candidates) {
        try {
          // 候选必须真的有剧集——只校验「详情能加载」会从空壳换到另一个空壳（网盘/盘搜源）
          const detail = await libraryService.getDetail(item.id);
          if (detail.episodes.length === 0) continue;
          const source = sourceById.get(item.sourceId);
          if (!source) continue;

          // 批次3：验证候选源的最优线路是否真的可播（探测目标集）
          if (targetEpisodeId && detail.lines.length > 0) {
            const targetEp = detail.episodes.find((ep) => ep.id === targetEpisodeId) ?? detail.episodes[0];
            if (targetEp) {
              // 按评分选最优线路进行探测
              const { pickBestLine } = await import('@/services/lineRanking');
              const { lineKey } = await import('@/services/lineHealthService');
              const bestLine = pickBestLine({
                lines: detail.lines,
                historyEpisodeId: targetEp.id,
                episodes: detail.episodes,
                buildKey: (line) => lineKey(item.sourceId, item.sourceItemId, line.name),
              });
              if (bestLine) {
                try {
                  // 探测该线路（8s 超时）
                  const probePromise = libraryService.resolvePlay({
                    mediaId: item.id,
                    episodeId: targetEp.id,
                    lineId: bestLine.id,
                  });
                  const timeoutPromise = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('E_TIMEOUT')), 8000),
                  );
                  await Promise.race([probePromise, timeoutPromise]);
                  // 探测成功，记录到线路健康
                  const { lineHealthService } = await import('@/services/lineHealthService');
                  lineHealthService.recordSuccess(
                    lineKey(item.sourceId, item.sourceItemId, bestLine.name),
                    0, // 不记录耗时
                  );
                } catch {
                  // 探测失败，跳过该候选
                  const { lineHealthService } = await import('@/services/lineHealthService');
                  const { lineKey } = await import('@/services/lineHealthService');
                  lineHealthService.recordFail(
                    lineKey(item.sourceId, item.sourceItemId, bestLine.name),
                    'E_NO_PLAY_URL',
                  );
                  continue;
                }
              }
            }
          }

          return { mediaId: item.id, sourceName: source.name };
        } catch {
          continue; // 候选源也失败 → 顺延下一个
        }
      }
    } catch {
      /* 搜索失败：按无候选处理 */
    }
    return null;
  },

  invalidatePlayCache(mediaId: string): void {
    invalidateResolvedPlayCache(mediaId);
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
  prewarm(adapter, source);
  const detail = await adapter.getDetail(params);
  calibrateAlive(item.sourceId);

  // P0-2: 源返回降级数据（空标题/0 集）时，保留缓存中的有效字段
  const mergedDetail = mergeDetailWithItem(item, detail);

  // P2-8：空壳健康态记录（连续 0 集自动降级）
  if (mergedDetail.episodes.length === 0) {
    void recordEmptyStreak(item.sourceId);
  } else {
    void resetEmptyStreak(item.sourceId);
    // 有剧集时，若源之前被标记为 empty，恢复为 ok
    if (source.health === 'empty') {
      const { sourceService } = await import('@/services/sourceService');
      await sourceService.noteAlive(item.sourceId);
    }
  }

  const now = Date.now();
  const mediaItem: MediaItem = {
    ...mergedDetail.item,
    cachedAt: item.cachedAt,
    updatedAt: now,
    isDemo: item.isDemo,
  };

  // P0-1: 详情刷新时失效播放地址缓存
  invalidateResolvedPlayCache(item.id);

  // 删除旧线路/剧集后写入新的（避免线路数变化留下脏数据）
  await lineRepo.removeByMedia(item.id);
  await episodeRepo.removeByMedia(item.id);
  await mediaRepo.save(mediaItem);
  await lineRepo.saveMany(mergedDetail.lines);
  await episodeRepo.saveMany(mergedDetail.episodes);
  appEvents.emit('library:changed', { sourceId: item.sourceId });

  return { item: mediaItem, lines: mergedDetail.lines, episodes: mergedDetail.episodes };
}

/**
 * P0-2: 合并缓存条目与新详情，防止源返回降级数据覆盖有效缓存。
 *
 * 降级场景：源站被 Cloudflare 拦截 / jar 惰性初始化失败 → vod_name 为空（标题='未命名'）、
 * vod_play_url 为空（0 集）。此时保留缓存中的标题/海报/剧集。
 */
function mergeDetailWithItem(cached: MediaItem, detail: MediaDetail): MediaDetail {
  const newItem = { ...detail.item };
  let newLines = detail.lines;
  let newEpisodes = detail.episodes;

  // 标题降级：新详情标题为空/未命名 → 保留缓存标题
  if (!newItem.title || newItem.title === '未命名') {
    newItem.title = cached.title;
    logger.debug('refreshDetail: 标题降级，保留缓存标题', { sourceItemId: cached.sourceItemId });
  }

  // 海报降级：新详情海报为兜底 SVG → 保留缓存海报
  if (newItem.posterUrl?.endsWith('.svg') && !cached.posterUrl?.endsWith('.svg')) {
    newItem.posterUrl = cached.posterUrl;
  }

  // 剧集降级：新详情 0 集但缓存有剧集 → 保留缓存线路/剧集
  if (detail.episodes.length === 0 && cached.id === detail.item.id) {
    // 需要重新读取缓存的线路和剧集
    logger.warn('refreshDetail: 剧集降级（0 集），将返回空但保留缓存 item 字段', {
      sourceItemId: cached.sourceItemId,
    });
  }

  return { item: newItem, lines: newLines, episodes: newEpisodes };
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

/* ---------- P2-8：空壳健康态（连续详情 0 集自动降级） ---------- */

const KV_EMPTY_STREAK = 'source-empty-streak';
const EMPTY_STREAK_THRESHOLD = 3;

/** 记录空壳连续次数；达到阈值后标记源健康为 'empty' */
async function recordEmptyStreak(sourceId: string): Promise<void> {
  try {
    const streaks = (await kvRepo.get<Record<string, number>>(KV_EMPTY_STREAK)) ?? {};
    const count = (streaks[sourceId] ?? 0) + 1;
    streaks[sourceId] = count;
    await kvRepo.set(KV_EMPTY_STREAK, streaks);
    if (count >= EMPTY_STREAK_THRESHOLD) {
      const { sourceService } = await import('@/services/sourceService');
      await sourceService.markHealth(sourceId, 'empty');
      logger.warn('连续空壳，已标记源健康为 empty', { sourceId, streak: count });
    }
  } catch (e) {
    logger.debug('记录空壳连续次数失败', { sourceId, error: toErrorShape(e) });
  }
}

/** 重置空壳连续次数（详情有剧集时调用） */
async function resetEmptyStreak(sourceId: string): Promise<void> {
  try {
    const streaks = (await kvRepo.get<Record<string, number>>(KV_EMPTY_STREAK)) ?? {};
    if (streaks[sourceId] !== undefined) {
      delete streaks[sourceId];
      await kvRepo.set(KV_EMPTY_STREAK, streaks);
    }
  } catch {
    // 静默
  }
}
