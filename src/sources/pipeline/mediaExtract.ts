/**
 * 页面文本 → 媒体地址提取（纯函数，不发请求）
 *
 * 从 `playPageResolver` 抽出，避免 `playPageResolver → scheduler → parsers → playPageResolver` 的模块环。
 * `playPageResolver` 继续 re-export，外部调用点无需改动。
 */
import { toAbsoluteUrl } from '@/shared/url';

/** 绝对媒体地址（协议相对也接受），排除引号/空白/反斜杠干扰 */
const ABSOLUTE_MEDIA = /(?:https?:)?\/\/[^\s"'<>()\\]+?\.(m3u8|mp4|m4v|mov|webm)(?:\?[^\s"'<>()\\]*)?/gi;

/** 引号包裹的相对媒体地址 */
const QUOTED_MEDIA = /["']([^"'\s<>]*?\.(m3u8|mp4|m4v|mov|webm)(?:\?[^"'\s<>]*)?)["']/gi;

export interface MediaCandidate {
  url: string;
  /** 优先级：m3u8 最高（同一页面常同时给出封面 mp4 预览） */
  rank: number;
}

/** 页面文本里的转义还原（`\/`、`\u002F`、`&amp;`） */
function unescapePageText(html: string): string {
  return html
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&');
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
