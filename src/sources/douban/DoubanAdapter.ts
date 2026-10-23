/**
 * 豆瓣源适配器（「发现源」）
 *
 * 与其它适配器的区别：**不提供播放**。
 * 豆瓣只有元数据，播放地址通过 `resolvePlayFrom` 回调向 CMS 源借用——
 * 回调由 `doubanRuntime.ts` 装配，避免适配器反向依赖 libraryService 形成环。
 *
 * 参考实现：TVBox drpy 规则 `douban.js`（聚玩盒子4K 的 ext）。
 */
import { AppError } from '@/shared/errors';
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

/** 跨源播放解析器：由装配方注入，返回可播的候选源与条目 */
export type DoubanPlayResolver = (params: {
  title: string;
  year: number | null;
  signal?: AbortSignal;
}) => Promise<PlayCandidate | null>;

/** 取候选源适配器（装配方注入，便于测试替身） */
export type DoubanAdapterGetter = (source: Source) => {
  resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource>;
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
    // 从库里读条目拿片名与年份（不用适配器内的可变状态，避免并发串数据）。
    // 库里没有则用源配置能拿到的最小信息（sourceItemId/默认标题），
    // 免得 resolvePlayUrl 因缓存未命中而误报「不存在」。
    const item = await mediaRepo.get(params.mediaId);
    const title = item?.title ?? (params.sourceItemId.length > 0 ? params.sourceItemId : '');
    if (title.length === 0) {
      throw new AppError('E_NO_PLAY_URL', '缺少影片信息，无法匹配播放来源');
    }

    const candidate = await resolvePlayFrom({ title, year: item?.year ?? null, signal: params.signal });
    if (candidate === null) {
      throw new AppError('E_NO_PLAY_URL', '已启用的源里没有找到这部影片的可播放地址');
    }

    // 借来的地址按候选源自己的口径解析（它的 baseUrl 决定相对地址如何补全）
    return adapterGetter(candidate.source).resolvePlayUrl({
      source: candidate.source,
      mediaId: params.mediaId,
      sourceItemId: candidate.item.sourceItemId,
      episodeId: params.episodeId,
      lineId: params.lineId,
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
        id: `douban-${item.id}-1`,
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
