/**
 * 归一化工具（API-01 支撑）
 *
 * 各适配器的原始字段差异很大，统一在这里收敛为 MediaItem / Category / Episode 雏形，
 * 保证同一个源在不同协议下产出同构数据。
 */
import { guessFormatFromUrl } from '@/shared/url';
import { demoPoster } from '@/data/demo/demoCatalog';
import type { Category, MediaFormat, MediaType } from '@/types';

/** 类型推断：优先用源给出的字符串/数字，其次用标题与分类关键字 */
export function inferMediaType(
  raw: string | number | null | undefined,
  title: string | null | undefined = '',
  genreHint: string | null | undefined = '',
): MediaType {
  const value = String(raw ?? '').toLowerCase();
  const haystack = `${value} ${title ?? ''} ${genreHint ?? ''}`.toLowerCase();
  if (/anime|动漫|番剧|动画片/.test(haystack)) return 'anime';
  if (/variety|综艺|真人秀/.test(haystack)) return 'variety';
  if (/series|tv|电视剧|剧集|连续剧|episode/.test(haystack)) return 'series';
  if (/movie|film|电影|影片/.test(haystack)) return 'movie';
  return 'other';
}

/** 年份：从任意字符串中提取 1900-2100 的四位数字 */
export function normalizeYear(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const year = Math.trunc(value);
    return year >= 1900 && year <= 2100 ? year : null;
  }
  if (typeof value === 'string') {
    const match = /(19|20)\d{2}/.exec(value);
    if (match) {
      const year = Number.parseInt(match[0], 10);
      return year >= 1900 && year <= 2100 ? year : null;
    }
  }
  return null;
}

/** 时长：支持 `7200`、`"7200"`、`"120分钟"`、`"1:30:00"`、`"90:00"` */
export function normalizeDurationSec(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const num = Number.parseFloat(text);
    return num > 0 ? Math.round(num) : null;
  }
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (clock) {
    const a = Number.parseInt(clock[1] ?? '0', 10);
    const b = Number.parseInt(clock[2] ?? '0', 10);
    const c = clock[3] === undefined ? null : Number.parseInt(clock[3], 10);
    return c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  }
  const minutes = /^(\d+(?:\.\d+)?)\s*(?:分钟|min|mins|minutes)$/i.exec(text);
  if (minutes?.[1]) return Math.round(Number.parseFloat(minutes[1]) * 60);
  const hours = /^(\d+(?:\.\d+)?)\s*(?:小时|h|hr|hours?)$/i.exec(text);
  if (hours?.[1]) return Math.round(Number.parseFloat(hours[1]) * 3600);
  return null;
}

/** 集数：支持 `"更新至24集"`、`"24"`、`"24集"` */
export function normalizeEpisodeCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const match = /\d+/.exec(value);
  if (!match) return null;
  const count = Number.parseInt(match[0], 10);
  return count > 0 ? count : null;
}

/**
 * 备注（`vod_remarks`）里的集数：只认显式集数，避免把年份、清晰度当集数。
 *
 * 备注是自由文本，`"1998"`（年份）、`"1080P"`、`"4K"`、`"60帧"` 都可能出现，
 * 因此不接受裸数字，必须带 `集/话/期/回` 单位或 `更新至` 之类的前缀。
 */
export function episodeCountFromRemarks(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const count = Math.trunc(value);
    if (count <= 0 || (count >= 1900 && count <= 2100)) return null;
    return count;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;

  // `全30集` / `共36集` 优先于进度类备注
  const full = /(?:全|共)\s*(\d{1,4})\s*[集话期回]/.exec(text);
  if (full?.[1]) return positiveOrNull(Number(full[1]));

  // `30集` / `全30集` / `第12集` / `1-30集` / `48话` / `12期`
  const unit = /(\d{1,4})\s*[集话期回]/.exec(text);
  if (unit?.[1]) return positiveOrNull(Number(unit[1]));

  // `更新至24`（无单位）
  const progress = /(?:更新至|更新到|已更新至|完结至)\s*(\d{1,4})\s*$/.exec(text);
  if (progress?.[1]) return positiveOrNull(Number(progress[1]));

  return null;
}

function positiveOrNull(value: number): number | null {
  return value > 0 ? value : null;
}

/** 评分：0-10；非法或越界返回 null */
export function normalizeRating(value: unknown): number | null {
  const num = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseFloat(value) : NaN;
  if (!Number.isFinite(num)) return null;
  if (num <= 0) return null;
  return Math.min(10, Math.round(num * 10) / 10);
}

/** 去 HTML 标签与多余空白（站点简介常带 <p>/<br>） */
export function stripHtml(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > 0 ? text : null;
}

/** 标题清洗：去掉多余空白与控制字符 */
export function normalizeTitle(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 数组字段归一化：接受 `"动作,科幻"`、`["动作"]`、`null` */
export function normalizeStringList(value: unknown, separator = /[,，/、|]/): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(separator)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

/** 从 URL 推断格式；无法判断时按 MP4 处理（API-01 约定） */
export function normalizeFormat(url: string | null | undefined, fallback: MediaFormat = 'mp4'): MediaFormat {
  return guessFormatFromUrl(url) ?? fallback;
}

/** 海报兜底：源未提供海报时用标题生成可离线渲染的 SVG（不产生破图） */
export function fallbackPoster(title: string): string {
  let hash = 0;
  for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) % 360;
  return demoPoster(title.length > 0 ? title : '未命名', hash);
}

/** 分类归一化：保证 id 规则 `${sourceId}:${value}` 与 order 连续 */
export function normalizeCategories(
  sourceId: string,
  raw: Array<{ value: string | number; name: string }>,
  idOf: (sourceId: string, value: string) => string,
): Category[] {
  const seen = new Set<string>();
  const out: Category[] = [];
  raw.forEach((entry, index) => {
    const value = String(entry.value);
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    out.push({
      id: idOf(sourceId, value),
      sourceId,
      name: normalizeTitle(entry.name) || value,
      value,
      order: index,
    });
  });
  return out;
}

/**
 * 分类 ID：`${sourceId}:${encodeURIComponent(value)}`
 *
 * 技术方案写作 "${sourceId}:${value}"，但分类值可能是含 `/`、`?` 的路径（AList/WebDAV），
 * 直接拼接会与"按冒号切分"的解析逻辑冲突，因此 value 段做 URI 编码（仍满足"源内唯一"）。
 */
export function categoryIdFor(sourceId: string, value: string): string {
  return `${sourceId}:${encodeURIComponent(value)}`;
}

/** 从分类 ID 还原 value；不属于该源或格式非法时返回 null */
export function parseCategoryValue(sourceId: string, categoryId: string | null): string | null {
  if (!categoryId) return null;
  const prefix = `${sourceId}:`;
  if (!categoryId.startsWith(prefix)) return null;
  const encoded = categoryId.slice(prefix.length);
  try {
    const decoded = decodeURIComponent(encoded);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return encoded.length > 0 ? encoded : null;
  }
}

/** 计算下一页是否还有更多（适配器必须返回准确的 hasMore） */
export function computeHasMore(page: number, pageSize: number, received: number, total: number | null): boolean {
  if (received < pageSize) return false;
  if (total !== null) return page * pageSize < total;
  return true;
}
