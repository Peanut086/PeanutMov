/**
 * 站点源适配器（TVBox 风格 JSON，技术方案 7.6）
 *
 * 仅支持 JSON API（不做 HTML 抓取）；`api?ac=list|detail|search` 三种请求。
 * 播放地址按 `线路$集数` 解析规则处理。
 * 功能扩展-6：支持解析接口（jx）——优先直连 API 解析，回退 WebView 嗅探。
 */
import { AppError } from '@/shared/errors';
import { mediaIdOf } from '@/shared/id';
import { joinUrl, toAbsoluteUrl, withQuery } from '@/shared/url';
import { logger } from '@/shared/logger';
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
import { resolveViaMultiple } from '@/services/resolverService';
import { selectEpisodeInDetail } from '@/sources/mapping/EpisodeMappingService';
import { titleMatches, titleMatchScore } from '@/sources/mapping/TitleNormalizer';
import type { EpisodeLookupMatch } from '@/services/UnifiedEpisodeService';
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

/**
 * 按「片名 + 集数序号」查到的剧集（EXT-03 跨源统一映射用）。
 *
 * 与 `SpiderAdapter` 的 `SpiderEpisodeMatch` 同构（都指向 FIX-05 的 `EpisodeMappingTarget`），
 * 统一剧集服务可以不加区分地消费两个适配器的直查结果。
 */
export type SiteEpisodeMatch = EpisodeLookupMatch;

/** 非订阅 JSON 的统一用户文案（17.7.2，四条 format 类共用；与管道同一常量） */
const UNSUPPORTED_FORMAT_MESSAGE = UNSUPPORTED_FORMAT_MESSAGE_PIPELINE;

/** 占位符替换：`{type}` / `{page}` / `{kw}` / `{id}` */
function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(type|page|kw|id)\}/g, (_, key: string) => String(values[key] ?? ''));
}

/**
 * 功能扩展-6：从解析接口 URL 中提取原始视频地址。
 *
 * 解析接口典型形态：`https://jx.xxx.com/?url=VIDEO_URL` 或 `https://jx.xxx.com/?url=VIDEO_URL&other=xxx`
 * 提取 提取 提取 返回 null（表示无法提取，回退到 WebView 嗅）。
 */
function extractOriginalVideoUrl(resolverUrl: string): string | null {
  try {
    const url = new URL(resolverUrl);
    const videoUrl = url.searchParams.get('url');
    if (!videoUrl || videoUrl.trim().length === 0) return null;
    // 基本校验：必须是 http/https 开头
    if (!/^https?:\/\//i.test(videoUrl)) return null;
    return videoUrl;
  } catch {
    return null;
  }
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
    const extFilters = filters.ext && Object.keys(filters.ext).length > 0 ? filters.ext : null;
    const response = await this.request(source, 'list', {
      typeId: typeId ?? '',
      page,
      filter: extFilters,
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
    const response = await this.request(source, 'search', { keyword: kw, page: params.page, signal: params.signal, budgetMs: params.budgetMs });
    return (response.list ?? []).slice(0, params.pageSize).map((vod) => this.toItem(source, vod));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    const response = await this.request(source, 'detail', { ids: sourceItemId, signal: params.signal });
    const list = response.list ?? [];
    const matched = list.find((entry) => vodIdOf(entry) === sourceItemId);
    // P0-3: list[0] 兜底仅在「单条且无 vod_id」时安全；多条目或条目有 id 但不匹配时拒绝
    const vod = matched ?? (list.length === 1 && !vodIdHasValue(list[0]) ? list[0] : null);
    if (!vod) {
      logger.warn('SiteAdapter.getDetail: 源返回条目与请求不一致', {
        source: source.name,
        sourceItemId,
        listCount: list.length,
        firstVodId: list[0] ? vodIdOf(list[0]) : null,
      });
      throw new AppError('E_SOURCE_UNAVAILABLE', '源详情返回的条目与请求不一致', {
        detail: `sourceItemId=${sourceItemId}, listCount=${list.length}`,
      });
    }

    // P0-1: mediaId 必须基于请求时的 sourceItemId（而非 API 返回的 vodId，后者可能为空/不稳定）
    const stableMediaId = mediaIdOf(source.id, sourceItemId);
    const item = this.toItem(source, vod);
    item.id = stableMediaId;
    item.sourceItemId = sourceItemId;
    const { lines, episodes } = this.buildLinesWithRaw(source, vod, stableMediaId);
    logger.debug('SiteAdapter.getDetail: 详情加载完成', {
      source: source.name,
      sourceItemId,
      title: item.title,
      lines: lines.length,
      episodes: episodes.length,
    });
    return { item, lines, episodes };
  }

  /**
   * 按「片名 + 集数序号」找剧集（EXT-03）。
   *
   * 发现源（豆瓣）只知道片名与「第几集」，不知道本站的条目 id / 剧集 id：
   * 这里先用 `search` 找片、按片名相似度排序（季号/续集号冲突直接排除），
   * 再逐个取详情，用 `selectEpisodeInDetail` 按集号定位。
   *
   * 返回的命中自带 `source`（源标识）与可直接交给 `resolvePlayUrl` 的 `lineId` / `episodeId`。
   * 找不到返回 null——**不返回第一集兜底**。
   */
  async findEpisodeByTitle(
    title: string,
    episodeIndex: number,
    ctx: { source: Source; year?: number | null; signal?: AbortSignal; limit?: number },
  ): Promise<SiteEpisodeMatch | null> {
    const { source, year = null, signal, limit = 8 } = ctx;
    this.assertEnabled(source);
    const keyword = title.trim();
    const index = Math.trunc(episodeIndex);
    if (keyword.length === 0 || !Number.isFinite(index) || index < 1) return null;

    const found = await this.search({ source, keyword, page: 1, pageSize: limit, signal });
    const ranked = found
      .filter((item) => titleMatches(keyword, item.title))
      .filter((item) => year === null || item.year === null || item.year === year)
      .map((item) => ({ item, score: titleMatchScore(keyword, item.title) }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return null;

    let lastError: unknown = null;
    let failures = 0;
    for (const { item } of ranked) {
      signal?.throwIfAborted();
      try {
        const detail = await this.getDetail({ source, sourceItemId: item.sourceItemId, signal });
        const selection = selectEpisodeInDetail(detail, index);
        if (selection === null) continue;
        return {
          source,
          item: detail.item,
          line: selection.line,
          episode: selection.episode,
          lineId: selection.line.id,
          episodeId: selection.episode.id,
          episodeNumber: selection.episode.number,
          episodeTitle: selection.episode.title,
        };
      } catch (e) {
        lastError = e;
        failures += 1;
      }
    }
    // 全部候选的详情都取不到：把真实故障抛出去（区别于「没有这一集」）
    if (failures > 0 && failures === ranked.length) throw lastError;
    return null;
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId, episodeNumber } = params;
    this.assertEnabled(source);
    const response = await this.request(source, 'detail', { ids: sourceItemId, signal: params.signal });
    const list = response.list ?? [];
    const matched = list.find((entry) => vodIdOf(entry) === sourceItemId);
    // P0-3: list[0] 兜底仅在「单条且无 vod_id」时安全
    const vod = matched ?? (list.length === 1 && !vodIdHasValue(list[0]) ? list[0] : null);
    if (!vod) {
      throw new AppError('E_SOURCE_UNAVAILABLE', '源详情返回的条目与请求不一致', {
        detail: `sourceItemId=${sourceItemId}, listCount=${list.length}`,
      });
    }

    // P0-1: mediaId 基于请求参数而非 API 返回的 vodId（可能为空/不稳定）
    const stableMediaId = mediaIdOf(source.id, sourceItemId);
    const { lines, rawEpisodes } = this.buildLinesWithRaw(source, vod, stableMediaId);
    const lineIndex = lines.findIndex((line) => line.id === lineId);
    const line = lines[lineIndex >= 0 ? lineIndex : 0];
    if (!line) throw new AppError('E_NO_PLAY_URL');
    const epList = rawEpisodes[line.index] ?? [];
    let episodeIndex = epList.findIndex((entry) => entry.id === episodeId);
    // P0-4: id 匹配失败时，按序号兜底
    if (episodeIndex < 0 && episodeNumber !== undefined) {
      episodeIndex = epList.findIndex((entry) => entry.number === episodeNumber);
    }
    const picked = epList[episodeIndex >= 0 ? episodeIndex : 0];
    if (!picked || picked.url.length === 0) throw new AppError('E_NO_PLAY_URL');

    const absolute = toAbsoluteUrl(source.baseUrl, picked.url) ?? picked.url;
    if (looksLikeResolverUrl(absolute)) {
      // 功能扩展-6：解析接口（jx）支持
      // ① 优先尝试配置的解析接口列表（直连 API，速度快）
      const ext = extOf(source);
      const resolvers = ext.resolvers ?? [];
      if (resolvers.length > 0 && !(params.signal?.aborted ?? false)) {
        // 提取原始视频（解析接口需要的是被包装的 URL，不是解析接口本身）
        const originalVideoUrl = extractOriginalVideoUrl(absolute);
        if (originalVideoUrl) {
          const resolved = await resolveViaMultiple(resolvers, originalVideoUrl, params.signal);
          if (resolved) {
            return {
              url: resolved,
              format: normalizeFormat(resolved, line.format),
              headers: this.headersWith(source),
              subtitles: [],
              lineId: line.id,
              quality: line.quality,
              expiresAt: null,
              isLocal: false,
            };
          }
        }
      }

      // ② 回退：App 内走 WebView 嗅探取真实直链
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
      throw new AppError('E_NO_PLAY_URL', '该源需要解析接口，但未配置或嗅探失败');
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
    opts: {
      typeId?: string;
      page?: number;
      keyword?: string;
      ids?: string;
      /** 服务端筛选选中值（key→value），仅 list 动作使用 */
      filter?: Record<string, string> | null;
      signal?: AbortSignal;
      /** SO-05：透传搜索预算到 crawl 管道 */
      budgetMs?: number;
    },
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

    /**
     * 服务端筛选附加到列表 URL：维度键各自成参（MacCMS 通用），
     * 同时带 `f={json}` 兼容按 f 解析的实现；未知参数服务端会忽略。
     */
    const withFilterParams = (url: string): string => {
      if (action !== 'list' || !opts.filter) return url;
      return withQuery(url, { ...opts.filter, f: JSON.stringify(opts.filter) });
    };

    const send = async (ac: 'detail' | 'videolist'): Promise<TvboxListResponse> => {
      const url = withFilterParams(buildUrl(ac));
      try {
        // 格式判定与解析统一交给爬虫管道（指纹 → 规则 → 解析器），
        // 这里只负责拼 URL 与 `ac=videolist` 业务回退。
        const result = await crawl<TvboxListResponse>({
          intent: action === 'search' ? 'search' : action === 'detail' ? 'detail' : 'catalog',
          url,
          headers: this.headersWith(source, { Accept: 'application/json' }),
          signal: opts.signal,
          budgetMs: opts.budgetMs,
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

    // SO-09：搜索直接走 videolist，跳过先试 detail 再回退的两步流程（省一半预算）。
    // 列表/详情仍保留 detail→videolist 回退。
    if (action === 'search') {
      return send('videolist');
    }

    const first = await send('detail');
    // 老版 CMS 只认 `ac=videolist`：列表/详情返回空时回退一次。
    // 自定义路径不参与回退（用户已显式指定 URL 模板）。
    if (usesCustomPath) return first;
    if ((first.list?.length ?? 0) > 0) return first;

    const fallback = await send('videolist');
    return (fallback.list?.length ?? 0) > 0 ? fallback : first;
  }

  /* ---------------- 内部 ---------------- */

  private categoriesOf(source: Source, response: TvboxListResponse): Category[] {
    return categoriesOf(source, response.class, response);
  }

  /** 同时产出 PlayLine / Episode / 原始地址（resolvePlayUrl 复用） */
  private buildLinesWithRaw(source: Source, vod: TvboxVod, mediaId: string) {
    return buildLinesWithRaw(source, vod, mediaId);
  }

  private toItem(source: Source, vod: TvboxVod): MediaItem {
    return toItemFromVod(source, vod, (input) => this.makeItem(source, input));
  }
}

/** P0-3: 检查 vod 条目是否有有效的 vod_id（非空/非 'unknown' 兜底值） */
function vodIdHasValue(vod: TvboxVod): boolean {
  const id = vod.vod_id;
  if (id === null || id === undefined) return false;
  if (typeof id === 'string' && id.trim().length === 0) return false;
  return true;
}
