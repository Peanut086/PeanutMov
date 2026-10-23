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
 *
 * 提取逻辑已移到 `src/sources/pipeline/mediaExtract.ts`（避免模块环），
 * 这里保留同名导出，外部调用点无需改动。
 */
import { crawl } from '@/sources/pipeline/scheduler';
import { extractMediaFromPage, extractPlayUrlFromPage } from '@/sources/pipeline/mediaExtract';
import { PLAY_PAGE_NOT_FOUND_MESSAGE } from '@/sources/pipeline/messages';

export { extractMediaFromPage, extractPlayUrlFromPage, PLAY_PAGE_NOT_FOUND_MESSAGE };
export type { MediaCandidate } from '@/sources/pipeline/mediaExtract';

/** 媒体后缀（命中即认为已是直链，不再当播放页） */
const MEDIA_EXTENSION = /\.(m3u8|mp4|m4v|mov|webm|ts|mkv|flv)$/i;

/** 网页播放页路径特征 */
const PLAY_PAGE_PATH = /\/(share|play|vodplay|player)\//i;

/** 页面级扩展名 */
const PAGE_EXTENSION = /\.(html?|shtml|php)$/i;

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

export interface ResolvePlayPageOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * 取网页播放页并解析出直链。
 *
 * - 页面本身就是清单（首行 `#EXTM3U`）→ 原样返回该地址；
 * - 解析不到 → `E_NO_PLAY_URL`（不是"格式不支持"，避免误导用户）；
 * - 网络类失败由管道原样抛出，交由上层判定源健康度。
 *
 * 解析逻辑由管道解析器 `html.media` 承担（复用同一份 `extractMediaFromPage`）。
 */
export async function resolvePlayPage(
  pageUrl: string,
  options: ResolvePlayPageOptions = {},
): Promise<string> {
  const result = await crawl<string>({
    intent: 'playpage',
    url: pageUrl,
    headers: options.headers,
    signal: options.signal,
  });
  return result.value;
}
