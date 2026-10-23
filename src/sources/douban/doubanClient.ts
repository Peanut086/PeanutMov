/**
 * 豆瓣小程序 API 客户端（纯 TS 实现，不执行第三方 JS）
 *
 * 背景：TVBox 生态里大量 drpy 源（如「聚玩盒子4K」）的规则 `douban.js`
 * 只是豆瓣 API 的客户端。与其为这类源接 JS 引擎，不如直接用 TS 实现同样的请求——
 * 接口稳定、无引擎开销、可测试。
 *
 * 接口要点（实测 2026-10-23）：
 * - 域名 `frodo.douban.com`，路径前缀 `/api/v2`；
 * - 必须带微信小程序 UA + `servicewechat.com` Referer + `apikey`，
 *   否则返回 400 `invalid_request_997` 或 404；
 * - 返回体是标准 JSON，列表项字段为 `title/id/type/pic/rating/has_linewatch`。
 *
 * 能力边界：豆瓣只提供**元数据**，不托管视频。详情里的 `linewatches`/`vendors`
 * 是优酷/B站/爱奇艺的 App 深链（`youku://play?...`），需要对应 App 与会员，
 * 因此本模块只产出「片单」，播放由上层跨源借 CMS 完成。
 */
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { httpClient } from '@/sources/base/httpClient';

const API_HOST = 'https://frodo.douban.com/api/v2';
/** 豆瓣微信小程序的公开 apikey（规则文件里写死的同一个） */
const API_KEY = '0ac44ae016490db2204ce0a042db2916';
const MINIAPP_UA =
  'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.143 Safari/537.36 MicroMessenger/7.0.9.501 NetType/WIFI MiniProgramEnv/Windows WindowsWechat';
const MINIAPP_REFERER = 'https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html';

/** 每页条数（与规则里的 count 一致） */
export const DOUBAN_PAGE_SIZE = 30;

/** 分类定义：`key` 是豆瓣的 cate，`url` 决定走哪条接口分支 */
export interface DoubanCategory {
  key: string;
  name: string;
  /** `hot` = 热门榜（items）；`collection` = 合集（subject_collection_items）；`recommend` = 筛选（items） */
  kind: 'hot' | 'collection' | 'recommend';
  /** collection 类目用的合集 id */
  collectionId?: string;
}

/** 与 drpy 规则 class_url 一致的 7 个分类 */
export const DOUBAN_CATEGORIES: readonly DoubanCategory[] = [
  { key: 'hot_gaia', name: '热门电影', kind: 'hot' },
  { key: 'tv_hot', name: '热播剧集', kind: 'collection', collectionId: 'tv_hot' },
  { key: 'show_hot', name: '热播综艺', kind: 'collection', collectionId: 'show_hot' },
  { key: 'movie', name: '电影筛选', kind: 'recommend' },
  { key: 'tv', name: '电视筛选', kind: 'recommend' },
  { key: 'rank_list_movie', name: '电影榜单', kind: 'collection', collectionId: 'movie_real_time_hotest' },
  { key: 'rank_list_tv', name: '电视榜单', kind: 'collection', collectionId: 'tv_real_time_hotest' },
];

export type DoubanMediaType = 'movie' | 'tv' | 'show';

/** 归一化后的豆瓣条目 */
export interface DoubanItem {
  id: string;
  title: string;
  type: DoubanMediaType;
  posterUrl: string | null;
  rating: number | null;
  year: number | null;
  /** `2026 / 韩国 / 剧情 动作` 这类副标题，用于提取年份与地区 */
  cardSubtitle: string | null;
  /** 是否在正版平台有片（豆瓣自己的标记） */
  hasLinewatch: boolean;
  /** 获奖/榜单信息，拼进备注 */
  honor: string | null;
}

export interface DoubanPage {
  items: DoubanItem[];
  page: number;
  total: number;
  pageCount: number;
}

function headers(): Record<string, string> {
  return {
    'User-Agent': MINIAPP_UA,
    Referer: MINIAPP_REFERER,
    Accept: 'application/json',
  };
}

function withKey(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}apikey=${API_KEY}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `2026 / 韩国 / 剧情 动作` 的第二段起，取年份与地区 */
function parseSubtitle(subtitle: string | null): { year: number | null; area: string | null } {
  if (subtitle === null) return { year: null, area: null };
  const parts = subtitle.split('/').map((part) => part.trim());
  const year = /^\d{4}$/.test(parts[0] ?? '') ? Number.parseInt(parts[0]!, 10) : null;
  const area = parts[1] && parts[1].length > 0 ? parts[1] : null;
  return { year, area };
}

/** 海报：优先 `pic.normal`（列表），详情里是 `pic.large`/`cover_url` */
function posterOf(raw: Record<string, unknown>): string | null {
  const pic = raw['pic'];
  if (isRecord(pic)) {
    return str(pic['normal']) ?? str(pic['large']) ?? str(pic['small']) ?? null;
  }
  return str(pic) ?? str(raw['cover_url']) ?? str(raw['cover']);
}

function typeOf(raw: Record<string, unknown>): DoubanMediaType {
  const value = str(raw['type']);
  if (value === 'tv' || value === 'show' || value === 'movie') return value;
  return 'movie';
}

/** 豆瓣原始条目 → 统一结构；缺标题/缺 id 的条目丢弃 */
export function normalizeDoubanItem(raw: unknown): DoubanItem | null {
  if (!isRecord(raw)) return null;
  const id = str(raw['id']);
  const title = str(raw['title']);
  if (id === null || title === null) return null;
  if (title === '未知电影') return null;

  const ratingRaw = raw['rating'];
  const rating = isRecord(ratingRaw) ? num(ratingRaw['value']) : null;

  const honorInfos = Array.isArray(raw['honor_infos']) ? raw['honor_infos'] : [];
  const honor = honorInfos
    .map((entry) => (isRecord(entry) ? str(entry['title']) : null))
    .filter((value): value is string => value !== null)
    .join('|');

  return {
    id,
    title,
    type: typeOf(raw),
    posterUrl: posterOf(raw),
    rating,
    year: parseSubtitle(str(raw['card_subtitle'])).year,
    cardSubtitle: str(raw['card_subtitle']),
    hasLinewatch: raw['has_linewatch'] === true,
    honor: honor.length > 0 ? honor : null,
  };
}

/** 豆瓣条目里提取地区（跨源匹配时用于校验） */
export function areaOf(item: DoubanItem): string | null {
  return parseSubtitle(item.cardSubtitle).area;
}

async function requestJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await httpClient.request<unknown>(withKey(url), {
    headers: headers(),
    timeoutMs: 12000,
    retries: 1,
    signal,
    responseType: 'json',
  });
  if (!isRecord(response)) {
    throw new AppError('E_PARSE', '豆瓣接口返回结构异常');
  }
  return response;
}

/** 从响应里按分支取条目数组 */
function pickItems(payload: Record<string, unknown>, kind: DoubanCategory['kind']): unknown[] {
  if (kind === 'collection') {
    const collection = payload['subject_collection_items'];
    return Array.isArray(collection) ? collection : [];
  }
  const items = payload['items'];
  return Array.isArray(items) ? items : [];
}

/**
 * 拉取一个分类的一页。
 * 三个分支的接口路径与参数不同（见 DOUBAN_CATEGORIES.kind）：
 * - hot：`/movie/hot_gaia?area=&sort=&start=&count=`
 * - collection：`/subject_collection/{id}/items?start=&count=`
 * - recommend：`/{movie|tv}/recommend?sort=T&tags=&start=&count=`
 */
export async function fetchCategoryPage(
  category: DoubanCategory,
  page: number,
  signal?: AbortSignal,
): Promise<DoubanPage> {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const start = (safePage - 1) * DOUBAN_PAGE_SIZE;

  let url: string;
  if (category.kind === 'collection') {
    const id = category.collectionId ?? category.key;
    url = `${API_HOST}/subject_collection/${encodeURIComponent(id)}/items?start=${start}&count=${DOUBAN_PAGE_SIZE}`;
  } else if (category.kind === 'recommend') {
    const cate = category.key === 'tv' ? 'tv' : 'movie';
    url = `${API_HOST}/${cate}/recommend?sort=T&tags=&start=${start}&count=${DOUBAN_PAGE_SIZE}`;
  } else {
    url = `${API_HOST}/movie/${category.key}?area=${encodeURIComponent('全部')}&sort=recommend&start=${start}&count=${DOUBAN_PAGE_SIZE}`;
  }

  const payload = await requestJson(url, signal);
  const items = pickItems(payload, category.kind)
    .map(normalizeDoubanItem)
    .filter((item): item is DoubanItem => item !== null);

  const total = num(payload['total']) ?? items.length;
  const pageCount = Math.max(1, Math.ceil(total / DOUBAN_PAGE_SIZE));
  return { items, page: safePage, total, pageCount };
}

/** 豆瓣搜索：`/search?q=` 返回 contents.items，每条在 `target` 里 */
export async function searchDouban(keyword: string, signal?: AbortSignal): Promise<DoubanItem[]> {
  const query = keyword.trim();
  if (query.length === 0) return [];
  const url = `${API_HOST}/search?q=${encodeURIComponent(query)}&start=0&count=${DOUBAN_PAGE_SIZE}`;
  const payload = await requestJson(url, signal);
  const contents = payload['contents'];
  const rawItems = isRecord(contents) && Array.isArray(contents['items']) ? contents['items'] : [];
  const out: DoubanItem[] = [];
  for (const entry of rawItems) {
    if (!isRecord(entry)) continue;
    // 搜索结果是混合卡片：影视条目在 `target`，其它（影评/小组）跳过
    const target = isRecord(entry['target']) ? entry['target'] : null;
    if (target === null) continue;
    const item = normalizeDoubanItem(target);
    if (item !== null) out.push(item);
  }
  return out;
}

/** 详情：补齐简介、年份、地区、演员 */
export interface DoubanDetail {
  item: DoubanItem;
  intro: string | null;
  actors: string[];
  directors: string[];
  genres: string[];
  area: string | null;
  durationSec: number | null;
}

export async function fetchDoubanDetail(
  mediaType: DoubanMediaType,
  subjectId: string,
  signal?: AbortSignal,
): Promise<DoubanDetail> {
  const cate = mediaType === 'movie' ? 'movie' : 'tv';
  const url = `${API_HOST}/${cate}/${encodeURIComponent(subjectId)}`;
  const payload = await requestJson(url, signal);

  const base = normalizeDoubanItem({ ...payload, id: subjectId }) ?? {
    id: subjectId,
    title: str(payload['title']) ?? '未命名',
    type: mediaType,
    posterUrl: posterOf(payload),
    rating: isRecord(payload['rating']) ? num(payload['rating']['value']) : null,
    year: null,
    cardSubtitle: str(payload['card_subtitle']),
    hasLinewatch: payload['has_linewatch'] === true,
    honor: null,
  };

  const names = (key: string): string[] =>
    (Array.isArray(payload[key]) ? payload[key] : [])
      .map((entry) => (isRecord(entry) ? str(entry['name']) : null))
      .filter((value): value is string => value !== null);

  const durations = Array.isArray(payload['durations']) ? payload['durations'] : [];
  const firstDuration = str(durations[0]);
  const durationSec = firstDuration ? parseDuration(firstDuration) : null;

  return {
    item: { ...base, year: base.year ?? (num(payload['year']) ?? null) },
    intro: str(payload['intro']),
    actors: names('actors'),
    directors: names('directors'),
    genres: (Array.isArray(payload['genres']) ? payload['genres'] : []).filter(
      (value): value is string => typeof value === 'string',
    ),
    area: areaOf(base) ?? (Array.isArray(payload['countries']) ? str(payload['countries'][0]) : null),
    durationSec,
  };
}

/** `01:52:00` / `112分钟` → 秒 */
export function parseDuration(value: string): number | null {
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (clock) {
    const a = Number.parseInt(clock[1]!, 10);
    const b = Number.parseInt(clock[2]!, 10);
    const c = clock[3] ? Number.parseInt(clock[3], 10) : null;
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const minutes = /^(\d+)\s*分钟$/.exec(value.trim());
  if (minutes) return Number.parseInt(minutes[1]!, 10) * 60;
  return null;
}

/** 探活：拉一页热门，能解析出条目即视为可用 */
export async function probeDouban(signal?: AbortSignal): Promise<number> {
  try {
    const page = await fetchCategoryPage(DOUBAN_CATEGORIES[0]!, 1, signal);
    return page.items.length;
  } catch (e) {
    logger.warn('豆瓣探活失败', e);
    throw e;
  }
}
