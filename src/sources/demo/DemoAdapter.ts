/**
 * 演示源适配器（API-01 / FR-43）
 *
 * 数据直接来自 `demoCatalog.ts`，不访问网络与数据库，因此离线可用；
 * 首页海报墙与点播全链路在首次启动 seed 后即可跑通。
 */
import { DEMO_CATEGORIES, DEMO_ITEMS, DEMO_HLS_URL, findDemoItem, demoPoster } from '@/data/demo/demoCatalog';
import { AppError } from '@/shared/errors';
import { episodeIdOf, lineIdOf, mediaIdOf } from '@/shared/id';
import { categoryIdFor, parseCategoryValue } from '@/sources/base/normalize';
import { normalizeFormat } from '@/sources/base/normalize';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import type {
  BrowseParams,
  Category,
  Episode,
  GetDetailParams,
  MediaDetail,
  MediaItem,
  PageResult,
  PlaybackSource,
  PlayLine,
  ResolvePlayParams,
  SearchParams,
  Source,
  SourceType,
} from '@/types';

/** 演示源条目数（供测试与 UI 断言） */
export const DEMO_ADAPTER_ITEM_COUNT = DEMO_ITEMS.length;

function matchesFilters(
  seed: (typeof DEMO_ITEMS)[number],
  filters: BrowseParams['filters'],
): boolean {
  if (filters.type !== null && seed.type !== filters.type) return false;
  if (filters.yearFrom !== null && (seed.year === null || seed.year < filters.yearFrom)) return false;
  if (filters.yearTo !== null && (seed.year === null || seed.year > filters.yearTo)) return false;
  if (filters.area !== null && seed.area !== filters.area) return false;
  return true;
}

export class DemoAdapter extends BaseAdapter {
  readonly type: SourceType = 'demo';

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    return { itemCount: DEMO_ITEMS.length };
  }

  async listCategories(source: Source): Promise<Category[]> {
    this.assertEnabled(source);
    return DEMO_CATEGORIES.map((category) => ({
      id: categoryIdFor(source.id, category.value),
      sourceId: source.id,
      name: category.name,
      value: category.value,
      order: category.order,
    }));
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, filters, page, pageSize } = params;
    this.assertEnabled(source);
    const categoryValue = parseCategoryValue(source.id, categoryId);
    const now = Date.now();
    const rows = DEMO_ITEMS.filter((seed) => {
      if (categoryValue !== null && seed.type !== categoryValue) return false;
      return matchesFilters(seed, filters);
    });
    const start = (page - 1) * pageSize;
    const slice = rows.slice(start, start + pageSize);
    return {
      items: slice.map((seed) => this.toItem(source, seed, now)),
      page,
      pageSize,
      total: rows.length,
      hasMore: start + pageSize < rows.length,
    };
  }

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { source, keyword } = params;
    this.assertEnabled(source);
    const kw = keyword.trim().toLowerCase();
    if (kw.length === 0) return [];
    const now = Date.now();
    return DEMO_ITEMS.filter(
      (seed) =>
        seed.title.toLowerCase().includes(kw) ||
        (seed.originalTitle ?? '').toLowerCase().includes(kw) ||
        seed.genres.some((g) => g.toLowerCase().includes(kw)),
    )
      .slice(0, params.pageSize)
      .map((seed) => this.toItem(source, seed, now));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    const seed = findDemoItem(sourceItemId);
    if (!seed) {
      throw new AppError('E_NOT_FOUND');
    }
    const now = Date.now();
    const item = this.toItem(source, seed, now);
    const lines: PlayLine[] = [];
    const episodes: Episode[] = [];
    seed.lines.forEach((lineSeed, index) => {
      const lineId = lineIdOf(item.id, index);
      lines.push({
        id: lineId,
        mediaId: item.id,
        sourceId: source.id,
        name: lineSeed.name,
        quality: lineSeed.quality,
        format: lineSeed.format,
        index,
      });
      lineSeed.episodes.forEach((episodeSeed, epIndex) => {
        const number = epIndex + 1;
        episodes.push({
          id: episodeIdOf(item.id, lineId, number),
          mediaId: item.id,
          sourceId: source.id,
          lineId,
          number,
          title: episodeSeed.title,
          durationSec: episodeSeed.durationSec,
          subtitles: [],
          updatedAt: now,
        });
      });
    });
    return { item, lines, episodes };
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId } = params;
    this.assertEnabled(source);
    const seed = findDemoItem(sourceItemId);
    if (!seed) throw new AppError('E_NOT_FOUND');

    const lineIndex = seed.lines.findIndex((_, index) => lineIdOf(mediaIdOf(source.id, seed.itemId), index) === lineId);
    const resolvedIndex = lineIndex >= 0 ? lineIndex : 0;
    const lineSeed = seed.lines[resolvedIndex];
    if (!lineSeed) throw new AppError('E_NO_PLAY_URL');

    const mediaId = mediaIdOf(source.id, seed.itemId);
    const expectedLineId = lineIdOf(mediaId, resolvedIndex);
    const episodeIndex = lineSeed.episodes.findIndex(
      (_, index) => episodeIdOf(mediaId, expectedLineId, index + 1) === episodeId,
    );
    const episodeSeed = lineSeed.episodes[episodeIndex >= 0 ? episodeIndex : 0];
    if (!episodeSeed) throw new AppError('E_NO_PLAY_URL');

    return {
      url: episodeSeed.url,
      format: normalizeFormat(episodeSeed.url, lineSeed.format),
      headers: {},
      subtitles: [],
      lineId: expectedLineId,
      quality: lineSeed.quality,
      expiresAt: null,
      isLocal: false,
    };
  }

  private toItem(source: Source, seed: (typeof DEMO_ITEMS)[number], now: number): MediaItem {
    const episodeCount = seed.type === 'movie' ? null : (seed.lines[0]?.episodes.length ?? null);
    return this.makeItem(source, {
      sourceItemId: seed.itemId,
      title: seed.title,
      type: seed.type,
      originalTitle: seed.originalTitle,
      year: seed.year,
      area: seed.area,
      genres: seed.genres,
      tags: seed.tags,
      rating: seed.rating,
      posterUrl: demoPoster(seed.title, seed.hue),
      description: seed.description,
      durationSec: seed.durationSec,
      episodeCount,
      isDemo: true,
      now,
    });
  }
}

/** HLS 样片地址（AC-96 断言用） */
export const DEMO_HLS_SAMPLE_URL = DEMO_HLS_URL;
