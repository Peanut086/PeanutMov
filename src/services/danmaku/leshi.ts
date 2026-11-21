/**
 * 乐视直连弹幕源（无凭证）
 *
 * 链路：`so.le.com` 搜索页 → 结果块内联的 `vidEpisode`（集号→vid）/播放链接 →
 * 播放页配置取本集时长与类型 → `hd-my.le.com/danmu/list` 按 300s 窗口并发。
 *
 * 接口口径：
 * - 搜索结果是服务端渲染的 HTML，每个 `So-detail` 块带一段 JS 对象字面量 `data-info`，
 *   其中 `vidEpisode:'1-28834428,2-...'` 已含全部分集 vid，不必再抓剧集详情页；
 * - 弹幕窗口固定 300 秒（`start` 落在哪个窗口取哪个窗口），`amount` 是窗口内条数上限，
 *   热门剧常顶到 2000 条，抽稀由 `danmakuService` 统一处理；
 * - 条目字段 `start` 是**相对视频起点**的秒数，`color` 为 6 位十六进制文本，
 *   `position` 1 顶部、3 底部，其余（2/4）滚动——与优酷的 1/2 口径不同，按播放器分支实测确认。
 *
 * 版权现状：乐视片库大量下架，搜索能命中本名才继续，命中不到直接放弃（不拿花絮/cut 版顶）。
 */
import { requestWithHeaders } from './nativeHttp';
import { pickCandidate, titleMatchScore } from './titlePick';
import { fetchInBatches, parseDurationSec } from './segments';
import { stripTitleNoise } from '@/sources/douban/playMatch';
import type { DanmakuComment } from '@/types';
import type { DanmakuProvider, DanmakuQuery } from './provider';

const SEARCH_URL = 'https://so.le.com/s';
const PLAY_PAGE_URL = 'https://www.le.com/ptv/vplay/';
const DANMU_URL = 'https://hd-my.le.com/danmu/list';

/** 弹幕接口的固定分片步长（秒），起点偏移 5s 与播放器一致 */
const SEGMENT_STEP_SEC = 300;
const SEGMENT_START_OFFSET = 5;
const SEGMENT_AMOUNT = 2000;
/** 窗口数上限：40 片 = 200 分钟，超出按超长内容截断 */
const MAX_SEGMENTS = 40;

/** 低于此时长的分集按预告/花絮处理 */
const MIN_FEATURE_LENGTH_SEC = 300;

const LE_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html, application/json, text/plain, */*',
  Referer: 'https://www.le.com/',
};

/* ---------- 搜索结果块 ---------- */

interface LeResult {
  title: string;
  year: number | null;
  /** 集号 → vid（电视剧/综艺）；电影为空，vid 取播放链接 */
  episodes: Array<{ episode: number; vid: string }>;
  playVid: string | null;
}

/** `data-info` 是 JS 对象字面量（键无引号、值单引号），只按字段名取需要的项 */
function infoField(info: string, key: string): string {
  const match = new RegExp(`${key}:'([^']*)'`).exec(info);
  return match ? (match[1] ?? '') : '';
}

function yearOf(text: string, title: string): number | null {
  const tail = title.length > 0 ? text.replace(title, '') : text;
  const match = /(19|20)\d{2}/.exec(tail);
  return match ? Number(match[0]) : null;
}

/** 锚点里 `href` 与 `title` 的先后顺序不固定，先整段取出标签再分别解析 */
function anchorOf(block: string): { title: string; vid: string | null } {
  const anchor = /<a\b[^>]*j-baidu-a[^>]*>/i.exec(block)?.[0] ?? '';
  const title = /title="([^"]*)"/.exec(anchor)?.[1] ?? '';
  const vid = /vplay\/(\d+)\.html/.exec(anchor)?.[1] ?? null;
  return { title: title.trim(), vid };
}

function parseVidEpisode(raw: string): Array<{ episode: number; vid: string }> {
  const out: Array<{ episode: number; vid: string }> = [];
  for (const pair of raw.split(',')) {
    const match = /^(\d+)-(\d+)$/.exec(pair.trim());
    if (match) out.push({ episode: Number(match[1]), vid: match[2] ?? '' });
  }
  return out;
}

/** 结果块之间靠 `So-detail` 分隔；块首可能混入侧栏广告，只认带 data-info 的块 */
function parseResults(html: string): LeResult[] {
  const out: LeResult[] = [];
  for (const block of html.split(/<div class="So-detail\s/).slice(1)) {
    const info = (/data-info="([^"]*)"/.exec(block) ?? [])[1] ?? '';
    if (info.length === 0) continue;
    const anchor = anchorOf(block);
    if (anchor.title.length === 0) continue;
    out.push({
      title: anchor.title,
      year: yearOf(infoField(info, 'keyWord'), anchor.title),
      episodes: parseVidEpisode(infoField(info, 'vidEpisode')),
      playVid: anchor.vid,
    });
  }
  return out;
}

/**
 * 候选按片名精度选：归一化相等优先，年份只在同分候选内做优选。
 * cut 版/花絮/纪录片与前缀同名的衍生条目在精度分层里自然落到低分。
 */
function pickResult(results: LeResult[], query: DanmakuQuery): LeResult | null {
  const candidates = results.map((item) => ({
    item,
    score: titleMatchScore(item.title, query.title),
    year: item.year,
  }));
  return pickCandidate(candidates, query.year)?.item ?? null;
}

/* ---------- 本集时长与类型 ---------- */

interface LeFeature {
  durationSec: number;
  title: string | null;
}

/**
 * 播放页内联配置（非 JSON）里取长时与专辑名：`duration:'45:40'`、`pTitle:"白鹿原"`、
 * `videotypeName:"正片"`。顺带用专辑名再校验一次，防搜索块与播放页对不上。
 */
async function fetchFeature(vid: string, query: DanmakuQuery): Promise<LeFeature | null> {
  const html = await requestWithHeaders<string>(`${PLAY_PAGE_URL}${vid}.html`, {
    headers: LE_HEADERS,
    responseType: 'text',
    timeoutMs: 10_000,
    retries: 0,
    signal: query.signal,
  });
  const durationSec = parseDurationSec(/duration:'([^']*)'/.exec(html)?.[1]);
  if (durationSec === null || durationSec < MIN_FEATURE_LENGTH_SEC) return null;
  if (/videotypeName:"(?!正片)/.test(html)) return null;

  const title = /pTitle:"([^"]*)"/.exec(html)?.[1] ?? null;
  if (title !== null && stripTitleNoise(title) !== stripTitleNoise(query.title)) return null;
  return { durationSec, title };
}

/* ---------- 弹幕 ---------- */

interface LeDanmuItem {
  txt?: string;
  start?: number | string;
  color?: string;
  position?: number | string;
}

interface LeDanmuResponse {
  code?: number | string;
  data?: { list?: LeDanmuItem[] };
}

/** 乐视样式：1 顶部、3 底部，其余（2 滚动、4 发送默认）按滚动 */
function modeOf(position: number | string | undefined): DanmakuComment['mode'] {
  const raw = Number(position);
  if (raw === 1) return 'top';
  if (raw === 3) return 'bottom';
  return 'scroll';
}

function colorOf(raw: string | undefined): number {
  const hex = (raw ?? '').replace(/[^0-9a-fA-F]/g, '');
  const value = Number.parseInt(hex, 16);
  return Number.isFinite(value) && hex.length > 0 ? value : 0xffffff;
}

function toComment(item: LeDanmuItem): DanmakuComment | null {
  const text = (item.txt ?? '').trim();
  if (text.length === 0) return null;
  const time = Number(item.start);
  if (!Number.isFinite(time) || time < 0) return null;
  return { time, mode: modeOf(item.position), color: colorOf(item.color), text };
}

export const leshiProvider: DanmakuProvider = {
  id: 'leshi',
  available: () => true,
  async match(query) {
    if (query.episode < 1) return null;
    const html = await requestWithHeaders<string>(
      `${SEARCH_URL}?from=pc&wd=${encodeURIComponent(query.title)}`,
      { headers: LE_HEADERS, responseType: 'text', timeoutMs: 8000, retries: 0, signal: query.signal },
    );
    const result = pickResult(parseResults(html), query);
    if (result === null) return null;

    const vid =
      query.episode === 1
        ? (result.episodes.find((item) => item.episode === 1)?.vid ?? result.playVid)
        : (result.episodes.find((item) => item.episode === query.episode)?.vid ?? null);
    if (vid === null || vid.length === 0) return null;

    const feature = await fetchFeature(vid, query);
    if (feature === null) return null;

    const starts: number[] = [];
    for (let index = 0; index * SEGMENT_STEP_SEC < feature.durationSec && starts.length < MAX_SEGMENTS; index += 1) {
      starts.push(index * SEGMENT_STEP_SEC + SEGMENT_START_OFFSET);
    }

    const comments = await fetchInBatches(starts, async (start) => {
      const response = await requestWithHeaders<LeDanmuResponse>(
        `${DANMU_URL}?vid=${encodeURIComponent(vid)}&start=${start}&amount=${SEGMENT_AMOUNT}`,
        { headers: LE_HEADERS, responseType: 'json', timeoutMs: 8000, retries: 0, signal: query.signal },
      );
      if (Number(response.code) !== 200) return [];
      const out: DanmakuComment[] = [];
      for (const item of response.data?.list ?? []) {
        const comment = toComment(item);
        if (comment !== null) out.push(comment);
      }
      return out;
    });
    if (comments.length === 0) return null;
    return { comments, matchedTitle: feature.title ?? result.title };
  },
};
