/**
 * 弹幕数据 Provider（v1.7 / CHG-22，只读不发）
 *
 * 回退顺序（`danmakuService.match` 按序尝试）：
 *
 * 实时播放（`scene='playback'`）时 1~4 四个内置直连源**并行**发起，先给出「题名匹配且过门槛」
 * 的结果胜出，整组 12 秒预算；5~8 仍按下面的顺序串行兜底。预取（`scene='prefetch'`）全程串行，
 * 避免整季批量 × 4 并发打进场源风控区。
 *
 * 1. `bilibili` —— B 站直连（见 `./bilibili`），无凭据主力源；XML 触到弹幕池上限时按 360s 分片补量
 *    （补量只在实时播放路径做，预取路径不扇出，见 `DanmakuQuery.scene`）；
 * 2. `tencent` —— 腾讯视频直连（见 `./tencent`），国产剧/独播剧兜底；
 * 3. `mgtv` —— 芒果TV 直连（见 `./mgtv`），芒果独播剧/综艺；
 * 4. `iqiyi` —— 爱奇艺直连（见 `./iqiyi`），爱系独播（Brotli + protobuf 分片）；
 * 5. `youku` —— 优酷直连（见 `./youku`），优系独播（mtop 匿名 token 签名）；
 * 6. `leshi` —— 乐视直连（见 `./leshi`），长尾版权兜底；
 * 7. `danmu-api` —— 用户自建的 danmu_api（LogVar 弹幕 API）聚合服务，需要填写基址（用户在
 *    设置里配置前**不启用**）。它按弹弹play接口规范在服务端扇出到二十来个源，用来补我们直连不到的
 *    长尾平台；但**覆盖面是部署者 env 的函数**：上游 `SOURCE_ORDER` 默认只有
 *    `douban,360,renren,hanjutv`，咪咕/巴哈/B 站要显式加进去（巴哈还需配 `PROXY_URL`，B 站完整
 *    弹幕需 `BILIBILI_COOKIE`）；基址由用户提供，不内置任何公共实例；
 * 8. `dandanplay` —— 弹弹play开放弹幕网络（www.dandanplay.com），需要 appId/secret（用户在
 *    设置里配置前**不启用**，避免无凭据请求打官方接口）。用官方推荐的「凭证模式」
 *    （`X-AppId` + `X-AppSecret`），命中结果带 `shift` 时间轴偏移；
 * 9. `local-xml` —— 用户本地 B 站格式 xml（播放页「弹幕设置 → 导入本地弹幕 XML」），纯解析不发请求。
 *
 * 匹配口径与豆瓣借播一致（`stripTitleNoise`）：片名归一化相等 + 集号由调用方传入。
 * 隐私约束：请求只携带片名/年份/集号，绝不携带用户标识。
 */
import { DANMAKU_DANDANPLAY_BASE } from '@/shared/constants';
import { stripTitleNoise } from '@/sources/douban/playMatch';
import type { DanmakuComment, DanmakuProviderId } from '@/types';
import { modeOf, parseBilibiliXml } from './bilibiliXml';
import { requestWithHeaders } from './nativeHttp';

/** 网络弹幕源标识（本地 xml 兜底不参与回退链枚举） */
type NetworkProviderId = Exclude<DanmakuProviderId, 'local-xml'>;

/** 调用场景：实时播放 / 下载完成时的离线预取 */
export type DanmakuQueryScene = 'playback' | 'prefetch';

/** 匹配查询：片名归一化由 provider 内部完成 */
export interface DanmakuQuery {
  title: string;
  year: number | null;
  /** 1 起的集号；电影固定 1 */
  episode: number;
  /**
   * 缺省 `playback`。`prefetch` 只保证「离线有弹幕」，不做**补量扇出**：整季批量预取的
   * 分片请求量会打进场源风控区（B 站实测连发约 260 片返回 `-352`，约 2 分钟自愈）。
   * 语义只针对补量——腾讯/爱奇艺/优酷/乐视的分片就是弹幕本体，跳过等于没有弹幕，不适用。
   */
  scene?: DanmakuQueryScene;
  signal?: AbortSignal;
}

/** 本地 xml 内容供给（设置/文件读取后传入） */
export type LocalXmlSource = (() => string | null) | null;

/** dandanplay 凭据（localStorage 键；未配置 = Provider 不可用） */
const DDP_APP_ID_KEY = 'peanutmov.danmaku.dandanplay.appId';
const DDP_SECRET_KEY = 'peanutmov.danmaku.dandanplay.secret';

export function getDandanplayCredentials(): { appId: string; secret: string } | null {
  const appId = globalThis.localStorage?.getItem(DDP_APP_ID_KEY) ?? '';
  const secret = globalThis.localStorage?.getItem(DDP_SECRET_KEY) ?? '';
  return appId.length > 0 && secret.length > 0 ? { appId, secret } : null;
}

/** 设置页写入凭据（任一项留空 = 关闭该源，回到「无凭据不打官方接口」） */
export function setDandanplayCredentials(appId: string, secret: string): void {
  const store = globalThis.localStorage;
  if (!store) return;
  const id = appId.trim();
  const key = secret.trim();
  if (id.length === 0 || key.length === 0) {
    store.removeItem(DDP_APP_ID_KEY);
    store.removeItem(DDP_SECRET_KEY);
    return;
  }
  store.setItem(DDP_APP_ID_KEY, id);
  store.setItem(DDP_SECRET_KEY, key);
}

/* ---------- danmu_api（LogVar 弹幕 API）自建聚合服务基址 ---------- */

/** 聚合服务基址（localStorage 键；未配置 = Provider 不可用）。TOKEN 按上游口径写在基址路径里 */
const DANMU_API_BASE_KEY = 'peanutmov.danmaku.danmuApi.baseUrl';

/**
 * 归一化用户填写的基址：只接受带 scheme 的 http(s) 绝对地址，去掉末尾斜杠，返回可直接
 * 拼 `/api/v2/...` 的结果；不合法返回 null。
 *
 * 两个刻意的取舍：
 * - 不替用户补 `http://`——填错就该停用，静默改地址会让「连不上」变成无从排查；
 * - 拒绝 `https://user:pass@host` 形态——弹幕基址不该携带凭据，且查询串/片段一律丢弃，
 *   避免把用户误粘的 token 拼进每一次请求。
 */
export function normalizeDanmuApiBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname.length === 0 || url.username.length > 0 || url.password.length > 0) return null;
  let path = url.pathname.replace(/\/+$/, '');
  // 部分播放器（小幻）习惯把基址写成 `.../api/v2`；前缀由我们补，先摘掉免得拼成 /api/v2/api/v2
  if (path.endsWith('/api/v2')) path = path.slice(0, -'/api/v2'.length);
  return `${url.protocol}//${url.host}${path}`;
}

export function getDanmuApiBaseUrl(): string | null {
  return normalizeDanmuApiBaseUrl(globalThis.localStorage?.getItem(DANMU_API_BASE_KEY) ?? '');
}

/** 设置页写入基址；返回归一化结果（null = 停用），UI 用它回显真实状态 */
export function setDanmuApiBaseUrl(raw: string): string | null {
  const store = globalThis.localStorage;
  const normalized = normalizeDanmuApiBaseUrl(raw);
  if (!store) return null;
  if (normalized === null) {
    store.removeItem(DANMU_API_BASE_KEY);
    return null;
  }
  store.setItem(DANMU_API_BASE_KEY, normalized);
  return normalized;
}

/* ---------- 弹弹play协议响应（dandanplay 官方与 danmu_api 聚合服务共用） ---------- */

/**
 * 字段名与 `https://api.dandanplay.net/swagger/v2/swagger.json` 对齐：
 * `MatchResponseV2` = `ResponseBase` + `isMatched` + 扁平 `matches[]`（每一项已经是一个节目/弹幕库），
 * 没有 `matched` 布尔位，也没有按季分层的 `episodes[]`。
 * danmu_api 兼容同一规范（其 `/api/v2/match` 只解构 `fileName`，`matchMode` 会被忽略；
 * `matches` 恒为服务端解析出的那一条，`shift` 恒为 0），因此两个源共用这些类型与解析函数。
 */
interface DdpMatchCandidate {
  episodeId: number;
  animeId?: number;
  animeTitle?: string | null;
  episodeTitle?: string | null;
  /** 弹幕偏移秒数：正数=弹幕应延迟，负数=应提前 */
  shift?: number;
}
interface DdpMatchResponse {
  success?: boolean;
  errorCode?: number;
  errorMessage?: string | null;
  isMatched?: boolean;
  matches?: DdpMatchCandidate[] | null;
}
/**
 * `CommentData`：`p` = `出现时间,模式,颜色,用户ID`（danmu_api 的第 4 段是 `[来源]` 标签，
 * 我们不读第 4 段，两种口径共用同一解析），`m` = 弹幕文本
 */
interface DdpCommentData {
  cid?: number;
  p?: string | null;
  m?: string | null;
}
interface DdpCommentResponse {
  count?: number;
  comments?: DdpCommentData[] | null;
}
/** `SearchEpisodesResponse`：季号未知时的服务端兜底（只回 episodeId/episodeTitle） */
interface DdpSearchEpisodesResponse {
  success?: boolean;
  animes?: Array<{ animeId?: number; animeTitle?: string | null; episodes?: Array<{ episodeId: number; episodeTitle?: string | null }> | null }> | null;
}

function toComments(response: DdpCommentResponse | null): DanmakuComment[] {
  const out: DanmakuComment[] = [];
  for (const row of response?.comments ?? []) {
    const text = (row?.m ?? '').trim();
    if (text.length === 0) continue;
    const [rawTime, rawMode, rawColor] = (row.p ?? '').split(',');
    const time = Number(rawTime);
    if (!Number.isFinite(time) || time < 0) continue;
    // 模式口径与 B 站一致（1 滚动 / 4 底部 / 5 顶部），颜色是 `R*256*256+G*256+B`
    out.push({ time, mode: modeOf(Number(rawMode) || 1), color: Number(rawColor) || 0xffffff, text });
  }
  return out;
}

/** 标题里出现「第 N 话/集/期」或纯数字标题，说明这条候选自带集号信息 */
const EPISODE_MARK_RE = /第\s*\d+\s*[话集期]|^\s*\d+\s*$/;

/**
 * 从候选里挑本集：标题带目标集号的优先；一条都没有时只接受「标题不带集号」的候选
 * （电影/SP 常见），绝不退回到 `matches[0]`——那会把别的集号当成这一集，串时间轴比没弹幕更糟。
 */
function pickCandidate(matches: DdpMatchCandidate[], episode: number): DdpMatchCandidate | null {
  const wanted = new RegExp(`第\\s*0*${episode}\\s*[话集期]`);
  return (
    matches.find((item) => {
      const title = item?.episodeTitle ?? '';
      return wanted.test(title) || title.trim() === String(episode);
    }) ??
    matches.find((item) => !EPISODE_MARK_RE.test(item?.episodeTitle ?? '')) ??
    null
  );
}

/* ---------- Provider 实现 ---------- */

export interface DanmakuProvider {
  readonly id: NetworkProviderId;
  /** 该 Provider 当前是否可用（凭据缺失等） */
  available(): boolean;
  /** 匹配成功返回弹幕、远端回传的题名（供阈值校验）与该源的时间轴偏移；无匹配返回 null */
  match(query: DanmakuQuery): Promise<DanmakuProviderMatch | null>;
}

/** Provider 命中结果 */
export interface DanmakuProviderMatch {
  comments: DanmakuComment[];
  matchedTitle: string | null;
  /** 弹幕时间轴偏移（秒），缺省 0 */
  offsetSec?: number;
}

/** 文件名形态的查询串：弹弹play 的文件识别按文件名做模糊匹配 */
function ddpFileName(query: DanmakuQuery): string {
  const year = query.year !== null ? `.${query.year}` : '';
  return `${query.title}${year}.S01E${String(query.episode).padStart(2, '0')}`;
}

/**
 * `/match` 认不出这一集时的服务端兜底：弹幕库把「同一动画的每个季度」登记成独立作品，
 * 而我们只有片名 + 集号，硬编码的 S01 可能整体落空；`search/episodes` 由服务端跨季找第 N 集。
 */
async function searchEpisodeCandidate(
  baseUrl: string,
  query: DanmakuQuery,
  auth: Record<string, string>,
  timeoutMs: number,
): Promise<DdpMatchCandidate | null> {
  const url =
    `${baseUrl}/api/v2/search/episodes` +
    `?anime=${encodeURIComponent(query.title)}&episode=${query.episode}`;
  const response = await requestWithHeaders<DdpSearchEpisodesResponse>(url, {
    headers: auth,
    responseType: 'json',
    timeoutMs,
    retries: 0,
    signal: query.signal,
  });
  if (response?.success === false) return null;
  for (const anime of response?.animes ?? []) {
    const hit = pickCandidate(anime.episodes ?? [], query.episode);
    if (hit !== null) {
      return { episodeId: hit.episodeId, animeTitle: anime.animeTitle ?? null, episodeTitle: hit.episodeTitle ?? null };
    }
  }
  return null;
}

async function matchViaDandanplay(
  query: DanmakuQuery,
  credentials: { appId: string; secret: string },
): Promise<DanmakuProviderMatch | null> {
  const auth = { 'X-AppId': credentials.appId, 'X-AppSecret': credentials.secret };
  const matchResponse = await requestWithHeaders<DdpMatchResponse>(`${DANMAKU_DANDANPLAY_BASE}/api/v2/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ fileName: ddpFileName(query), matchMode: 'fileNameOnly' }),
    responseType: 'json',
    timeoutMs: 6000,
    retries: 0,
    signal: query.signal,
  });
  // 额度用尽 / 参数校验失败是 200 + success:false，重试没有意义，直接让链路往下走
  if (matchResponse?.success === false) return null;
  const candidate =
    pickCandidate(matchResponse?.matches ?? [], query.episode) ??
    (await searchEpisodeCandidate(DANMAKU_DANDANPLAY_BASE, query, auth, 6000));
  if (candidate === null) return null;

  // 该接口以 302 跳到弹幕加速服务；原生通路（CapacitorHttp/OkHttp）才会跟随跨域跳转
  const commentResponse = await requestWithHeaders<DdpCommentResponse>(
    `${DANMAKU_DANDANPLAY_BASE}/api/v2/comment/${candidate.episodeId}?withRelated=true`,
    { headers: auth, responseType: 'json', timeoutMs: 8000, retries: 0, signal: query.signal },
  );
  const comments = toComments(commentResponse);
  if (comments.length === 0) return null;
  const shift = Number(candidate.shift);
  return {
    comments,
    matchedTitle: candidate.animeTitle ?? null,
    offsetSec: Number.isFinite(shift) ? shift : 0,
  };
}

export const dandanplayProvider: DanmakuProvider = {
  id: 'dandanplay',
  available: () => getDandanplayCredentials() !== null,
  async match(query) {
    const credentials = getDandanplayCredentials();
    if (!credentials) return null;
    return matchViaDandanplay(query, credentials);
  },
};

/* ---------- danmu_api 聚合服务 ---------- */

/**
 * 上游要在多个源站里扇出（TMDB 链路官方口径 5-10s），比直连单源慢一个量级；
 * 12s 是能等回弹幕、又不至于把播放页的弹幕面板挂太久的折中。
 */
const DANMU_API_TIMEOUT_MS = 12_000;

async function matchViaDanmuApi(query: DanmakuQuery, baseUrl: string): Promise<DanmakuProviderMatch | null> {
  const matchResponse = await requestWithHeaders<DdpMatchResponse>(`${baseUrl}/api/v2/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 只发 fileName：上游解构 `{ fileName }`，matchMode 会被忽略；集号解析交给服务端
    body: JSON.stringify({ fileName: ddpFileName(query) }),
    responseType: 'json',
    timeoutMs: DANMU_API_TIMEOUT_MS,
    retries: 0,
    signal: query.signal,
  });
  // 参数/鉴权/限流失败既可能是 4xx（nativeHttp 抛错），也可能是 200 + success:false；后者重试同样没有意义
  if (matchResponse?.success === false) return null;
  const candidate =
    pickCandidate(matchResponse?.matches ?? [], query.episode) ??
    (await searchEpisodeCandidate(baseUrl, query, {}, DANMU_API_TIMEOUT_MS));
  if (candidate === null) return null;

  // 必须显式要 format=json：`DANMU_OUTPUT_FORMAT` 允许部署者把默认改成 xml，届时 JSON 解析拿不到弹幕
  const commentResponse = await requestWithHeaders<DdpCommentResponse>(
    `${baseUrl}/api/v2/comment/${candidate.episodeId}?format=json`,
    { responseType: 'json', timeoutMs: DANMU_API_TIMEOUT_MS, retries: 0, signal: query.signal },
  );
  const comments = toComments(commentResponse);
  if (comments.length === 0) return null;
  const shift = Number(candidate.shift);
  return {
    comments,
    matchedTitle: candidate.animeTitle ?? null,
    // 上游当前恒回 0（集号解析在服务端完成），仍按字段读取，便于其启用偏移规则后自动生效
    offsetSec: Number.isFinite(shift) ? shift : 0,
  };
}

export const danmuApiProvider: DanmakuProvider = {
  id: 'danmu-api',
  available: () => getDanmuApiBaseUrl() !== null,
  async match(query) {
    const baseUrl = getDanmuApiBaseUrl();
    if (baseUrl === null) return null;
    return matchViaDanmuApi(query, baseUrl);
  },
};

/* ---------- 本地 B 站 xml 兜底 ---------- */

export const localXmlProvider = {
  id: 'local-xml' as const,
  /** 解析本地 xml 内容；空内容返回 null */
  parse(xml: string): DanmakuComment[] | null {
    const comments = parseBilibiliXml(xml);
    return comments.length > 0 ? comments : null;
  },
};

/** 片名是否值得发起匹配（归一化后非空才打网，避免空串请求） */
export function isMatchableTitle(title: string): boolean {
  return stripTitleNoise(title).length > 0 || title.trim().length > 0;
}
