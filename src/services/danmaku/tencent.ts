/**
 * 腾讯视频直连弹幕源（无凭证）
 *
 * 链路：MbSearch 搜正片 cid → float_vinfo2 取分集 vid → barrage/base 取 30s 分片 → 并法拉分片弹幕。
 * 国产剧大多只在腾讯/爱奇艺有版权，B 站匹配不到时由本源兜底。
 * 注意：搜索接口缺 `Origin: https://v.qq.com` 会返回 ret=20607（空结果），不是 403。
 */
import { requestWithHeaders } from './nativeHttp';
import { pickCandidate, titleMatchScore } from './titlePick';
import { seasonOfTitle } from '@/sources/douban/playMatch';
import type { DanmakuComment } from '@/types';
import type { DanmakuProvider, DanmakuQuery } from './provider';

const SEARCH_URL =
  'https://pbaccess.video.qq.com/trpc.videosearch.mobile_search.MultiTerminalSearch/MbSearch?vplatform=2';
const EPISODES_URL = 'https://node.video.qq.com/x/api/float_vinfo2';
const BARRAGE_INDEX_URL = 'https://dm.video.qq.com/barrage/base';
const BARRAGE_SEGMENT_URL = 'https://dm.video.qq.com/barrage/segment';

const TENCENT_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const SEARCH_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': TENCENT_UA,
  Accept: 'application/json, text/plain, */*',
  Origin: 'https://v.qq.com',
};

const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'User-Agent': TENCENT_UA,
};

/** 分片并发上限：一集 45min 约 90 片，一次全 fan-out 会被反爬 */
const SEGMENT_CONCURRENCY = 6;

interface TenSearchItem {
  doc?: { id?: string };
  videoInfo?: {
    title?: string;
    year?: number;
    subTitle?: string;
    playFlag?: number;
  };
}

interface TenSearchResponse {
  ret: number;
  data?: {
    normalList?: { itemList?: TenSearchItem[] };
    areaBoxList?: Array<{ boxId?: string; itemList?: TenSearchItem[] }>;
  };
}

interface TenVinfoResponse {
  c?: { title?: string; video_ids?: string[] };
}

interface TenBarrageIndexResponse {
  segment_index?: Record<string, { segment_start?: string | number; segment_name?: string }>;
}

interface TenBarrageItem {
  content?: string;
  time_offset?: string | number;
  content_style?: string;
}

interface TenBarrageSegmentResponse {
  barrage_list?: TenBarrageItem[];
}

function plainTitle(title: string | undefined): string {
  return (title ?? '').replace(/<[^>]*>/g, '').trim();
}

/** 搜索结果标题带 `<em>` 高亮标签，主区（MainNeed）优先，缺失时退回 normalList */
async function searchItems(keyword: string, signal?: AbortSignal): Promise<TenSearchItem[]> {
  const body = JSON.stringify({
    version: '25071701',
    clientType: 1,
    filterValue: '',
    uuid: '0379274D-05A0-4EB6-A89C-878C9A460426',
    query: keyword,
    retry: 0,
    pagenum: 0,
    isPrefetch: true,
    pagesize: 30,
    queryFrom: 0,
    searchDatakey: '',
    transInfo: '',
    isneedQc: true,
    preQid: '',
    adClientInfo: '',
    extraInfo: { multi_terminal_pc: '1', themeType: '1', sugRelatedIds: '{}', appVersion: '' },
  });
  const response = await requestWithHeaders<TenSearchResponse>(SEARCH_URL, {
    method: 'POST',
    headers: {
      ...SEARCH_HEADERS,
      Referer: `https://v.qq.com/x/search/?q=${encodeURIComponent(keyword)}`,
    },
    body,
    responseType: 'json',
    timeoutMs: 8000,
    retries: 0,
    signal,
  });
  if (response.ret !== 0) return [];
  const main = response.data?.areaBoxList?.find((box) => box.boxId === 'MainNeed');
  return main?.itemList ?? response.data?.normalList?.itemList ?? [];
}

interface CoverCandidate {
  cid: string;
  title: string;
  year: number | null;
  /** 2 = 归一化完全相等，1 = 去掉季/年份后相等（「庆余年第一季」↔「庆余年」） */
  score: number;
}

/**
 * 从搜索结果挑正片：季号冲突直接排除（防止「庆余年」匹配到第三季），
 * 再按「片名精确度 > 年份」选——年份只在最高分候选内做优选，
 * 不许把去噪同名的候选顶到完全同名候选前面（站点错标年份时会整集串片）。
 */
function pickCover(items: TenSearchItem[], query: DanmakuQuery): CoverCandidate | null {
  const querySeason = seasonOfTitle(query.title);

  const candidates: CoverCandidate[] = [];
  for (const item of items) {
    const cid = item.doc?.id;
    const rawTitle = item.videoInfo?.title;
    if (!cid || !rawTitle) continue;
    if (item.videoInfo?.subTitle === '全网搜' || item.videoInfo?.playFlag === 2) continue;
    const title = plainTitle(rawTitle);
    const candidateSeason = seasonOfTitle(title) ?? 1;
    if (querySeason !== null && candidateSeason !== querySeason) continue;
    const score = titleMatchScore(title, query.title);
    if (score === 0) continue;
    const year = item.videoInfo?.year;
    candidates.push({ cid, title, year: year && year > 0 ? year : null, score });
  }
  return pickCandidate(candidates, query.year);
}

/** 分集 vid 按正片顺序返回（float_vinfo2 的 video_ids 与选集一一对应） */
async function fetchEpisodeVids(
  cid: string,
  signal?: AbortSignal,
): Promise<{ title: string | null; videoIds: string[] }> {
  const response = await requestWithHeaders<TenVinfoResponse>(`${EPISODES_URL}?cid=${encodeURIComponent(cid)}`, {
    headers: { ...JSON_HEADERS, Referer: `https://v.qq.com/x/cover/${cid}.html` },
    responseType: 'json',
    timeoutMs: 6000,
    retries: 0,
    signal,
  });
  const videoIds = (response.c?.video_ids ?? []).filter((vid) => typeof vid === 'string' && vid.length > 0);
  return { title: response.c?.title ?? null, videoIds };
}

async function fetchSegmentNames(vid: string, signal?: AbortSignal): Promise<string[]> {
  const response = await requestWithHeaders<TenBarrageIndexResponse>(`${BARRAGE_INDEX_URL}/${vid}`, {
    headers: JSON_HEADERS,
    responseType: 'json',
    timeoutMs: 6000,
    retries: 0,
    signal,
  });
  return Object.values(response.segment_index ?? {})
    .filter((item) => typeof item.segment_name === 'string' && item.segment_name.length > 0)
    .sort((a, b) => Number(a.segment_start ?? 0) - Number(b.segment_start ?? 0))
    .map((item) => item.segment_name as string);
}

async function fetchOneSegment(vid: string, name: string, signal?: AbortSignal): Promise<TenBarrageItem[]> {
  const response = await requestWithHeaders<TenBarrageSegmentResponse>(`${BARRAGE_SEGMENT_URL}/${vid}/${name}`, {
    headers: JSON_HEADERS,
    responseType: 'json',
    timeoutMs: 8000,
    retries: 0,
    signal,
  });
  return Array.isArray(response.barrage_list) ? response.barrage_list : [];
}

/** 分批并法拉全部分片；单片失败不影响整集（返回已成功的部分） */
async function fetchAllSegments(
  vid: string,
  names: string[],
  signal?: AbortSignal,
): Promise<TenBarrageItem[]> {
  const all: TenBarrageItem[] = [];
  for (let start = 0; start < names.length; start += SEGMENT_CONCURRENCY) {
    const batch = names.slice(start, start + SEGMENT_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((name) => fetchOneSegment(vid, name, signal)));
    for (const result of results) {
      if (result.status === 'fulfilled') all.push(...result.value);
    }
  }
  return all;
}

/** `content_style` 是 JSON 字符串：position 2 顶部、3 底部；颜色六位 hex */
function parseStyle(raw: string | undefined): { color: number; mode: DanmakuComment['mode'] } {
  const fallback: { color: number; mode: DanmakuComment['mode'] } = { color: 0xffffff, mode: 'scroll' };
  if (!raw) return fallback;
  try {
    const style = JSON.parse(raw) as { color?: string; gradient_colors?: string[]; position?: number };
    const hex = style.gradient_colors?.[0] ?? style.color ?? '';
    const color = /^#?[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex.replace('#', ''), 16) : 0xffffff;
    const mode = style.position === 2 ? 'top' : style.position === 3 ? 'bottom' : 'scroll';
    return { color, mode };
  } catch {
    return fallback;
  }
}

/** `time_offset` 是视频起点起的毫秒数（跨分片连续，不要再加分片偏移） */
function toComments(items: TenBarrageItem[]): DanmakuComment[] {
  const out: DanmakuComment[] = [];
  for (const item of items) {
    const text = (item.content ?? '').trim();
    if (text.length === 0) continue;
    const time = Number(item.time_offset) / 1000;
    if (!Number.isFinite(time) || time < 0) continue;
    const { color, mode } = parseStyle(item.content_style);
    out.push({ time, mode, color, text });
  }
  return out;
}

export const tencentProvider: DanmakuProvider = {
  id: 'tencent',
  available: () => true,
  async match(query) {
    if (query.episode < 1) return null;
    const items = await searchItems(query.title, query.signal);
    const cover = pickCover(items, query);
    if (cover === null) return null;

    const { title, videoIds } = await fetchEpisodeVids(cover.cid, query.signal);
    const vid = videoIds[query.episode - 1];
    if (vid === undefined) return null;

    const names = await fetchSegmentNames(vid, query.signal);
    if (names.length === 0) return null;

    const comments = toComments(await fetchAllSegments(vid, names, query.signal));
    if (comments.length === 0) return null;
    return { comments, matchedTitle: title };
  },
};
