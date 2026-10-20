/**
 * Jellyfin 适配器（API-01）
 *
 * 流程（技术方案 6 章）：
 * - `GET /Users/{userId}/Items` + `api_key` 浏览媒体库或某库内条目；
 * - `GET /Items?Ids={id}` 取详情（含 `MediaSources`）；
 * - `PlaybackInfo` 优先取 `MediaSources[].Path` / `DirectStreamUrl`，其次 `TranscodingUrl`。
 *
 * 认证：`ext.apiKey`（或 `auth.token`）+ `ext.userId`（或 `auth.username`）；
 * 库（`Views`）→ 分类；剧集（`Series`）→ `Episodes` 作为剧集列表。
 */
import { AppError } from '@/shared/errors';
import { episodeIdOf, lineIdOf, mediaIdOf } from '@/shared/id';
import { joinUrl, withQuery } from '@/shared/url';
import { httpClient } from '@/sources/base/httpClient';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import {
  categoryIdFor,
  fallbackPoster,
  inferMediaType,
  normalizeEpisodeCount,
  normalizeFormat,
  normalizeRating,
  normalizeStringList,
  normalizeTitle,
  normalizeYear,
  parseCategoryValue,
  stripHtml,
} from '@/sources/base/normalize';
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

interface JellyfinExt {
  apiKey?: string | null;
  userId?: string | null;
}

interface JellyfinItem {
  Id: string;
  Name: string;
  OriginalTitle?: string | null;
  Type: string;
  ProductionYear?: number | null;
  Overview?: string | null;
  CommunityRating?: number | null;
  OfficialRating?: string | null;
  Genres?: string[] | null;
  RunTimeTicks?: number | null;
  IndexNumber?: number | null;
  ParentIndexNumber?: number | null;
  SeriesId?: string | null;
  SeriesName?: string | null;
  CollectionType?: string | null;
  ImageTags?: Record<string, string> | null;
  BackdropImageTags?: string[] | null;
  ChildCount?: number | null;
  RecursiveItemCount?: number | null;
  MediaSources?: JellyfinMediaSource[] | null;
  UserData?: { PlayedPercentage?: number | null; PlaybackPositionTicks?: number | null } | null;
}

interface JellyfinMediaSource {
  Id: string;
  Name?: string | null;
  Path?: string | null;
  Container?: string | null;
  Size?: number | null;
  DirectStreamUrl?: string | null;
  TranscodingUrl?: string | null;
  SupportsDirectStream?: boolean | null;
}

interface ItemsResult {
  Items?: JellyfinItem[] | null;
  TotalRecordCount?: number | null;
}

const TICKS_PER_SECOND = 10_000_000;

function ticksToSeconds(ticks: number | null | undefined): number | null {
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks <= 0) return null;
  return Math.round(ticks / TICKS_PER_SECOND);
}

function extOf(source: Source): JellyfinExt {
  return (source.ext ?? {}) as JellyfinExt;
}

function apiKeyOf(source: Source): string | null {
  if (source.auth.token && source.auth.token.trim().length > 0) return source.auth.token.trim();
  const key = extOf(source).apiKey;
  return key && key.trim().length > 0 ? key.trim() : null;
}

function userIdOf(source: Source): string | null {
  const userId = extOf(source).userId;
  if (userId && userId.trim().length > 0) return userId.trim();
  const username = source.auth.username;
  return username && username.trim().length > 0 ? username.trim() : null;
}

function assertConfigured(source: Source): { apiKey: string; userId: string } {
  const apiKey = apiKeyOf(source);
  const userId = userIdOf(source);
  if (!apiKey) throw new AppError('E_INVALID_INPUT', '缺少 Jellyfin API Key');
  if (!userId) throw new AppError('E_INVALID_INPUT', '缺少 Jellyfin 用户 ID');
  return { apiKey, userId };
}

export class JellyfinAdapter extends BaseAdapter {
  readonly type: SourceType = 'jellyfin';

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    const { apiKey, userId } = assertConfigured(source);
    const result = await this.get<ItemsResult>(source, `/Users/${encodeURIComponent(userId)}/Views`, {
      apiKey,
      signal: undefined,
    });
    const count = result.Items?.length ?? 0;
    return { itemCount: count };
  }

  async listCategories(source: Source, signal?: AbortSignal): Promise<Category[]> {
    this.assertEnabled(source);
    const { apiKey, userId } = assertConfigured(source);
    const result = await this.get<ItemsResult>(source, `/Users/${encodeURIComponent(userId)}/Views`, {
      apiKey,
      signal,
    });
    const views = result.Items ?? [];
    if (views.length === 0) {
      return [{ id: categoryIdFor(source.id, 'all'), sourceId: source.id, name: '全部', value: 'all', order: 0 }];
    }
    return views.map((view, index) => ({
      id: categoryIdFor(source.id, view.Id),
      sourceId: source.id,
      name: normalizeTitle(view.Name),
      value: view.Id,
      order: index,
    }));
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, page, pageSize } = params;
    this.assertEnabled(source);
    const { apiKey, userId } = assertConfigured(source);
    const parentId = parseCategoryValue(source.id, categoryId) ?? 'all';

    const query: Record<string, string | number> = {
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series,Video,Episode',
      Fields: 'Overview,Genres,ProductionYear,CommunityRating,ChildCount,RunTimeTicks,ImageTags',
      StartIndex: (page - 1) * pageSize,
      Limit: pageSize,
      SortBy: 'SortName',
      SortOrder: 'Ascending',
    };
    if (parentId !== 'all') query['ParentId'] = parentId;

    const url = `/Users/${encodeURIComponent(userId)}/Items`;
    const result = await this.get<ItemsResult>(source, url, { apiKey, query, signal: params.signal });
    const items = result.Items ?? [];
    const total = result.TotalRecordCount ?? items.length;

    return {
      items: items.map((item) => this.toItem(source, item)),
      page,
      pageSize,
      total,
      hasMore: page * pageSize < total,
    };
  }

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { source, keyword } = params;
    this.assertEnabled(source);
    const { apiKey, userId } = assertConfigured(source);
    const result = await this.get<ItemsResult>(source, `/Users/${encodeURIComponent(userId)}/Items`, {
      apiKey,
      query: {
        Recursive: 'true',
        SearchTerm: keyword,
        IncludeItemTypes: 'Movie,Series,Video',
        Fields: 'Overview,Genres,ProductionYear,CommunityRating,ChildCount',
        Limit: params.pageSize,
      },
      signal: params.signal,
    });
    return (result.Items ?? []).map((item) => this.toItem(source, item));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    const { apiKey, userId } = assertConfigured(source);
    const item = await this.getItemById(source, sourceItemId, apiKey, userId, params.signal);
    if (!item) throw new AppError('E_NOT_FOUND');

    const mediaItem = this.toItem(source, item);
    const lineId = lineIdOf(mediaItem.id, 0);
    const line: PlayLine = {
      id: lineId,
      mediaId: mediaItem.id,
      sourceId: source.id,
      name: 'Jellyfin 直连',
      quality: null,
      format: normalizeFormat(item.MediaSources?.[0]?.Container ?? 'mp4', 'mp4'),
      index: 0,
    };

    let episodes: Episode[] = [];
    if (item.Type === 'Series') {
      const childResult = await this.get<ItemsResult>(
        source,
        `/Shows/${encodeURIComponent(item.Id)}/Episodes`,
        {
          apiKey,
          query: {
            userId,
            Fields: 'Overview,RunTimeTicks,IndexNumber,ParentIndexNumber',
            SortBy: 'ParentIndexNumber,IndexNumber',
            SortOrder: 'Ascending',
          },
          signal: params.signal,
        },
      );
      episodes = (childResult.Items ?? []).map((child) => this.toEpisode(source, mediaItem.id, lineId, child));
    } else {
      episodes = [this.toEpisode(source, mediaItem.id, lineId, item)];
    }

    return { item: mediaItem, lines: [line], episodes };
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId } = params;
    this.assertEnabled(source);
    const { apiKey, userId } = assertConfigured(source);

    // 剧集场景：episodeId 由 mediaId+lineId+number 生成，需要反查 Jellyfin 的真实条目 Id
    let targetId = sourceItemId;
    const detail = await this.getItemById(source, sourceItemId, apiKey, userId, params.signal);
    if (!detail) throw new AppError('E_NOT_FOUND');
    if (detail.Type === 'Series') {
      const childResult = await this.get<ItemsResult>(
        source,
        `/Shows/${encodeURIComponent(detail.Id)}/Episodes`,
        {
          apiKey,
          query: { userId, Fields: 'RunTimeTicks,IndexNumber' },
          signal: params.signal,
        },
      );
      const mediaId = mediaIdOf(source.id, sourceItemId);
      const matched = (childResult.Items ?? []).find(
        (child) =>
          episodeIdOf(mediaId, lineId, this.episodeNumberOf(child)) === episodeId,
      );
      if (!matched) throw new AppError('E_NOT_FOUND', '该集在源中已不存在');
      targetId = matched.Id;
    }

    const playback = await this.get<{ MediaSources?: JellyfinMediaSource[] | null }>(
      source,
      `/Items/${encodeURIComponent(targetId)}/PlaybackInfo`,
      { apiKey, signal: params.signal },
    );
    const sources = playback.MediaSources ?? [];
    const picked = sources[0];
    if (!picked) throw new AppError('E_NO_PLAY_URL');

    const url = this.resolveSourceUrl(source, picked, apiKey, userId);
    if (!url) throw new AppError('E_NO_PLAY_URL');

    return {
      url,
      format: normalizeFormat(picked.Container ?? picked.Path ?? '', 'mp4'),
      headers: apiKey ? { 'X-Emby-Token': apiKey } : {},
      subtitles: [],
      lineId,
      quality: picked.Name ?? null,
      expiresAt: null,
      isLocal: false,
    };
  }

  /* ---------------- 内部 ---------------- */

  private resolveSourceUrl(
    source: Source,
    mediaSource: JellyfinMediaSource,
    apiKey: string,
    userId: string,
  ): string | null {
    if (mediaSource.DirectStreamUrl && mediaSource.DirectStreamUrl.length > 0) {
      return joinUrl(source.baseUrl, mediaSource.DirectStreamUrl);
    }
    if (mediaSource.Path && /^https?:\/\//i.test(mediaSource.Path)) {
      return mediaSource.Path;
    }
    if (mediaSource.TranscodingUrl && mediaSource.TranscodingUrl.length > 0) {
      const withKey = withQuery(joinUrl(source.baseUrl, mediaSource.TranscodingUrl), { api_key: apiKey });
      return withKey;
    }
    if (mediaSource.Id) {
      // 兜底：走通用流接口
      return withQuery(joinUrl(source.baseUrl, `/Videos/${encodeURIComponent(mediaSource.Id)}/stream`), {
        static: 'true',
        api_key: apiKey,
        userId,
      });
    }
    return null;
  }

  private posterUrl(source: Source, item: JellyfinItem): string | null {
    const tag = item.ImageTags?.['Primary'];
    if (!item.Id || !tag) return null;
    return withQuery(
      joinUrl(source.baseUrl, `/Items/${encodeURIComponent(item.Id)}/Images/Primary`),
      { tag, quality: 90, maxHeight: 450 },
    );
  }

  private backdropUrl(source: Source, item: JellyfinItem): string | null {
    const tag = item.BackdropImageTags?.[0];
    if (!item.Id || !tag) return null;
    return withQuery(
      joinUrl(source.baseUrl, `/Items/${encodeURIComponent(item.Id)}/Images/Backdrop`),
      { tag, quality: 80, maxWidth: 640 },
    );
  }

  private async getItemById(
    source: Source,
    id: string,
    apiKey: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<JellyfinItem | null> {
    const result = await this.get<ItemsResult>(source, `/Users/${encodeURIComponent(userId)}/Items`, {
      apiKey,
      query: { Ids: id, Fields: 'Overview,Genres,ProductionYear,CommunityRating,ChildCount,RunTimeTicks' },
      signal,
    });
    return result.Items?.[0] ?? null;
  }

  private toItem(source: Source, item: JellyfinItem): MediaItem {
    const type = inferMediaType(item.Type, item.Name, (item.Genres ?? []).join(' '));
    const episodeCount = item.Type === 'Series' ? (item.RecursiveItemCount ?? item.ChildCount ?? null) : null;
    return this.makeItem(source, {
      sourceItemId: item.Id,
      title: normalizeTitle(item.Name),
      type,
      originalTitle: item.OriginalTitle ?? null,
      year: normalizeYear(item.ProductionYear),
      area: null,
      genres: normalizeStringList(item.Genres),
      rating: normalizeRating(item.CommunityRating),
      posterUrl: this.posterUrl(source, item) ?? fallbackPoster(item.Name),
      backdropUrl: this.backdropUrl(source, item),
      description: stripHtml(item.Overview),
      durationSec: ticksToSeconds(item.RunTimeTicks),
      episodeCount: episodeCount ?? normalizeEpisodeCount(item.ChildCount),
      now: Date.now(),
    });
  }

  private episodeNumberOf(item: JellyfinItem): number {
    if (typeof item.IndexNumber === 'number' && item.IndexNumber > 0) return item.IndexNumber;
    return normalizeEpisodeCount(item.Name) ?? 1;
  }

  private toEpisode(source: Source, mediaId: string, lineId: string, item: JellyfinItem): Episode {
    const number = this.episodeNumberOf(item);
    return {
      id: episodeIdOf(mediaId, lineId, number),
      mediaId,
      sourceId: source.id,
      lineId,
      number,
      title: normalizeTitle(item.Name),
      durationSec: ticksToSeconds(item.RunTimeTicks),
      subtitles: [],
      updatedAt: Date.now(),
    };
  }

  private async get<T>(
    source: Source,
    path: string,
    opts: {
      apiKey: string;
      query?: Record<string, string | number>;
      signal?: AbortSignal;
    },
  ): Promise<T> {
    const url = withQuery(joinUrl(source.baseUrl, path), { ...(opts.query ?? {}) });
    return httpClient.request<T>(url, {
      method: 'GET',
      headers: this.headersWith(source, {
        Authorization: `MediaBrowser Token="${opts.apiKey}"`,
        'X-Emby-Token': opts.apiKey,
        Accept: 'application/json',
      }),
      signal: opts.signal,
      retries: 0,
    });
  }
}

/** 播放信息类型（导出便于测试构造 fixture） */
export type { JellyfinItem, JellyfinMediaSource, ItemsResult };