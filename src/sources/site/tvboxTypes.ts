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

/** 剧集名兜底：`第 N 集` */
export function episodeTitleOf(name: string, index: number): string {
  const trimmed = name.trim();
  if (trimmed.length > 0) return trimmed;
  return `第 ${index + 1} 集`;
}

/** 判断地址是否需要解析接口（`?url=` 包装：首版不支持递归解析，技术方案 7.6） */
export function looksLikeResolverUrl(url: string): boolean {
  return /[?&]url=/i.test(url);
}