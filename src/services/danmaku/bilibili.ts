/**
 * B 站直连弹幕源（无凭证）
 *
 * 链路：wbi 签名搜索番剧/影视 → 取季分集 → 按集号取 cid → 拉弹幕 XML；
 * XML 已触到 B 站弹幕池上限时，再按 360s 分片扇出补量（见 `fetchSegmentExtras`；预取路径不扇出）。
 * 只用公开接口，不带用户标识；CapacitorHttp 原生请求，无 CORS 限制。
 * 覆盖范围限于 B 站有版权的番剧/国创/影视，匹配不到即返回 null（宁缺毋滥）。
 */
import { stripTitleNoise } from '@/sources/douban/playMatch';
import { parseBilibiliXml } from './bilibiliXml';
import { parseSegmentReply } from './bilibiliProto';
import { requestBytes, requestWithHeaders } from './nativeHttp';
import { fetchInBatches, parseDurationSec } from './segments';
import { md5 } from './md5';
import type { DanmakuComment } from '@/types';
import type { DanmakuProvider, DanmakuQuery } from './provider';

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const SEASON_URL = 'https://api.bilibili.com/pgc/view/web/season';
const DANMAKU_URL = 'https://api.bilibili.com/x/v1/dm/list.so';
/** 分片接口：只有 `web/seg.so` 可用（`x/v2/dm/seg.so`、`x/v2/danmaku/webgl` 实测 404） */
const SEGMENT_URL = 'https://api.bilibili.com/x/v2/dm/web/seg.so';

/**
 * 实测契约（2026-11-16，无登录直连）：
 * - 一块 360s，时间轴是**绝对时间**（protobuf field 2 = 毫秒），不是片内相对时间；
 * - 没有任何接口能查分片总数，只能由时长算，或探到 `Bili-Status-Code: -304`（越界即空 body）；
 * - XML 是「每 cid 弹幕池」的**截断采样**：热片会触顶（实测 3600、9600 两档整数顶），
 *   分片是同一池的**另一批采样**，两者几乎不相交（咒术回战 S2E1：XML 3600 / 分片 5473，
 *   净新增 5183，并集 2.41x）；而冷门片 XML 未触顶时分片是 XML 的子集（弹速狂飙 E1：
 *   净新增 0）。所以只在 XML 条数接近触顶时才扇出，否则纯浪费请求；
 * - 扇出过快会被风控：连发约 260 片后分片接口改回 HTTP 200 + `-352` + 39B 空 body，
 *   约 2 分钟自愈，期间 XML 通路不受影响。上限取 10 片（实测第 10 片之后收益已趋平）。
 */
const SEGMENT_STEP_SEC = 360;
const SEGMENT_MAX_COUNT = 10;
/** 低于此条数说明 XML 没触顶，分片不会带来新弹幕 */
const SEGMENT_FANOUT_MIN_XML = 3000;

/** B 站接口对 UA + Referer 有风控校验，缺 Referer 直接 403 */
const BILI_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Referer: 'https://www.bilibili.com',
};

/** wbi 混排表（B 站前端固定常量） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
] as const;

const MIXIN_TTL_MS = 30 * 60 * 1000;

let mixinCache: { key: string; expiresAt: number } | null = null;

/** 单测用：清掉签名密钥缓存 */
export function clearBilibiliCache(): void {
  mixinCache = null;
}

interface BiliNavResponse {
  code: number;
  data?: { wbi_img?: { img_url?: string; sub_url?: string } };
}

/** 取 wbi 混排密钥；未登录时 nav 返回 -101 但 wbi_img 仍然下发 */
async function getMixinKey(signal?: AbortSignal): Promise<string> {
  if (mixinCache !== null && mixinCache.expiresAt > Date.now()) return mixinCache.key;
  const nav = await requestWithHeaders<BiliNavResponse>(NAV_URL, {
    headers: BILI_HEADERS,
    responseType: 'json',
    timeoutMs: 5000,
    retries: 0,
    signal,
  });
  const img = nav.data?.wbi_img?.img_url ?? '';
  const sub = nav.data?.wbi_img?.sub_url ?? '';
  const raw = `${img.split('/').pop()?.split('.')[0] ?? ''}${sub.split('/').pop()?.split('.')[0] ?? ''}`;
  if (raw.length < 64) throw new Error('wbi 密钥缺失');
  const key = MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? '').join('').slice(0, 32);
  mixinCache = { key, expiresAt: Date.now() + MIXIN_TTL_MS };
  return key;
}

/** wbi 签名：参数按 key 排序，值剔除 !'()* 后拼接，再与混排密钥做 md5 */
function signWbi(params: Record<string, string | number>, mixinKey: string): string {
  const all: Record<string, string | number> = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = encodeURIComponent(String(all[key]).replace(/[!'()*]/g, ''));
      return `${encodeURIComponent(key)}=${value}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(`${query}${mixinKey}`)}`;
}

interface BiliSearchItem {
  title?: string;
  season_id?: number;
}

interface BiliSearchResponse {
  code: number;
  data?: { result?: BiliSearchItem[] };
}

interface BiliEpisode {
  cid?: number;
  title?: string;
  long_title?: string;
  /** PGC 侧单位是毫秒（实测 1509000 = 25 分钟），交给 `parseDurationSec` 归一 */
  duration?: number;
}

interface BiliSeasonResponse {
  code: number;
  result?: { title?: string; episodes?: BiliEpisode[] };
}

/** 搜索结果的标题带 `<em class="keyword">` 高亮标签 */
function plainTitle(title: string | undefined): string {
  return (title ?? '').replace(/<[^>]*>/g, '').trim();
}

async function searchSeasons(type: 'media_bangumi' | 'media_ft', keyword: string, signal?: AbortSignal): Promise<BiliSearchItem[]> {
  const mixinKey = await getMixinKey(signal);
  const query = signWbi({ search_type: type, keyword, page: 1 }, mixinKey);
  const response = await requestWithHeaders<BiliSearchResponse>(`${SEARCH_URL}?${query}`, {
    headers: BILI_HEADERS,
    responseType: 'json',
    timeoutMs: 6000,
    retries: 0,
    signal,
  });
  if (response.code !== 0) return [];
  return response.data?.result ?? [];
}

/** 归一化片名完全相等才采用；优先番剧库，其次影视库 */
async function findSeason(query: DanmakuQuery): Promise<number | null> {
  const target = stripTitleNoise(query.title);
  if (target.length === 0) return null;
  for (const type of ['media_bangumi', 'media_ft'] as const) {
    const items = await searchSeasons(type, query.title, query.signal);
    const hit = items.find((item) => stripTitleNoise(plainTitle(item.title)) === target);
    if (hit?.season_id !== undefined) return hit.season_id;
  }
  return null;
}

/** 集号优先按 `title`（正片序号）匹配，退回顺序位；同时带出该集时长（分片数要用） */
function pickEpisode(episodes: BiliEpisode[], episode: number): { cid: number; durationSec: number | null } | null {
  const byTitle = episodes.find((item) => Number(item.title) === episode);
  const chosen = byTitle ?? episodes[episode - 1];
  if (chosen?.cid === undefined) return null;
  return { cid: chosen.cid, durationSec: parseDurationSec(chosen.duration) };
}

/**
 * XML 触顶后的分片补量：按 360s 一块扇出，与 XML 结果直接拼接。
 * 重复条目交回渲染层处理（`PlayerView` 的 `dedupe` + `DanmakuOverlay` 的按时间排序），
 * 这里不再排一次——两个接口返回的是同一池的不同采样，合并顺序无意义。
 *
 * 预取路径（`scene === 'prefetch'`）不扇出：下载完成时整季批量预取会把分片请求量推近实测
 * 触发 `-352` 的连发规模，而预取的目标只是「离线有弹幕」，XML 基线已经满足。
 */
async function fetchSegmentExtras(
  query: DanmakuQuery,
  cid: number,
  durationSec: number | null,
  xmlCount: number,
): Promise<DanmakuComment[]> {
  if (query.scene === 'prefetch') return [];
  if (durationSec === null || xmlCount < SEGMENT_FANOUT_MIN_XML) return [];
  const indexes: number[] = [];
  const count = Math.min(Math.ceil(durationSec / SEGMENT_STEP_SEC), SEGMENT_MAX_COUNT);
  for (let index = 1; index <= count; index += 1) indexes.push(index);

  return fetchInBatches(indexes, async (index) => {
    const bytes = await requestBytes(`${SEGMENT_URL}?type=1&oid=${cid}&segment_index=${index}`, {
      headers: BILI_HEADERS,
      timeoutMs: 8000,
      retries: 0,
      signal: query.signal,
    });
    return parseSegmentReply(bytes);
  });
}

async function fetchSeason(seasonId: number, signal?: AbortSignal): Promise<BiliSeasonResponse['result'] | null> {
  const response = await requestWithHeaders<BiliSeasonResponse>(`${SEASON_URL}?season_id=${seasonId}`, {
    headers: BILI_HEADERS,
    responseType: 'json',
    timeoutMs: 6000,
    retries: 0,
    signal,
  });
  return response.code === 0 ? (response.result ?? null) : null;
}

export const bilibiliProvider: DanmakuProvider = {
  id: 'bilibili',
  available: () => true,
  async match(query) {
    const seasonId = await findSeason(query);
    if (seasonId === null) return null;

    const season = await fetchSeason(seasonId, query.signal);
    const episode = pickEpisode(season?.episodes ?? [], query.episode);
    if (episode === null) return null;

    const xml = await requestWithHeaders<string>(`${DANMAKU_URL}?oid=${episode.cid}`, {
      headers: BILI_HEADERS,
      responseType: 'text',
      timeoutMs: 8000,
      retries: 0,
      signal: query.signal,
    });
    const comments = parseBilibiliXml(xml);
    if (comments.length === 0) return null;

    const extras = await fetchSegmentExtras(query, episode.cid, episode.durationSec, comments.length);
    return {
      comments: extras.length === 0 ? comments : [...comments, ...extras],
      matchedTitle: season?.title ?? null,
    };
  },
};
