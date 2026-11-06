/**
 * 豆瓣源适配器（「发现源」）
 *
 * 与其它适配器的区别：**不提供播放**。
 * 豆瓣只有元数据，播放地址通过 `resolvePlayFrom` 回调向 CMS 源借用——
 * 回调由 `doubanRuntime.ts` 装配，避免适配器反向依赖 libraryService 形成环。
 *
 * FIX-05：借地址前必须先把「豆瓣的集数」映射成「目标源的线路/剧集」。
 * 旧实现把豆瓣自己的 `episodeId` 透传给目标适配器，目标找不到该 id 时会
 * 静默回退第一集（选第 5 集播第 1 集）。现在走 `EpisodeMappingService`：
 * 命中不了集数就报错，**不降级**。
 *
 * 参考实现：TVBox drpy 规则 `douban.js`（聚玩盒子4K 的 ext）。
 */
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import { categoryIdFor, inferMediaType, normalizeRating } from '@/sources/base/normalize';
import {
  DOUBAN_CATEGORIES,
  DOUBAN_PAGE_SIZE,
  areaOf,
  fetchCategoryPage,
  fetchDoubanDetail,
  probeDouban,
  searchDouban,
  type DoubanCategory,
  type DoubanDetail,
  type DoubanItem,
} from '@/sources/douban/doubanClient';
import type { PlayCandidate } from '@/sources/douban/playMatch';
import {
  EpisodeMappingService,
  buildDoubanEpisodeId,
  episodeMissText,
  parseDoubanEpisodeId,
  type EpisodeMappingMiss,
} from '@/sources/mapping/EpisodeMappingService';
import type {
  BrowseParams,
  Category,
  GetDetailParams,
  MediaDetail,
  MediaItem,
  MediaType,
  PageResult,
  PlaybackSource,
  PlayLine,
  ResolvePlayParams,
  SearchParams,
  Source,
  SourceType,
} from '@/types';

/** 跨源播放解析器：由装配方注入，返回按质量排序的可播候选（首个优先，失败顺延） */
export type DoubanPlayResolver = (params: {
  title: string;
  year: number | null;
  signal?: AbortSignal;
}) => Promise<PlayCandidate[]>;

/** 取候选源适配器（装配方注入，便于测试替身） */
export type DoubanAdapterGetter = (source: Source) => {
  resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource>;
  /** 详情查询：集数映射需要目标源的线路/剧集清单（FIX-05） */
  getDetail?(params: GetDetailParams): Promise<MediaDetail>;
};

/**
 * 跨源播放装配。
 * registry 在模块加载时就注册本适配器，而那时装配方可能还没就绪，
 * 因此用可变字段持有依赖，装配后即生效（registry 注册的是同一实例）。
 */
export const doubanRuntime: {
  resolvePlayFrom: DoubanPlayResolver | null;
  adapterGetter: DoubanAdapterGetter | null;
} = {
  resolvePlayFrom: null,
  adapterGetter: null,
};

/**
 * 跨源集数映射（FIX-05）：模块级单例，缓存目标源的线路/剧集清单与映射结论。
 * 取详情时才去 `doubanRuntime` 上拿适配器——装配是滞后的，不能在建实例时捕获。
 */
export const doubanEpisodeMapping = new EpisodeMappingService({
  getDetail: async (params) => {
    const getter = doubanRuntime.adapterGetter;
    if (getter === null) throw new AppError('E_NOT_IMPLEMENTED', '未配置可播放的来源');
    const adapter = getter(params.source);
    if (typeof adapter.getDetail !== 'function') {
      throw new AppError('E_NOT_IMPLEMENTED', `「${params.source.name}」不支持剧集查询`);
    }
    return adapter.getDetail(params);
  },
});

/** 分类 id → 豆瓣分类定义 */
export function doubanCategoryOf(sourceId: string, categoryId: string | null): DoubanCategory | null {
  if (categoryId === null) return DOUBAN_CATEGORIES[0] ?? null;
  return DOUBAN_CATEGORIES.find((entry) => categoryIdFor(sourceId, entry.key) === categoryId) ?? null;
}

/** 豆瓣条目 → 统一 MediaItem */
function toMediaItem(item: DoubanItem, makeItem: (input: {
  sourceItemId: string;
  title: string;
  type: MediaType;
  originalTitle?: string | null;
  year?: number | null;
  area?: string | null;
  genres?: string[];
  tags?: string[];
  rating?: number | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
  description?: string | null;
  durationSec?: number | null;
  episodeCount?: number | null;
  now?: number;
}) => MediaItem): MediaItem {
  const tags = item.honor ? item.honor.split('|').filter((part) => part.length > 0).slice(0, 3) : [];
  return makeItem({
    sourceItemId: item.id,
    title: item.title,
    type: item.type === 'tv' ? 'series' : item.type === 'show' ? 'variety' : inferMediaType(null, item.title),
    originalTitle: null,
    year: item.year,
    area: areaOf(item),
    genres: [],
    tags,
    rating: item.rating !== null ? normalizeRating(item.rating) : null,
    posterUrl: item.posterUrl,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
  });
}

/** 未命中原因汇总成一句话，作为错误 detail（不暴露给用户主文案，供排查用） */
function describeMisses(misses: readonly EpisodeMappingMiss[]): string {
  if (misses.length === 0) return '';
  return misses
    .map((miss) => {
      const reason = episodeMissText(miss.reason);
      const extra = miss.detail !== null && miss.detail.length > 0 ? `（${miss.detail}）` : '';
      return `${miss.sourceName}：${reason}${extra}`;
    })
    .join('；');
}

export class DoubanAdapter extends BaseAdapter {
  readonly type: SourceType = 'douban';

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    return { itemCount: await probeDouban() };
  }

  async listCategories(source: Source, _signal?: AbortSignal): Promise<Category[]> {
    this.assertEnabled(source);
    return DOUBAN_CATEGORIES.map((entry, index) => ({
      id: categoryIdFor(source.id, entry.key),
      sourceId: source.id,
      name: entry.name,
      value: entry.key,
      order: index,
    }));
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, page, pageSize } = params;
    this.assertEnabled(source);
    const category = doubanCategoryOf(source.id, categoryId) ?? DOUBAN_CATEGORIES[0];
    if (!category) throw new AppError('E_UNSUPPORTED_FORMAT', '豆瓣分类缺失');

    const result = await fetchCategoryPage(category, page, params.signal);
    return {
      items: result.items.map((item) => this.toItem(source, item)),
      page: result.page,
      pageSize: pageSize || DOUBAN_PAGE_SIZE,
      total: result.total,
      hasMore: result.pageCount > 0 && page < result.pageCount,
    };
  }

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { source, keyword } = params;
    this.assertEnabled(source);
    const items = await searchDouban(keyword, params.signal);
    return items.slice(0, params.pageSize).map((item) => this.toItem(source, item));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    // 条目可能是电影也可能是剧集：先按电影取，404 再按剧集取
    let detail: DoubanDetail;
    try {
      detail = await fetchDoubanDetail('movie', sourceItemId, params.signal);
    } catch (e) {
      if (e instanceof AppError && e.code === 'E_HTTP_404') {
        detail = await fetchDoubanDetail('tv', sourceItemId, params.signal);
      } else {
        throw e;
      }
    }
    return this.toDetail(source, detail);
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source } = params;
    this.assertEnabled(source);

    const { resolvePlayFrom, adapterGetter } = doubanRuntime;
    if (resolvePlayFrom === null || adapterGetter === null) {
      throw new AppError('E_NO_PLAY_URL', '该源仅提供片单，未配置可播放的来源');
    }

    // 豆瓣的 episodeId 里带着「要第几集」，先解析出来；解析不了就报错，绝不猜集数。
    const ref = parseDoubanEpisodeId(params.episodeId);
    if (ref === null) {
      throw new AppError('E_INVALID_INPUT', `无法识别的剧集标识：${String(params.episodeId)}`);
    }
    const episodeIndex = ref.episodeIndex;

    // 从库里读条目拿片名与年份（不用适配器内的可变状态，避免并发串数据）。
    // 库里没有则退到调用方给的 sourceItemId / movieId，免得因缓存未命中误报「不存在」。
    const item = await mediaRepo.get(params.mediaId);
    const fallbackTitle = params.sourceItemId.length > 0 ? params.sourceItemId : ref.movieId;
    const title = item?.title ?? fallbackTitle;
    if (title.length === 0) {
      throw new AppError('E_NO_PLAY_URL', '缺少影片信息，无法匹配播放来源');
    }

    const candidates = await resolvePlayFrom({ title, year: item?.year ?? null, signal: params.signal });
    if (candidates.length === 0) {
      throw new AppError('E_NO_PLAY_URL', '已启用的源里没有找到这部影片的可播放地址');
    }

    // 把「豆瓣第 N 集」映射成「目标源的线路 id + 剧集 id」；映射不中不降级（FIX-05）。
    const mapping = await doubanEpisodeMapping.resolve({
      title,
      year: item?.year ?? null,
      episodeIndex,
      candidates,
      signal: params.signal,
    });

    // 只有「第 1 集」才允许沿用旧的透传方式：单集电影/历史 id 场景下目标源可能
    // 连线路清单都拿不到，透传 episodeId 让目标源按自己的兜底逻辑取首集——
    // 首集就是用户点的集，不存在降级问题。
    const attempts =
      mapping.targets.length > 0
        ? mapping.targets
        : episodeIndex === 1
          ? candidates.map((candidate) => ({
              source: candidate.source,
              item: candidate.item,
              lineId: params.lineId,
              episodeId: params.episodeId,
            }))
          : [];

    if (attempts.length === 0) {
      throw new AppError('E_NO_PLAY_URL', `已启用的源里没有第 ${episodeIndex} 集`, {
        detail: describeMisses(mapping.misses),
      });
    }

    // 借来的地址按候选源自己的口径解析（它的 baseUrl 决定相对地址如何补全）；
    // 高质量候选失败（线路需要解析接口、源站瞬时故障等）时顺延下一个（CHG-12）
    const failures: string[] = [];
    for (const attempt of attempts) {
      try {
        return await adapterGetter(attempt.source).resolvePlayUrl({
          source: attempt.source,
          mediaId: params.mediaId,
          sourceItemId: attempt.item.sourceItemId,
          episodeId: attempt.episodeId,
          lineId: attempt.lineId,
        });
      } catch (e) {
        if (params.signal?.aborted) throw e;
        failures.push(`${attempt.source.name}：${e instanceof AppError ? e.message : String(e)}`);
      }
    }
    logger.warn('douban play resolve failed', { title, episodeIndex, failures });
    throw new AppError('E_NO_PLAY_URL', `${attempts.length} 个候选源均无法解析播放地址`, {
      detail: failures.join('；'),
    });
  }

  /* ---------------- 内部 ---------------- */

  private toDetail(source: Source, detail: DoubanDetail): MediaDetail {
    const base = this.toItem(source, detail.item);
    const item: MediaItem = {
      ...base,
      description: detail.intro ?? base.description,
      genres: detail.genres.length > 0 ? detail.genres : base.genres,
    };

    // 豆瓣没有线路与剧集：给一条「正片」线路让 UI 有东西点，
    // 播放时再跨源借地址（借不到由 resolvePlayUrl 抛错说明）
    const lineId = `douban-${item.id}`;
    const lines: PlayLine[] = [
      { id: lineId, mediaId: item.id, sourceId: source.id, name: '正片', quality: null, format: 'mp4', index: 0 },
    ];
    const episodes = [
      {
        // FIX-05：集数标识统一为 `douban_{movieId}_{episodeIndex}`，
        // resolvePlayUrl 从标识里解析集号，不再依赖「正片=第 1 集」的隐含约定。
        id: buildDoubanEpisodeId(item.sourceItemId, 1),
        mediaId: item.id,
        sourceId: source.id,
        lineId,
        number: 1,
        title: '正片',
        durationSec: detail.durationSec,
        subtitles: [],
        updatedAt: Date.now(),
      },
    ];
    return { item, lines, episodes };
  }

  private toItem(source: Source, item: DoubanItem): MediaItem {
    return toMediaItem(item, (input) => this.makeItem(source, input));
  }
}
