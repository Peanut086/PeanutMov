/**
 * 归一化工具（API-01 支撑）
 *
 * 各适配器的原始字段差异很大，统一在这里收敛为 MediaItem / Category / Episode 雏形，
 * 保证同一个源在不同协议下产出同构数据。
 */
import { guessFormatFromUrl } from '@/shared/url';
import { titlePoster } from '@/shared/posterFallback';
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
  if (SERIES_HINT.test(haystack)) return 'series';
  if (/movie|film|电影|影片/.test(haystack)) return 'movie';
  return 'other';
}

/**
 * 连载标记词表。
 *
 * 采集站常把「电视剧」写成「电视」「国产剧」「日韩剧」这类截断/地域写法，
 * `inferMediaType` 原来的 `电视剧|连续剧` 一条都接不住；「剧情」「喜剧」是类型不是连载形态，
 * 所以只收带「剧」的地域/平台写法，不放开成裸「剧」字。
 * 末尾的季/部号是给 `绝命毒师 第二季` 这类「分类字段为空、只把季号写进片名」的条目
 * （实测 861 条 `other` 里 779 条没有 `type_name`）。裸「第N集」不算：单集也可能这么写。
 */
const SERIES_HINT =
  /series|tv|电视剧|剧集|连续剧|episode|电视|国产剧|港台剧|日韩剧|欧美剧|网络剧|网剧|短剧|韩剧|美剧|日剧|港剧|台剧|英剧|泰剧|陆剧|第[0-9一二三四五六七八九十]+\s*[季部]/;

/** 备注里的连载进度词（实测样本：`已完结`×57、`更新至HD`×20、`13集全`×7） */
const SERIAL_PROGRESS_RE =
  /更新至|更新到|已完结|完结|连载|更至|全[0-9]{1,4}\s*[集话期回]|[0-9]{1,4}\s*[集话期回]全|第[0-9]{1,4}\s*[集话期回]/;

/**
 * 备注形态推类型：只在 `type_name` 判不出（落到 `other`）时兜底。
 *
 * 依据是设备实测的 947 条缓存条目：861 条 `other` 里 779 条根本没有 `type_name`，
 * 但备注写着「已完结」「更新至HD」「13集全」，或 `episodeCount` 已经推出来了（193 条）——
 * 这些都是连载形态的直接证据，比继续显示「其它」信息量更高。
 * 推不出就返回 null，不猜：`other` 是诚实结果，伪造类型才是问题。
 */
export function inferTypeFromShape(remarks: unknown, episodeCount: number | null): MediaType | null {
  const text = typeof remarks === 'string' ? remarks : '';
  if (episodeCount !== null && episodeCount > 1) return 'series';
  if (SERIAL_PROGRESS_RE.test(text)) return 'series';
  return null;
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

/**
 * 标题里的发行年兜底：只认「括号内」「紧跟『年』」「结尾且有分隔符」三种位置。
 *
 * 实测设备缓存 947 条里 736 条 `vod_year` 为空，但片名常自带年份
 * （`庆余年(2019)`、`1993年07月26日上映`、`漂白 2025`）。
 * 位置受限是为了不把片名里的数字当发行年——`2001太空漫游` 必须推不出，
 * 否则同一片会被拆成「1968 年」与「2001 年」两组（年份宽容按 item.year 归组）。
 * 汉字直接接年份（`流浪地球2019`）同样不认：设备缓存里没存过这种写法的样本，
 * 放开的代价（`消失的1937` 会被当成 1937 年）目前没有实测收益支撑。
 */
const YEAR_IN_BRACKET = /[（(【[]\s*((?:19|20)\d{2})\s*年?\s*[）)】\]]/;
const YEAR_WITH_SUFFIX = /(?:^|[\s\-_/·，,、.「『])((?:19|20)\d{2})\s*年(?!代)/;
const YEAR_AT_TAIL = /(?:^|[\s\-_/·，,、.（(【[\]])((?:19|20)\d{2})\s*(?:年版|版)?\s*$/;

export function yearFromTitle(title: string | null | undefined): number | null {
  if (typeof title !== 'string') return null;
  const text = title.trim();
  if (text.length === 0) return null;
  for (const pattern of [YEAR_IN_BRACKET, YEAR_WITH_SUFFIX, YEAR_AT_TAIL]) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const year = Number.parseInt(match[1], 10);
    if (year >= 1900 && year <= 2100) return year;
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
  const minutes = /^(\d+(?:\.\d+)?)\s*(?:分钟|分鐘|min|mins|minutes)$/i.exec(text);
  if (minutes?.[1]) return Math.round(Number.parseFloat(minutes[1]) * 60);
  const hours = /^(\d+(?:\.\d+)?)\s*(?:小时|小時|h|hr|hours?)$/i.exec(text);
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

/** 标签长度上限（半角单位）：超过这个宽度的备注是句子片段，不是标签 */
const MAX_TAG_UNITS = 16;

/** 全角/中日韩字符判定（按 2 个半角单位算宽度） */
const WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 显示宽度（半角单位）。
 *
 * 卡片一行只放得下约 8 个汉字，却放得下 20 多个字母，所以不能按 `length` 一刀切：
 * 汉字算 2、其余算 1，「本片讲述了一个发生在民国年间的离奇案件」这种句子片段才切得掉，
 * 而「更新至24集」「蓝光原盘」不会误伤。
 */
function displayUnits(value: string): number {
  let units = 0;
  for (const ch of value) units += WIDE_CHAR.test(ch) ? 2 : 1;
  return units;
}

/** ISO 时间戳形态（`2019-04-01`、`2019-04-01T12:00:00`、`2019/04/01 12:00`），实测有源把它当标签 */
const ISO_TIMESTAMP_TAG = /^[0-9]{4}[-/][0-9]{1,2}([-/][0-9]{1,2})?([T\s]+[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?)?/;

/** 繁体计量单位归一：`3分鐘` 与 `3分钟` 是同一个意思，不该各占一个标签 */
const TAG_UNIT_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/分鐘/g, '分钟'],
  [/小時/g, '小时'],
  [/秒鐘/g, '秒'],
];

/**
 * 标签清洗（P2-7）。
 *
 * `vod_remarks` 是自由文本，直接切出来会混进 ISO 时间戳、被分隔符切碎的日期数字碎片
 * （`2019/04/01` 按 `/` 一切就成了「2019」「04」「01」三个标签）和整句备注。
 * 只删「确定不是标签」的形态，不做词义过滤——「纪录片」「合集」这类是正经信息，
 * 误删比留下更糟（同 `isNonFeatureContent` 的取舍口径：只收实测出现过的形态）。
 */
export function normalizeTags(value: unknown, separator?: RegExp): string[] {
  const out: string[] = [];
  for (const entry of normalizeStringList(value, separator)) {
    let tag = entry;
    for (const [pattern, replacement] of TAG_UNIT_MAP) tag = tag.replace(pattern, replacement);
    tag = tag.replace(/\s+/g, ' ').trim();
    if (tag.length === 0 || displayUnits(tag) > MAX_TAG_UNITS) continue;
    if (ISO_TIMESTAMP_TAG.test(tag)) continue;
    // 纯数字里只留合法年份：日期被切碎剩下的「04」「01」不是标签
    if (/^[0-9]+$/.test(tag) && normalizeYear(tag) === null) continue;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** 从 URL 推断格式；无法判断时按 MP4 处理（API-01 约定） */
export function normalizeFormat(url: string | null | undefined, fallback: MediaFormat = 'mp4'): MediaFormat {
  return guessFormatFromUrl(url) ?? fallback;
}

/** 海报兜底：源未提供海报时用标题生成可离线渲染的 SVG（不产生破图） */
export function fallbackPoster(title: string): string {
  return titlePoster(title);
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
