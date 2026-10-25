/**
 * 弹幕数据 Provider（v1.7 / CHG-22，只读不发）
 *
 * 三级回退（`danmakuService.match` 按序尝试）：
 * 1. `dandanplay` —— 官方匹配 API，需要 appId/secret（用户在设置里配置前**不启用**，
 *    避免无凭据请求打官方接口）；
 * 2. `aggregate` —— 社区聚合端点（dandanplay 兼容协议），无凭据可用，为主力源；
 * 3. `local-xml` —— 用户本地 B 站格式 xml（下载目录/手动粘贴），纯解析不发请求。
 *
 * 匹配口径与豆瓣借播一致（`stripTitleNoise`）：片名归一化相等 + 集号由调用方传入。
 * 隐私约束：请求只携带片名/年份/集号，绝不携带用户标识。
 */
import { DANMAKU_AGGREGATE_BASE, DANMAKU_DANDANPLAY_BASE } from '@/shared/constants';
import { stripTitleNoise } from '@/sources/douban/playMatch';
import type { DanmakuComment } from '@/types';
import { httpClient } from '@/sources/base/httpClient';

/** 匹配查询：片名归一化由 provider 内部完成 */
export interface DanmakuQuery {
  title: string;
  year: number | null;
  /** 1 起的集号；电影固定 1 */
  episode: number;
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

/* ---------- dandanplay 协议响应（aggregate 兼容同一形态） ---------- */

interface DdpMatchEpisode {
  episodeId: number;
  episodeTitle: string;
}
interface DdpMatchResponse {
  matched: boolean;
  matches?: Array<{
    seasonId?: number;
    animeTitle: string;
    type: string;
    typeDescription: string;
    episodes: DdpMatchEpisode[];
  }>;
}
/** 弹幕内容行：`[时间(秒), 模式, 颜色, 文本]` */
type DdpCommentRow = [number, number, number, string];

/** 模式映射（dandanplay/B 站惯例：1~3 滚动、4 底部、5 顶部） */
function modeOf(raw: number): DanmakuComment['mode'] {
  if (raw === 4) return 'bottom';
  if (raw === 5) return 'top';
  return 'scroll';
}

function rowsToComments(rows: DdpCommentRow[]): DanmakuComment[] {
  const out: DanmakuComment[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) continue;
    const [time, rawMode, color, text] = row;
    if (typeof time !== 'number' || typeof text !== 'string') continue;
    if (text.trim().length === 0) continue;
    out.push({ time, mode: modeOf(Number(rawMode)), color: Number(color) || 0xffffff, text: text.trim() });
  }
  return out;
}

/** 从 matches 里按集号挑 episodeId：集标题含「第 N 话/集」优先，否则按序号取第 episode 个 */
function pickEpisodeId(
  matches: NonNullable<DdpMatchResponse['matches']>,
  episode: number,
): number | null {
  for (const match of matches) {
    if (match.episodes.length === 0) continue;
    const byTitle = match.episodes.find((ep) =>
      new RegExp(`第\\s*0*${episode}\\s*[话集话]`).test(ep.episodeTitle) ||
      ep.episodeTitle.trim() === String(episode),
    );
    const chosen = byTitle ?? match.episodes[episode - 1] ?? null;
    if (chosen) return chosen.episodeId;
  }
  return null;
}

/* ---------- Provider 实现 ---------- */

export interface DanmakuProvider {
  readonly id: 'dandanplay' | 'aggregate';
  /** 该 Provider 当前是否可用（凭据缺失等） */
  available(): boolean;
  /** 匹配成功返回弹幕与远端回传的题名（供阈值校验）；无匹配返回 null */
  match(query: DanmakuQuery): Promise<{ comments: DanmakuComment[]; matchedTitle: string | null } | null>;
}

/** 匹配请求（dandanplay /api/v2/match）：只带文件名形态的片名与集号 */
function matchRequestBody(query: DanmakuQuery): string {
  const fileName = query.year !== null ? `${query.title}.${query.year}.S01E${String(query.episode).padStart(2, '0')}` : query.title;
  return JSON.stringify({ fileName, matchMode: 'episodeOnly' });
}

async function matchViaCompatibleApi(
  base: string,
  query: DanmakuQuery,
  headers: Record<string, string>,
): Promise<{ comments: DanmakuComment[]; matchedTitle: string | null } | null> {
  const matchResponse = await httpClient.request<DdpMatchResponse>(`${base}/api/v2/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: matchRequestBody(query),
    timeoutMs: 6000,
    retries: 0,
    signal: query.signal,
  });
  if (!matchResponse.matched || !matchResponse.matches || matchResponse.matches.length === 0) return null;
  const episodeId = pickEpisodeId(matchResponse.matches, query.episode);
  if (episodeId === null) return null;

  const comments = await httpClient.request<{ count: number; comments: DdpCommentRow[] }>(
    `${base}/api/v2/comment/${episodeId}?withRelated=true`,
    { timeoutMs: 8000, retries: 0, signal: query.signal },
  );
  const list = rowsToComments(comments.comments ?? []);
  if (list.length === 0) return null;
  const matchedTitle = matchResponse.matches[0]?.animeTitle ?? null;
  return { comments: list, matchedTitle };
}

export const dandanplayProvider: DanmakuProvider = {
  id: 'dandanplay',
  available: () => getDandanplayCredentials() !== null,
  async match(query) {
    const credentials = getDandanplayCredentials();
    if (!credentials) return null;
    return matchViaCompatibleApi(DANMAKU_DANDANPLAY_BASE, query, {
      'X-AppId': credentials.appId,
      'X-Secret': credentials.secret,
    });
  },
};

export const aggregateProvider: DanmakuProvider = {
  id: 'aggregate',
  available: () => true,
  async match(query) {
    return matchViaCompatibleApi(DANMAKU_AGGREGATE_BASE, query, {});
  },
};

/* ---------- 本地 B 站 xml 解析（纯函数，供 Provider 与单测共用） ---------- */

function unescapeXmlText(value: string): string {
  return value
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&amp;/gi, '&');
}

/**
 * B 站弹幕 xml → 弹幕列表。
 * `<d p="time,mode,size,color,timestamp,pool,uid,rowid">文本</d>`；
 * 兼容 CIDATA 包裹与属性引号缺失的宽松形态。
 */
export function parseBilibiliXml(xml: string): DanmakuComment[] {
  const out: DanmakuComment[] = [];
  const pattern = /<d\s+[^>]*p\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/d\s*>/gi;
  for (const match of xml.matchAll(pattern)) {
    const parts = (match[1] ?? '').split(',');
    const text = unescapeXmlText(match[2] ?? '').trim();
    const time = Number.parseFloat(parts[0] ?? '');
    if (!Number.isFinite(time) || text.length === 0) continue;
    const rawMode = Number.parseInt(parts[1] ?? '1', 10) || 1;
    const color = Number.parseInt(parts[3] ?? '16777215', 10) || 0xffffff;
    out.push({ time, mode: modeOf(rawMode), color, text });
  }
  return out;
}

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
