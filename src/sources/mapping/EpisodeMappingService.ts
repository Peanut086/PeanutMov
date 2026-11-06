/**
 * 跨源集数映射服务（FIX-05）
 *
 * 背景：豆瓣（`douban`）只有元数据，播放地址向 CMS 源（`site` / `spider`）借用。
 * 旧实现把豆瓣自己的 `episodeId` 原样传给目标适配器，目标适配器在剧集列表里
 * 找不到该 id 时会**静默回退到第一集**——于是「选第 5 集播放第 1 集」。
 *
 * 本服务负责把「豆瓣的 (片名, 年份, 集数序号)」映射成「目标源的 (线路 id, 剧集 id)」：
 * 1. 片名匹配：见 `TitleNormalizer`（归一化 + 季号/续集号消解 + 相似度）；
 * 2. 集数匹配：以线路内 1 起的 `Episode.number` 为准，其次解析剧集标题里的集号；
 * 3. 命中不了返回 `null`（miss），**不降级到第一集**。
 *
 * 缓存：内存 LRU（默认 64 条 / 5 分钟），两级——
 * - 详情级：同一 (源, 条目) 的线路/剧集只拉一次；
 * - 映射级：同一 (片名, 年份, 集数, 源, 条目) 的映射结果（含「没有这一集」的否定结果）。
 *
 * 服务不直接依赖 registry / libraryService：取详情的动作由调用方注入（`getDetail`），
 * 避免适配器 ↔ 服务的反向依赖与循环 import。
 */
import { AppError, toAppError } from '@/shared/errors';
import {
  parseEpisodeIndex,
  seasonConflicts,
  titleMatches,
} from '@/sources/mapping/TitleNormalizer';
import type {
  Episode,
  GetDetailParams,
  MediaDetail,
  MediaItem,
  PlayLine,
  Source,
} from '@/types';

/** 映射服务依赖：取目标源详情 */
export interface EpisodeMappingDeps {
  /** 目标适配器不支持详情查询时抛 `E_NOT_IMPLEMENTED`（映射按「不可用」处理） */
  getDetail(params: GetDetailParams): Promise<MediaDetail>;
}

export interface EpisodeMappingOptions {
  /** 缓存有效期（ms），默认 5 分钟 */
  ttlMs?: number;
  /** 缓存条数上限，默认 64 */
  maxEntries?: number;
  /** 时钟（测试注入） */
  now?: () => number;
}

/** 候选：片名匹配后的「源 + 条目」 */
export interface EpisodeMappingCandidate {
  source: Source;
  item: MediaItem;
}

export interface EpisodeMappingRequest {
  /** 目标片名（豆瓣条目名，可带季/部后缀） */
  title: string;
  /** 目标年份；任一缺失则跳过校验 */
  year: number | null;
  /** 集数序号，从 1 开始 */
  episodeIndex: number;
  /** 已按源质量排序的候选 */
  candidates: readonly EpisodeMappingCandidate[];
  signal?: AbortSignal;
}

/** 映射命中：目标源里对应的那一集 */
export interface EpisodeMappingTarget {
  source: Source;
  item: MediaItem;
  line: PlayLine;
  episode: Episode;
  /** 传给目标适配器 `resolvePlayUrl` 的线路 id */
  lineId: string;
  /** 传给目标适配器 `resolvePlayUrl` 的剧集 id */
  episodeId: string;
  /** 集号（1 起） */
  episodeNumber: number;
  episodeTitle: string;
}

export type EpisodeMappingMissReason =
  | 'title_mismatch'
  | 'season_mismatch'
  | 'year_mismatch'
  | 'episode_out_of_range'
  | 'no_episodes'
  | 'detail_unavailable'
  | 'detail_failed';

export interface EpisodeMappingMiss {
  sourceId: string;
  sourceName: string;
  reason: EpisodeMappingMissReason;
  /** 附加线索（如「共 12 集」「年份不一致：2024 / 2019」） */
  detail: string | null;
}

export interface EpisodeMappingResult {
  /** 命中的目标集，顺序与候选顺序一致（保持源质量排序） */
  targets: EpisodeMappingTarget[];
  /** 未命中的候选及原因（供上层给出可读错误） */
  misses: EpisodeMappingMiss[];
  /** 命中缓存的候选数 */
  cacheHits: number;
}

/** 单个候选的映射结论（含否定结论，便于缓存） */
export type EpisodeMappingOutcome =
  | { target: EpisodeMappingTarget; miss: null }
  | { target: null; miss: EpisodeMappingMiss };

export interface EpisodeMappingStats {
  /** 详情缓存条数 */
  detailEntries: number;
  /** 映射缓存条数 */
  mappingEntries: number;
  cacheHits: number;
  /** 实际调用注入 getDetail 的次数 */
  detailFetches: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 64;

/** 未命中原因 → 用户可读短语 */
export function episodeMissText(reason: EpisodeMappingMissReason): string {
  switch (reason) {
    case 'title_mismatch':
      return '片名不匹配';
    case 'season_mismatch':
      return '季/部数不一致';
    case 'year_mismatch':
      return '年份不一致';
    case 'episode_out_of_range':
      return '没有这一集';
    case 'no_episodes':
      return '没有剧集';
    case 'detail_unavailable':
      return '不支持剧集查询';
    case 'detail_failed':
      return '详情读取失败';
  }
}

/** 豆瓣剧集标识的解析结果 */
export interface DoubanEpisodeRef {
  /** 豆瓣条目 id（`douban_{movieId}_{index}` 的中间段） */
  movieId: string;
  /** 集数序号，1 起 */
  episodeIndex: number;
}

/** 构造豆瓣剧集标识：`douban_{movieId}_{episodeIndex}` */
export function buildDoubanEpisodeId(movieId: string, episodeIndex: number): string {
  const id = movieId.trim().replace(/\s+/g, '');
  const index = Number.isFinite(episodeIndex) && episodeIndex > 0 ? Math.trunc(episodeIndex) : 1;
  return `douban_${id}_${index}`;
}

/**
 * 解析豆瓣剧集标识。
 *
 * 兼容三种历史写法（库里可能存着旧 id）：
 * - `douban_{movieId}_{index}`（本任务约定的规范形态）
 * - `douban-{mediaId}-{index}`（旧实现 `douban-${item.id}-1`）
 * - 空串 → 视为第 1 集（电影只有一个「正片」）
 *
 * 非空但无法解析时返回 null，由调用方报错（不猜集数）。
 */
export function parseDoubanEpisodeId(episodeId: string | null | undefined): DoubanEpisodeRef | null {
  const raw = String(episodeId ?? '').trim();
  if (raw.length === 0) return { movieId: '', episodeIndex: 1 };
  const match = /^douban[_-](.+)[_-]([0-9]{1,4})$/.exec(raw);
  if (!match) return null;
  const movieId = (match[1] ?? '').trim();
  const index = Number.parseInt(match[2] ?? '', 10);
  if (movieId.length === 0 || !Number.isFinite(index) || index < 1) return null;
  return { movieId, episodeIndex: index };
}

export interface EpisodeSelection {
  line: PlayLine;
  episode: Episode;
}

/**
 * 在目标源详情里定位第 `episodeIndex` 集（1 起）。
 *
 * 线路优先级：剧集数多的线路优先（避免「预告」这类只有 1 集的线路抢走第 1 集），同数量按源顺序。
 * 集数匹配：先按 `Episode.number`（线路内 1 起序号），再解析剧集标题里的集号。
 * 找不到返回 null——**不回退第一集**。
 */
export function selectEpisodeInDetail(
  detail: MediaDetail,
  episodeIndex: number,
): EpisodeSelection | null {
  if (!Number.isFinite(episodeIndex) || episodeIndex < 1) return null;
  const index = Math.trunc(episodeIndex);

  const episodesByLine = new Map<string, Episode[]>();
  for (const episode of detail.episodes) {
    const list = episodesByLine.get(episode.lineId);
    if (list) list.push(episode);
    else episodesByLine.set(episode.lineId, [episode]);
  }
  if (episodesByLine.size === 0) return null;

  const lines = [...detail.lines].sort((a, b) => {
    const countA = episodesByLine.get(a.id)?.length ?? 0;
    const countB = episodesByLine.get(b.id)?.length ?? 0;
    if (countA !== countB) return countB - countA;
    return a.index - b.index;
  });

  // 1) 集号精确命中
  for (const line of lines) {
    const hit = episodesByLine.get(line.id)?.find((episode) => episode.number === index);
    if (hit) return { line, episode: hit };
  }
  // 2) 剧集标题里写了集号（`第5集` / `EP05` / `05`）
  for (const line of lines) {
    const list = episodesByLine.get(line.id) ?? [];
    const hit = list.find((episode) => parseEpisodeIndex(episode.title) === index);
    if (hit) return { line, episode: hit };
  }
  return null;
}

/** 缓存条目 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class EpisodeMappingService {
  private readonly deps: EpisodeMappingDeps;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly mappingCache = new Map<string, CacheEntry<EpisodeMappingOutcome>>();
  private readonly detailCache = new Map<string, CacheEntry<MediaDetail>>();
  private cacheHits = 0;
  private detailFetches = 0;

  constructor(deps: EpisodeMappingDeps, options: EpisodeMappingOptions = {}) {
    this.deps = deps;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * 把「片名 + 年份 + 集数序号」映射到候选源里的对应集。
   * 命中不了不抛错，返回空 `targets` + `misses`；由调用方决定是否报错（FIX-05 要求报错而非降级）。
   */
  async resolve(request: EpisodeMappingRequest): Promise<EpisodeMappingResult> {
    const episodeIndex = Math.trunc(request.episodeIndex);
    if (!Number.isFinite(episodeIndex) || episodeIndex < 1) {
      throw new AppError('E_INVALID_INPUT', '集数序号不合法（应从 1 开始）');
    }

    const targets: EpisodeMappingTarget[] = [];
    const misses: EpisodeMappingMiss[] = [];
    const seen = new Set<string>();
    let cacheHits = 0;

    for (const candidate of request.candidates) {
      request.signal?.throwIfAborted();
      const dedupeKey = `${candidate.source.id}|${candidate.item.sourceItemId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const key = mappingCacheKey(request.title, request.year, episodeIndex, candidate);
      const cached = this.read(this.mappingCache, key);
      let outcome: EpisodeMappingOutcome;
      if (cached !== undefined) {
        cacheHits += 1;
        outcome = cached;
      } else {
        outcome = await this.mapCandidate({
          candidate,
          title: request.title,
          year: request.year,
          episodeIndex,
          signal: request.signal,
        });
        this.write(this.mappingCache, key, outcome);
      }

      if (outcome.target !== null) targets.push(outcome.target);
      else misses.push(outcome.miss);
    }

    this.cacheHits += cacheHits;
    return { targets, misses, cacheHits };
  }

  /** 清空缓存（换源/订阅变更后由调用方触发，测试也用） */
  clear(): void {
    this.mappingCache.clear();
    this.detailCache.clear();
    this.cacheHits = 0;
    this.detailFetches = 0;
  }

  stats(): EpisodeMappingStats {
    return {
      detailEntries: this.detailCache.size,
      mappingEntries: this.mappingCache.size,
      cacheHits: this.cacheHits,
      detailFetches: this.detailFetches,
    };
  }

  /* ---------------- 内部 ---------------- */

  private async mapCandidate(input: {
    candidate: EpisodeMappingCandidate;
    title: string;
    year: number | null;
    episodeIndex: number;
    signal?: AbortSignal;
  }): Promise<EpisodeMappingOutcome> {
    const { candidate, title, year, episodeIndex, signal } = input;
    const { source, item } = candidate;
    const miss = (reason: EpisodeMappingMissReason, detail: string | null = null): EpisodeMappingOutcome => ({
      target: null,
      miss: { sourceId: source.id, sourceName: source.name, reason, detail },
    });

    // 1) 片名（含季号消解）
    if (!titleMatches(title, item.title)) {
      return miss(
        seasonConflicts(title, item.title) ? 'season_mismatch' : 'title_mismatch',
        item.title,
      );
    }
    // 2) 年份：双方都有时必须一致
    if (year !== null && item.year !== null && year !== item.year) {
      return miss('year_mismatch', `${year} / ${item.year}`);
    }

    // 3) 详情（失败不影响其它候选）
    const detail = await this.detailOf(source, item, signal);
    if (detail.error !== null) {
      return miss(detail.error.reason, detail.error.detail);
    }
    const media = detail.value;
    if (media.episodes.length === 0) return miss('no_episodes');

    // 4) 集数
    const selection = selectEpisodeInDetail(media, episodeIndex);
    if (selection === null) {
      const max = media.episodes.reduce((acc, episode) => Math.max(acc, episode.number), 0);
      return miss('episode_out_of_range', max > 0 ? `共 ${max} 集` : null);
    }

    return {
      target: {
        source,
        item: media.item,
        line: selection.line,
        episode: selection.episode,
        lineId: selection.line.id,
        episodeId: selection.episode.id,
        episodeNumber: selection.episode.number,
        episodeTitle: selection.episode.title,
      },
      miss: null,
    };
  }

  /** 详情缓存：同一 (源, 条目) 只拉一次；失败不缓存（下次重试） */
  private async detailOf(
    source: Source,
    item: MediaItem,
    signal?: AbortSignal,
  ): Promise<
    | { value: MediaDetail; error: null }
    | { value: null; error: { reason: EpisodeMappingMissReason; detail: string | null } }
  > {
    const key = `${source.id}|${item.sourceItemId}`;
    const cached = this.read(this.detailCache, key);
    if (cached !== undefined) return { value: cached, error: null };

    try {
      this.detailFetches += 1;
      const detail = await this.deps.getDetail({ source, sourceItemId: item.sourceItemId, signal });
      this.write(this.detailCache, key, detail);
      return { value: detail, error: null };
    } catch (e) {
      if (signal?.aborted) throw e;
      const error = toAppError(e, 'E_SOURCE_UNAVAILABLE');
      const unavailable =
        error.code === 'E_NOT_IMPLEMENTED' ||
        error.code === 'E_UNSUPPORTED_FORMAT' ||
        error.code === 'E_SOURCE_DISABLED';
      return {
        value: null,
        error: {
          reason: unavailable ? 'detail_unavailable' : 'detail_failed',
          detail: error.message,
        },
      };
    }
  }

  /** LRU 读：命中后挪到末尾 */
  private read<T>(cache: Map<string, CacheEntry<T>>, key: string): T | undefined {
    const entry = cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      cache.delete(key);
      return undefined;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  /** LRU 写：满则淘汰队首 */
  private write<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T): void {
    if (cache.size >= this.maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    cache.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }
}

function mappingCacheKey(
  title: string,
  year: number | null,
  episodeIndex: number,
  candidate: EpisodeMappingCandidate,
): string {
  return [
    title.trim().toLowerCase(),
    year ?? '',
    episodeIndex,
    candidate.source.id,
    candidate.item.sourceItemId,
  ].join('|');
}
