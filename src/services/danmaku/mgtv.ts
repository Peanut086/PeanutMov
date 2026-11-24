/**
 * 芒果TV 直连弹幕源（无凭证）
 *
 * 链路：applet 搜索取正片 vid → pcweb 分集列表取本集 vid/cid/时长 → galaxy 弹幕接口按 60s 步进并发。
 * 芒果独播剧（如何其他平台无版权的湖南系剧集）此前只能落到 dandanplay，由本源补齐。
 * 接口口径：`rdbarrage` 的 `time` 是分片起点的毫秒数（可传 0 起步，响应 `next` 给下一段），
 * 条目的 `time` 是**相对视频起点**的毫秒数，跨分片连续，不需要再叠加片偏移。
 */
import { requestWithHeaders } from './nativeHttp';
import { episodeNumberOf, fetchInBatches, indexByNumber, parseDurationSec } from './segments';
import { pickCandidate, titleMatchScore } from './titlePick';
import type { DanmakuComment } from '@/types';
import type { DanmakuProvider, DanmakuQuery } from './provider';

const SEARCH_URL = 'https://mobileso.bz.mgtv.com/applet/search/v1';
const EPISODES_URL = 'https://pcweb.api.mgtv.com/episode/list';
const BARRAGE_URL = 'https://galaxy.bz.mgtv.com/rdbarrage';

/** 弹幕接口的固定分片步长（毫秒）：响应 `interval` 为 60 秒 */
const SEGMENT_STEP_MS = 60_000;

/** 低于此时长的分集按预告/花絮处理，不当正片取弹幕 */
const MIN_FEATURE_LENGTH_SEC = 300;

/** 分集接口单页上限 30 条，长剧翻页；上限 10 页足够 300 集 */
const EPISODE_PAGE_SIZE = 30;
const MAX_EPISODE_PAGES = 10;

const MGTV_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.mgtv.com/',
};

interface MgtvSearchItem {
  title?: string;
  vid?: string | number;
  desc?: string[];
}

interface MgtvSearchResponse {
  code: number;
  data?: { contents?: Array<{ data?: MgtvSearchItem[] }> };
}

interface MgtvEpisode {
  t1?: string | number;
  video_id?: string | number;
  url?: string;
  time?: string;
}

interface MgtvEpisodesResponse {
  data?: {
    total?: number | string;
    info?: { title?: string };
    list?: MgtvEpisode[];
  };
}

interface MgtvBarrageResponse {
  status?: number;
  data?: { items?: Array<{ content?: string; time?: number; type?: number }> | null };
}

/** 「电视剧 / 内地 / 2025」→ 2025 */
function yearOf(desc: string[] | undefined): number | null {
  for (const line of desc ?? []) {
    const match = /(19|20)\d{2}/.exec(line);
    if (match) return Number(match[0]);
  }
  return null;
}

/**
 * 搜索结果选正片：片名精确度优先于年份（年份只在同分候选内优选）。
 * 芒果的同名条目常是「正片（无标注）+ 第N季/精华版」，让年份越级就会串片。
 */
function pickVideoId(items: MgtvSearchItem[], query: DanmakuQuery): string | null {
  const candidates = items
    .filter((item) => item.vid !== undefined)
    .map((item) => {
      const title = (item.title ?? '').replace(/<[^>]*>/g, '').trim();
      return { vid: String(item.vid), score: titleMatchScore(title, query.title), year: yearOf(item.desc) };
    });
  return pickCandidate(candidates, query.year)?.vid ?? null;
}

/** `/b/615428/22328413.html` → 专辑号 cid（弹幕接口必填） */
function cidOf(url: string | undefined): string | null {
  const match = /\/b\/(\d+)\//.exec(url ?? '');
  return match ? (match[1] ?? null) : null;
}

/**
 * 分集列表：接口单页最多 30 条（长剧会翻页），按 `total` 逐页取全。
 * 只取到目标集号所在页即可，避免为 80 集剧拉满 3 页。
 */
async function fetchEpisodes(
  videoId: string,
  episode: number,
  signal?: AbortSignal,
): Promise<{ list: MgtvEpisode[]; title: string | null }> {
  const list: MgtvEpisode[] = [];
  let title: string | null = null;
  for (let page = 1; page <= MAX_EPISODE_PAGES; page += 1) {
    const response = await requestWithHeaders<MgtvEpisodesResponse>(
      `${EPISODES_URL}?video_id=${encodeURIComponent(videoId)}&page=${page}&size=${EPISODE_PAGE_SIZE}`,
      { headers: MGTV_HEADERS, responseType: 'json', timeoutMs: 8000, retries: 0, signal },
    );
    title = response.data?.info?.title ?? title;
    list.push(...(response.data?.list ?? []));
    const total = Number(response.data?.total ?? 0) || list.length;
    if (list.length >= total || (response.data?.list ?? []).length === 0) break;
    // 目标集号已出现且已取到足够时长信息即可停止
    if (list.some((item) => episodeNumberOf(item.t1) === episode)) break;
  }
  return { list, title };
}

async function searchVideoId(query: DanmakuQuery): Promise<string | null> {
  const response = await requestWithHeaders<MgtvSearchResponse>(
    `${SEARCH_URL}?q=${encodeURIComponent(query.searchTitle ?? query.title)}&pn=1&pc=20`,
    { headers: MGTV_HEADERS, responseType: 'json', timeoutMs: 8000, retries: 0, signal: query.signal },
  );
  const items = (response.data?.contents ?? []).flatMap((group) => group.data ?? []);
  return pickVideoId(items, query);
}

/**
 * 取本集正片：同集号可能并存正片与预告（如「第 3 集 01:29」），按时长取最长的一条。
 */
function pickEpisode(list: MgtvEpisode[], episode: number): MgtvEpisode | null {
  const sameNumber = list.filter((item) => episodeNumberOf(item.t1) === episode);
  const pool = sameNumber.length > 0 ? sameNumber : list.length > 0 ? [list[indexByNumber(list, episode, (i) => episodeNumberOf(i.t1))]].filter(Boolean) : [];
  let chosen: MgtvEpisode | null = null;
  let bestSec = -1;
  for (const item of pool) {
    const sec = parseDurationSec(item.time) ?? 0;
    if (sec > bestSec) {
      bestSec = sec;
      chosen = item;
    }
  }
  if (chosen === null || bestSec < MIN_FEATURE_LENGTH_SEC) return null;
  return chosen;
}

export const mgtvProvider: DanmakuProvider = {
  id: 'mgtv',
  available: () => true,
  async match(query) {
    if (query.episode < 1) return null;
    const videoId = await searchVideoId(query);
    if (videoId === null) return null;

    const { list, title } = await fetchEpisodes(videoId, query.episode, query.signal);
    const target = pickEpisode(list, query.episode);
    const cid = cidOf(target?.url);
    if (target === null || cid === null || target.video_id === undefined) return null;
    const durationSec = parseDurationSec(target.time) ?? 0;
    if (durationSec <= 0) return null;

    const starts: number[] = [];
    for (let ms = 0; ms < durationSec * 1000; ms += SEGMENT_STEP_MS) starts.push(ms);

    const comments = await fetchInBatches(starts, async (start) => {
      const response = await requestWithHeaders<MgtvBarrageResponse>(
        `${BARRAGE_URL}?vid=${encodeURIComponent(String(target.video_id))}&cid=${encodeURIComponent(cid)}&time=${start}`,
        { headers: MGTV_HEADERS, responseType: 'json', timeoutMs: 8000, retries: 0, signal: query.signal },
      );
      if (response.status !== 0) return [];
      const out: DanmakuComment[] = [];
      for (const item of response.data?.items ?? []) {
        const text = (item.content ?? '').trim();
        if (text.length === 0) continue;
        const time = Number(item.time) / 1000;
        if (!Number.isFinite(time) || time < 0) continue;
        // rdbarrage 只回文本与时间，不带颜色/位置样式，统一按滚动渲染
        out.push({ time, mode: 'scroll', color: 0xffffff, text });
      }
      return out;
    });
    if (comments.length === 0) return null;
    return { comments, matchedTitle: title };
  },
};
