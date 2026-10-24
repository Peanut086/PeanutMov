/**
 * 站点源适配器（TVBox 风格 JSON，技术方案 7.6）
 *
 * 仅支持 JSON API（不做 HTML 抓取）；`api?ac=list|detail|search` 三种请求。
 * 播放地址按 `线路$集数` 解析规则处理，不做解析接口的递归解包。
 */
import { AppError } from '@/shared/errors';
import { mediaIdOf } from '@/shared/id';
import { joinUrl, toAbsoluteUrl, withQuery } from '@/shared/url';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import { deriveHasMore } from '@/sources/base/pagination';
import { crawl } from '@/sources/pipeline/scheduler';
import { UNSUPPORTED_FORMAT_MESSAGE as UNSUPPORTED_FORMAT_MESSAGE_PIPELINE } from '@/sources/pipeline/messages';
import { inferMediaType, normalizeFormat, parseCategoryValue } from '@/sources/base/normalize';
import { looksLikeResolverUrl, type SiteExt, type TvboxListResponse, type TvboxVod } from '@/sources/site/tvboxTypes';
import {
  buildLinesWithRaw,
  categoriesOf,
  toItemFromVod,
  toNumberOrNull,
  vodIdOf,
} from '@/sources/site/tvboxNormalize';
import { isPlayPageUrl, resolvePlayPage } from '@/sources/site/playPageResolver';
import { sniffPlayUrl } from '@/native/snifferPlugin';
import { isNative } from '@/shared/platform';
import { TIMEOUT_SEARCH_SITE_MS } from '@/shared/constants';
import type {
  BrowseParams,
  Category,
  GetDetailParams,
  MediaDetail,
  MediaItem,
  PageResult,
  PlaybackSource,
  ResolvePlayParams,
  SearchParams,
  Source,
  SourceType,
} from '@/types';

function extOf(source: Source): SiteExt {
  return (source.ext ?? {}) as SiteExt;
}

/** 非订阅 JSON 的统一用户文案（17.7.2，四条 format 类共用；与管道同一常量） */
const UNSUPPORTED_FORMAT_MESSAGE = UNSUPPORTED_FORMAT_MESSAGE_PIPELINE;

/** 占位符替换：`{type}` / `{page}` / `{kw}` / `{id}` */
function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(type|page|kw|id)\}/g, (_, key: string) => String(values[key] ?? ''));
}

export class SiteAdapter extends BaseAdapter {
  readonly type: SourceType = 'site';

  /** CHG-15：CMS 搜索是单次模板请求，5s 在慢网下偏紧，放宽到 8s */
  override readonly searchTimeoutMs: number = TIMEOUT_SEARCH_SITE_MS;

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
    const allRows = response.list ?? [];
    const rows = allRows.filter((vod) => {
      if (filters.type === null) return true;
      return inferMediaType(vod.type_name, vod.vod_name) === filters.type;
    });
    const total = toNumberOrNull(response.total);
    const pageCount = toNumberOrNull(response.pagecount);
    const items = rows.map((vod) => this.toItem(source, vod));
    const hasMore = deriveHasMore({ page, rawCount: allRows.length, total, pageCount });
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
      // 解析器地址（jx 页面）：App 内走 WebView 嗅探取真实直链
      if (isNative() && !(params.signal?.aborted ?? false)) {
        const sniffed = await sniffPlayUrl(absolute, this.headersWith(source)).catch(() => null);
        if (sniffed) {
          return {
            url: sniffed,
            format: normalizeFormat(sniffed, line.format),
            headers: this.headersWith(source),
            subtitles: [],
            lineId: line.id,
            quality: line.quality,
            expiresAt: null,
            isLocal: false,
          };
        }
      }
      throw new AppError('E_NO_PLAY_URL', '该源需要解析接口，暂不支持');
    }
    if (!/^https?:\/\//i.test(absolute) && !absolute.startsWith('magnet:')) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '播放地址协议不受支持');
    }

    // 网页播放页（/share/<id>、/play/<id>、*.html）：真实 m3u8 明文写在页面里，
    // 必须先取出直链，否则 ffmpeg 会把 HTML 当媒体解封装并报「暂不支持该格式」。
    const headers = this.headersWith(source);
    const resolved = isPlayPageUrl(absolute)
      ? await resolvePlayPage(absolute, { headers, signal: params.signal })
      : absolute;

    return {
      url: resolved,
      format: normalizeFormat(resolved, line.format),
      headers,
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

    const custom =
      action === 'list'
        ? (ext.listPath ?? null)
        : action === 'detail'
          ? (ext.detailPath ?? null)
          : (ext.searchPath ?? null);
    const usesCustomPath = custom !== null && custom.trim().length > 0;

    const buildUrl = (ac: 'detail' | 'videolist'): string => {
      if (usesCustomPath && custom) {
        return joinUrl(
          base,
          fillTemplate(custom, {
            type: opts.typeId ?? '',
            page,
            kw: encodeURIComponent(opts.keyword ?? ''),
            id: opts.ids ?? '',
          }),
        );
      }
      if (action === 'search') {
        return withQuery(base, { wd: opts.keyword ?? '', ac, pg: page });
      }
      if (action === 'detail') {
        return withQuery(base, { ac, ids: opts.ids ?? '' });
      }
      return withQuery(base, {
        ac,
        t: opts.typeId && opts.typeId.length > 0 ? opts.typeId : undefined,
        pg: page,
      });
    };

    const send = async (ac: 'detail' | 'videolist'): Promise<TvboxListResponse> => {
      const url = buildUrl(ac);
      try {
        // 格式判定与解析统一交给爬虫管道（指纹 → 规则 → 解析器），
        // 这里只负责拼 URL 与 `ac=videolist` 业务回退。
        const result = await crawl<TvboxListResponse>({
          intent: action === 'search' ? 'search' : action === 'detail' ? 'detail' : 'catalog',
          url,
          headers: this.headersWith(source, { Accept: 'application/json' }),
          signal: opts.signal,
        });
        return result.value;
      } catch (e) {
        // `httpClient` 的 E_PARSE 语义被其它适配器依赖，只在此处包装为格式错误（17.7.3）
        if (e instanceof AppError && e.code === 'E_PARSE') {
          throw new AppError('E_UNSUPPORTED_FORMAT', UNSUPPORTED_FORMAT_MESSAGE, {
            detail: e.detail ?? e.message,
            cause: e,
          });
        }
        throw e;
      }
    };

    const first = await send('detail');
    // 老版 CMS 只认 `ac=videolist`：列表/搜索/详情返回空时回退一次。
    // 自定义路径不参与回退（用户已显式指定 URL 模板）。
    if (usesCustomPath) return first;
    if ((first.list?.length ?? 0) > 0) return first;

    const fallback = await send('videolist');
    return (fallback.list?.length ?? 0) > 0 ? fallback : first;
  }

  /* ---------------- 内部 ---------------- */

  private categoriesOf(source: Source, response: TvboxListResponse): Category[] {
    return categoriesOf(source, response.class);
  }

  /** 同时产出 PlayLine / Episode / 原始地址（resolvePlayUrl 复用） */
  private buildLinesWithRaw(source: Source, vod: TvboxVod, mediaId: string) {
    return buildLinesWithRaw(source, vod, mediaId);
  }

  private toItem(source: Source, vod: TvboxVod): MediaItem {
    return toItemFromVod(source, vod, (input) => this.makeItem(source, input));
  }
}
