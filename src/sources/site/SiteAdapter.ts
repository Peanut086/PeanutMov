/**
 * 站点源适配器（TVBox 风格 JSON，技术方案 7.6）
 *
 * 仅支持 JSON API（不做 HTML 抓取）；`api?ac=list|detail|search` 三种请求。
 * 播放地址按 `线路$集数` 解析规则处理，不做解析接口的递归解包。
 */
import { AppError } from '@/shared/errors';
import { episodeIdOf, lineIdOf, mediaIdOf } from '@/shared/id';
import { joinUrl, toAbsoluteUrl, withQuery } from '@/shared/url';
import { httpClient } from '@/sources/base/httpClient';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import {
  categoryIdFor,
  fallbackPoster,
  inferMediaType,
  normalizeDurationSec,
  normalizeEpisodeCount,
  normalizeFormat,
  normalizeRating,
  normalizeStringList,
  normalizeTitle,
  normalizeYear,
  parseCategoryValue,
  stripHtml,
} from '@/sources/base/normalize';
import {
  episodeTitleOf,
  looksLikeResolverUrl,
  parsePlayFromField,
  parsePlayUrlField,
  type SiteExt,
  type TvboxListResponse,
  type TvboxVod,
} from '@/sources/site/tvboxTypes';
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

function extOf(source: Source): SiteExt {
  return (source.ext ?? {}) as SiteExt;
}

/** 占位符替换：`{type}` / `{page}` / `{kw}` / `{id}` */
function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(type|page|kw|id)\}/g, (_, key: string) => String(values[key] ?? ''));
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function vodIdOf(vod: TvboxVod): string {
  const raw = vod.vod_id;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return normalizeTitle(vod.vod_name) || 'unknown';
}

export class SiteAdapter extends BaseAdapter {
  readonly type: SourceType = 'site';

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    const response = await this.request(source, 'list', {});
    return { itemCount: response.list?.length ?? response.class?.length ?? 0 };
  }

  async listCategories(source: Source, signal?: AbortSignal): Promise<Category[]> {
    this.assertEnabled(source);
    const response = await this.request(source, 'list', { signal });
    return this.categoriesOf(source, response);
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, page, pageSize, filters } = params;
    this.assertEnabled(source);
    const typeId = parseCategoryValue(source.id, categoryId);
    const response = await this.request(source, 'list', {
      typeId: typeId ?? '',
      page,
      signal: params.signal,
    });
    const rows = (response.list ?? []).filter((vod) => {
      if (filters.type === null) return true;
      return inferMediaType(vod.type_name, vod.vod_name) === filters.type;
    });
    const total = toNumberOrNull(response.total);
    const pageCount = toNumberOrNull(response.pagecount);
    const items = rows.map((vod) => this.toItem(source, vod));
    const hasMore =
      total !== null
        ? page * pageSize < total
        : pageCount !== null
          ? page < pageCount
          : items.length >= pageSize;
    return { items, page, pageSize, total: total ?? (pageCount !== null ? pageCount * pageSize : null), hasMore };
  }

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { source, keyword } = params;
    this.assertEnabled(source);
    const kw = keyword.trim();
    if (kw.length === 0) return [];
    const response = await this.request(source, 'search', { keyword: kw, page: params.page, signal: params.signal });
    return (response.list ?? []).slice(0, params.pageSize).map((vod) => this.toItem(source, vod));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    const response = await this.request(source, 'detail', { ids: sourceItemId, signal: params.signal });
    const vod = response.list?.find((entry) => vodIdOf(entry) === sourceItemId) ?? response.list?.[0];
    if (!vod) throw new AppError('E_NOT_FOUND');

    const item = this.toItem(source, vod);
    const { lines, episodes } = this.buildLinesWithRaw(source, vod, mediaIdOf(source.id, vodIdOf(vod)));
    return { item, lines, episodes };
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId } = params;
    this.assertEnabled(source);
    const response = await this.request(source, 'detail', { ids: sourceItemId, signal: params.signal });
    const vod = response.list?.find((entry) => vodIdOf(entry) === sourceItemId) ?? response.list?.[0];
    if (!vod) throw new AppError('E_NOT_FOUND');

    const { lines, rawEpisodes } = this.buildLinesWithRaw(source, vod, mediaIdOf(source.id, vodIdOf(vod)));
    const lineIndex = lines.findIndex((line) => line.id === lineId);
    const line = lines[lineIndex >= 0 ? lineIndex : 0];
    if (!line) throw new AppError('E_NO_PLAY_URL');
    const list = rawEpisodes[line.index] ?? [];
    const episodeIndex = list.findIndex((entry) => entry.id === episodeId);
    const picked = list[episodeIndex >= 0 ? episodeIndex : 0];
    if (!picked || picked.url.length === 0) throw new AppError('E_NO_PLAY_URL');

    const absolute = toAbsoluteUrl(source.baseUrl, picked.url) ?? picked.url;
    if (looksLikeResolverUrl(absolute)) {
      throw new AppError('E_NO_PLAY_URL', '该源需要解析接口，暂不支持');
    }
    if (!/^https?:\/\//i.test(absolute) && !absolute.startsWith('magnet:')) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '播放地址协议不受支持');
    }

    return {
      url: absolute,
      format: normalizeFormat(absolute, line.format),
      headers: this.headersWith(source),
      subtitles: [],
      lineId: line.id,
      quality: line.quality,
      expiresAt: null,
      isLocal: false,
    };
  }

  /* ---------------- 内部 ---------------- */

  /** 统一请求：按 action 拼 URL 并解析 JSON */
  private async request(
    source: Source,
    action: 'list' | 'detail' | 'search',
    opts: { typeId?: string; page?: number; keyword?: string; ids?: string; signal?: AbortSignal },
  ): Promise<TvboxListResponse> {
    const ext = extOf(source);
    const base = source.baseUrl;
    const page = opts.page ?? 1;

    let url: string;
    const custom =
      action === 'list'
        ? (ext.listPath ?? null)
        : action === 'detail'
          ? (ext.detailPath ?? null)
          : (ext.searchPath ?? null);
    if (custom && custom.trim().length > 0) {
      url = joinUrl(
        base,
        fillTemplate(custom, {
          type: opts.typeId ?? '',
          page,
          kw: encodeURIComponent(opts.keyword ?? ''),
          id: opts.ids ?? '',
        }),
      );
    } else if (action === 'search') {
      url = withQuery(base, { wd: opts.keyword ?? '', ac: 'detail', pg: page });
    } else if (action === 'detail') {
      url = withQuery(base, { ac: 'detail', ids: opts.ids ?? '' });
    } else {
      url = withQuery(base, {
        ac: 'detail',
        t: opts.typeId && opts.typeId.length > 0 ? opts.typeId : undefined,
        pg: page,
      });
    }

    const payload = await httpClient.request<unknown>(url, {
      method: 'GET',
      headers: this.headersWith(source, { Accept: 'application/json' }),
      signal: opts.signal,
      retries: 1,
    });

    if (Array.isArray(payload)) {
      // 少数站点直接返回数组
      return { list: payload as TvboxVod[] };
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new AppError('E_PARSE', '站点返回的数据格式不支持');
    }
    const response = payload as TvboxListResponse;
    if (response.list !== undefined && response.list !== null && !Array.isArray(response.list)) {
      throw new AppError('E_PARSE', '站点返回的 list 字段不是数组');
    }
    return response;
  }

  private categoriesOf(source: Source, response: TvboxListResponse): Category[] {
    const classes = response.class ?? [];
    return classes
      .map((entry, index) => {
        const value = entry.type_id ?? entry.id ?? null;
        const name = normalizeTitle(entry.type_name ?? entry.name ?? '');
        if (value === null || name.length === 0) return null;
        return {
          id: categoryIdFor(source.id, String(value)),
          sourceId: source.id,
          name,
          value: String(value),
          order: index,
        };
      })
      .filter((entry): entry is Category => entry !== null);
  }

  /** 同时产出 PlayLine / Episode / 原始地址（resolvePlayUrl 复用） */
  private buildLinesWithRaw(
    source: Source,
    vod: TvboxVod,
    mediaId: string,
  ): {
    lines: PlayLine[];
    episodes: Episode[];
    rawEpisodes: Array<Array<{ id: string; url: string; title: string; number: number }>>;
  } {
    const fromNames = parsePlayFromField(vod.vod_play_from);
    const parsed = parsePlayUrlField(vod.vod_play_url, fromNames.length);
    const now = Date.now();

    const lines: PlayLine[] = [];
    const episodes: Episode[] = [];
    const rawEpisodes: Array<Array<{ id: string; url: string; title: string; number: number }>> = [];

    parsed.forEach((segment, index) => {
      if (segment.episodes.length === 0) return;
      const lineId = lineIdOf(mediaId, index);
      const lineName = fromNames[index] ?? `线路 ${index + 1}`;
      const firstUrl = segment.episodes[0]?.url ?? '';
      lines.push({
        id: lineId,
        mediaId,
        sourceId: source.id,
        name: lineName,
        quality: null,
        format: normalizeFormat(firstUrl, 'mp4'),
        index,
      });
      const rawList: Array<{ id: string; url: string; title: string; number: number }> = [];
      segment.episodes.forEach((entry, epIndex) => {
        const number = epIndex + 1;
        const title = episodeTitleOf(entry.name, epIndex);
        const id = episodeIdOf(mediaId, lineId, number);
        rawList.push({ id, url: entry.url, title, number });
        episodes.push({
          id,
          mediaId,
          sourceId: source.id,
          lineId,
          number,
          title,
          durationSec: null,
          subtitles: [],
          updatedAt: now,
        });
      });
      rawEpisodes[index] = rawList;
    });

    return { lines, episodes, rawEpisodes };
  }

  private toItem(source: Source, vod: TvboxVod): MediaItem {
    const title = normalizeTitle(vod.vod_name);
    const episodeCount = normalizeEpisodeCount(vod.vod_remarks);
    return this.makeItem(source, {
      sourceItemId: vodIdOf(vod),
      title: title || '未命名',
      type: inferMediaType(vod.type_name, vod.vod_name),
      year: normalizeYear(vod.vod_year),
      area: vod.vod_area ? normalizeTitle(vod.vod_area) : null,
      genres: normalizeStringList(vod.type_name),
      tags: normalizeStringList(vod.vod_remarks).slice(0, 3),
      rating: normalizeRating(vod.vod_score),
      posterUrl: toAbsoluteUrl(source.baseUrl, vod.vod_pic) ?? fallbackPoster(title),
      description: stripHtml(vod.vod_content),
      durationSec: normalizeDurationSec(vod.vod_remarks),
      episodeCount,
      now: Date.now(),
    });
  }
}
