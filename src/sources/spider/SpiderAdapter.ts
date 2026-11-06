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
import {
  TIMEOUT_PROBE_SPIDER_MS,
  TIMEOUT_PROBE_SPIDER_WARM_MS,
  TIMEOUT_SEARCH_SPIDER_MS,
  TIMEOUT_SPIDER_PLAY_COLD_MS,
  TIMEOUT_SPIDER_PLAY_HOT_MS,
} from '@/shared/constants';
import { logger } from '@/shared/logger';
import { isMagnetUrl, MAGNET_MESSAGE, sanitizeSourceMessage } from '@/shared/sourceFailure';
import { isNative } from '@/shared/platform';
import { withGithubMirrorFallback } from '@/shared/githubMirror';
import { httpClient } from '@/sources/base/httpClient';
import { Spider as SpiderNative, type SpiderMethod, type SpiderProxyResult } from '@/native/spiderPlugin';
import { Drpy as DrpyNative, type DrpyMethod } from '@/native/drpyPlugin';
import { sniffPlayUrl } from '@/native/snifferPlugin';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import { deriveHasMore } from '@/sources/base/pagination';
import { inferMediaType, normalizeFormat, parseCategoryValue } from '@/sources/base/normalize';
import { looksLikeResolverUrl, unwrapTvboxLocalProxy, type TvboxListResponse, type TvboxVod } from '@/sources/site/tvboxTypes';
import {
  buildLinesWithRaw,
  categoriesOf,
  toItemFromVod,
  toNumberOrNull,
  vodIdOf,
  type RawEpisode,
} from '@/sources/site/tvboxNormalize';
import { selectEpisodeInDetail } from '@/sources/mapping/EpisodeMappingService';
import { titleMatches, titleMatchScore } from '@/sources/mapping/TitleNormalizer';
import { isPlayPageUrl, resolvePlayPage } from '@/sources/site/playPageResolver';
import { getNetdiskConfig, formatConfigForSpider } from '@/services/netdiskConfig';
import type { EpisodeLookupMatch } from '@/services/UnifiedEpisodeService';
import type {
  BrowseParams,
  Category,
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

/**
 * 按「片名 + 集数序号」查到的剧集（FIX-05 跨源集数映射 / EXT-03 统一剧集用）。
 *
 * 与 `SiteAdapter` 的 `SiteEpisodeMatch` 同构，统一指向 FIX-05 的 `EpisodeMappingTarget`
 * （含 `source` 源标识与可直接交给 `resolvePlayUrl` 的 `lineId` / `episodeId`），
 * 统一剧集服务可无差别消费两个适配器的直查结果。
 */
export type SpiderEpisodeMatch = EpisodeLookupMatch;

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

/**
 * P4-3: 判断是否为网盘源
 * 通过 initExt 或 baseUrl 中的关键词识别
 */
function isNetdiskSource(source: Source): boolean {
  const ext = extOf(source);
  const keywords = ['netdisk', 'pan', 'quark', 'uc', '123', 'tianyi', 'ali', '网盘'];
  const searchText = `${ext.initExt} ${source.baseUrl ?? ''}`.toLowerCase();
  return keywords.some(kw => searchText.includes(kw.toLowerCase()));
}

/**
 * P4-3: 为网盘源附加画质/线程配置到 initExt
 * 配置以 JSON 格式追加，爬虫源启动时解析
 * P2-1: 加密 ext（长度 > 100 且含特殊字符）不追加，避免破坏加密结构
 */
function appendNetdiskConfig(initExt: string): string {
  try {
    // P2-1: 检测加密 ext（长度 > 100 且非 JSON 对象）
    const isEncrypted = initExt.length > 100 && !initExt.trim().startsWith('{');
    if (isEncrypted) {
      logger.debug('跳过网盘配置追加（加密 ext）', { length: initExt.length });
      return initExt;
    }

    const config = getNetdiskConfig();
    const configStr = formatConfigForSpider(config);
    // 如果 initExt 已包含配置，替换；否则追加
    if (initExt.includes('"quality"') || initExt.includes('"thread"')) {
      // 尝试合并配置
      try {
        const existing = JSON.parse(initExt);
        if (typeof existing === 'object') {
          return JSON.stringify({ ...existing, ...config });
        }
      } catch {
        // 解析失败，直接追加
      }
    }
    // 追加配置（用分隔符避免冲突）
    return initExt ? `${initExt}|||${configStr}` : configStr;
  } catch (e) {
    logger.warn('附加网盘配置失败', e);
    return initExt;
  }
}

/**
 * 爬虫返回的 JSON 字符串 → TVBox 结构；非法 JSON 抛 E_PARSE
 *
 * `op` / `sourceName` 仅用于错误文案定位：空返回时用户能看到是哪个方法、哪个源出了问题，
 * 避免「详情加载失败」这种笼统提示（B1 / 奥特多线诊断）。
 */
function parseSpiderJson(
  json: string | null | undefined,
  op?: string,
  sourceName?: string,
): TvboxListResponse {
  if (typeof json !== 'string' || json.trim().length === 0) {
    const who = sourceName ? `「${sourceName}」` : '该源';
    const what = op ? `${op} 返回空` : '未返回数据';
    throw new AppError('E_PARSE', `${who}${what}，源站结构可能已变更`);
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
  /** P1: 错误码（用于前端分类处理） */
  code?: string;
}

function parsePlayerJson(json: string | null | undefined, sourceName?: string): SpiderPlayerResult {
  const base = parseSpiderJson(json, 'playerContent', sourceName) as SpiderPlayerResult;
  return base;
}

/* ---------- CHG-16：drpy（kind:'js'）路由 ---------- */

/** TVBox 方法名 → drpy 编排方法（drpy_host.js 的 __drpyCall 分支） */
function drpyMethodOf(method: SpiderMethod): DrpyMethod {
  switch (method) {
    case 'homeContent':
      return 'home';
    case 'categoryContent':
      return 'category';
    case 'detailContent':
      return 'detail';
    case 'searchContent':
      return 'search';
    case 'playerContent':
      return 'play';
  }
}

/** TVBox 位置参数 → drpy 单参 JSON（字段名与 drpy_host.js 的编排约定一致） */
function drpyArgOf(
  method: SpiderMethod,
  args: Array<string | number | boolean | Record<string, string> | string[]>,
): Record<string, unknown> {
  switch (method) {
    case 'homeContent':
      return {};
    case 'categoryContent':
      return {
        tid: String(args[0] ?? ''),
        pg: Number(args[1] ?? 1),
        // 第 4 参 HashMap 是服务端筛选选中值，drpy 侧作为 extend 参与模板渲染
        extend: args[3] && typeof args[3] === 'object' ? args[3] : {},
      };
    case 'detailContent':
      return { id: String(args[0] ?? '') };
    case 'searchContent': {
      // P2-8：drpy 的 search 编排需要页码，缺省（undefined）会让规则拼出 `page=undefined`，
      // 源站直接 412/502。TVBox 的 searchContent 没有页码形参，故由调用方以第 3 参透传。
      const pg = Number(args[2]);
      return {
        wd: String(args[0] ?? ''),
        quick: args[1] === true,
        pg: Number.isFinite(pg) && pg > 0 ? pg : 1,
      };
    }
    case 'playerContent':
      return { flag: String(args[0] ?? ''), id: String(args[1] ?? '') };
  }
}

/* ---------- 调用护栏：超时 + 取消（原生调用不可中断，只能竞速放弃） ---------- */

/** 单次原生调用超时（与原生看门狗对齐；JS 侧先到先报错，避免 UI 无限等待） */
const NATIVE_LOAD_TIMEOUT_MS = 75_000;
/**
 * 调用超时（P1-6）：jar 已缓存命中（热句柄）时 10s 就够——真机实测出现 30s 才报错的
 * 长等待，用户以为卡死。只有「下载 jar / 镜像降级」的冷链路才允许 30s。
 */
const NATIVE_INVOKE_TIMEOUT_MS = TIMEOUT_SPIDER_PLAY_COLD_MS;
const NATIVE_INVOKE_TIMEOUT_HOT_MS = TIMEOUT_SPIDER_PLAY_HOT_MS;
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
  // 规则/接口返回 HTML 页：宿主层已把 `unexpected token '<'` 还原成带 HTTP 码的原因，
  // 这里保留该文案（比泛化的「资源不存在(404)」更能说明是源站挂了）
  if (message.includes('HTML 页面而非 JSON')) {
    return new AppError('E_SOURCE_UNAVAILABLE', message, { detail: message, cause: e });
  }
  if (message.includes('HTML 页面而非 JS 源码')) {
    return new AppError('E_SOURCE_UNAVAILABLE', message, { detail: message, cause: e });
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
  // P1-5：规则脚本内部异常（`expecting ';'` / `'data' is not defined` / `... of null`）
  // 对用户没有任何意义，还会泄露实现。原文只进日志，UI 统一成一句人话。
  const safe = sanitizeSourceMessage(message);
  if (safe !== message) {
    logger.debug('规则脚本原始异常（仅日志）', message);
    return new AppError(fallback.code, safe, { detail: safe, cause: e });
  }
  return new AppError(fallback.code, message || fallback.message, { detail: message, cause: e });
}

export class SpiderAdapter extends BaseAdapter {
  readonly type: SourceType = 'spider';

  /** CHG-15：冷启动搜索需 jar 下载+dex+init（5s 必超时）；warmup 后热句柄 <1s，
   * 20s 只兜未预热场景 */
  override readonly searchTimeoutMs: number = TIMEOUT_SEARCH_SPIDER_MS;

  /** sourceId → 原生插件返回的实例句柄 */
  private readonly handles = new Map<string, string>();
  /** sourceId → 实际可下载的 jar 变体地址（探活/加载命中的镜像，CHG-11 回退） */
  private readonly jarVariants = new Map<string, string>();
  /** sourceId → 最近一次 homeContent 的分类表（空 tid 回退 + 健康检测复用） */
  private readonly categoryCache = new Map<string, Category[]>();
  /** CHG-15：正在预热中的 sourceId，防重复加载 */
  private readonly warmingUp = new Set<string>();
  /** P1-6：正在加载中的 sourceId → 加载 Promise（预热与真实调用共用一次加载） */
  private readonly loading = new Map<string, Promise<string>>();

  /* ---------------- 探活与加载 ---------------- */

  /**
   * 首次探活包含 jar 下载（原生侧连接超时 20s、读取超时 30s），
   * 基类的 3s 窗口会把慢网络下的正常加载误判成 timeout，故放宽到 35s。
   * 句柄缓存后，后续探活只走一次 homeContent，远快于窗口上限。
   */
  protected override get probeTimeoutMs(): number {
    return TIMEOUT_PROBE_SPIDER_MS;
  }

  /**
   * P0-3：冷/热分级窗口。句柄已在内存时（复检、体检第二轮）只走 homeContent +
   * 一次列表，按热窗口收紧；冷启动才给 jar 下载 + dex + 防护初始化的余量。
   */
  protected override probeWindowMs(source: Source): number {
    return this.handles.has(source.id) ? TIMEOUT_PROBE_SPIDER_WARM_MS : TIMEOUT_PROBE_SPIDER_MS;
  }

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    const ext = extOf(source);
    if (!isNative()) {
      throw new AppError('E_NOT_IMPLEMENTED', '爬虫源仅支持在 App 内使用');
    }
    if (ext.kind === 'js') {
      // CHG-16：drpy 规则源——A 段 HEAD 规则地址，B 段加载规则 + home
      const candidates = this.ruleUrlCandidates(source, ext);
      const reachable = await withGithubMirrorFallback(
        candidates[0] ?? '',
        (variantUrl) =>
          httpClient.request(variantUrl, {
            method: 'HEAD',
            responseType: 'none',
            timeoutMs: 3000,
            retries: 0,
          }),
      ).catch((e: unknown) => {
        if (headInconclusive(e)) return { value: undefined, viaMirror: null };
        throw e;
      });
      if (reachable.viaMirror) this.jarVariants.set(source.id, reachable.viaMirror);
      await this.load(source);
      const response = await this.invoke(source, 'homeContent', [true], undefined, undefined);
      const categories = categoriesOf(source, response.class, response);
      this.categoryCache.set(source.id, categories);
      return {
        itemCount: response.class?.length ?? response.list?.length ?? 0,
      };
    }
    if (ext.kind !== 'jar' || ext.jarUrl === null || ext.api === null) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '该爬虫源缺少 jar 或爬虫类名');
    }
    // A 段：HEAD jar 快速判死（CHG-09），失败直接归类（403 → auth_failed 等），
    // 不再走 20~30s 的原生 jar 下载；结论不确定时继续 B 段。
    // P0-3：句柄已在内存（热）时跳过 A 段——jar 已经验证过可达，再 HEAD 一次只会
    // 给体检加一次可能失败的网络请求（慢网络下正是它把活源判成 unreachable）。
    const hot = this.handles.has(source.id);
    const jarUrl = ext.jarUrl.split(';')[0] ?? ext.jarUrl;
    if (!hot) {
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
    }
    // B 段：完整加载 + homeContent，测「jar 活着但源站死了」
    await this.load(source);
    const response = await this.invoke(source, 'homeContent', [true], undefined, undefined);
    const categories = categoriesOf(source, response.class, response);
    this.categoryCache.set(source.id, categories);
    // C 段：真正拉一次列表，验证「能出片」。
    // 只测 homeContent 会把「jar 能加载但源站已死」判成 ok——实测修复前 61 个
    // 「可用」源点进去全空，正是这个口径造成的误导。
    const sampleTid = categories[0]?.value ?? '';
    const probeItems = await this.invoke(
      source,
      'categoryContent',
      [sampleTid, 1, true, {}],
      undefined,
      undefined,
    );
    const itemCount = probeItems.list?.length ?? response.list?.length ?? 0;
    if (itemCount === 0) {
      throw new AppError('E_SOURCE_UNAVAILABLE', '源可加载但没有内容（源站可能已失效）', {
        detail: `homeContent 分类 ${categories.length} 个，categoryContent 返回 0 条`,
      });
    }
    return { itemCount };
  }

  /**
   * CHG-16：drpy 规则地址候选（按序尝试）。
   * TVBox 生态两种写法：`ext` 是规则 URL（优先），或 `api`/baseUrl 直接指向规则 .js。
   */
  private ruleUrlCandidates(source: Source, ext: SpiderSourceExt): string[] {
    const out: string[] = [];
    const push = (value: string | null | undefined): void => {
      const trimmed = (value ?? '').trim().split(';')[0]?.trim() ?? '';
      if (/^https?:\/\//i.test(trimmed) && !out.includes(trimmed)) out.push(trimmed);
    };
    push(ext.initExt);
    push(source.baseUrl);
    // 命中的变体（探活/上次加载的镜像）排最前
    const hit = this.jarVariants.get(source.id);
    if (hit) out.unshift(hit);
    return out;
  }

  /**
   * 确保该源已加载，返回实例句柄。
   *
   * P1-6：无论这次加载由谁发起（预热、其它并发请求、本次调用），调用方的
   * 取消/超时都必须生效。否则预热先起的 jar 加载（原生 75s）会让搜索的 20s
   * 预算失效——真机实测「单个源把整轮聚合搜索拖到 75s」。
   */
  private async ensureLoaded(source: Source, signal?: AbortSignal): Promise<string> {
    this.assertEnabled(source);
    const existing = this.handles.get(source.id);
    if (existing) return existing;
    return raceNative(() => this.load(source, signal), signal, NATIVE_LOAD_TIMEOUT_MS);
  }

  /**
   * CHG-15：后台预热——只加载 jar 拿句柄，不发 homeContent。
   * 让后续搜索/浏览命中热句柄（否则 5s/20s 搜索预算扛不住冷启动）。
   * 失败静默：预热不打扰用户，真实调用时再报错。
   */
  override async warmup(source: Source): Promise<void> {
    if (!isNative()) return;
    const ext = extOf(source);
    if (ext.kind === 'js') {
      // drpy：规则地址缺失就不预热（加载时会报更明确的错）
      if (this.ruleUrlCandidates(source, ext).length === 0) return;
    } else if (ext.kind !== 'jar' || ext.api === null || ext.jarUrl === null) {
      return;
    }
    if (source.health === 'unreachable' || source.health === 'bad_config' || source.health === 'auth_failed') {
      return;
    }
    if (this.handles.has(source.id) || this.warmingUp.has(source.id)) return;
    this.warmingUp.add(source.id);
    try {
      await this.load(source);
      logger.debug('爬虫源预热完成', source.name);
    } catch (e) {
      logger.debug('爬虫源预热失败（静默）', source.name, e);
    } finally {
      this.warmingUp.delete(source.id);
    }
  }

  /**
   * 加载入口（P1-6）：同源并发加载去重。
   * 预热（warmup）与真实调用可能同时触发加载，若各自跑一遍会出现两次 jar 下载/加载，
   * 既拖慢首屏也会让原生侧重复初始化。
   */
  private async load(source: Source, signal?: AbortSignal): Promise<string> {
    const existing = this.handles.get(source.id);
    if (existing) return existing;
    const inflight = this.loading.get(source.id);
    if (inflight) return inflight;
    const task = this.loadInner(source, signal).finally(() => {
      this.loading.delete(source.id);
    });
    this.loading.set(source.id, task);
    return task;
  }

  private async loadInner(source: Source, signal?: AbortSignal): Promise<string> {
    const ext = extOf(source);
    if (!isNative()) {
      throw new AppError('E_NOT_IMPLEMENTED', '爬虫源仅支持在 App 内使用');
    }
    if (ext.kind === 'js') {
      return this.loadJs(source, ext, signal);
    }
    if (ext.kind !== 'jar' || ext.jarUrl === null || ext.api === null) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '该爬虫源缺少 jar 或爬虫类名');
    }
    const cleanJarUrl = ext.jarUrl.split(';')[0] ?? ext.jarUrl;
    const md5Suffix = ext.jarUrl.slice(cleanJarUrl.length);
    // P4-3: 网盘源附加画质/线程配置
    const initExt = isNetdiskSource(source) ? appendNetdiskConfig(ext.initExt) : ext.initExt;
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
              initExt,
              userAgent: source.headers['User-Agent'] ?? source.headers['user-agent'] ?? null,
            }),
          signal,
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

  /**
   * CHG-16：加载 drpy 规则到原生 QuickJS 引擎。
   * 候选地址按序尝试（GitHub 地址自动带镜像变体，与 jar 加载同口径）；
   * 命中的变体记入 jarVariants（js 源复用该映射存规则变体）。
   */
  private async loadJs(source: Source, ext: SpiderSourceExt, signal?: AbortSignal): Promise<string> {
    const candidates = this.ruleUrlCandidates(source, ext);
    if (candidates.length === 0) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '该 drpy 源缺少规则地址');
    }
    // P4-3: 网盘源附加画质/线程配置
    const initExt = isNetdiskSource(source) ? appendNetdiskConfig(ext.initExt) : ext.initExt;
    let lastError: unknown = null;
    const tried = new Set<string>();
    for (const candidate of candidates) {
      for (const variant of [candidate, ...mirrorVariants(candidate)]) {
        if (tried.has(variant)) continue;
        tried.add(variant);
        try {
          const result = await raceNative(
            () =>
              DrpyNative.load({
                ruleUrl: variant,
                initExt,
              }),
            signal,
            NATIVE_LOAD_TIMEOUT_MS,
          );
          this.jarVariants.set(source.id, variant);
          this.handles.set(source.id, result.handle);
          return result.handle;
        } catch (e) {
          if (e instanceof AppError && e.code === 'E_ABORTED') throw e;
          lastError = e;
          logger.warn('drpy 规则加载失败（本次变体）', source.name, variant, e);
        }
      }
    }
    throw nativeErrorOf(lastError, new AppError('E_SOURCE_UNAVAILABLE', 'drpy 规则加载失败，请检查网络或更换源'));
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
    const handle = await this.ensureLoaded(source, signal);
    try {
      let result: { json: string | null; logs?: string[] };
      if (extOf(source).kind === 'js') {
        // CHG-16：drpy 路由——TVBox 方法名映射为编排方法，位置参数拼成单参 JSON
        result = await raceNative(
          () =>
            DrpyNative.invoke({
              handle,
              method: drpyMethodOf(method),
              arg: JSON.stringify(drpyArgOf(method, args)),
            }),
          signal,
          NATIVE_INVOKE_TIMEOUT_MS,
        );
      } else {
        result = await raceNative(
          () => SpiderNative.invoke({ handle, method, args, arrayArgs }),
          signal,
          NATIVE_INVOKE_TIMEOUT_MS,
        );
      }
      return parseSpiderJson(result.json, method, source.name);
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
    const categories = categoriesOf(source, response.class, response);
    this.categoryCache.set(source.id, categories);
    return categories;
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, page, pageSize, filters } = params;
    this.assertEnabled(source);
    // 空 tid（UI 选中「全部」）会让大量爬虫直接返回空列表：实测枫叶 8 个分类全空。
    // TVBox 的约定是「没有显式分类时取第一个分类」，这里对齐该行为。
    const typeId = parseCategoryValue(source.id, categoryId) ?? (await this.firstCategoryValue(source));
    // categoryContent(tid, pg, filter, hashmap)：第 4 参是 HashMap，不能传字符串。
    // 服务端筛选选中值（UI 由 homeContent 的 filters 配置生成）放 HashMap 透传给爬虫。
    const filterExt =
      filters.ext && Object.keys(filters.ext).length > 0 ? { ...filters.ext } : {};
    const response = await this.invoke(
      source,
      'categoryContent',
      [typeId, page, true, filterExt],
      undefined,
      params.signal,
    );
    const allRows = response.list ?? [];
    const rows = allRows.filter((vod) => {
      if (filters.type === null) return true;
      return inferMediaType(vod.type_name, vod.vod_name) === filters.type;
    });
    const total = toNumberOrNull(response.total);
    const pageCount = toNumberOrNull(response.pagecount);
    const items = rows.map((vod) => this.toItem(source, vod));
    const hasMore = deriveHasMore({ page, rawCount: allRows.length, total, pageCount });
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
    // P2-8/P2-9：drpy（js）编排吃页码；
    // jar 的 searchContent 可能是 2 参 (String, boolean) 或 3 参 (String, boolean, String)。
    // 新版 catvod Guard jar（饭太硬系）只覆写 3 参版本——传 2 参会命中基类 stub 返回 null。
    // 原生侧已做 null 回退（P2-9），但主动传 3 参可避免一次无效反射调用。
    const args: Array<string | number | boolean> =
      extOf(source).kind === 'js' ? [kw, true, params.page ?? 1] : [kw, true];
    const response = await this.invoke(source, 'searchContent', args, undefined, params.signal);
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

  /**
   * 按「片名 + 集数序号」找剧集（FIX-05）。
   *
   * 豆瓣等发现源只知道片名与「第几集」，不知道目标源的条目 id / 剧集 id：
   * 这里先用 `search` 找片、按片名相似度排序（季号/续集号冲突直接排除），
   * 再逐个取详情，用 `selectEpisodeInDetail` 按集号定位。
   *
   * 找不到返回 null——**不返回第一集兜底**。
   */
  async findEpisodeByTitle(
    title: string,
    episodeIndex: number,
    ctx: { source: Source; year?: number | null; signal?: AbortSignal; limit?: number },
  ): Promise<SpiderEpisodeMatch | null> {
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

  /**
   * 在详情里定位要播的那一集。
   *
   * FIX-05：旧实现「线路找不到取第 0 条、剧集找不到取第 0 集」，
   * 跨源透传过来的 id 对不上时会静默播出第一集（选第 5 集播第 1 集）。现在：
   * - 指定了线路且该线路里有这一集 → 用它；
   * - 线路 id 失效（库缓存过期）但别的线路有这一集 → 换线路，**不换集**；
   * - `episodeId` 为空（单集电影 / 未指定集）→ 取首条线路的第 1 集，这是语义正确的默认；
   * - `episodeId` 非空但哪条线路都没有 → 返回 null，由调用方报错。
   */
  private locateEpisode(
    lines: PlayLine[],
    rawEpisodes: RawEpisode[][],
    lineId: string | null | undefined,
    episodeId: string | null | undefined,
  ): { line: PlayLine; picked: RawEpisode } | null {
    const wantedLine = lines.find((entry) => entry.id === lineId) ?? null;
    const wantedEpisode = String(episodeId ?? '').trim();

    const pickIn = (line: PlayLine): RawEpisode | null => {
      const list = rawEpisodes[line.index] ?? [];
      return list.find((entry) => entry.id === wantedEpisode) ?? null;
    };

    if (wantedLine !== null) {
      const picked = pickIn(wantedLine);
      if (picked !== null) return { line: wantedLine, picked };
    }

    if (wantedEpisode.length > 0) {
      for (const line of lines) {
        if (line === wantedLine) continue;
        const picked = pickIn(line);
        if (picked !== null) return { line, picked };
      }
      return null;
    }

    const line = wantedLine ?? lines[0];
    if (line === undefined) return null;
    const first = (rawEpisodes[line.index] ?? []).find((entry) => entry.url.length > 0);
    return first !== undefined ? { line, picked: first } : null;
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
    const located = this.locateEpisode(lines, rawEpisodes, lineId, episodeId);
    if (located === null) {
      // FIX-05：找不到用户点的那一集就报错，不能悄悄播第一集
      throw new AppError('E_NO_PLAY_URL', '该源没有这一集', {
        detail: `lineId=${lineId} episodeId=${episodeId}`,
        retryable: false,
      });
    }
    const { line, picked } = located;
    if (picked.url.length === 0) throw new AppError('E_NO_PLAY_URL');

    // 2. playerContent(flag, id, vipFlags) 取真实播放地址；
    //    flag 用线路名，id 用剧集地址（TVBox 约定），vipFlags 传空数组
    const flag = line.name;
    const played = await this.invokePlayer(source, flag, picked.url, params.signal);

    const raw = (played.url ?? played.playUrl ?? '').trim();
    if (raw.length === 0) {
      // P1: 识别网盘登录错误
      const msg = played.msg ?? '';
      const errorCode = detectNetdiskError(msg);
      throw new AppError(errorCode ?? 'E_NO_PLAY_URL', msg || '爬虫未返回播放地址');
    }

    const absolute = toAbsoluteUrl(source.baseUrl, raw) ?? raw;

    // P0-1: 优先解包 TVBox 本地代理地址（127.0.0.1:9978/proxy?do=m3u8&url=...）
    // 取内层真实播放地址，跳过 parse/proxy 分支直接走后续流程
    const innerPlaylist = unwrapTvboxLocalProxy(absolute);
    let direct = innerPlaylist ?? absolute;
    let proxyHeaders: Record<string, string> | null = null;

    if (innerPlaylist) {
      logger.debug('播放地址为 TVBox 本地代理，已取内层地址', {
        source: source.name,
        inner: innerPlaylist,
      });
    } else if (parseFlagIsEnabled(played.parse) || parseFlagIsEnabled(played.jx)) {
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

    if (isMagnetUrl(direct)) {
      // P1-4：App 不内置种子下载/播放链路，点开必失败。这里给出确定结论 +
      // 原始地址（detail），UI 据此提供「用外部应用打开」，而不是一句「该源暂不可用」。
      throw new AppError('E_UNSUPPORTED_FORMAT', MAGNET_MESSAGE, {
        detail: direct.trim(),
        retryable: false,
      });
    }
    if (!/^https?:\/\//i.test(direct)) {
      throw new AppError('E_UNSUPPORTED_FORMAT', '播放地址协议不受支持', {
        detail: direct.slice(0, 120),
        retryable: false,
      });
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
   * P0-3: 并发执行直抓与嗅探，竞速返回；直抓超时从 15s 降到 8s。
   * 先按普通请求抓一次：App 系爬虫的解析中转接口（getM3u8 之类）响应体就是 m3u8
   * 清单本身，页面里不会有媒体子请求，WebView 嗅探只能干等超时（真机实证
   * 2026-11-03：热播|多线/AppTT 15s 超时报「无播放地址」）；抓到清单 → 该地址直接可播。
   * HTML 解析页（靠 JS 发起媒体请求）维持 WebView 嗅探。
   */
  private async resolveViaParse(source: Source, pageUrl: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!isNative()) {
      throw new AppError('E_NO_PLAY_URL', '该线路需要解析接口，暂不支持');
    }

    // P0-3: 并发执行直抓与嗅探，竞速返回
    const directPromise = this.fetchIfPlaylist(pageUrl, source, signal).catch((e: unknown) => {
      logger.warn('解析地址直抓失败', source.name, pageUrl, e);
      return null;
    });

    const sniffPromise = sniffPlayUrl(pageUrl, this.headersWith(source), 8_000).catch((e: unknown) => {
      logger.warn('嗅探解析失败', source.name, pageUrl, e);
      return null;
    });

    // 竞速：谁先返回有效结果用谁
    const result = await Promise.race([
      directPromise.then((url) => ({ source: 'direct' as const, url })),
      sniffPromise.then((url) => ({ source: 'sniff' as const, url })),
    ]);

    if (result.url) {
      logger.debug('解析竞速胜出', { source: source.name, winner: result.source, url: result.url });
      return result.url;
    }

    // 两者都失败，等待另一个完成（可能还在跑）
    const other = result.source === 'direct' ? await sniffPromise : await directPromise;
    if (other) return other;

    throw new AppError('E_NO_PLAY_URL', '未能从解析页取得播放地址，请换线路');
  }

  /** 解析地址的响应即 m3u8 清单 → 该地址本身可播；其余（HTML/错误页）返回 null 走嗅探 */
  private async fetchIfPlaylist(url: string, source: Source, signal?: AbortSignal): Promise<string | null> {
    const response = await httpClient.requestWithMeta<string>(url, {
      method: 'GET',
      headers: this.headersWith(source),
      signal,
      throwOnHttpError: false,
      retries: 0,
      // P0-3: 超时从 15s 降到 8s
      timeoutMs: 8_000,
      responseType: 'text',
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (/mpegurl/i.test(contentType)) return url;
    const body = (response.data ?? '').trimStart();
    if (!body.startsWith('#EXTM3U')) {
      logger.warn(
      '解析地址响应不是清单',
      source.name,
      `status=${response.status}`,
      `ct=${contentType}`,
      `head=${body.slice(0, 96).replace(/\s+/g, ' ')}`,
    );
    return null;
    }
    return url;
  }

  /** playerContent 的返回可能是 JSON 字符串，也可能被爬虫包装成其它结构 */
  private async invokePlayer(
    source: Source,
    flag: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<SpiderPlayerResult> {
    signal?.throwIfAborted();
    // P1-6：句柄已在内存（热）→ 10s 必须出结果；冷启动才给 30s 的下载/镜像余量
    const hot = this.handles.has(source.id);
    const invokeTimeout = hot ? NATIVE_INVOKE_TIMEOUT_HOT_MS : NATIVE_INVOKE_TIMEOUT_MS;
    const handle = await this.ensureLoaded(source, signal);

    // 方向3：设置本地代理归属，确保 9978 代理请求路由到正确的爬虫
    try {
      await SpiderNative.setCurrentOwner({ handle });
    } catch (e) {
      logger.warn('设置代理归属失败', { sourceId: source.id, error: e });
      // 不阻断主流程，继续执行
    }

    try {
      let result: { json: string | null; logs?: string[] };
      if (extOf(source).kind === 'js') {
        // CHG-16：drpy 的 play 编排，返回结构与 playerContent 同构
        result = await raceNative(
          () =>
            DrpyNative.invoke({
              handle,
              method: 'play',
              arg: JSON.stringify({ flag, id }),
            }),
          signal,
          invokeTimeout,
        );
      } else {
        result = await raceNative(
          () =>
            SpiderNative.invoke({
              handle,
              method: 'playerContent',
              args: [flag, id, ''],
              // vipFlags 是 List 形参，走 arrayArgs 避免被桥接展平
              arrayArgs: { 2: [] },
            }),
          signal,
          invokeTimeout,
        );
      }
      return parsePlayerJson(result.json, source.name);
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
    const handle = await this.ensureLoaded(source, signal);
    if (extOf(source).kind === 'js') {
      // drpy 规则没有 TVBox 的 proxy(Map) 契约；parse=1 的场景走 resolveViaParse
      throw new AppError('E_NO_PLAY_URL', 'drpy 源不支持爬虫代理地址');
    }
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

  /**
   * 取该源的第一个分类值（空 tid 的回退目标）。
   *
   * 优先用 `listCategories` 缓存的分类表；没有缓存时拉一次 homeContent。
   * 全部失败时返回空串——保持旧行为，让爬虫自己决定怎么处理（有些源确实接受空 tid）。
   */
  private async firstCategoryValue(source: Source): Promise<string> {
    const cached = this.categoryCache.get(source.id);
    if (cached !== undefined) return cached[0]?.value ?? '';
    try {
      const categories = await this.listCategories(source);
      return categories[0]?.value ?? '';
    } catch (e) {
      logger.warn('取首个分类失败，回退空 tid', source.name, e);
      return '';
    }
  }
}

/** TVBox 的 parse/jx 既可能是 0/1，也可能是 true/"1" */
function parseFlagIsEnabled(value: SpiderPlayerResult['parse']): boolean {
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.trim() === '1' || value.trim().toLowerCase() === 'true';
  return false;
}

/** P1: 识别网盘登录错误 */
function detectNetdiskError(msg: string): 'E_NETDISK_LOGIN_REQUIRED' | undefined {
  if (!msg) return undefined;
  const lower = msg.toLowerCase();
  if (lower.includes('未登录') || lower.includes('还未登录') || lower.includes('未配置') || lower.includes('请登录')) {
    return 'E_NETDISK_LOGIN_REQUIRED';
  }
  if (lower.includes('cookie') || lower.includes('账号')) {
    return 'E_NETDISK_LOGIN_REQUIRED';
  }
  return undefined;
}

/** HEAD 结论不确定：超时（慢网络活源）或服务端不支持 HEAD（405/501），应继续 B 段 */
function headInconclusive(e: unknown): boolean {
  if (e instanceof AppError) {
    if (e.code === 'E_TIMEOUT') return true;
    return e.httpStatus === 405 || e.httpStatus === 501;
  }
  return false;
}
