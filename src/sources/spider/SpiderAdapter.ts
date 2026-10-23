/**
 * 爬虫源适配器（TVBox jar 爬虫，技术方案 7.3 的 `spider` 类型）
 *
 * 数据流：
 *   订阅条目（type 3 + api=csp_XBPQ + jar）→ `spider` 源
 *   → 原生插件下载/加载 jar → 反射调用 `homeContent`/`categoryContent`/`detailContent`/
 *     `searchContent`/`playerContent` → 返回 TVBox JSON 字符串
 *   → 本适配器解析 JSON 并复用 `tvboxNormalize` 归一化
 *
 * 与 `SiteAdapter` 的分工：`site` 自己发 HTTP 请求拿 TVBox JSON；
 * `spider` 的 HTTP 请求在 jar 内部完成，本适配器只负责「调用 + 解析」。
 * 两者的字段口径（`vod_*` / `class` / `list`）完全一致，归一化不重复实现。
 */
import { AppError } from '@/shared/errors';
import { mediaIdOf } from '@/shared/id';
import { toAbsoluteUrl } from '@/shared/url';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import { Spider as SpiderNative, type SpiderMethod } from '@/native/spiderPlugin';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import { inferMediaType, normalizeFormat, parseCategoryValue } from '@/sources/base/normalize';
import { looksLikeResolverUrl, type TvboxListResponse, type TvboxVod } from '@/sources/site/tvboxTypes';
import {
  buildLinesWithRaw,
  categoriesOf,
  toItemFromVod,
  toNumberOrNull,
  vodIdOf,
} from '@/sources/site/tvboxNormalize';
import { isPlayPageUrl, resolvePlayPage } from '@/sources/site/playPageResolver';
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

/** 解析器写入 `Source.ext` 的爬虫配置（subscriptionParser 的 SpiderExtRecord） */
export interface SpiderSourceExt {
  kind: 'jar' | 'js';
  /** jar 爬虫类名（`csp_XBPQ`）；JS 爬虫为 null */
  api: string | null;
  /** jar 地址（含 `;md5;` 后缀时原样保留，由原生侧解析校验） */
  jarUrl: string | null;
  /** 传给 `Spider.init(context, ext)` 的原始 ext */
  initExt: string;
  searchable?: boolean;
}

function extOf(source: Source): SpiderSourceExt {
  const ext = (source.ext ?? {}) as Partial<SpiderSourceExt>;
  return {
    kind: ext.kind ?? 'jar',
    api: ext.api ?? null,
    jarUrl: ext.jarUrl ?? null,
    initExt: ext.initExt ?? '',
    searchable: ext.searchable ?? true,
  };
}

/** 爬虫返回的 JSON 字符串 → TVBox 结构；非法 JSON 抛 E_PARSE */
function parseSpiderJson(json: string | null | undefined): TvboxListResponse {
  if (typeof json !== 'string' || json.trim().length === 0) {
    throw new AppError('E_PARSE', '爬虫未返回数据');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError('E_PARSE', '爬虫返回的不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AppError('E_PARSE', '爬虫返回结构不是对象');
  }
  return parsed as TvboxListResponse;
}

/** playerContent 返回的播放信息（字段全部可选，实现差异大） */
export interface SpiderPlayerResult {
  url?: string | null;
  parse?: number | boolean | string | null;
  jx?: number | boolean | string | null;
  header?: Record<string, string> | null;
  /** 部分爬虫把地址放在子字段里 */
  playUrl?: string | null;
  flag?: string | null;
  msg?: string | null;
}

function parsePlayerJson(json: string | null | undefined): SpiderPlayerResult {
  const base = parseSpiderJson(json) as SpiderPlayerResult;
  return base;
}

export class SpiderAdapter extends BaseAdapter {
  readonly type: SourceType = 'spider';

  /** sourceId → 原生插件返回的实例句柄 */
  private readonly handles = new Map<string, string>();

  /* ---------------- 探活与加载 ---------------- */

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    const ext = extOf(source);
    if (ext.kind !== 'jar' || ext.jarUrl === null || ext.api === null) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '该爬虫源缺少 jar 或爬虫类名');
    }
    if (!isNative()) {
      throw new AppError('E_NOT_IMPLEMENTED', '爬虫源仅支持在 App 内使用');
    }
    await this.load(source);
    const response = await this.invoke(source, 'homeContent', [true]);
    return {
      itemCount: response.list?.length ?? response.class?.length ?? 0,
    };
  }

  /** 确保该源已加载，返回实例句柄 */
  private async ensureLoaded(source: Source): Promise<string> {
    this.assertEnabled(source);
    const existing = this.handles.get(source.id);
    if (existing) return existing;
    return this.load(source);
  }

  private async load(source: Source): Promise<string> {
    const ext = extOf(source);
    if (ext.kind !== 'jar' || ext.jarUrl === null || ext.api === null) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '该爬虫源缺少 jar 或爬虫类名');
    }
    if (!isNative()) {
      throw new AppError('E_NOT_IMPLEMENTED', '爬虫源仅支持在 App 内使用');
    }
    try {
      const result = await SpiderNative.load({
        jarUrl: ext.jarUrl,
        api: ext.api,
        initExt: ext.initExt,
        userAgent: source.headers['User-Agent'] ?? source.headers['user-agent'] ?? null,
      });
      this.handles.set(source.id, result.handle);
      return result.handle;
    } catch (e) {
      logger.warn('爬虫 jar 加载失败', source.name, e);
      throw new AppError('E_SOURCE_UNAVAILABLE', '爬虫加载失败，请检查网络或更换源', {
        detail: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }
  }

  private async invoke(
    source: Source,
    method: SpiderMethod,
    args: Array<string | number | boolean | Record<string, string> | string[]>,
    /** 位置下标 → 数组值：List 形参必须走这里（桥接会展平嵌套数组） */
    arrayArgs?: Record<number, string[]>,
  ) {
    const handle = await this.ensureLoaded(source);
    try {
      const result = await SpiderNative.invoke({ handle, method, args, arrayArgs });
      return parseSpiderJson(result.json);
    } catch (e) {
      if (e instanceof AppError) throw e;
      logger.warn('爬虫调用失败', source.name, method, e);
      throw new AppError('E_SOURCE_UNAVAILABLE', '爬虫执行失败', {
        detail: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }
  }

  /* ---------------- 数据方法 ---------------- */

  async listCategories(source: Source, signal?: AbortSignal): Promise<Category[]> {
    this.assertEnabled(source);
    void signal;
    const response = await this.invoke(source, 'homeContent', [true]);
    return categoriesOf(source, response.class);
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, page, pageSize, filters } = params;
    this.assertEnabled(source);
    void params.signal;
    const typeId = parseCategoryValue(source.id, categoryId) ?? '';
    // categoryContent(tid, pg, filter, hashmap)：第 4 参是 HashMap，不能传字符串
    const response = await this.invoke(source, 'categoryContent', [typeId, page, true, {}]);
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
    return {
      items,
      page,
      pageSize,
      total: total ?? (pageCount !== null ? pageCount * pageSize : null),
      hasMore,
    };
  }

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { source, keyword } = params;
    this.assertEnabled(source);
    void params.signal;
    const kw = keyword.trim();
    if (kw.length === 0) return [];
    const response = await this.invoke(source, 'searchContent', [kw, true]);
    return (response.list ?? []).slice(0, params.pageSize).map((vod) => this.toItem(source, vod));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    void params.signal;
    // detailContent 的 ids 是 List 形参，必须走 arrayArgs（桥接会展平嵌套数组）
    const response = await this.invoke(source, 'detailContent', [sourceItemId], { 0: [sourceItemId] });
    const vod = response.list?.find((entry) => vodIdOf(entry) === sourceItemId) ?? response.list?.[0];
    if (!vod) throw new AppError('E_NOT_FOUND');

    const item = this.toItem(source, vod);
    const { lines, episodes } = buildLinesWithRaw(source, vod, mediaIdOf(source.id, vodIdOf(vod)));
    return { item, lines, episodes };
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId } = params;
    this.assertEnabled(source);
    void params.signal;

    // 1. 取剧集列表（与 SiteAdapter 同一口径），定位用户点的那一集
    const response = await this.invoke(source, 'detailContent', [sourceItemId], { 0: [sourceItemId] });
    const vod = response.list?.find((entry) => vodIdOf(entry) === sourceItemId) ?? response.list?.[0];
    if (!vod) throw new AppError('E_NOT_FOUND');
    const { lines, rawEpisodes } = buildLinesWithRaw(source, vod, mediaIdOf(source.id, vodIdOf(vod)));
    const lineIndex = lines.findIndex((line) => line.id === lineId);
    const line = lines[lineIndex >= 0 ? lineIndex : 0];
    if (!line) throw new AppError('E_NO_PLAY_URL');
    const list = rawEpisodes[line.index] ?? [];
    const episodeIndex = list.findIndex((entry) => entry.id === episodeId);
    const picked = list[episodeIndex >= 0 ? episodeIndex : 0];
    if (!picked || picked.url.length === 0) throw new AppError('E_NO_PLAY_URL');

    // 2. playerContent(flag, id, vipFlags) 取真实播放地址；
    //    flag 用线路名，id 用剧集地址（TVBox 约定），vipFlags 传空数组
    const flag = line.name;
    const played = await this.invokePlayer(source, flag, picked.url);
    const headers = this.headersWith(source, played.header ?? undefined);

    // parse=1 表示地址仍需解析接口；首版不做递归解包（与 SiteAdapter 一致）
    if (parseFlagIsEnabled(played.parse) || parseFlagIsEnabled(played.jx)) {
      throw new AppError('E_NO_PLAY_URL', '该线路需要解析接口，暂不支持');
    }

    const raw = (played.url ?? played.playUrl ?? '').trim();
    if (raw.length === 0) throw new AppError('E_NO_PLAY_URL', played.msg ?? '爬虫未返回播放地址');

    const absolute = toAbsoluteUrl(source.baseUrl, raw) ?? raw;
    if (looksLikeResolverUrl(absolute)) {
      throw new AppError('E_NO_PLAY_URL', '该源需要解析接口，暂不支持');
    }
    if (!/^https?:\/\//i.test(absolute) && !absolute.startsWith('magnet:')) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '播放地址协议不受支持');
    }

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

  /** playerContent 的返回可能是 JSON 字符串，也可能被爬虫包装成其它结构 */
  private async invokePlayer(source: Source, flag: string, id: string): Promise<SpiderPlayerResult> {
    const handle = await this.ensureLoaded(source);
    try {
      const result = await SpiderNative.invoke({
        handle,
        method: 'playerContent',
        args: [flag, id, ''],
        // vipFlags 是 List 形参，走 arrayArgs 避免被桥接展平
        arrayArgs: { 2: [] },
      });
      return parsePlayerJson(result.json);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('E_SOURCE_UNAVAILABLE', '爬虫取播放地址失败', {
        detail: e instanceof Error ? e.message : String(e),
        cause: e,
      });
    }
  }

  private toItem(source: Source, vod: TvboxVod): MediaItem {
    return toItemFromVod(source, vod, (input) => this.makeItem(source, input));
  }
}

/** TVBox 的 parse/jx 既可能是 0/1，也可能是 true/"1" */
function parseFlagIsEnabled(value: SpiderPlayerResult['parse']): boolean {
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim() === '1' || value.trim().toLowerCase() === 'true';
  return false;
}
