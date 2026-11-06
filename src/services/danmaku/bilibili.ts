/**
 * B 站直连弹幕源（无凭证）
 *
 * 链路：wbi 签名搜索番剧/影视 → 取季分集 → 按集号取 cid → 拉弹幕 XML。
 * 只用公开接口，不带用户标识；CapacitorHttp 原生请求，无 CORS 限制。
 * 覆盖范围限于 B 站有版权的番剧/国创/影视，匹配不到即返回 null（宁缺毋滥）。
 */
import { stripTitleNoise } from '@/sources/douban/playMatch';
import { parseBilibiliXml } from './bilibiliXml';
import { requestWithHeaders } from './nativeHttp';
import { md5 } from './md5';
import type { DanmakuProvider, DanmakuQuery } from './provider';

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';
const SEARCH_URL = 'https://api.bilibili.com/x/web-interface/wbi/search/type';
const SEASON_URL = 'https://api.bilibili.com/pgc/view/web/season';
const DANMAKU_URL = 'https://api.bilibili.com/x/v1/dm/list.so';

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

/** 集号优先按 `title`（正片序号）匹配，退回顺序位 */
function pickEpisodeCid(episodes: BiliEpisode[], episode: number): number | null {
  const byTitle = episodes.find((item) => Number(item.title) === episode);
  const chosen = byTitle ?? episodes[episode - 1];
  return chosen?.cid ?? null;
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
    const cid = pickEpisodeCid(season?.episodes ?? [], query.episode);
    if (cid === null) return null;

    const xml = await requestWithHeaders<string>(`${DANMAKU_URL}?oid=${cid}`, {
      headers: BILI_HEADERS,
      responseType: 'text',
      timeoutMs: 8000,
      retries: 0,
      signal: query.signal,
    });
    const comments = parseBilibiliXml(xml);
    if (comments.length === 0) return null;
    return { comments, matchedTitle: season?.title ?? null };
  },
};
