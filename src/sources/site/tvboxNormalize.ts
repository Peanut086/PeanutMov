/**
 * TVBox 数据归一化（`site` 与 `spider` 适配器共用）
 *
 * `site` 从 CMS JSON API 拿数据，`spider` 从 jar 爬虫拿 JSON 字符串，
 * 两者最终都落到同一套 TVBox 字段（`vod_*` / `class` / `list`），
 * 因此列表项、分类、线路与剧集的构造只保留这一份实现。
 */
import { episodeIdOf, lineIdOf, mediaIdOf } from '@/shared/id';
import { toAbsoluteUrl } from '@/shared/url';
import {
  categoryIdFor,
  episodeCountFromRemarks,
  fallbackPoster,
  inferMediaType,
  inferTypeFromShape,
  normalizeDurationSec,
  normalizeFormat,
  normalizeRating,
  normalizeStringList,
  normalizeTags,
  normalizeTitle,
  normalizeYear,
  stripHtml,
  yearFromTitle,
} from '@/sources/base/normalize';
import {
  episodeTitleOf,
  parsePlayFromField,
  parsePlayListField,
  parsePlayUrlField,
  type TvboxClass,
  type TvboxListResponse,
  type TvboxVod,
} from '@/sources/site/tvboxTypes';
import type { Category, Episode, FilterDimension, MediaItem, MediaType, PlayLine, Source } from '@/types';

/** 生成基础 MediaItem 所需的最小字段集（由适配器的 `makeItem` 提供） */
export interface ItemFactory {
  (input: {
    sourceItemId: string;
    title: string;
    type: MediaType;
    originalTitle?: string | null;
    year?: number | null;
    area?: string | null;
    genres?: string[];
    tags?: string[];
    rating?: number | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    description?: string | null;
    durationSec?: number | null;
    episodeCount?: number | null;
    now?: number;
  }): MediaItem;
}

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const num = Number.parseInt(value, 10);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

export function vodIdOf(vod: TvboxVod): string {
  const raw = vod.vod_id;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim();
  return normalizeTitle(vod.vod_name) || 'unknown';
}

/** `class` 数组 → 分类；缺 `type_id`/`type_name` 的条目丢弃 */
export function categoriesOf(
  source: Source,
  classes: TvboxClass[] | null | undefined,
  response?: TvboxListResponse | null,
): Category[] {
  return (classes ?? [])
    .map((entry, index): Category | null => {
      const value = entry.type_id ?? entry.id ?? null;
      const name = normalizeTitle(entry.type_name ?? entry.name ?? '');
      if (value === null || name.length === 0) return null;
      return {
        id: categoryIdFor(source.id, String(value)),
        sourceId: source.id,
        name,
        value: String(value),
        order: index,
        filters: filterDimensionsOf(response, String(value)),
      };
    })
    .filter((entry): entry is Category => entry !== null);
}

/**
 * TVBox `filters` → 指定分类的服务端筛选维度。
 * 响应无配置 / 分类未命中 / 维度缺 key 时返回 null（UI 回退通用本地筛选）。
 */
export function filterDimensionsOf(
  response: TvboxListResponse | null | undefined,
  categoryValue: string,
): FilterDimension[] | null {
  const dims = response?.filters?.[categoryValue];
  if (!Array.isArray(dims) || dims.length === 0) return null;
  const parsed: FilterDimension[] = [];
  for (const dim of dims) {
    const key = typeof dim.key === 'string' ? dim.key.trim() : '';
    const name = typeof dim.name === 'string' && dim.name.trim().length > 0 ? dim.name.trim() : key;
    if (key.length === 0) continue;
    const options = (dim.value ?? [])
      .map((opt) => ({
        value: typeof opt.v === 'string' ? opt.v : String(opt.v ?? ''),
        label: typeof opt.n === 'string' && opt.n.trim().length > 0 ? opt.n.trim() : String(opt.v ?? ''),
      }))
      .filter((opt) => opt.value.length > 0 && opt.label.length > 0);
    if (options.length === 0) continue;
    parsed.push({ key, name, options });
  }
  return parsed.length > 0 ? parsed : null;
}

/** TVBox `vod_*` → 统一 MediaItem */
export function toItemFromVod(source: Source, vod: TvboxVod, makeItem: ItemFactory): MediaItem {
  const title = normalizeTitle(vod.vod_name);
  // 类型/集数/时长都来自 `vod_remarks` 这类自由文本，先算一次再分发给各字段，避免同一串备注被反复猜
  const episodeCount = episodeCountFromRemarks(vod.vod_remarks);
  const durationSec = normalizeDurationSec(vod.vod_remarks);
  const inferredType = inferMediaType(vod.type_name, vod.vod_name);
  return makeItem({
    sourceItemId: vodIdOf(vod),
    title: title || '未命名',
    type: inferredType === 'other' ? inferTypeFromShape(vod.vod_remarks, episodeCount) ?? 'other' : inferredType,
    year: normalizeYear(vod.vod_year) ?? yearFromTitle(title),
    area: vod.vod_area ? normalizeTitle(vod.vod_area) : null,
    genres: normalizeStringList(vod.type_name),
    tags: normalizeTags(vod.vod_remarks).slice(0, 3),
    rating: normalizeRating(vod.vod_score),
    posterUrl: toAbsoluteUrl(source.baseUrl, vod.vod_pic) ?? fallbackPoster(title),
    description: stripHtml(vod.vod_content),
    durationSec,
    episodeCount,
    now: Date.now(),
  });
}

export interface RawEpisode {
  id: string;
  url: string;
  title: string;
  number: number;
}

export interface LinesWithRaw {
  lines: PlayLine[];
  episodes: Episode[];
  /** 与 `lines` 同序：第 i 条线路的原始剧集（含未解析的播放地址） */
  rawEpisodes: RawEpisode[][];
}

/** `vod_play_from` + `vod_play_url` → 线路 / 剧集 / 原始地址 */
export function buildLinesWithRaw(
  source: Source,
  vod: TvboxVod,
  mediaId: string,
  now = Date.now(),
): LinesWithRaw {
  const fromNames = parsePlayFromField(vod.vod_play_from);
  let lineNames = fromNames;
  let parsed = parsePlayUrlField(vod.vod_play_url, fromNames.length);

  // 网盘/盘搜类源不返回标准 `vod_play_url`，改由 `vod_play_list` 提供线路
  if (!parsed.some((segment) => segment.episodes.length > 0)) {
    const listed = parsePlayListField(vod.vod_play_list);
    if (listed.length > 0) {
      parsed = listed;
      lineNames = listed.map((line, index) => line.name || fromNames[index] || '');
    }
  }

  const lines: PlayLine[] = [];
  const episodes: Episode[] = [];
  const rawEpisodes: RawEpisode[][] = [];

  parsed.forEach((segment, index) => {
    if (segment.episodes.length === 0) return;
    const lineId = lineIdOf(mediaId, index);
    const lineName = lineNames[index] || `线路 ${index + 1}`;
    const firstUrl = segment.episodes[0]?.url ?? '';
    lines.push({
      id: lineId,
      mediaId,
      sourceId: source.id,
      name: lineName,
      quality: null,
      format: normalizeFormat(firstUrl, 'mp4'),
      index,
    });
    const rawList: RawEpisode[] = [];
    // P0-5: 按 url 去重（源可能返回重复集），去重后按顺序重新编号 1..N
    const seenUrls = new Set<string>();
    let sequenceNumber = 0;
    segment.episodes.forEach((entry) => {
      if (!entry.url || seenUrls.has(entry.url)) return;
      seenUrls.add(entry.url);
      sequenceNumber += 1;
      const title = episodeTitleOf(entry.name, sequenceNumber - 1);
      const id = episodeIdOf(mediaId, lineId, sequenceNumber);
      rawList.push({ id, url: entry.url, title, number: sequenceNumber });
      episodes.push({
        id,
        mediaId,
        sourceId: source.id,
        lineId,
        number: sequenceNumber,
        title,
        durationSec: null,
        subtitles: [],
        rawUrl: entry.url,
        updatedAt: now,
      });
    });
    rawEpisodes[index] = rawList;
  });

  return { lines, episodes, rawEpisodes };
}

/** 供调用方拼 mediaId（`spider` 与 `site` 的 id 口径一致） */
export function mediaIdOfVod(source: Source, vod: TvboxVod): string {
  return mediaIdOf(source.id, vodIdOf(vod));
}
