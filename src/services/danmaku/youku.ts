/**
 * 优酷直连弹幕源（无凭证）
 *
 * 链路：搜索取 showId → 分集取本集 vid 与时长 → mtop 匿名 token → `mopen.youku.danmu.list` 按 60s 分片。
 *
 * 分集有两条路，按可靠性排序：
 * 1. `openapi/v2/shows/videos.json`——带时长，集数完整，但只对 `copyright_status=authorized` 的剧返回；
 * 2. 移动端播放页 SSR（`m.youku.com/video/id_{vid}.html` 的 `window.__INITIAL_DATA__`）里的
 *    「播放页选集」组件——覆盖 openapi 取不到的剧，但只有 ≤50 集，且入口 vid 可能是别的剧，
 *    因此必须校验选集页的 `videoMap.showId` 与目标 showId 一致，否则视为无匹配（防串片）。
 *
 * mtop 签名：token 由 `mtop.com.youku.aplatform.weakget` 下发在 Set-Cookie，
 * 外层 `sign = md5(`${tk 前 32 位}&${t}&${appKey}&${data}`)`，
 * 内层 `msg.sign = md5(`${base64(msg)}${内层盐}`)`。Web 端读不到 Set-Cookie，本源仅原生可用。
 */
import { md5 } from './md5';
import { requestResponse, requestWithHeaders } from './nativeHttp';
import { episodeNumberOf, fetchInBatches, parseDurationSec } from './segments';
import { pickCandidate, titleMatchScore } from './titlePick';
import type { DanmakuComment } from '@/types';
import type { DanmakuProvider, DanmakuQuery } from './provider';

const APP_KEY = '24679788';
const SEARCH_URL = 'https://search.youku.com/api/search';
const EPISODES_URL = 'https://openapi.youku.com/v2/shows/videos.json';
const VIDEO_URL = 'https://openapi.youku.com/v2/videos/show.json';
const PLAY_PAGE_URL = 'https://m.youku.com/video/id_';
const TOKEN_URL = `https://acs.youku.com/h5/mtop.com.youku.aplatform.weakget/1.0/?jsv=2.5.1&appKey=${APP_KEY}`;
const DANMU_URL = 'https://acs.youku.com/h5/mopen.youku.danmu.list/1.0/';

/** mtop 公共参数：appKey 与两层签名盐都是优酷前端常量 */
const MSG_SALT = 'MkmC9SoIw6xCkSKHhJ7b5D2r51kBiREr';
/** openapi 的 client_id 是公开的接入方标识，不含任何用户信息 */
const OPEN_CLIENT_ID = '53e6cc67237fc59a';

const SEGMENT_STEP_SEC = 60;
const EPISODE_PAGE_SIZE = 100;
const MAX_EPISODE_PAGES = 4;
/** 低于此时长的分集按预告/花絮处理 */
const MIN_FEATURE_LENGTH_SEC = 300;

const YOUKU_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://v.youku.com/',
};

/**
 * 分片请求要带一个客户端标识 guid，接口无它不退数据。这里用每次进程启动新生成的随机值，
 * 不落库、不复用、不含设备信息，因此不会成为可追踪的用户标识。
 */
const CLIENT_GUID = md5(`${Date.now()}${Math.random()}`).slice(0, 24);

/* ---------- 响应类型 ---------- */

interface YoukuSearchCard {
  showId?: string;
  episodeTotal?: number;
  feature?: string;
  titleDTO?: { displayName?: string };
}

interface YoukuSearchResponse {
  pageComponentList?: Array<{ commonData?: YoukuSearchCard }>;
}

interface YoukuOpenVideo {
  id?: string;
  stage?: string | number;
  seq?: string | number;
  duration?: string | number;
  title?: string;
}

interface YoukuVideosResponse {
  total?: number;
  videos?: YoukuOpenVideo[];
}

interface YoukuVideoInfo {
  duration?: string | number;
  title?: string;
}

/** 选集条目：`action.value` 即该集 vid */
interface SsrEpisode {
  vid: string;
  stage: number | null;
}

interface DanmuListResponse {
  ret?: string[];
  data?: { result?: string };
}

/* ---------- 搜索 ---------- */

function yearOf(feature: string | undefined): number | null {
  const match = /(19|20)\d{2}/.exec(feature ?? '');
  return match ? Number(match[0]) : null;
}

/** 片名精度优先于年份（年份只在同分候选内优选）；没有 showId 的卡片不可用，先排除 */
function pickShow(cards: YoukuSearchCard[], query: DanmakuQuery): YoukuSearchCard | null {
  const candidates = cards
    .filter((card) => card.showId !== undefined && card.showId.length > 0)
    .map((card) => ({
      card,
      score: titleMatchScore(card.titleDTO?.displayName ?? '', query.title),
      year: yearOf(card.feature),
    }));
  return pickCandidate(candidates, query.year)?.card ?? null;
}

async function searchShow(query: DanmakuQuery): Promise<YoukuSearchCard | null> {
  const params = new URLSearchParams({
    keyword: query.searchTitle ?? query.title,
    site: '1',
    categories: '0',
    ftype: '0',
    ob: '0',
    pg: '1',
  });
  const response = await requestWithHeaders<YoukuSearchResponse>(
    `${SEARCH_URL}?${params.toString()}`,
    {
      headers: { ...YOUKU_HEADERS, Referer: 'https://www.youku.com/' },
      responseType: 'json',
      timeoutMs: 8000,
      retries: 0,
      signal: query.signal,
    },
  );
  const cards = (response.pageComponentList ?? []).map((component) => component.commonData);
  return pickShow(cards.filter((card): card is YoukuSearchCard => card !== undefined), query);
}

/* ---------- 分集 ---------- */

/** openapi 分集列表：只在授权剧返回；翻页直到命中目标集号 */
async function fetchOpenEpisodes(
  showId: string,
  episode: number,
  signal?: AbortSignal,
): Promise<YoukuOpenVideo | null> {
  const seen: YoukuOpenVideo[] = [];
  for (let page = 1; page <= MAX_EPISODE_PAGES; page += 1) {
    const params = new URLSearchParams({
      client_id: OPEN_CLIENT_ID,
      package: 'com.huawei.hwvplayer.youku',
      ext: 'show',
      show_id: showId,
      page: String(page),
      count: String(EPISODE_PAGE_SIZE),
    });
    const response = await requestWithHeaders<YoukuVideosResponse>(`${EPISODES_URL}?${params.toString()}`, {
      headers: YOUKU_HEADERS,
      responseType: 'json',
      timeoutMs: 8000,
      retries: 0,
      signal,
    });
    const list = response.videos ?? [];
    if (list.length === 0) return null;
    seen.push(...list);
    const target = seen.filter((item) => episodeNumberOf(item.stage ?? item.seq) === episode);
    if (target.length > 0) return longest(target);
    const total = Number(response.total ?? 0);
    if (total > 0 && seen.length >= total) return null;
  }
  return null;
}

function longest(items: YoukuOpenVideo[]): YoukuOpenVideo | null {
  let chosen: YoukuOpenVideo | null = null;
  let bestSec = -1;
  for (const item of items) {
    const sec = parseDurationSec(item.duration) ?? 0;
    if (sec > bestSec) {
      bestSec = sec;
      chosen = item;
    }
  }
  return bestSec >= MIN_FEATURE_LENGTH_SEC ? chosen : null;
}

/**
 * 取 `window.__INITIAL_DATA__` 的字面量：该对象在脚本里以 `= {...};` 结尾，
 * 但值里含字符串与嵌套括号，只能按大括号配对切——不能按分号或行尾截。
 */
function extractInitialData(html: string): string | null {
  let best: string | null = null;
  for (let at = html.indexOf('window.__INITIAL_DATA__'); at >= 0; at = html.indexOf('window.__INITIAL_DATA__', at + 1)) {
    const open = html.indexOf('{', at);
    if (open < 0) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = open; i < html.length; i += 1) {
      const char = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const slice = html.slice(open, i + 1);
          if (best === null || slice.length > best.length) best = slice;
          break;
        }
      }
    }
  }
  return best;
}

/** SSR 里的组件树深度不稳定（moduleList / componentList / dataNode 多层嵌套），按名字递归收集 */
function collectAnthology(node: unknown, out: unknown[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectAnthology(item, out, depth + 1);
    return;
  }
  const record = node as { componentId?: string; dataNode?: unknown };
  if (record.componentId === 'h5-detail-anthology') out.push(node);
  for (const value of Object.values(record)) collectAnthology(value, out, depth + 1);
}

async function fetchPlayPage(id: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  const html = await requestWithHeaders<string>(`${PLAY_PAGE_URL}${encodeURIComponent(id)}.html`, {
    headers: { ...YOUKU_HEADERS, Accept: 'text/html' },
    responseType: 'text',
    timeoutMs: 10_000,
    retries: 0,
    signal,
  });
  const blob = extractInitialData(html);
  if (blob === null) return null;
  try {
    return JSON.parse(blob) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function videoMapOf(data: Record<string, unknown>): Record<string, unknown> {
  return (data.videoMap ?? {}) as Record<string, unknown>;
}

function anthologyOf(data: Record<string, unknown>): SsrEpisode[] {
  const comps: Record<string, unknown>[] = [];
  collectAnthology(data, comps);
  const nodes = (comps[0]?.dataNode ?? []) as Array<{ data?: Record<string, unknown> }>;
  const out: SsrEpisode[] = [];
  for (const node of nodes) {
    const action = node.data?.action as { type?: string; value?: string } | undefined;
    if (action?.type !== 'JUMP_TO_VIDEO' || typeof action.value !== 'string') continue;
    out.push({ vid: action.value, stage: episodeNumberOf(node.data?.stage as string | number | undefined) });
  }
  return out;
}

/**
 * SSR 回退：showId 页给出的 `videoMap.videoId` 可能是同目录里别的剧（优酷列表页对未授权剧已失效），
 * 因此取到选集后必须再校验该页 showId 与目标一致。
 */
async function fetchSsrEpisode(showId: string, episode: number, signal?: AbortSignal): Promise<SsrEpisode | null> {
  const entry = await fetchPlayPage(showId, signal);
  const bootVid = typeof videoMapOf(entry ?? {}).videoId === 'string' ? String(videoMapOf(entry ?? {}).videoId) : null;
  if (entry === null || bootVid === null) return null;

  const page = await fetchPlayPage(bootVid, signal);
  if (page === null || String(videoMapOf(page).showId ?? '') !== showId) return null;
  const episodes = anthologyOf(page);
  const byStage = episodes.filter((item) => item.stage === episode);
  return byStage.length > 0 ? (byStage[0] ?? null) : (episodes[episode - 1] ?? null);
}

/* ---------- mtop 签名与分片 ---------- */

interface MtopToken {
  tk: string;
  enc: string;
}

/** 一次取 token、整集分片复用；令牌过期时由分片请求就地换新 */
interface TokenRef {
  current: MtopToken;
}

/** 从 Set-Cookie 取 `_m_h5_tk`：原生通路只回一条拼接串，按分隔符取首个值 */
function cookieValue(setCookie: string | undefined, name: string): string | null {
  const match = new RegExp(`${name}=([^;,]+)`).exec(setCookie ?? '');
  return match ? (match[1] ?? '').trim() || null : null;
}

async function fetchToken(signal?: AbortSignal): Promise<MtopToken | null> {
  const response = await requestResponse<string>(TOKEN_URL, {
    headers: { ...YOUKU_HEADERS, Accept: 'text/html' },
    responseType: 'text',
    timeoutMs: 8000,
    retries: 0,
    signal,
  });
  const tk = cookieValue(response.headers['set-cookie'], '_m_h5_tk');
  const enc = cookieValue(response.headers['set-cookie'], '_m_h5_tk_enc');
  return tk === null || enc === null ? null : { tk, enc };
}

/** token 过期/缺失时 mtop 回 FAIL_SYS_TOKEN_*，此时换 token 重试该片 */
function isTokenError(ret: string[] | undefined): boolean {
  return (ret ?? []).some((item) => item.startsWith('FAIL_SYS_TOKEN') || item.startsWith('FAIL_SYS_ILLEGAL'));
}

function buildDanmuUrl(token: MtopToken, vid: string, mat: number): { url: string; body: string } {
  const msg: Record<string, string | number> = {
    ctime: Date.now(),
    ctype: 10004,
    cver: 'v1.0',
    guid: CLIENT_GUID,
    mat,
    mcount: 1,
    pid: 0,
    sver: '3.1.0',
    type: 1,
    vid,
  };
  // 内层负载先 base64 再签一遍：msg 字段全为 ASCII，btoa 可直接编码
  const encoded = btoa(JSON.stringify(msg));
  msg.msg = encoded;
  msg.sign = md5(`${encoded}${MSG_SALT}`);
  const data = JSON.stringify(msg);
  const t = String(Date.now());
  const sign = md5([token.tk.slice(0, 32), t, APP_KEY, data].join('&'));
  const params = new URLSearchParams({
    jsv: '2.5.6',
    appKey: APP_KEY,
    t,
    sign,
    api: 'mopen.youku.danmu.list',
    v: '1.0',
    type: 'originaljson',
    dataType: 'jsonp',
    timeout: '20000',
    jsonpIncPrefix: 'utility',
  });
  return { url: `${DANMU_URL}?${params.toString()}`, body: `data=${encodeURIComponent(data)}` };
}

interface DanmuItem {
  content?: string;
  playat?: number;
  propertis?: string;
}

/** `propertis` 是嵌在条目里的 JSON 文本，位置 1 顶部、2 底部，其余按滚动渲染 */
function toComment(item: DanmuItem): DanmakuComment | null {
  const text = (item.content ?? '').trim();
  if (text.length === 0) return null;
  const time = Number(item.playat) / 1000;
  if (!Number.isFinite(time) || time < 0) return null;
  let color = 0xffffff;
  let mode: DanmakuComment['mode'] = 'scroll';
  try {
    const props = JSON.parse(item.propertis ?? '{}') as { color?: number | string; pos?: number };
    const raw = Number(props.color);
    if (Number.isFinite(raw) && raw > 0) color = raw;
    if (props.pos === 1) mode = 'top';
    else if (props.pos === 2) mode = 'bottom';
  } catch {
    // 属性解析失败只丢样式，不丢这条弹幕
  }
  return { time, mode, color, text };
}

async function fetchSegment(
  tokenRef: TokenRef,
  vid: string,
  mat: number,
  signal?: AbortSignal,
): Promise<DanmakuComment[]> {
  const request = async (): Promise<DanmuListResponse> => {
    const token = tokenRef.current;
    const { url, body } = buildDanmuUrl(token, vid, mat);
    return requestWithHeaders<DanmuListResponse>(url, {
      method: 'POST',
      headers: { ...YOUKU_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `_m_h5_tk=${token.tk};_m_h5_tk_enc=${token.enc};` },
      body,
      responseType: 'json',
      timeoutMs: 8000,
      retries: 0,
      signal,
    });
  };

  let response = await request();
  if (isTokenError(response.ret)) {
    const refreshed = await fetchToken(signal);
    if (refreshed === null) return [];
    tokenRef.current = refreshed;
    response = await request();
  }
  if (isTokenError(response.ret)) return [];

  let inner: { code?: string | number; data?: { result?: DanmuItem[] } };
  try {
    inner = JSON.parse(response.data?.result ?? '{}') as typeof inner;
  } catch {
    return [];
  }
  if (String(inner.code) === '-1') return [];
  const out: DanmakuComment[] = [];
  for (const item of inner.data?.result ?? []) {
    const comment = toComment(item);
    if (comment !== null) out.push(comment);
  }
  return out;
}

/* ---------- Provider ---------- */

/**
 * 本集 vid 与时长：openapi 优先（自带时长且集数完整），取不到再走 SSR 选集并补一次视频信息。
 */
async function resolveEpisode(
  showId: string,
  episode: number,
  signal?: AbortSignal,
): Promise<{ vid: string; durationSec: number } | null> {
  const open = await fetchOpenEpisodes(showId, episode, signal);
  if (typeof open?.id === 'string') {
    const durationSec = parseDurationSec(open.duration);
    return durationSec === null ? null : { vid: open.id, durationSec };
  }

  const ssr = await fetchSsrEpisode(showId, episode, signal);
  if (ssr === null) return null;
  const info = await requestWithHeaders<YoukuVideoInfo>(
    `${VIDEO_URL}?client_id=${OPEN_CLIENT_ID}&video_id=${encodeURIComponent(ssr.vid)}&ext=show`,
    { headers: YOUKU_HEADERS, responseType: 'json', timeoutMs: 8000, retries: 0, signal },
  );
  const durationSec = parseDurationSec(info.duration);
  return durationSec === null ? null : { vid: ssr.vid, durationSec };
}

export const youkuProvider: DanmakuProvider = {
  id: 'youku',
  available: () => true,
  async match(query) {
    if (query.episode < 1) return null;
    const show = await searchShow(query);
    if (show === null || show.showId === undefined) return null;

    const episode = await resolveEpisode(show.showId, query.episode, query.signal);
    if (episode === null || episode.durationSec < MIN_FEATURE_LENGTH_SEC) return null;

    const initial = await fetchToken(query.signal);
    if (initial === null) return null;
    const tokenRef: TokenRef = { current: initial };

    const mats: number[] = [];
    for (let mat = 0; mat * SEGMENT_STEP_SEC < episode.durationSec; mat += 1) mats.push(mat);

    const comments = await fetchInBatches(mats, (mat) =>
      fetchSegment(tokenRef, episode.vid, mat, query.signal),
    );
    if (comments.length === 0) return null;
    return { comments, matchedTitle: show.titleDTO?.displayName ?? null };
  },
};
