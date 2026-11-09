/**
 * 站点源（TVBox 风格 JSON）类型（技术方案 7.6）
 *
 * 全部字段可空/可变：真实站点实现差异大，映射时一律做防御性读取。
 */
export interface TvboxListResponse {
  code?: number | string;
  msg?: string | null;
  page?: number | string;
  pagecount?: number | string;
  limit?: number | string;
  total?: number | string;
  list?: TvboxVod[] | null;
  class?: TvboxClass[] | null;
  /** TVBox 筛选配置：分类 type_id → 维度列表（homeContent / ac=detail 响应携带） */
  filters?: Record<string, TvboxFilterDimension[]> | null;
}

/** TVBox 筛选维度：`{ key, name, value: [{ n, v }] }` */
export interface TvboxFilterDimension {
  key?: string | null;
  name?: string | null;
  value?: Array<{ n?: string | null; v?: string | null }> | null;
}

export interface TvboxClass {
  type_id?: number | string | null;
  type_name?: string | null;
  /** 部分实现用 id/name */
  id?: number | string | null;
  name?: string | null;
}

export interface TvboxVod {
  vod_id?: number | string | null;
  vod_name?: string | null;
  vod_pic?: string | null;
  vod_year?: number | string | null;
  vod_area?: string | null;
  vod_lang?: string | null;
  vod_remarks?: string | null;
  vod_content?: string | null;
  vod_actor?: string | null;
  vod_director?: string | null;
  vod_time?: string | null;
  vod_score?: number | string | null;
  type_id?: number | string | null;
  type_name?: string | null;
  /** 线路名，`$$$` 分隔 */
  vod_play_from?: string | null;
  /** 剧集，`名称$地址` 以 `#` 分隔，线路间 `$$$` 分隔 */
  vod_play_url?: string | null;
  /** 非标准播放列表（网盘/盘搜类源），`vod_play_url` 为空时的回退 */
  vod_play_list?: TvboxPlayListEntry[] | null;
}

/** 非标准 `vod_play_list` 的一条线路 */
export interface TvboxPlayListEntry {
  flag?: string | null;
  title?: string | null;
  name?: string | null;
  /** 解析接口前缀，通常以 `url=` 结尾，拼在 `urls[].url` 前使用 */
  parse_urls?: Array<string | null> | null;
  urls?: Array<{ name?: string | null; url?: string | null } | null> | null;
}

/** 站点源 ext（源配置） */
export interface SiteExt {
  /** 搜索路径覆盖（默认 `?wd={kw}&ac=detail`） */
  searchPath?: string | null;
  /** 列表路径覆盖（默认 `?ac=detail&t={type}&pg={page}`） */
  listPath?: string | null;
  /** 分类路径覆盖（默认 `?ac=list`） */
  categoryPath?: string | null;
  /** 详情路径覆盖（默认 `?ac=detail&ids={id}`） */
  detailPath?: string | null;
  /** 功能扩展-6：解析接口列表（按顺序尝试；支持 `{url}` 占位符或已带 `?url=`） */
  resolvers?: string[] | null;
  /** SO-05：单源搜索超时覆盖（秒），来自订阅 ext.timeout */
  timeout?: number;
}

export interface TvboxPlayLine {
  name: string;
  episodes: Array<{ name: string; url: string }>;
}

/**
 * 解析 `vod_play_url`：线路间 `$$$`，集间 `#`，`名称$地址`。
 * - 无 `$` 的段整体视为地址；
 * - 空段跳过；
 * - 地址原样保留（相对地址由适配器补 baseUrl）。
 */
export function parsePlayUrlField(raw: string | null | undefined, lineCount: number): TvboxPlayLine[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return Array.from({ length: Math.max(lineCount, 1) }, () => ({ name: '', episodes: [] }));
  }
  const segments = raw.split('$$$');
  return segments.map((segment) => {
    const episodes: Array<{ name: string; url: string }> = [];
    for (const chunk of segment.split('#')) {
      const trimmed = chunk.trim();
      if (trimmed.length === 0) continue;
      const dollarIndex = trimmed.indexOf('$');
      if (dollarIndex < 0) {
        episodes.push({ name: '', url: trimmed });
      } else {
        const name = trimmed.slice(0, dollarIndex).trim();
        const url = trimmed.slice(dollarIndex + 1).trim();
        if (url.length > 0) episodes.push({ name, url });
      }
    }
    return { name: '', episodes };
  });
}

/** 解析线路名字段：`线路1$$$线路2` */
export function parsePlayFromField(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split('$$$')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * 解析非标准 `vod_play_list`（网盘/盘搜类源）。
 * - 线路名取 `title`/`name`；
 * - 剧集取 `urls[]`，`parse_urls` 非空时把首个前缀拼到原始地址前
 *   （前缀通常已止于 `url=`，token 原样拼接，不做 URL 编码）；
 * - 无剧集的线路丢弃。
 */
export function parsePlayListField(raw: TvboxPlayListEntry[] | null | undefined): TvboxPlayLine[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const lines: TvboxPlayLine[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const prefix =
      (Array.isArray(entry.parse_urls) ? entry.parse_urls : []).find(
        (url): url is string => typeof url === 'string' && url.trim().length > 0,
      ) ?? '';
    const episodes: Array<{ name: string; url: string }> = [];
    for (const episode of Array.isArray(entry.urls) ? entry.urls : []) {
      const url = typeof episode?.url === 'string' ? episode.url.trim() : '';
      if (url.length === 0) continue;
      const name = typeof episode?.name === 'string' ? episode.name.trim() : '';
      episodes.push({ name, url: /^https?:\/\//i.test(url) ? url : `${prefix}${url}` });
    }
    if (episodes.length === 0) continue;
    const title = [entry.title, entry.name].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );
    lines.push({ name: title?.trim() ?? '', episodes });
  }
  return lines;
}

/** 剧集名兜底：`第 N 集` */
export function episodeTitleOf(name: string, index: number): string {
  const trimmed = name.trim();
  if (trimmed.length > 0) return trimmed;
  return `第 ${index + 1} 集`;
}

/** 判断是否为 TVBox 本地代理地址（127.0.0.1:9978/proxy 或 localhost:9978/proxy） */
export function isLocalProxyUrl(url: string): boolean {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/proxy\?/i.test(url);
}

/** 判断地址是否需要解析接口（`?url=` 包装，排除本地代理地址） */
export function looksLikeResolverUrl(url: string): boolean {
  if (isLocalProxyUrl(url)) return false;
  return /[?&]url=/i.test(url);
}

/**
 * 解包 TVBox 本地代理地址，提取内层真实播放地址。
 * 支持两种格式：
 * 1. `proxy://do=m3u8&url=<绝对地址>`
 * 2. `http://127.0.0.1:9978/proxy?do=m3u8&url=<绝对地址>`
 *
 * 返回 null 表示不是本地代理地址或内层地址无效。
 */
export function unwrapTvboxLocalProxy(url: string): string | null {
  const text = url.trim();
  let query: string;

  if (/^proxy:\/\//i.test(text)) {
    query = text.slice('proxy://'.length).replace(/^\/+/, '');
  } else if (isLocalProxyUrl(text)) {
    const idx = text.indexOf('?');
    if (idx < 0) return null;
    query = text.slice(idx + 1);
  } else {
    return null;
  }

  const params = new URLSearchParams(query);
  if (params.get('do') !== 'm3u8') return null;

  const inner = params.get('url') ?? '';
  return /^https?:\/\//i.test(inner) ? inner : null;
}