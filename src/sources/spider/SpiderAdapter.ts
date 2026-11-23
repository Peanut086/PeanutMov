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
import {
  classifySourceFailure,
  isMagnetUrl,
  COOLDOWN_MESSAGE,
  MAGNET_MESSAGE,
  QUARANTINE_MESSAGE,
  SAFE_MODE_MESSAGE,
  SPIDER_MISMATCH_MESSAGE,
  sanitizeSourceMessage,
} from '@/shared/sourceFailure';
import { recordUpstreamNotice, redactNoticeText } from '@/shared/noticeOrigin';
import {
  LOAD_FAILURE_LABELS,
  classifyDeterministicLoadFailure,
  findAttemptedArtifact,
  findSuppressedLoadFailure,
  markArtifactAttempted,
  noteLoadFailure,
} from '@/services/spiderLoadLedger';
import { clearSourceBlock, isSourceBlocked, noteSourceBlocked } from '@/services/sourceBlockState';
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
import { isNetdiskSource } from '@/services/netdiskPlatforms';
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
  /** SO-05：单源搜索超时覆盖（秒），来自订阅 ext.timeout */
  timeout?: number;
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

/** P0-3: 检查 vod 条目是否有有效的 vod_id（非空/非 'unknown' 兜底值） */
function vodIdHasValue(vod: TvboxVod): boolean {
  const id = vod.vod_id;
  if (id === null || id === undefined) return false;
  if (typeof id === 'string' && id.trim().length === 0) return false;
  return true;
}

/**
 * P4-3: 把画质/线程配置合并进网盘源的 JSON ext
 *
 * 只认 JSON 对象形态。drpy/catvod 侧靠 `JSON.parse(ext)` 取源配置
 * （见 assets/drpy_host.js 的 `__catvodEnsureInit`），此前用 `ext|||{json}`
 * 追加会让整次解析抛错并退回 `{}` —— 不但配置没下发，连源自带的 api/token
 * 配置一起丢掉，等于把能用的网盘源改坏。URL 形态与加密 ext 一律原样返回。
 *
 * 合并只是「尽力而为」的下发通道：未知 key 会被守规矩的爬虫忽略，
 * 因此设置页据此标注为「由爬虫源自行生效」，不承诺必然生效。
 * P2-1: 加密 ext（长度 > 100 且非 JSON 对象）不追加，避免破坏加密结构
 */
function appendNetdiskConfig(initExt: string): string {
  const trimmed = (initExt ?? '').trim();
  if (!trimmed.startsWith('{')) return initExt;

  try {
    const existing = JSON.parse(trimmed) as unknown;
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      return initExt;
    }
    const config = getNetdiskConfig();
    const patch = JSON.parse(formatConfigForSpider(config)) as Record<string, unknown>;
    return JSON.stringify({ ...(existing as Record<string, unknown>), ...patch });
  } catch (e) {
    logger.debug('ext 不是 JSON 对象，跳过网盘配置合并', e);
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
  header?: Record<string, string> | string | null;
  /** 部分爬虫把地址放在子字段里 */
  playUrl?: string | null;
  /** 1 = 地址需经爬虫的 proxy(Map) 换回直链（TVBox 约定） */
  proxy?: number | boolean | string | null;
  flag?: string | null;
  msg?: string | null;
  /** P1: 错误码（用于前端分类处理） */
  code?: string;
}

/**
 * 把 playerContent 的 header 摊成真正的键值对。
 *
 * jar 爬虫常把 header 原样塞成 JSON 字符串（Java 侧 `JSONObject.toString()` 直接 put 进去），
 * 类型声明却是对象。字符串一旦进 `{...played.header}` 会被摊成 `"0".."80"` 的字符下标头：
 * 真机实测 UA 与 Referer 一个都没发出去，CDN 一律 403——而请求日志里只看见一堆单字符头，
 * 排查时没人想到根因在这一行。
 */
function headerMapOf(header: SpiderPlayerResult['header']): Record<string, string> {
  if (!header) return {};
  let value: unknown = header;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || raw === undefined) continue;
    out[key] = typeof raw === 'string' ? raw : String(raw);
  }
  return out;
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
 * F3：僵尸原生调用的冷却窗口。JS 侧 raceNative 超时只是放弃等待，原生任务还会跑
 * 到自身看门狗/HTTP 超时（最长 ≈ INVOKE_TIMEOUT_MS 30s）；窗口内对同一源的重试
 * 会被直接拒绝，避免"重试失败源"往还在执行的实例上撞（原生侧另有 F1 同实例锁兜底）。
 */
const ZOMBIE_COOLDOWN_MS = 30_000;
/**
 * P1-5：被原生 F1 闸门挡回（「源正忙」）时的排队预算。
 *
 * 真机实测：批量下载期间刷新详情页，同一秒里既有 `源正忙` 拒绝也有同源
 * `exec=1037ms` 成功——挡回它的那次调用马上就要结束，冷却却按 30s 报。
 * 现在按**在飞调用的真实截止时间**记冷却，剩余不超过这个预算的就等它落定重投一次；
 * 超过的（真僵尸）仍然快速失败，不陪等 30 秒。
 */
const BUSY_WAIT_MAX_MS = 5_000;
/** 原生说忙、但 JS 侧没记到在飞调用（预热等其它入口发的）时的保守冷却 */
const BUSY_COOLDOWN_FALLBACK_MS = 6_000;
/** 排队的轮询间隔（在飞调用落定时会主动摘掉冷却，通常一两次就能放行） */
const BUSY_IDLE_POLL_MS = 150;
/**
 * 「上一次调用还在原生侧跑」的两种成因：
 * - `busy`：原生 F1 锁挡回，报告的是**另一个**调用还在跑，它落定就有空位；
 * - `zombie`：本次调用自己超时/被放弃，原生线程仍在跑到自身看门狗（≈30s）。
 */
type NativeBusyKind = 'busy' | 'zombie';

/**
 * F4：本次会话内已知「jar 自带原生库」的源 id。
 *
 * 带原生库的 jar（guard 系列）在并发初始化时是原生崩溃的头号触发条件，
 * 预热据此把它们排到最后单独串行跑。原生侧另有 F1 闸门（同 jar 串行 + 全局 ≤2），
 * 这里只是让正常预热不去撞那道闸门。
 * 仅内存态：冷启动首轮没有先验知识，由 F1 兜底；熔断时预热整体降级串行，不依赖这份名单。
 */
const nativeBearingSourceIds = new Set<string>();

export function isNativeBearingSpiderSource(sourceId: string): boolean {
  return nativeBearingSourceIds.has(sourceId);
}

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
  // 保护态/隔离态：原文含 IllegalStateException 会被收敛成"源侧执行异常"，
  // 这里前置识别，让 UI 与容错链拿到对症原因。
  if (message.includes('safe mode active')) {
    return new AppError('E_SOURCE_UNAVAILABLE', SAFE_MODE_MESSAGE, { detail: message, cause: e });
  }
  if (message.includes('quarantined')) {
    return new AppError('E_SOURCE_UNAVAILABLE', QUARANTINE_MESSAGE, { detail: message, cause: e });
  }
  // P0-1：冷却档单独成类。归进 quarantined 会让 UI 让用户去解一份并不存在的隔离。
  if (message.includes('cooling down')) {
    return new AppError('E_SOURCE_UNAVAILABLE', COOLDOWN_MESSAGE, { detail: message, cause: e });
  }
  if (message.includes('超时')) {
    return new AppError('E_TIMEOUT', message);
  }
  // 401/403/429 分档：三种处置完全不同（改凭据 / 等一等），合成一句「源可能已失效」
  // 会把它们都送去自动换线重试——对 429 是续上限，对 401 是白烧一轮。
  // 状态同时写进 httpStatus，让分类不只能靠文案猜。
  if (/HTTP 401/.test(message)) {
    return new AppError('E_HTTP_401', '源地址要求鉴权（HTTP 401），凭据可能已失效', {
      detail: message,
      httpStatus: 401,
      cause: e,
    });
  }
  if (/HTTP 403/.test(message)) {
    return new AppError('E_HTTP_403', '源地址拒绝访问（HTTP 403），可能被限制', {
      detail: message,
      httpStatus: 403,
      cause: e,
    });
  }
  if (/HTTP 429/.test(message)) {
    return new AppError('E_HTTP_429', '源侧限流（HTTP 429），稍后再试', {
      detail: message,
      httpStatus: 429,
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
  // P1-2：链接期/二进制不兼容的错都归到同一句人话——对用户都是「这个 jar 跟当前 App 装不上」，
  // 逐个透出 `IncompatibleClassChangeError` 只会变成看不懂的英文堆栈词。
  if (
    /ClassNotFound|NoClassDefFound|NoSuchMethod|NoSuchField|ClassCastException|IncompatibleClassChange|UnsupportedClassVersion|VerifyError|ExceptionInInitializer/.test(
      message,
    )
  ) {
    return new AppError('E_PARSE', SPIDER_MISMATCH_MESSAGE, { detail: message, cause: e });
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
  /**
   * F3：sourceId → 冷却（截止时刻 + 成因，jar 爬虫专用）。
   * 成因决定后来者怎么办：`busy` 排队等空位，`zombie` 不陪等直接快速失败。
   */
  private readonly invokeCooldown = new Map<string, { until: number; kind: NativeBusyKind }>();
  /**
   * P1-5：sourceId → 当前已发给原生、JS 侧仍在竞速的 jar 调用。
   * 用集合而非单值：被 F1 挡回的那次调用自己也在里面，它落定时只能摘掉自己那一条
   * （按对象引用删），否则会把真正在飞的那次的截止时间误删。
   */
  private readonly nativeCallDeadlines = new Map<string, Set<{ deadlineAt: number }>>();

  /* ---------------- 探活与加载 ---------------- */

  /**
   * P0-3：冷/热分级窗口。句柄已在内存时（复检、体检第二轮）只走 homeContent +
   * 一次列表，按热窗口收紧；冷启动才给 jar 下载（原生侧连接 20s、读取 30s）+ dex +
   * 防护初始化的余量，故首次给 35s——基类的类型分级在句柄状态这里帮不上忙。
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
   * F10：句柄不在内存 = 这次调用还要走 jar 下载 / dex / 防护初始化（drpy 则是规则加载）。
   * 搜索扇出据此给冷源追加一段加载预算，避免加载时间把搜索预算吃干。
   */
  override isSourceCold(source: Source): boolean {
    return !this.handles.has(source.id);
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
    // P0-1：原生已隔离/冷却的源，本轮不再发加载请求。此前预热只认确定性加载失败台账
    // （isLoadSuppressed），对保护态一无所知——每次批量预热都重新去敲一扇已经明确拒绝的门。
    if (isSourceBlocked(source.id)) {
      logger.debug('跳过保护态中的爬虫源预热', source.name);
      return;
    }
    // P1-2：同一版 jar/规则已经确定崩过一次的，不再每轮冷启动重下一遍
    // （真实搜索仍照常发起，判错种类不会让用户拿不到结果）
    if (await this.isLoadSuppressed(source, ext)) return;
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
   * P1-2：账本用的「规则 / JAR 版本」标识。
   *
   * jar 用配置里的原始 `jarUrl`（含 `;md5;` 后缀）——后缀就是版本，源站换文件即新版本；
   * drpy 用规则地址。镜像变体是同一个文件的不同入口，不参与版本判定。
   */
  private loadVersionTarget(source: Source, ext: SpiderSourceExt): string {
    if (ext.kind === 'js') return this.ruleUrlCandidates(source, ext)[0] ?? '';
    return (ext.jarUrl ?? '').trim();
  }

  /** 命中确定性失败账本时记一条日志并返回 true（跳过预热的唯一依据） */
  private async isLoadSuppressed(source: Source, ext: SpiderSourceExt): Promise<boolean> {
    const target = this.loadVersionTarget(source, ext);
    if (!target) return false;
    const hit = await findSuppressedLoadFailure(source, target);
    if (!hit) return false;
    logger.debug('跳过确定性坏源的预热', source.name, LOAD_FAILURE_LABELS[hit.kind]);
    return true;
  }

  /**
   * P1-2 / P1-3：所有候选地址都失败后，判一次是不是「同一输入必然同样失败」。
   *
   * 持久记账只影响后台预热，不改这次的报错——用户看到的仍然是对症错误。
   * P1-3 另外把它记进本进程：同一构件在这个运行里已经栽过一次，再下载再 dex 一遍
   * 结论不会变（缺类还是缺类、语法错还是语法错），第二次直接用第一次的原因失败。
   */
  private async noteLoadFailureIfNeeded(
    source: Source,
    ext: SpiderSourceExt,
    lastError: unknown,
  ): Promise<void> {
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? '');
    const kind = classifyDeterministicLoadFailure(message);
    const target = this.loadVersionTarget(source, ext);
    if (!kind || !target) return;
    markArtifactAttempted(source, kind, target, message);
    try {
      await noteLoadFailure(source, kind, target, message);
    } catch (e) {
      logger.debug('确定性失败记账失败（忽略）', e);
    }
  }

  /**
   * P1-3：本进程已判定为确定性坏构件时，跳过重新下载/加载，直接用第一次的真实原因失败。
   *
   * 只跳过**同一份构件**（jar 地址含 `;md5;` 后缀、drpy 规则地址），换版本即重新真跑一次；
   * 报错保持原判据（`isJarLinkageMessage` 等据此分类），不新造一套口径。
   */
  private knownBadArtifact(source: Source, ext: SpiderSourceExt): AppError | null {
    const target = this.loadVersionTarget(source, ext);
    const hit = findAttemptedArtifact(source, target);
    if (!hit) return null;
    logger.debug('同一构件本进程已确定性失败，跳过重复加载', source.name, LOAD_FAILURE_LABELS[hit.kind]);
    // 走与第一次同一条文案收敛：账本里存的是原生原文，直接抛出去会让用户在第二次看到英文堆栈
    return nativeErrorOf(
      new Error(hit.message),
      new AppError('E_SOURCE_UNAVAILABLE', LOAD_FAILURE_LABELS[hit.kind], { detail: source.name }),
    );
  }

  /**
   * P0-1：把原生的保护态（隔离 / 冷却 / 安全模式）镜像到前端。
   * 只镜像原生真实抛回来的拒绝，不猜 api↔jar 对应关系（同类名可能分布在多个 jar，
   * 按类名反推会误杀健康站）。预热、失败换线、自动换源据此在同一轮避开该源。
   */
  private mirrorProtection(source: Source, error: AppError | null): void {
    if (!error) return;
    const kind = classifySourceFailure(error.toShape());
    if (kind !== 'quarantined' && kind !== 'cooldown' && kind !== 'safe_mode') return;
    noteSourceBlocked(source.id, kind, error.message);
  }

  /** P0-1：任何一次成功调用都说明原生已放行，解除镜像 */
  private clearProtection(source: Source): void {
    clearSourceBlock(source.id);
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
    // P1-3：这个 jar 在本次进程里已经确定性失败过（缺类/依赖冲突/md5 不过），
    // 重下重 dex 结论不会变，直接用第一次的真实原因失败，不再占爬虫池。
    const knownBad = this.knownBadArtifact(source, ext);
    if (knownBad) throw knownBad;
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
        // F4：竞速失败（超时/取消）后原生可能仍完成加载并返回句柄——那时句柄无人认领、
        // 也永远不会被 unload（实例+jar 状态滞留）。保留 promise 引用，迟到回执时回收。
        let delivered = false;
        const loadPromise = Promise.resolve().then(() =>
          SpiderNative.load({
            jarUrl: `${candidate}${md5Suffix}`,
            api: ext.api ?? '',
            initExt,
            userAgent: source.headers['User-Agent'] ?? source.headers['user-agent'] ?? null,
          }),
        );
        void loadPromise.then(
          (late) => {
            if (!late?.handle) return;
            if (late.native === true) nativeBearingSourceIds.add(source.id);
            // 宏任务再判定：成功路径的 delivered/handles 写入都发生在微任务里，
            // 同步检查会把"刚创建的正牌句柄"误判成孤儿。
            setTimeout(() => {
              if (!delivered && this.handles.get(source.id) !== late.handle) {
                logger.warn('jar 加载迟到回执，回收孤儿句柄', source.name, late.handle);
                // Promise.resolve 包裹：mock/Web 代理可能不返回 thenable，不可直接 .catch
                void Promise.resolve(SpiderNative.unload({ handle: late.handle })).catch(() => {});
              }
            }, 0);
          },
          () => {
            /* 失败路径无需回收（没有句柄产生） */
          },
        );
        const result = await raceNative(() => loadPromise, signal, NATIVE_LOAD_TIMEOUT_MS);
        delivered = true;
        this.jarVariants.set(source.id, candidate);
        this.handles.set(source.id, result.handle);
        // undefined（Web/旧插件不带该字段）时保留既有判断，不当成"非原生"
        if (result.native === true) nativeBearingSourceIds.add(source.id);
        else if (result.native === false) nativeBearingSourceIds.delete(source.id);
        this.clearProtection(source);
        return result.handle;
      } catch (e) {
        if (e instanceof AppError && e.code === 'E_ABORTED') throw e;
        lastError = e;
        logger.warn('爬虫 jar 加载失败（本次变体）', source.name, candidate, e);
      }
    }
    await this.noteLoadFailureIfNeeded(source, ext, lastError);
    const failed = nativeErrorOf(
      lastError,
      new AppError('E_SOURCE_UNAVAILABLE', '爬虫加载失败，请检查网络或更换源'),
    );
    this.mirrorProtection(source, failed);
    throw failed;
  }

  /**
   * CHG-16：加载 drpy 规则到原生 QuickJS 引擎。
   * 候选地址按序尝试（GitHub 地址自动带镜像变体，与 jar 加载同口径）；
   * 命中的变体记入 jarVariants（js 源复用该映射存规则变体）。
   */
  private async loadJs(source: Source, ext: SpiderSourceExt, signal?: AbortSignal): Promise<string> {
    // P1-3：同一条规则本次进程已因语法/引用错误失败过 → 不再重跑镜像变体数组
    const knownBad = this.knownBadArtifact(source, ext);
    if (knownBad) throw knownBad;
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
          this.clearProtection(source);
          return result.handle;
        } catch (e) {
          if (e instanceof AppError && e.code === 'E_ABORTED') throw e;
          lastError = e;
          logger.warn('drpy 规则加载失败（本次变体）', source.name, variant, e);
        }
      }
    }
    await this.noteLoadFailureIfNeeded(source, ext, lastError);
    const failed = nativeErrorOf(
      lastError,
      new AppError('E_SOURCE_UNAVAILABLE', 'drpy 规则加载失败，请检查网络或更换源'),
    );
    this.mirrorProtection(source, failed);
    throw failed;
  }

  private async invoke(
    source: Source,
    method: SpiderMethod,
    args: Array<string | number | boolean | Record<string, string> | string[]>,
    /** 位置下标 → 数组值：List 形参必须走这里（桥接会展平嵌套数组） */
    arrayArgs?: Record<number, string[]>,
    signal?: AbortSignal,
    /** SO-05：调用方传入的预算超时，覆盖默认 NATIVE_INVOKE_TIMEOUT_MS */
    timeoutMs?: number,
  ) {
    signal?.throwIfAborted();
    // F3：上一次调用还在原生线程里跑时，不对同一实例发第二次并发调用；
    // P1-5：剩余时间很短的「源忙」排队等它落定再投，不再把用户支去等 30 秒
    await this.reserveNativeCall(source, signal);
    const handle = await this.ensureLoaded(source, signal);
    const effectiveTimeout = timeoutMs ?? NATIVE_INVOKE_TIMEOUT_MS;
    const isJar = extOf(source).kind !== 'js';
    try {
      const result = isJar
        ? await this.invokeJar(source, handle, method, args, effectiveTimeout, arrayArgs, signal)
        : // CHG-16：drpy 路由——TVBox 方法名映射为编排方法，位置参数拼成单参 JSON。
          // drpy 运行时自带引擎单线程队列，不存在并发重入，冷却逻辑不适用。
          await raceNative(
            () =>
              DrpyNative.invoke({
                handle,
                method: drpyMethodOf(method),
                arg: JSON.stringify(drpyArgOf(method, args)),
              }),
            signal,
            effectiveTimeout,
          );
      this.clearProtection(source);
      return parseSpiderJson(result.json, method, source.name);
    } catch (e) {
      if (e instanceof AppError) throw e;
      logger.warn('爬虫调用失败', source.name, method, e);
      const failed = nativeErrorOf(e, new AppError('E_SOURCE_UNAVAILABLE', '爬虫执行失败'));
      this.mirrorProtection(source, failed);
      throw failed;
    }
  }

  /**
   * jar 爬虫的单次原生调用（F1 同实例串行的 JS 侧配合）。
   *
   * 被原生忙挡回时最多排队重投一次：第二次仍挡就直接抛，绝不循环——
   * 「等空位」不等于「放开串行」，同一时刻仍然只有一个调用压在原生实例上。
   */
  private async invokeJar(
    source: Source,
    handle: string,
    method: SpiderMethod,
    args: Array<string | number | boolean | Record<string, string> | string[]>,
    timeoutMs: number,
    /** 位置下标 → 数组值：List 形参必须走这里（桥接会展平嵌套数组） */
    arrayArgs?: Record<number, string[]>,
    signal?: AbortSignal,
  ): Promise<{ json: string | null; logs?: string[] }> {
    for (let attempt = 0; ; attempt += 1) {
      // Promise.resolve().then 包装：mock/Web 代理可能**同步**抛错，直接取值会绕过 promise 轨道
      const callPromise = Promise.resolve().then(() =>
        SpiderNative.invoke({ handle, method, args, arrayArgs }),
      );
      // 僵尸真正结束时提前解除冷却（raceNative 的放弃 ≠ 原生任务的结束）。
      // finally 的返回 promise 会原样转发拒绝，必须再 catch 兜住，否则 unhandled。
      let callSettled = false;
      const call = { deadlineAt: Date.now() + timeoutMs };
      this.markNativeCall(source.id, call);
      void callPromise
        .finally(() => {
          callSettled = true;
          this.clearNativeCall(source.id, call);
          this.invokeCooldown.delete(source.id);
        })
        .catch(() => {});
      try {
        return await raceNative(() => callPromise, signal, timeoutMs);
      } catch (e) {
        const busy = this.busyKindOf(e, callSettled);
        if (busy) {
          this.enterBusyCooldown(source.id, busy);
          // 只对「另一个调用还在跑」排队：僵尸那 30 秒不该让详情页陪着卡
          if (attempt === 0 && busy === 'busy' && (await this.waitForNativeIdle(source.id, signal))) {
            logger.debug('源忙排队成功，重投一次', { sourceName: source.name, method });
            continue;
          }
          if (!(e instanceof AppError)) {
            // 原生忙拒绝（F1 锁）：P1-3 独立成 `E_SOURCE_BUSY`——文案对准真实状态，
            // 也不再借"源不可用"被下游当成死源立刻重投、换线路、记线路连败
            throw new AppError('E_SOURCE_BUSY', this.busyMessage(source.id), {
              detail: source.name,
              cause: e,
            });
          }
        }
        throw e;
      }
    }
  }

  /** F3：判定"上一次原生调用还在跑"并分成因（完成与到期同刻竞走时不该记冷却） */
  private busyKindOf(e: unknown, callSettled: boolean): NativeBusyKind | null {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('源正忙')) return 'busy';
    if (e instanceof AppError && !callSettled && (e.code === 'E_TIMEOUT' || e.code === 'E_ABORTED')) {
      return 'zombie';
    }
    return null;
  }

  /**
   * P1-5：冷却窗口对准真实在飞调用。
   * `busy` 取其它在飞调用最迟的 JS 截止时刻（那是"最坏还要多久"的上界，
   * 真机实测常态只有 1~2s，旧口径一律按 30s 报）；`zombie` 维持 F3 的 30s。
   */
  private enterBusyCooldown(sourceId: string, kind: NativeBusyKind): void {
    const now = Date.now();
    if (kind === 'zombie') {
      this.invokeCooldown.set(sourceId, { until: now + ZOMBIE_COOLDOWN_MS, kind });
      return;
    }
    let latest = 0;
    for (const call of this.nativeCallDeadlines.get(sourceId) ?? []) {
      latest = Math.max(latest, call.deadlineAt);
    }
    const until = latest === 0
      ? now + BUSY_COOLDOWN_FALLBACK_MS
      : Math.min(Math.max(latest, now + BUSY_IDLE_POLL_MS), now + ZOMBIE_COOLDOWN_MS);
    this.invokeCooldown.set(sourceId, { until, kind });
  }

  /** 登记/摘掉一次已发给原生、JS 侧仍在竞速的调用（按对象引用删，只删自己那条） */
  private markNativeCall(sourceId: string, call: { deadlineAt: number }): void {
    const set = this.nativeCallDeadlines.get(sourceId) ?? new Set();
    set.add(call);
    this.nativeCallDeadlines.set(sourceId, set);
  }

  private clearNativeCall(sourceId: string, call: { deadlineAt: number }): void {
    const set = this.nativeCallDeadlines.get(sourceId);
    if (!set) return;
    set.delete(call);
    if (set.size === 0) this.nativeCallDeadlines.delete(sourceId);
  }

  /**
   * P1-5：等这个源排到空位——在飞调用落定时它的 finally 会摘掉冷却，这里只是轮询确认，
   * 不并发发第二次（串行闸门不松口）。预算就是预算：不超过 BUSY_WAIT_MAX_MS。
   */
  private async waitForNativeIdle(sourceId: string, signal?: AbortSignal): Promise<boolean> {
    const giveUpAt = Date.now() + BUSY_WAIT_MAX_MS;
    for (;;) {
      // 与 raceNative 同一口径：排队等待被取消也是 E_ABORTED，不能让 DOMException 串到错误面板
      if (signal?.aborted) throw new AppError('E_ABORTED');
      const cooldown = this.invokeCooldown.get(sourceId);
      if (cooldown === undefined) return true;
      // 在飞调用中途变成僵尸（自己也没等到回执）：那是 30 秒量级，不陪等
      if (cooldown.kind === 'zombie') return false;
      if (Date.now() >= giveUpAt) return false;
      await new Promise((resolve) => setTimeout(resolve, BUSY_IDLE_POLL_MS));
    }
  }

  /** 忙到排不上时的文案：给真实剩余秒数，不指挥用户去查网络 */
  private busyMessage(sourceId: string): string {
    const remainMs = (this.invokeCooldown.get(sourceId)?.until ?? 0) - Date.now();
    return remainMs > 0
      ? `该源正忙（上一次调用约 ${Math.ceil(remainMs / 1000)} 秒后结束），请稍后重试`
      : '该源正忙（上一次调用仍未结束），请稍后重试';
  }

  /**
   * P1-3：把「这个源现在有多忙」交给上层——等待预算必须来自真实在飞时长，不能再写死秒数。
   *
   * - `inFlightMs`：该源在飞调用最迟的 JS 截止时刻还剩多久（同 `enterBusyCooldown` 口径）。
   *   僵尸那 30 秒也算在里面，所以调用方要按 `busyWaitBudgetMs` 的上限自己收口。
   * - `queueDepth`：JS 侧已投进原生、尚未回执的调用数。**不是**原生池那条 32 长队列——
   *   原生 `ThreadPoolExecutor` 的队列长度在 JS 侧不可观测，这里给的是能实测的那一半。
   */
  busyStateOf(sourceId: string): { inFlightMs: number; queueDepth: number } {
    const now = Date.now();
    let latest = 0;
    for (const call of this.nativeCallDeadlines.get(sourceId) ?? []) {
      latest = Math.max(latest, call.deadlineAt);
    }
    const cooldownRemain = (this.invokeCooldown.get(sourceId)?.until ?? 0) - now;
    return {
      inFlightMs: Math.max(0, Math.max(latest - now, cooldownRemain)),
      queueDepth: this.nativeCallDeadlines.get(sourceId)?.size ?? 0,
    };
  }

  /** F3 + P1-5：冷却窗口内先按成因排队，排不上或僵尸窗口才快速失败 */
  private async reserveNativeCall(source: Source, signal?: AbortSignal): Promise<void> {
    const cooldown = this.invokeCooldown.get(source.id);
    if (cooldown === undefined) return;
    if (cooldown.kind === 'busy' && (await this.waitForNativeIdle(source.id, signal))) return;
    if (cooldown.until <= Date.now()) {
      // 窗口已过：摘掉冷却，允许下一次真正尝试，不再无限期锁死这个源
      this.invokeCooldown.delete(source.id);
      return;
    }
    throw new AppError('E_SOURCE_BUSY', this.busyMessage(source.id), { detail: source.name });
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
    const response = await this.invoke(source, 'searchContent', args, undefined, params.signal, params.budgetMs);
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
    const list = response.list ?? [];
    const matched = list.find((entry) => vodIdOf(entry) === sourceItemId);
    // P0-3: list[0] 兜底仅在「单条且无 vod_id」时安全；多条目或条目有 id 但不匹配时拒绝
    const vod = matched ?? (list.length === 1 && !vodIdHasValue(list[0]) ? list[0] : null);
    if (!vod) {
      logger.warn('SpiderAdapter.getDetail: 源返回条目与请求不一致', {
        source: source.name,
        sourceItemId,
        listCount: list.length,
        firstVodId: list[0] ? vodIdOf(list[0]) : null,
      });
      throw new AppError('E_SOURCE_UNAVAILABLE', '源详情返回的条目与请求不一致', {
        detail: `sourceItemId=${sourceItemId}, listCount=${list.length}`,
      });
    }

    // P0-1: mediaId 必须基于请求时的 sourceItemId（而非爬虫返回的 vodId，后者可能为空/不稳定）
    const stableMediaId = mediaIdOf(source.id, sourceItemId);
    const item = this.toItem(source, vod);
    item.id = stableMediaId;
    item.sourceItemId = sourceItemId;
    const { lines, episodes } = buildLinesWithRaw(source, vod, stableMediaId);
    logger.debug('SpiderAdapter.getDetail: 详情加载完成', {
      source: source.name,
      sourceItemId,
      title: item.title,
      lines: lines.length,
      episodes: episodes.length,
    });
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
   *
   * P0-4: 新增 episodeNumber 兜底——当 episodeId 匹配失败（如缓存数据来自旧版本），
   * 按序号匹配同一位置的剧集。
   */
  private locateEpisode(
    lines: PlayLine[],
    rawEpisodes: RawEpisode[][],
    lineId: string | null | undefined,
    episodeId: string | null | undefined,
    episodeNumber?: number,
  ): { line: PlayLine; picked: RawEpisode } | null {
    const wantedLine = lines.find((entry) => entry.id === lineId) ?? null;
    const wantedEpisode = String(episodeId ?? '').trim();

    const pickIn = (line: PlayLine): RawEpisode | null => {
      const list = rawEpisodes[line.index] ?? [];
      return list.find((entry) => entry.id === wantedEpisode) ?? null;
    };

    const pickByNumber = (line: PlayLine): RawEpisode | null => {
      if (episodeNumber === undefined || !Number.isFinite(episodeNumber)) return null;
      const list = rawEpisodes[line.index] ?? [];
      return list.find((entry) => entry.number === episodeNumber) ?? null;
    };

    if (wantedLine !== null) {
      const picked = pickIn(wantedLine);
      if (picked !== null) return { line: wantedLine, picked };
      // P0-4: id 匹配失败，尝试按序号兜底
      const byNumber = pickByNumber(wantedLine);
      if (byNumber !== null) return { line: wantedLine, picked: byNumber };
    }

    if (wantedEpisode.length > 0) {
      for (const line of lines) {
        if (line === wantedLine) continue;
        const picked = pickIn(line);
        if (picked !== null) return { line, picked };
      }
      // P0-4: 所有线路 id 都匹配失败，尝试按序号兜底
      if (episodeNumber !== undefined) {
        for (const line of lines) {
          if (line === wantedLine) continue;
          const byNumber = pickByNumber(line);
          if (byNumber !== null) return { line, picked: byNumber };
        }
      }
      return null;
    }

    const line = wantedLine ?? lines[0];
    if (line === undefined) return null;
    const first = (rawEpisodes[line.index] ?? []).find((entry) => entry.url.length > 0);
    return first !== undefined ? { line, picked: first } : null;
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId, episodeNumber } = params;
    this.assertEnabled(source);

    // 1. 取剧集列表（与 SiteAdapter 同一口径），定位用户点的那一集
    const response = await this.invoke(
      source,
      'detailContent',
      [sourceItemId],
      { 0: [sourceItemId] },
      params.signal,
    );
    const list = response.list ?? [];
    const matched = list.find((entry) => vodIdOf(entry) === sourceItemId);
    // P0-3: list[0] 兜底仅在「单条且无 vod_id」时安全
    const vod = matched ?? (list.length === 1 && !vodIdHasValue(list[0]) ? list[0] : null);
    if (!vod) {
      throw new AppError('E_SOURCE_UNAVAILABLE', '源详情返回的条目与请求不一致', {
        detail: `sourceItemId=${sourceItemId}, listCount=${list.length}`,
      });
    }
    // P0-1: mediaId 基于请求参数而非爬虫返回的 vodId（可能为空/不稳定）
    const stableMediaId = mediaIdOf(source.id, sourceItemId);
    const { lines, rawEpisodes } = buildLinesWithRaw(source, vod, stableMediaId);
    const located = this.locateEpisode(lines, rawEpisodes, lineId, episodeId, episodeNumber);
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
      // 爬虫 msg 是上游原文，此前原样进 AppError.message 就被顶到界面上：里面常带 cookie、
      // 签名直链，也带着真正的原因（「本接口免费使用…」就是额度，不是源失效）。
      // 登记只解决「这条提示从哪儿来」；分档仍走 classifySourceFailure 一套口径。
      const notice = recordUpstreamNotice(msg, {
        origin: 'spider_msg',
        operation: 'playerContent',
        sourceId: source.id,
        // `played.code` 声明了却从没被读过——业务码是区分额度与鉴权的关键一档
        businessCode: played.code ?? null,
        errorCode: errorCode ?? 'E_NO_PLAY_URL',
      });
      const display = redactNoticeText(sanitizeSourceMessage(msg));
      throw new AppError(errorCode ?? 'E_NO_PLAY_URL', display || '爬虫未返回播放地址', {
        detail: notice.detail,
        meta: { requestId: notice.requestId, noticeOrigin: notice.noticeOrigin, failureKind: notice.kind },
      });
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

    const playHeaders = headerMapOf(played.header);
    const headers = this.headersWith(source, proxyHeaders ? { ...playHeaders, ...proxyHeaders } : playHeaders);

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

/**
 * P1: 识别网盘登录错误。
 *
 * 只认明确的「登录/凭证缺失」文案。旧实现把任意含 `cookie` / `账号` 的 msg 都判为
 * 未登录，导致夸克分享类错误（如 41031「分享者账号已被封禁」、失效分享提示）被误映射成
 * `E_NETDISK_LOGIN_REQUIRED`，把已登录的用户反复弹去登录页。现改为：登录短语直接命中；
 * `cookie/凭证/token` 必须配合「失效/过期/为空」等限定词才算登录态问题。
 */
export function detectNetdiskError(msg: string): 'E_NETDISK_LOGIN_REQUIRED' | undefined {
  if (!msg) return undefined;
  const lower = msg.toLowerCase();
  // 播放失败文案里出现「登录」基本就是登录态问题（未登录/请先登录/重新登录/登录失效/扫码登录）；
  // 夸克分享与死链文案（分享者账号已被封禁、分享地址已失效）不含「登录」，因此不会误判。
  if (lower.includes('登录')) return 'E_NETDISK_LOGIN_REQUIRED';
  if (/未配置|请配置|配置中心/.test(lower)) return 'E_NETDISK_LOGIN_REQUIRED';
  // cookie/凭证类：需带失效限定词，避免分享文案里出现「cookie」二字就误判
  if (
    /(cookie|凭证|令牌|token)[^。]*?(失效|过期|无效|错误|为空|未设置|缺失|missing|invalid|expired)/.test(
      lower,
    )
  ) {
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
