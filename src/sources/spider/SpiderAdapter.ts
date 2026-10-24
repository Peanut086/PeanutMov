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
import { mirrorVariants } from '@/shared/githubMirror';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { httpClient } from '@/sources/base/httpClient';
import { Spider as SpiderNative, type SpiderMethod, type SpiderProxyResult } from '@/native/spiderPlugin';
import { sniffPlayUrl } from '@/native/snifferPlugin';
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
  /** 1 = 地址需经爬虫的 proxy(Map) 换回直链（TVBox 约定） */
  proxy?: number | boolean | string | null;
  flag?: string | null;
  msg?: string | null;
}

function parsePlayerJson(json: string | null | undefined): SpiderPlayerResult {
  const base = parseSpiderJson(json) as SpiderPlayerResult;
  return base;
}

/* ---------- 调用护栏：超时 + 取消（原生调用不可中断，只能竞速放弃） ---------- */

/** 单次原生调用超时（与原生看门狗对齐；JS 侧先到先报错，避免 UI 无限等待） */
const NATIVE_LOAD_TIMEOUT_MS = 75_000;
const NATIVE_INVOKE_TIMEOUT_MS = 30_000;
const NATIVE_PROXY_TIMEOUT_MS = 25_000;

/**
 * 原生调用竞速：正常结果 / 外部取消 / 超时三者先到先出。
 * 超时或取消后底层任务仍在原生线程池里跑，但 JS 侧立刻得到确定结果。
 */
function raceNative<T>(
  run: () => Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: AppError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      fail(new AppError('E_TIMEOUT', `源响应超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    const onAbort = (): void => fail(new AppError('E_ABORTED'));
    signal?.addEventListener('abort', onAbort, { once: true });
    void run().then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (e: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      },
    );
  });
}

/**
 * 原生 reject message → 具体 AppError（P0-5 错误透传）：
 * 原生侧会给出 HTTP 状态、md5 校验、类缺失等具体原因，映射成对应错误码，
 * 让自动换源（FALLBACK_ERROR_CODES）与错误面板文案都能对症。
 */
function nativeErrorOf(e: unknown, fallback: AppError): AppError {
  if (e instanceof AppError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (message.includes('超时')) {
    return new AppError('E_TIMEOUT', message);
  }
  if (/HTTP 40[13]/.test(message)) {
    return new AppError('E_SOURCE_UNAVAILABLE', '源地址拒绝访问（HTTP 401/403），源可能已失效', {
      detail: message,
      cause: e,
    });
  }
  if (/HTTP 404/.test(message)) {
    return new AppError('E_HTTP_404', undefined, { detail: message, cause: e });
  }
  if (/HTTP 5\d\d/.test(message)) {
    return new AppError('E_HTTP_5XX', undefined, { detail: message, cause: e });
  }
  if (/md5/i.test(message)) {
    return new AppError('E_PARSE', 'jar 校验失败，源文件已损坏或被替换', { detail: message, cause: e });
  }
  if (/ClassNotFound|ClassCastException|NoSuchMethod/.test(message)) {
    return new AppError('E_PARSE', '爬虫类缺失，源配置与 jar 不匹配', { detail: message, cause: e });
  }
  if (message.includes('jar too large')) {
    return new AppError('E_PARSE', 'jar 文件过大，无法加载', { detail: message, cause: e });
  }
  return new AppError(fallback.code, message || fallback.message, { detail: message, cause: e });
}

export class SpiderAdapter extends BaseAdapter {
  readonly type: SourceType = 'spider';

  /** sourceId → 原生插件返回的实例句柄 */
  private readonly handles = new Map<string, string>();
  /** sourceId → 实际可下载的 jar 变体地址（探活/加载命中的镜像，CHG-11 回退） */
  private readonly jarVariants = new Map<string, string>();

  /* ---------------- 探活与加载 ---------------- */

  /**
   * 首次探活包含 jar 下载（原生侧连接超时 20s、读取超时 30s），
   * 基类的 3s 窗口会把慢网络下的正常加载误判成 timeout，故放宽到 35s。
   * 句柄缓存后，后续探活只走一次 homeContent，远快于窗口上限。
   */
  protected override get probeTimeoutMs(): number {
    return 35_000;
  }

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    const ext = extOf(source);
    if (ext.kind !== 'jar' || ext.jarUrl === null || ext.api === null) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '该爬虫源缺少 jar 或爬虫类名');
    }
    if (!isNative()) {
      throw new AppError('E_NOT_IMPLEMENTED', '爬虫源仅支持在 App 内使用');
    }
    // A 段：HEAD jar 快速判死（CHG-09），失败直接归类（403 → auth_failed 等），
    // 不再走 20~30s 的原生 jar 下载；结论不确定时继续 B 段
    const jarUrl = ext.jarUrl.split(';')[0] ?? ext.jarUrl;
    const reachable = await withGithubMirrorFallback(
      jarUrl,
      (variantUrl) =>
        httpClient.request(variantUrl, {
          method: 'HEAD',
          responseType: 'none',
          timeoutMs: 3000,
          retries: 0,
        }),
    ).catch((e: unknown) => {
      // 结论不确定（超时可能是慢网络下的活源；405/501 是服务端不支持 HEAD）→ 交给 B 段
      if (headInconclusive(e)) return { value: undefined, viaMirror: null };
      throw e;
    });
    // 探活命中的镜像记下来，B 段与后续 load 直接纳用（不再重复试错）
    if (reachable.viaMirror) this.jarVariants.set(source.id, reachable.viaMirror);
    // B 段：完整加载 + homeContent，测「jar 活着但源站死了」
    await this.load(source);
    const response = await this.invoke(source, 'homeContent', [true], undefined, undefined);
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
    const cleanJarUrl = ext.jarUrl.split(';')[0] ?? ext.jarUrl;
    const md5Suffix = ext.jarUrl.slice(cleanJarUrl.length);
    // 直连优先；失败时依次尝试镜像变体（CHG-11）。探活命中的镜像已记入 jarVariants。
    const candidates = [this.jarVariants.get(source.id) ?? cleanJarUrl, ...mirrorVariants(cleanJarUrl)];
    const tried = new Set<string>();
    let lastError: unknown = null;
    for (const candidate of candidates) {
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      try {
        const result = await raceNative(
          () =>
            SpiderNative.load({
              jarUrl: `${candidate}${md5Suffix}`,
              api: ext.api ?? '',
              initExt: ext.initExt,
              userAgent: source.headers['User-Agent'] ?? source.headers['user-agent'] ?? null,
            }),
          undefined,
          NATIVE_LOAD_TIMEOUT_MS,
        );
        this.jarVariants.set(source.id, candidate);
        this.handles.set(source.id, result.handle);
        return result.handle;
      } catch (e) {
        if (e instanceof AppError && e.code === 'E_ABORTED') throw e;
        lastError = e;
        logger.warn('爬虫 jar 加载失败（本次变体）', source.name, candidate, e);
      }
    }
    throw nativeErrorOf(lastError, new AppError('E_SOURCE_UNAVAILABLE', '爬虫加载失败，请检查网络或更换源'));
  }

  private async invoke(
    source: Source,
    method: SpiderMethod,
    args: Array<string | number | boolean | Record<string, string> | string[]>,
    /** 位置下标 → 数组值：List 形参必须走这里（桥接会展平嵌套数组） */
    arrayArgs?: Record<number, string[]>,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const handle = await this.ensureLoaded(source);
    try {
      const result = await raceNative(
        () => SpiderNative.invoke({ handle, method, args, arrayArgs }),
        signal,
        NATIVE_INVOKE_TIMEOUT_MS,
      );
      return parseSpiderJson(result.json);
    } catch (e) {
      if (e instanceof AppError) throw e;
      logger.warn('爬虫调用失败', source.name, method, e);
      throw nativeErrorOf(e, new AppError('E_SOURCE_UNAVAILABLE', '爬虫执行失败'));
    }
  }

  /* ---------------- 数据方法 ---------------- */

  async listCategories(source: Source, signal?: AbortSignal): Promise<Category[]> {
    this.assertEnabled(source);
    const response = await this.invoke(source, 'homeContent', [true], undefined, signal);
    return categoriesOf(source, response.class);
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, page, pageSize, filters } = params;
    this.assertEnabled(source);
    const typeId = parseCategoryValue(source.id, categoryId) ?? '';
    // categoryContent(tid, pg, filter, hashmap)：第 4 参是 HashMap，不能传字符串
    const response = await this.invoke(
      source,
      'categoryContent',
      [typeId, page, true, {}],
      undefined,
      params.signal,
    );
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
    const kw = keyword.trim();
    if (kw.length === 0) return [];
    const response = await this.invoke(
      source,
      'searchContent',
      [kw, true],
      undefined,
      params.signal,
    );
    return (response.list ?? []).slice(0, params.pageSize).map((vod) => this.toItem(source, vod));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    // detailContent 的 ids 是 List 形参，必须走 arrayArgs（桥接会展平嵌套数组）
    const response = await this.invoke(
      source,
      'detailContent',
      [sourceItemId],
      { 0: [sourceItemId] },
      params.signal,
    );
    const vod = response.list?.find((entry) => vodIdOf(entry) === sourceItemId) ?? response.list?.[0];
    if (!vod) throw new AppError('E_NOT_FOUND');

    const item = this.toItem(source, vod);
    const { lines, episodes } = buildLinesWithRaw(source, vod, mediaIdOf(source.id, vodIdOf(vod)));
    return { item, lines, episodes };
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId } = params;
    this.assertEnabled(source);

    // 1. 取剧集列表（与 SiteAdapter 同一口径），定位用户点的那一集
    const response = await this.invoke(
      source,
      'detailContent',
      [sourceItemId],
      { 0: [sourceItemId] },
      params.signal,
    );
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
    const played = await this.invokePlayer(source, flag, picked.url, params.signal);

    const raw = (played.url ?? played.playUrl ?? '').trim();
    if (raw.length === 0) throw new AppError('E_NO_PLAY_URL', played.msg ?? '爬虫未返回播放地址');

    const absolute = toAbsoluteUrl(source.baseUrl, raw) ?? raw;

    let direct = absolute;
    let proxyHeaders: Record<string, string> | null = null;
    if (parseFlagIsEnabled(played.parse) || parseFlagIsEnabled(played.jx)) {
      // parse=1：地址需经解析接口/页面执行换回直链（P1-7 WebView 嗅探）
      direct = await this.resolveViaParse(source, absolute, params.signal);
    } else if (parseFlagIsEnabled(played.proxy) || /^proxy:\/\//i.test(absolute)) {
      // proxy=1 或 proxy:// 协议：地址需经爬虫的 proxy(Map) 换回直链
      // （原生插件语义是「返回直链」，非 TVBox 原版的本地流式代理）
      const proxied = await this.invokeProxy(source, absolute, params.signal);
      if (!proxied.url) throw new AppError('E_NO_PLAY_URL', '爬虫代理未返回播放地址');
      direct = proxied.url;
      proxyHeaders = proxied.headers;
    }

    if (looksLikeResolverUrl(direct)) {
      // 解析页地址（jx 页面）：嗅探其加载过程中的媒体请求
      direct = await this.resolveViaParse(source, direct, params.signal);
    }
    if (!/^https?:\/\//i.test(direct) && !direct.startsWith('magnet:')) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '播放地址协议不受支持');
    }

    const headers = this.headersWith(
      source,
      proxyHeaders ? { ...played.header, ...proxyHeaders } : (played.header ?? undefined),
    );

    const resolved = isPlayPageUrl(direct)
      ? await resolvePlayPage(direct, { headers, signal: params.signal })
      : direct;

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

  /**
   * 解析页 → 直链（parse=1 / jx 解析器地址）。
   * WebView 嗅探页面加载过程中的媒体请求（m3u8/mp4），拿到直链；失败给明确错误。
   */
  private async resolveViaParse(source: Source, pageUrl: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!isNative()) {
      throw new AppError('E_NO_PLAY_URL', '该线路需要解析接口，暂不支持');
    }
    const sniffed = await sniffPlayUrl(pageUrl, this.headersWith(source)).catch((e: unknown) => {
      logger.warn('嗅探解析失败', source.name, pageUrl, e);
      return null;
    });
    if (!sniffed) {
      throw new AppError('E_NO_PLAY_URL', '未能从解析页取得播放地址，请换线路');
    }
    return sniffed;
  }

  /** playerContent 的返回可能是 JSON 字符串，也可能被爬虫包装成其它结构 */
  private async invokePlayer(
    source: Source,
    flag: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<SpiderPlayerResult> {
    signal?.throwIfAborted();
    const handle = await this.ensureLoaded(source);
    try {
      const result = await raceNative(
        () =>
          SpiderNative.invoke({
            handle,
            method: 'playerContent',
            args: [flag, id, ''],
            // vipFlags 是 List 形参，走 arrayArgs 避免被桥接展平
            arrayArgs: { 2: [] },
          }),
        signal,
        NATIVE_INVOKE_TIMEOUT_MS,
      );
      return parsePlayerJson(result.json);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw nativeErrorOf(e, new AppError('E_SOURCE_UNAVAILABLE', '爬虫取播放地址失败'));
    }
  }

  /** 走爬虫代理换回直链（`proxy://` 地址或 playerContent 的 proxy=1） */
  private async invokeProxy(
    source: Source,
    url: string,
    signal?: AbortSignal,
  ): Promise<SpiderProxyResult> {
    signal?.throwIfAborted();
    const handle = await this.ensureLoaded(source);
    try {
      const result = await raceNative(
        () => SpiderNative.proxy({ handle, url }),
        signal,
        NATIVE_PROXY_TIMEOUT_MS,
      );
      return { url: result.url, headers: result.headers ?? {} };
    } catch (e) {
      if (e instanceof AppError) throw e;
      logger.warn('爬虫代理失败', source.name, e);
      throw nativeErrorOf(e, new AppError('E_SOURCE_UNAVAILABLE', '爬虫代理失败'));
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

/** HEAD 结论不确定：超时（慢网络活源）或服务端不支持 HEAD（405/501），应继续 B 段 */
function headInconclusive(e: unknown): boolean {
  if (e instanceof AppError) {
    if (e.code === 'E_TIMEOUT') return true;
    return e.httpStatus === 405 || e.httpStatus === 501;
  }
  return false;
}
