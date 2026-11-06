/**
 * 跨源剧集统一映射服务（EXT-03）
 *
 * 背景（承接 FIX-05）：FIX-05 解决的是「豆瓣选第 N 集却播第 1 集」——
 * 把「片名 + 年份 + 集数」映射到**单个**目标源的线路/剧集。但它有两条硬限制：
 * 1. 豆瓣详情里只有一条「正片」占位，用户看不到别的源到底有多少集；
 * 2. 映射结果只按候选顺序取第一个命中，前一个源挂了才顺延，没有「同一集在多个源里都有」的概念。
 *
 * EXT-03 把口径统一到「一集 → 一组可播候选」：
 * - **聚合**：按片名（`TitleNormalizer`）在已启用的可播源（`site` / `spider`）里找同一条目，
 *   取详情后按集号去重合并，得到「第 1..N 集」，每集标注可用的源列表；
 * - **选源**：每个源先按健康档位（`healthTierOf`）→ 探测延迟排序，
 *   播放时首个失败顺延下一个（降级链由调用方按 `candidates` 顺序执行）；
 * - **缓存**：聚合结果内存 LRU（默认 50 部 / 5 分钟），同一作品多次播放只聚合一次。
 *
 * 边界（有意为之）：
 * - 豆瓣源不参与聚合。豆瓣本身没有剧集清单，且 `DoubanAdapter.getDetail()` 会反过来调用本服务，
 *   把豆瓣纳入聚合会形成递归；豆瓣条目的「统一剧集列表」由调用方用它自己的占位合并（见 `DoubanAdapter`）。
 * - 本服务只做「展示 + 选源」，不改 `MediaDetail` / `PlaybackSource` 契约字段；
 *   播放仍由调用方把 `lineId` / `episodeId` 交给目标适配器解析。
 * - 依赖全部注入（`UnifiedEpisodeDeps`），默认实现用 `sourceRegistry` / `sourceService` /
 *   `healthService`，且都在**调用时**动态加载，避免适配器 ↔ 服务在模块求值阶段形成环。
 */
import { TIMEOUT_SEARCH_MS } from '@/shared/constants';
import { isCanceled, toAppError } from '@/shared/errors';
import { HEALTH_TIER_ORDER, healthTierOf, type HealthTier } from '@/shared/healthTier';
import { logger } from '@/shared/logger';
import { resolveSearchTimeoutMs } from '@/shared/searchBudget';
import { selectEpisodeInDetail, type EpisodeMappingTarget } from '@/sources/mapping/EpisodeMappingService';
import { titleMatches, titleMatchScore } from '@/sources/mapping/TitleNormalizer';
import type {
  GetDetailParams,
  MediaDetail,
  MediaItem,
  SearchParams,
  Source,
  SourceHealth,
} from '@/types';

/* =========================================================
 * 一、公共类型
 * =======================================================*/

/**
 * 单源「片名 + 集数」直查结果。
 *
 * 与 FIX-05 的映射命中同构（`EpisodeMappingTarget` 已含 `source` / `item` / `line` / `episode`
 * 与可直接交给适配器的 `lineId` / `episodeId`），因此这里只做别名，不重复定义字段。
 * `SiteAdapter` / `SpiderAdapter` 的 `findEpisodeByTitle()` 返回此形状。
 */
export type EpisodeLookupMatch = EpisodeMappingTarget;

/** 源质量输入：健康状态 + 最近一次探测延迟 */
export interface SourceQuality {
  health: SourceHealth;
  latencyMs: number | null;
}

/** 聚合依赖（全部可注入，便于纯逻辑单测） */
export interface UnifiedEpisodeDeps {
  /** 已配置的源（未启用 / 非可播源由本服务过滤） */
  listSources(): Promise<Source[]>;
  /** 单源搜索（适配器自身负责请求与解析） */
  search(params: SearchParams): Promise<MediaItem[]>;
  /** 取源详情（线路 + 剧集） */
  getDetail(params: GetDetailParams): Promise<MediaDetail>;
  /** 源质量（健康 + 延迟）；默认读 `healthService` 的内存快照 */
  qualityOf(sourceId: string): Promise<SourceQuality>;
  /**
   * 单源「片名 + 集数」直查（适配器的 `findEpisodeByTitle`）。
   * 缺省表示当前装配不支持直查——聚合未命中时不会再尝试降级查询。
   */
  findEpisodeByTitle?(input: {
    source: Source;
    title: string;
    episodeIndex: number;
    year: number | null;
    signal?: AbortSignal;
  }): Promise<EpisodeLookupMatch | null>;
  /** 单源请求预算（ms）；缺省 5s */
  budgetOf?(source: Source): Promise<number>;
  /** 时钟（测试注入） */
  now(): number;
}

/** 未参与聚合 / 未命中这一集的原因 */
export type UnifiedEpisodeMissReason =
  | 'title_mismatch'
  | 'year_mismatch'
  | 'no_result'
  | 'no_episodes'
  | 'detail_failed'
  | 'detail_unavailable'
  | 'timeout'
  | 'source_error';

/** 未命中原因 → 可读短语（排查用，不直接作为用户主文案） */
export function unifiedMissText(reason: UnifiedEpisodeMissReason): string {
  switch (reason) {
    case 'title_mismatch':
      return '片名不匹配';
    case 'year_mismatch':
      return '年份不一致';
    case 'no_result':
      return '该源搜不到这部作品';
    case 'no_episodes':
      return '该源没有剧集清单';
    case 'detail_failed':
      return '详情读取失败';
    case 'detail_unavailable':
      return '不支持剧集查询';
    case 'timeout':
      return '请求超时';
    case 'source_error':
      return '源请求失败';
  }
}

/** 未参与的源（用于错误明细与日志） */
export interface UnifiedEpisodeMiss {
  source: Source;
  reason: UnifiedEpisodeMissReason;
  /** 附加线索（如候选标题、错误 message） */
  detail: string | null;
}

/** 参与聚合的源摘要 */
export interface UnifiedEpisodeSourceSummary {
  source: Source;
  /** 该源命中的条目（可用于核对是否串片） */
  item: MediaItem;
  /** 该源提供的集数 */
  episodeCount: number;
  tier: HealthTier;
  latencyMs: number | null;
}

/** 某一集在某个源里的落点（含源标识，可直接构造 `ResolvePlayParams`） */
export interface UnifiedEpisodeSourceRef extends EpisodeMappingTarget {
  /** 源质量档位（决定候选顺序） */
  tier: HealthTier;
  /** 最近一次探测延迟（ms） */
  latencyMs: number | null;
}

/** 统一剧集：一集 + 可播它的全部源（按质量排序，首个为首选） */
export interface UnifiedEpisode {
  /** 集号（1 起） */
  number: number;
  /** 展示标题（取首选源的剧集标题） */
  title: string;
  /** 可用源列表（不可为空） */
  sources: UnifiedEpisodeSourceRef[];
}

/** 聚合结果 */
export interface UnifiedEpisodeAggregate {
  /** 作品 id（调用方给的作品标识；仅按片名聚合时为空串） */
  mediaId: string;
  title: string;
  year: number | null;
  /** 按集号升序 */
  episodes: UnifiedEpisode[];
  /** 参与聚合的源 */
  sources: UnifiedEpisodeSourceSummary[];
  /** 未参与 / 未命中的源 */
  misses: UnifiedEpisodeMiss[];
  /** 是否命中缓存 */
  cached: boolean;
  /** 聚合完成时间 */
  aggregatedAt: number;
}

/** 跨源查找结果：某一集的降级链 */
export interface UnifiedEpisodeHit {
  number: number;
  title: string;
  /** 按「健康档位 → 延迟 → 源顺序」排好，播放时逐个尝试 */
  candidates: UnifiedEpisodeSourceRef[];
}

/** 已知候选（跳过搜索，直接取详情）——播放链路已通过 playMatch 得到候选时用 */
export interface UnifiedEpisodeCandidate {
  source: Source;
  item: MediaItem;
}

/** 单次调用参数 */
export interface UnifiedEpisodeCallOptions {
  /** 目标年份；任一缺失则跳过校验 */
  year?: number | null;
  signal?: AbortSignal;
  /** 忽略聚合缓存重新聚合 */
  force?: boolean;
  /** 已知候选（给了就不再搜索/列源，只取这些候选的详情） */
  candidates?: readonly UnifiedEpisodeCandidate[];
  /** 限定参与的源 id */
  sourceIds?: readonly string[];
  /** 每个源最多比对几条搜索结果（默认 2） */
  detailLimit?: number;
  /** 最多参与聚合的源数（默认 6） */
  maxSources?: number;
  /** `findBestEpisode` 聚合未命中时是否用适配器直查兜底（默认 true；传 candidates 时不生效） */
  fallbackLookup?: boolean;
  /**
   * 替换默认详情实现（默认走 `deps.getDetail`）。
   *
   * 调用方（如豆瓣适配器）需要复用自身的适配器取数通道时注入，避免二次解析注册表。
   */
  detailOf?: (input: {
    source: Source;
    sourceItemId: string;
    signal?: AbortSignal;
  }) => Promise<MediaDetail>;
}

/** `findBestEpisode` 额外需要作品 id（缓存键） */
export interface UnifiedEpisodeLookupOptions extends UnifiedEpisodeCallOptions {
  mediaId?: string;
}

/** 服务构造参数 */
export interface UnifiedEpisodeServiceOptions {
  /** 聚合缓存有效期（ms），默认 5 分钟 */
  ttlMs?: number;
  /** 聚合缓存条数上限（作品数），默认 50 */
  maxEntries?: number;
  /** 时钟（测试注入） */
  now?: () => number;
}

export interface UnifiedEpisodeStats {
  /** 缓存中的作品数 */
  entries: number;
  /** 正在聚合的作品数 */
  inFlight: number;
  /** 聚合缓存命中次数 */
  cacheHits: number;
  /** 实际执行的聚合次数 */
  aggregations: number;
  /** 实际发出的单源搜索次数 */
  sourceSearches: number;
  /** 实际发出的详情请求次数 */
  detailFetches: number;
}

/* =========================================================
 * 二、常量
 * =======================================================*/

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_SOURCES = 6;
const DEFAULT_DETAIL_LIMIT = 2;
/** 聚合失败后最多对几个源做「片名 + 集数」直查兜底 */
const DEFAULT_LOOKUP_LIMIT = 3;
/** 单个源一次搜索取回的候选上限（用于详情比对） */
const SEARCH_PAGE_SIZE_MIN = 6;

/* =========================================================
 * 三、工具
 * =======================================================*/

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** 质量比较：档位 → 延迟（null 视为最大），相等返回 0 以保留调用方给定的顺序 */
function compareQuality(a: SourceQuality, b: SourceQuality): number {
  const tierA = healthTierOf(a.health, a.latencyMs);
  const tierB = healthTierOf(b.health, b.latencyMs);
  if (tierA !== tierB) return HEALTH_TIER_ORDER[tierA] - HEALTH_TIER_ORDER[tierB];
  const latencyA = a.latencyMs === null || !Number.isFinite(a.latencyMs) ? Number.POSITIVE_INFINITY : a.latencyMs;
  const latencyB = b.latencyMs === null || !Number.isFinite(b.latencyMs) ? Number.POSITIVE_INFINITY : b.latencyMs;
  if (latencyA !== latencyB) return latencyA - latencyB;
  return 0;
}

/** 详情类错误 → 未命中原因（不支持查询与真实故障区分开） */
function detailMissReason(error: unknown): UnifiedEpisodeMissReason {
  const appError = toAppError(error, 'E_SOURCE_UNAVAILABLE');
  return appError.code === 'E_NOT_IMPLEMENTED' ||
    appError.code === 'E_UNSUPPORTED_FORMAT' ||
    appError.code === 'E_SOURCE_DISABLED'
    ? 'detail_unavailable'
    : 'detail_failed';
}

/**
 * 搜索结果 → 候选（片名归一匹配 → 年份校验 → 相似度降序）。
 * 复用 `TitleNormalizer`，口径与 FIX-05 的候选筛选一致。
 */
function rankItems(
  items: readonly MediaItem[],
  title: string,
  year: number | null,
): { items: MediaItem[]; miss: UnifiedEpisodeMissReason | null } {
  if (items.length === 0) return { items: [], miss: 'no_result' };
  const matched = items.filter((item) => titleMatches(title, item.title));
  if (matched.length === 0) return { items: [], miss: 'title_mismatch' };
  const sameYear = matched.filter((item) => year === null || item.year === null || item.year === year);
  if (sameYear.length === 0) return { items: [], miss: 'year_mismatch' };
  const ranked = sameYear
    .map((item) => ({ item, score: titleMatchScore(title, item.title) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
  return { items: ranked, miss: null };
}

/** 适配器是否支持「片名 + 集数」直查（`SourceAdapter` 契约里没有这个方法，运行时探测） */
interface EpisodeLookupAdapter {
  findEpisodeByTitle(
    title: string,
    episodeIndex: number,
    ctx: { source: Source; year?: number | null; signal?: AbortSignal; limit?: number },
  ): Promise<EpisodeLookupMatch | null>;
}

/** 运行时探测适配器是否实现 `findEpisodeByTitle` */
export function asEpisodeLookup(adapter: unknown): EpisodeLookupAdapter | null {
  if (adapter === null || typeof adapter !== 'object') return null;
  const candidate = adapter as Partial<EpisodeLookupAdapter>;
  return typeof candidate.findEpisodeByTitle === 'function' ? (candidate as EpisodeLookupAdapter) : null;
}

type Guarded<T> =
  | { ok: true; value: T }
  | { ok: false; timedOut: boolean; error: unknown; message: string };

interface PlannedSource {
  source: Source;
  /** 已知候选条目（给了就不搜索） */
  itemHint: MediaItem | null;
  quality: SourceQuality;
}

type Contribution =
  | { ok: true; summary: UnifiedEpisodeSourceSummary; refs: UnifiedEpisodeSourceRef[] }
  | { ok: false; miss: UnifiedEpisodeMiss };

/* =========================================================
 * 四、服务
 * =======================================================*/

export class UnifiedEpisodeService {
  private readonly deps: UnifiedEpisodeDeps;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry<UnifiedEpisodeAggregate>>();
  private readonly inflight = new Map<string, Promise<UnifiedEpisodeAggregate>>();
  private cacheHits = 0;
  private aggregations = 0;
  private sourceSearches = 0;
  private detailFetches = 0;

  constructor(deps: UnifiedEpisodeDeps, options: UnifiedEpisodeServiceOptions = {}) {
    this.deps = deps;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = clampInt(options.maxEntries, DEFAULT_MAX_ENTRIES, 1, 500);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 聚合同一作品的剧集列表。
   *
   * - 不给 `candidates`：列出已启用的可播源（`site` / `spider`），按片名搜索 → 取详情 → 按集号合并；
   * - 给 `candidates`：只取这些候选的详情（播放链路已通过 `playMatch` 完成片名/年份筛选）。
   *
   * 任何单源失败都只记为 `misses`，不影响其它源；全部失败返回空 `episodes`（不抛错）。
   * 调用方 `signal` 中止时抛错（不写缓存）。
   */
  async getUnifiedEpisodes(
    mediaId: string,
    title: string,
    options: UnifiedEpisodeCallOptions = {},
  ): Promise<UnifiedEpisodeAggregate> {
    const cleanTitle = title.trim();
    const cleanMediaId = mediaId.trim();
    const year = options.year ?? null;
    if (cleanTitle.length === 0) {
      return this.emptyAggregate(cleanMediaId, cleanTitle, year);
    }

    const key = cacheKeyOf(cleanMediaId, cleanTitle, year);
    if (options.force !== true) {
      const cached = this.read(key);
      if (cached !== undefined) {
        this.cacheHits += 1;
        return { ...cached, cached: true };
      }
      // 并发去重：同一作品同时被多处请求时只聚合一回
      const running = this.inflight.get(key);
      if (running !== undefined) return running;
    }

    const task = this.aggregate({ mediaId: cleanMediaId, title: cleanTitle, year, options });
    this.inflight.set(key, task);
    try {
      const value = await task;
      this.write(key, value);
      return value;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * 跨源查找某一集的最佳匹配。
   *
   * 返回的 `candidates` 已按「健康档位 → 延迟 → 源顺序」排好：
   * 调用方依次尝试，首选源失败自动降级到下一个。
   * 聚合里没有这一集时，若适配器支持 `findEpisodeByTitle` 且没传 `candidates`，
   * 会对聚合失败的源做一次定向直查（最多 3 个）。
   */
  async findBestEpisode(
    title: string,
    episodeIndex: number,
    options: UnifiedEpisodeLookupOptions = {},
  ): Promise<UnifiedEpisodeHit | null> {
    const cleanTitle = title.trim();
    const index = Math.trunc(episodeIndex);
    if (cleanTitle.length === 0 || !Number.isFinite(index) || index < 1) return null;

    const aggregate = await this.getUnifiedEpisodes(options.mediaId ?? '', cleanTitle, options);
    const episode = aggregate.episodes.find((entry) => entry.number === index);
    if (episode !== undefined && episode.sources.length > 0) {
      return { number: episode.number, title: episode.title, candidates: episode.sources };
    }

    if (options.fallbackLookup === false) return null;
    // 已知候选时不再搜索：候选本身就是权威集合，直查兜底只会重复打源站
    if ((options.candidates ?? []).length > 0) return null;
    const lookup = this.deps.findEpisodeByTitle;
    if (lookup === undefined) return null;

    const retriable = aggregate.misses.filter(
      (miss) =>
        miss.reason !== 'title_mismatch' &&
        miss.reason !== 'year_mismatch' &&
        miss.reason !== 'detail_unavailable',
    );
    for (const miss of retriable.slice(0, DEFAULT_LOOKUP_LIMIT)) {
      options.signal?.throwIfAborted();
      try {
        const match = await lookup({
          source: miss.source,
          title: cleanTitle,
          episodeIndex: index,
          year: options.year ?? null,
          signal: options.signal,
        });
        if (match === null || match.episodeNumber !== index) continue;
        const quality = await this.qualityOf(miss.source);
        return {
          number: index,
          title: match.episodeTitle,
          candidates: [
            {
              ...match,
              tier: healthTierOf(quality.health, quality.latencyMs),
              latencyMs: quality.latencyMs,
            },
          ],
        };
      } catch (e) {
        if (options.signal?.aborted) throw e;
        logger.debug('单源集数直查失败', { sourceId: miss.source.id, title: cleanTitle, error: String(e) });
      }
    }
    return null;
  }

  /** 清空聚合缓存（换源 / 订阅变更后由调用方触发；测试也用） */
  clear(): void {
    this.cache.clear();
    this.inflight.clear();
    this.cacheHits = 0;
    this.aggregations = 0;
    this.sourceSearches = 0;
    this.detailFetches = 0;
  }

  stats(): UnifiedEpisodeStats {
    return {
      entries: this.cache.size,
      inFlight: this.inflight.size,
      cacheHits: this.cacheHits,
      aggregations: this.aggregations,
      sourceSearches: this.sourceSearches,
      detailFetches: this.detailFetches,
    };
  }

  /* ---------------- 聚合 ---------------- */

  private async aggregate(input: {
    mediaId: string;
    title: string;
    year: number | null;
    options: UnifiedEpisodeCallOptions;
  }): Promise<UnifiedEpisodeAggregate> {
    const { mediaId, title, year, options } = input;
    const signal = options.signal;
    const detailLimit = clampInt(options.detailLimit, DEFAULT_DETAIL_LIMIT, 1, 5);
    const maxSources = clampInt(options.maxSources, DEFAULT_MAX_SOURCES, 1, 20);

    this.aggregations += 1;
    const planned = await this.planSources(options, maxSources);
    signal?.throwIfAborted();
    if (planned.length === 0) {
      return this.emptyAggregate(mediaId, title, year);
    }

    const contributions = await Promise.all(
      planned.map((entry) =>
        this.collect({ planned: entry, title, year, detailLimit, signal, detailOf: options.detailOf }),
      ),
    );

    const byNumber = new Map<number, UnifiedEpisodeSourceRef[]>();
    const summaries: UnifiedEpisodeSourceSummary[] = [];
    const misses: UnifiedEpisodeMiss[] = [];
    for (const contribution of contributions) {
      if (!contribution.ok) {
        misses.push(contribution.miss);
        continue;
      }
      summaries.push(contribution.summary);
      for (const ref of contribution.refs) {
        const list = byNumber.get(ref.episodeNumber);
        if (list !== undefined) list.push(ref);
        else byNumber.set(ref.episodeNumber, [ref]);
      }
    }

    const episodes: UnifiedEpisode[] = [...byNumber.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([number, refs]) => {
        const ordered = [...refs].sort((a, b) => compareQuality(qualityOfRef(a), qualityOfRef(b)));
        const preferred = ordered[0];
        return {
          number,
          title: preferred !== undefined && preferred.episodeTitle.length > 0 ? preferred.episodeTitle : `第 ${number} 集`,
          sources: ordered,
        };
      });

    return {
      mediaId,
      title,
      year,
      episodes,
      sources: summaries,
      misses,
      cached: false,
      aggregatedAt: this.now(),
    };
  }

  /**
   * 参与聚合的源。
   *
   * - 有 `candidates`：直接用它（保持候选顺序，作为质量相同的最终次序）；
   * - 否则列出源 → 过滤启用 + `site`/`spider` → 取质量 → 按质量排序 → 截断 `maxSources`。
   *
   * 先排序再截断，保证「坏源」在好源够用时不会占用聚合预算。
   */
  private async planSources(
    options: UnifiedEpisodeCallOptions,
    maxSources: number,
  ): Promise<PlannedSource[]> {
    const allowedIds = options.sourceIds === undefined ? null : new Set(options.sourceIds);
    const candidates = options.candidates ?? [];
    if (candidates.length > 0) {
      const planned: PlannedSource[] = [];
      for (const candidate of candidates) {
        if (planned.length >= maxSources) break;
        if (allowedIds !== null && !allowedIds.has(candidate.source.id)) continue;
        planned.push({
          source: candidate.source,
          itemHint: candidate.item,
          quality: await this.qualityOf(candidate.source),
        });
      }
      return planned;
    }

    const all = await this.deps.listSources();
    const providers = all.filter(
      (source) =>
        source.enabled &&
        (source.type === 'site' || source.type === 'spider') &&
        (allowedIds === null || allowedIds.has(source.id)),
    );
    if (providers.length === 0) return [];

    const qualities = await Promise.all(providers.map((source) => this.qualityOf(source)));
    const decorated = providers.map((source, order) => ({
      source,
      order,
      quality: qualities[order] ?? { health: source.health, latencyMs: null },
    }));
    decorated.sort((a, b) => {
      const byQuality = compareQuality(a.quality, b.quality);
      if (byQuality !== 0) return byQuality;
      const bySort = a.source.sort - b.source.sort;
      if (bySort !== 0) return bySort;
      const byName = a.source.name.localeCompare(b.source.name, 'zh-Hans-CN');
      if (byName !== 0) return byName;
      return a.order - b.order;
    });

    return decorated.slice(0, maxSources).map((entry) => ({
      source: entry.source,
      itemHint: null,
      quality: entry.quality,
    }));
  }

  /** 单源聚合：搜索（或已知条目）→ 详情 → 按集号生成落点 */
  private async collect(input: {
    planned: PlannedSource;
    title: string;
    year: number | null;
    detailLimit: number;
    signal?: AbortSignal;
    detailOf?: (input: { source: Source; sourceItemId: string; signal?: AbortSignal }) => Promise<MediaDetail>;
  }): Promise<Contribution> {
    const { planned, title, year, signal } = input;
    const { source, quality } = planned;
    const tier = healthTierOf(quality.health, quality.latencyMs);
    const miss = (reason: UnifiedEpisodeMissReason, detail: string | null = null): Contribution => ({
      ok: false,
      miss: { source, reason, detail },
    });

    let items: MediaItem[];
    if (planned.itemHint !== null) {
      if (!titleMatches(title, planned.itemHint.title)) return miss('title_mismatch', planned.itemHint.title);
      items = [planned.itemHint];
    } else {
      const budget = await this.budgetOf(source);
      const searched = await this.runGuarded(source, signal, budget, (inner) =>
        this.deps.search({
          source,
          keyword: title,
          page: 1,
          pageSize: Math.max(input.detailLimit * 3, SEARCH_PAGE_SIZE_MIN),
          signal: inner,
        }),
      );
      this.sourceSearches += 1;
      if (!searched.ok) {
        return miss(searched.timedOut ? 'timeout' : 'source_error', searched.message);
      }
      const ranked = rankItems(searched.value, title, year);
      if (ranked.miss !== null) {
        const hint = searched.value.length > 0 ? searched.value[0]?.title ?? null : null;
        return miss(ranked.miss, hint);
      }
      items = ranked.items;
    }

    const budget = await this.budgetOf(source);
    let lastMiss: UnifiedEpisodeMiss = { source, reason: 'no_result', detail: null };
    for (const item of items.slice(0, input.detailLimit)) {
      signal?.throwIfAborted();
      const got = await this.runGuarded(source, signal, budget, (inner) =>
        input.detailOf !== undefined
          ? input.detailOf({ source, sourceItemId: item.sourceItemId, signal: inner })
          : this.deps.getDetail({ source, sourceItemId: item.sourceItemId, signal: inner }),
      );
      this.detailFetches += 1;
      if (!got.ok) {
        lastMiss = {
          source,
          reason: got.timedOut ? 'timeout' : detailMissReason(got.error),
          detail: got.message,
        };
        continue;
      }
      if (got.value.episodes.length === 0) {
        lastMiss = { source, reason: 'no_episodes', detail: got.value.item.title };
        continue;
      }
      const refs = this.refsOf(source, got.value, tier, quality.latencyMs);
      if (refs.length === 0) {
        lastMiss = { source, reason: 'no_episodes', detail: got.value.item.title };
        continue;
      }
      return {
        ok: true,
        summary: {
          source,
          item: got.value.item,
          episodeCount: refs.length,
          tier,
          latencyMs: quality.latencyMs,
        },
        refs,
      };
    }
    return { ok: false, miss: lastMiss };
  }

  /**
   * 详情 → 每集一个落点。
   *
   * 集号定位复用 FIX-05 的 `selectEpisodeInDetail()`（线路优先取集数多的、集号精确命中、
   * 标题集号兜底），保证「聚合展示的集」与「播放映射到的集」口径一致。
   */
  private refsOf(
    source: Source,
    detail: MediaDetail,
    tier: HealthTier,
    latencyMs: number | null,
  ): UnifiedEpisodeSourceRef[] {
    const numbers = new Set<number>();
    for (const episode of detail.episodes) numbers.add(episode.number);
    const refs: UnifiedEpisodeSourceRef[] = [];
    const seen = new Set<number>();
    for (const number of numbers) {
      const selection = selectEpisodeInDetail(detail, number);
      if (selection === null) continue;
      // 以「实际选中的那一集」的集号为键：线路里的 `number` 与标题集号不一致时，
      // 展示的集号必须等于播放的集号，否则用户点第 N 集可能播到别的集。
      const canonical = selection.episode.number;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      refs.push({
        source,
        item: detail.item,
        line: selection.line,
        episode: selection.episode,
        lineId: selection.line.id,
        episodeId: selection.episode.id,
        episodeNumber: canonical,
        episodeTitle: selection.episode.title,
        tier,
        latencyMs,
      });
    }
    return refs.sort((a, b) => a.episodeNumber - b.episodeNumber);
  }

  /* ---------------- 预算与错误 ---------------- */

  /** 单源请求预算：优先问适配器自报值，再按统一档位钳制 */
  private async budgetOf(source: Source): Promise<number> {
    if (this.deps.budgetOf !== undefined) {
      try {
        const budget = await this.deps.budgetOf(source);
        if (typeof budget === 'number' && Number.isFinite(budget) && budget > 0) return budget;
      } catch {
        /* 预算读取失败 → 用默认值 */
      }
    }
    return resolveSearchTimeoutMs(TIMEOUT_SEARCH_MS);
  }

  private async qualityOf(source: Source): Promise<SourceQuality> {
    try {
      const quality = await this.deps.qualityOf(source.id);
      return {
        health: quality.health === 'unknown' ? source.health : quality.health,
        latencyMs: quality.latencyMs,
      };
    } catch {
      return { health: source.health, latencyMs: null };
    }
  }

  /**
   * 带预算地执行一次源请求。
   *
   * - 预算到点：内部中止，按 `timeout` 归类（不是调用方取消）；
   * - 调用方 `signal` 中止：原样抛出（不写缓存、不吞错）。
   */
  private async runGuarded<T>(
    source: Source,
    outer: AbortSignal | undefined,
    budgetMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<Guarded<T>> {
    outer?.throwIfAborted();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budgetMs);
    const onAbort = (): void => controller.abort();
    outer?.addEventListener('abort', onAbort, { once: true });
    try {
      return { ok: true, value: await run(controller.signal) };
    } catch (e) {
      if (outer?.aborted) throw e;
      const error = toAppError(e, 'E_SOURCE_UNAVAILABLE');
      if (!timedOut && !isCanceled(e) && error.code === 'E_UNKNOWN') {
        logger.debug('跨源剧集聚合请求失败', { sourceId: source.id, error: error.message });
      }
      return {
        ok: false,
        timedOut: timedOut || error.code === 'E_TIMEOUT' || isCanceled(e),
        error,
        message: error.message,
      };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    }
  }

  /* ---------------- 缓存 ---------------- */

  private emptyAggregate(mediaId: string, title: string, year: number | null): UnifiedEpisodeAggregate {
    return { mediaId, title, year, episodes: [], sources: [], misses: [], cached: false, aggregatedAt: this.now() };
  }

  /** LRU 读：命中后挪到末尾 */
  private read(key: string): UnifiedEpisodeAggregate | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /** LRU 写：满则淘汰队首 */
  private write(key: string, value: UnifiedEpisodeAggregate): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

/** 缓存键：作品 id（缺省用片名归一键）+ 年份 + 片名归一键 */
function cacheKeyOf(mediaId: string, title: string, year: number | null): string {
  const identity = mediaId.length > 0 ? mediaId : `title:${titleKeyOf(title)}`;
  return `${identity}|${year ?? ''}|${titleKeyOf(title)}`;
}

function titleKeyOf(title: string): string {
  return title.trim().toLowerCase();
}

function qualityOfRef(ref: UnifiedEpisodeSourceRef): SourceQuality {
  return { health: ref.tier === 'unknown' ? 'unknown' : ref.tier === 'bad' ? 'unreachable' : 'ok', latencyMs: ref.latencyMs };
}

/* =========================================================
 * 五、默认装配（调用时动态加载，避免模块求值期成环）
 * =======================================================*/

type RegistryModule = typeof import('@/sources/registry');
type SourceServiceModule = typeof import('@/services/sourceService');
type HealthServiceModule = typeof import('@/services/healthService');

let registryModule: Promise<RegistryModule> | null = null;
let sourceServiceModule: Promise<SourceServiceModule> | null = null;
let healthServiceModule: Promise<HealthServiceModule> | null = null;

function loadRegistry(): Promise<RegistryModule> {
  registryModule ??= import('@/sources/registry');
  return registryModule;
}

function loadSourceService(): Promise<SourceServiceModule> {
  sourceServiceModule ??= import('@/services/sourceService');
  return sourceServiceModule;
}

function loadHealthService(): Promise<HealthServiceModule> {
  healthServiceModule ??= import('@/services/healthService');
  return healthServiceModule;
}

/** 默认依赖装配：源清单读库、请求走注册表里的适配器、质量读健康快照 */
export const defaultUnifiedEpisodeDeps: UnifiedEpisodeDeps = {
  async listSources(): Promise<Source[]> {
    const { sourceService } = await loadSourceService();
    return sourceService.list();
  },

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { sourceRegistry } = await loadRegistry();
    return sourceRegistry.forSource(params.source).search(params);
  },

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { sourceRegistry } = await loadRegistry();
    return sourceRegistry.forSource(params.source).getDetail(params);
  },

  async qualityOf(sourceId: string): Promise<SourceQuality> {
    const { healthService } = await loadHealthService();
    return { health: healthService.healthOf(sourceId), latencyMs: healthService.latencyOf(sourceId) };
  },

  async findEpisodeByTitle(input): Promise<EpisodeLookupMatch | null> {
    const { sourceRegistry } = await loadRegistry();
    const adapter = asEpisodeLookup(sourceRegistry.forSource(input.source));
    if (adapter === null) return null;
    return adapter.findEpisodeByTitle(input.title, input.episodeIndex, {
      source: input.source,
      year: input.year,
      signal: input.signal,
    });
  },

  async budgetOf(source: Source): Promise<number> {
    const { sourceRegistry } = await loadRegistry();
    const adapter = sourceRegistry.has(source.type) ? sourceRegistry.get(source.type) : null;
    return resolveSearchTimeoutMs(adapter?.searchTimeoutMs ?? TIMEOUT_SEARCH_MS);
  },

  now: () => Date.now(),
};

/** 模块级单例（适配器与将来的详情页共用同一份聚合缓存） */
export const unifiedEpisodeService = new UnifiedEpisodeService(defaultUnifiedEpisodeDeps);
