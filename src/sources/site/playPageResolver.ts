/**
 * 网页播放页 → 直链解析（站点源）
 *
 * 大量 CMS 采集站的 `vod_play_url` 给的不是直链，而是自家的**网页播放页**：
 * - `/share/<id>`（非凡、电影天堂、量子…）
 * - `/play/<id>`（火狐、光速、极速、新浪…）
 * - `*.html`
 *
 * 这些页面并不加密，真实 m3u8 就以明文写在 `<script>` 里，例如：
 * ```
 * const url = "/20261003/42433_f9195e75/index.m3u8?sign=...";   // share 页
 * const vid = 'https://play.hhuus.com/play/egJxyrGd/index.m3u8'; // play 页
 * ```
 * 直接交给 `<video>` 会让 ffmpeg 解封装器去读 HTML，报
 * `DEMUXER_ERROR_COULD_NOT_OPEN`，被误映射成「暂不支持该格式」。
 *
 * 边界：只做"从页面文本里取地址"，不执行页面 JS、不解密、不递归解析 `?url=` 包装。
 */
import { AppError } from '@/shared/errors';
import { toAbsoluteUrl } from '@/shared/url';
import { httpClient } from '@/sources/base/httpClient';

/** 页面里没找到可播地址时的用户文案 */
export const PLAY_PAGE_NOT_FOUND_MESSAGE = '该源返回的是网页播放页，未找到可播放地址';

/** 媒体后缀（命中即认为已是直链，不再当播放页） */
const MEDIA_EXTENSION = /\.(m3u8|mp4|m4v|mov|webm|ts|mkv|flv)$/i;

/** 网页播放页路径特征 */
const PLAY_PAGE_PATH = /\/(share|play|vodplay|player)\//i;

/** 页面级扩展名 */
const PAGE_EXTENSION = /\.(html?|shtml|php)$/i;

/** 绝对媒体地址（协议相对也接受），排除引号/空白/反斜杠干扰 */
const ABSOLUTE_MEDIA = /(?:https?:)?\/\/[^\s"'<>()\\]+?\.(m3u8|mp4|m4v|mov|webm)(?:\?[^\s"'<>()\\]*)?/gi;

/** 引号包裹的相对媒体地址 */
const QUOTED_MEDIA = /["']([^"'\s<>]*?\.(m3u8|mp4|m4v|mov|webm)(?:\?[^"'\s<>]*)?)["']/gi;

/**
 * 是否为"网页播放页"（需要先取页面再取直链）。
 *
 * 已带媒体后缀的地址一律放行（如 `/play/xx/index.m3u8` 虽含 `/play/`，但本身就是清单）。
 */
export function isPlayPageUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string' || url.trim().length === 0) return false;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('//')) return false;

  let pathname: string;
  try {
    pathname = new URL(trimmed, 'https://placeholder.invalid').pathname;
  } catch {
    pathname = trimmed.split('#')[0]!.split('?')[0]!;
  }
  if (MEDIA_EXTENSION.test(pathname)) return false;
  return PLAY_PAGE_PATH.test(pathname) || PAGE_EXTENSION.test(pathname);
}

/** 页面文本里的转义还原（`\/`、`\u002F`、`&amp;`） */
function unescapePageText(html: string): string {
  return html
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
}

interface MediaCandidate {
  url: string;
  /** 优先级：m3u8 最高（同一页面常同时给出封面 mp4 预览） */
  rank: number;
}

function rankOf(ext: string): number {
  switch (ext.toLowerCase()) {
    case 'm3u8':
      return 0;
    case 'mp4':
    case 'm4v':
    case 'mov':
      return 1;
    default:
      return 2;
  }
}

/**
 * 从页面文本提取媒体地址（已转绝对、去重、按优先级排序）。
 * 纯函数，不发请求。
 */
export function extractMediaFromPage(
  html: string | null | undefined,
  pageUrl: string,
): MediaCandidate[] {
  if (typeof html !== 'string' || html.length === 0) return [];
  const text = unescapePageText(html);
  const out: MediaCandidate[] = [];
  const seen = new Set<string>();

  const push = (raw: string, ext: string): void => {
    const absolute = toAbsoluteUrl(pageUrl, raw);
    if (!absolute || seen.has(absolute)) return;
    // 页面自身的地址不是媒体，防御性排除
    if (absolute === pageUrl) return;
    seen.add(absolute);
    out.push({ url: absolute, rank: rankOf(ext) });
  };

  for (const match of text.matchAll(ABSOLUTE_MEDIA)) {
    push(match[0], match[1] ?? '');
  }
  for (const match of text.matchAll(QUOTED_MEDIA)) {
    const raw = match[1];
    if (!raw) continue;
    push(raw, match[2] ?? '');
  }

  return out.sort((a, b) => a.rank - b.rank);
}

/** 从页面文本取首选播放地址；取不到返回 `null`（纯函数） */
export function extractPlayUrlFromPage(
  html: string | null | undefined,
  pageUrl: string,
): string | null {
  return extractMediaFromPage(html, pageUrl)[0]?.url ?? null;
}

export interface ResolvePlayPageOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * 取网页播放页并解析出直链。
 *
 * - 页面本身就是清单（首行 `#EXTM3U`）→ 原样返回该地址；
 * - 解析不到 → `E_NO_PLAY_URL`（不是"格式不支持"，避免误导用户）；
 * - 网络类失败由 `httpClient` 原样抛出，交由上层判定源健康度。
 */
export async function resolvePlayPage(
  pageUrl: string,
  options: ResolvePlayPageOptions = {},
): Promise<string> {
  const text = await httpClient.request<string>(pageUrl, {
    method: 'GET',
    headers: options.headers && Object.keys(options.headers).length > 0 ? options.headers : undefined,
    signal: options.signal,
    responseType: 'text',
  });

  if (text.trimStart().startsWith('#EXTM3U')) return pageUrl;

  const found = extractPlayUrlFromPage(text, pageUrl);
  if (!found) {
    const snippet = text.trim().replace(/\s+/g, ' ').slice(0, 80);
    throw new AppError('E_NO_PLAY_URL', PLAY_PAGE_NOT_FOUND_MESSAGE, {
      detail: `页面内未匹配到 m3u8/mp4 地址（前 80 字符：${snippet}）`,
      retryable: false,
    });
  }
  return found;
}
