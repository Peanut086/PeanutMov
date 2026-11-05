/**
 * 豆瓣榜单服务
 *
 * 数据来源：豆瓣公开页面（无需 API Key）。
 * 缓存策略：内存缓存 30 分钟，减少重复请求。
 *
 * 接口：
 * - getMovieTop250(): 豆瓣电影 Top250
 * - getMovieHot(): 正在热映
 * - getTvHot(): 热门电视剧
 * - getMovieComing(): 即将上映
 */
import { logger } from '@/shared/logger';

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟

export interface DoubanItem {
  id: string;
  title: string;
  subtitle?: string;
  year?: string;
  rating?: number;
  ratingCount?: string;
  posterUrl?: string;
  directors?: string[];
  actors?: string[];
  genres?: string[];
  region?: string;
  description?: string;
  url: string;
}

export interface DoubanCategory {
  name: string;
  items: DoubanItem[];
  fetchedAt: number;
}

interface CacheEntry {
  data: DoubanCategory;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function getCached(key: string): DoubanCategory | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: DoubanCategory): void {
  cache.set(key, {
    data,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

/**
 * 通过代理请求豆瓣页面（避免 CORS）
 * 使用本机代理或公共 CORS 代理
 */
async function fetchDoubanPage(url: string): Promise<string | null> {
  try {
    // 尝试直接请求（App 内 WebView 环境通常无 CORS 限制）
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.douban.com/',
      },
    });
    if (!response.ok) {
      logger.warn('豆瓣请求失败', { url, status: response.status });
      return null;
    }
    return await response.text();
  } catch (e) {
    logger.warn('豆瓣请求异常', { url, error: String(e) });
    return null;
  }
}

/**
 * 解析豆瓣 Top250 页面
 */
function parseTop250(html: string): DoubanItem[] {
  const items: DoubanItem[] = [];
  // 匹配每个条目块
  const entryRegex = /<div class="item">[\s\S]*?<img src="([^"]*)"[^>]*>[\s\S]*?<span class="title">([^<]*)<\/span>(?:[\s\S]*?<span class="title">&nbsp;\/&nbsp;([^<]*)<\/span>)?[\s\S]*?<p class="">[\s\S]*?导演: ([^\s]+)[\s\S]*?主演: ([^\s<]+)[\s\S]*?(\d{4})\/([^\/]*)\/([^<]*)[\s\S]*?<span class="rating_num"[^>]*>([^<]*)<\/span>[\s\S]*?<span>(\d+)人评价<\/span>/g;

  let match;
  let index = 0;
  while ((match = entryRegex.exec(html)) !== null) {
    const [, posterUrl, titleCn, titleEn, directors, , year, region, genres, rating, ratingCount] = match;
    items.push({
      id: `top250-${index++}`,
      title: titleCn,
      subtitle: titleEn || undefined,
      year,
      rating: parseFloat(rating) || undefined,
      ratingCount: formatRatingCount(parseInt(ratingCount, 10)),
      posterUrl: posterUrl?.replace('s_ratio_poster', 'l_ratio_poster'),
      directors: [directors],
      genres: genres?.split(/\s*\/\s*/).filter(Boolean),
      region,
      url: `https://movie.douban.com/subject/${match[0].match(/\/subject\/(\d+)/)?.[1] || ''}/`,
    });
  }

  // 备用解析：如果正则没匹配到，尝试更宽松的模式
  if (items.length === 0) {
    const simpleRegex = /<img src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>[\s\S]*?<span class="rating_num"[^>]*>([^<]*)<\/span>/g;
    let simpleMatch;
    index = 0;
    while ((simpleMatch = simpleRegex.exec(html)) !== null) {
      const [, posterUrl, title, rating] = simpleMatch;
      items.push({
        id: `top250-${index++}`,
        title,
        posterUrl: posterUrl?.replace('s_ratio_poster', 'l_ratio_poster'),
        rating: parseFloat(rating) || undefined,
        url: 'https://movie.douban.com/top250',
      });
    }
  }

  return items;
}

/**
 * 解析正在热映/即将上映页面
 */
function parseMovieList(html: string, type: 'hot' | 'coming'): DoubanItem[] {
  const items: DoubanItem[] = [];

  // 热映列表解析
  if (type === 'hot') {
    const regex = /<li[^>]*class="list-item"[^>]*>[\s\S]*?<img src="([^"]*)"[^>]*>[^>]*title="([^"]*)"[^>]*>[\s\S]*?rating_num">([\d.]+)<[\s\S]*?<a href="([^"]*)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const [, posterUrl, title, rating, url] = match;
      items.push({
        id: extractDoubanId(url) || `hot-${items.length}`,
        title,
        posterUrl,
        rating: parseFloat(rating) || undefined,
        url: url.startsWith('http') ? url : `https://movie.douban.com${url}`,
      });
    }
  }

  // 即将上映解析
  if (type === 'coming') {
    const regex = /<div[^>]*class="item"[^>]*>[\s\S]*?<img src="([^"]*)"[^>]*>[^>]*title="([^"]*)"[^>]*>[\s\S]*?<a href="([^"]*)"/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const [, posterUrl, title, url] = match;
      items.push({
        id: extractDoubanId(url) || `coming-${items.length}`,
        title,
        posterUrl,
        url: url.startsWith('http') ? url : `https://movie.douban.com${url}`,
      });
    }
  }

  return items;
}

/**
 * 解析热门电视剧
 */
function parseTvList(html: string): DoubanItem[] {
  const items: DoubanItem[] = [];
  const regex = /<a[^>]*href="([^"]*)"[^>]*class="item"[^>]*>[\s\S]*?<img[^>]*src="([^"]*)"[^>]*>[^>]*title="([^"]*)"[^>]*>[\s\S]*?rating_num">([\d.]+)</g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const [, url, posterUrl, title, rating] = match;
    items.push({
      id: extractDoubanId(url) || `tv-${items.length}`,
      title,
      posterUrl,
      rating: parseFloat(rating) || undefined,
      url: url.startsWith('http') ? url : `https://movie.douban.com${url}`,
    });
  }
  return items;
}

function extractDoubanId(url: string): string | null {
  const match = url.match(/\/subject\/(\d+)/);
  return match ? match[1] : null;
}

function formatRatingCount(count: number): string {
  if (count >= 10000) {
    return `${(count / 10000).toFixed(1)}万`;
  }
  return String(count);
}

/**
 * 获取豆瓣电影 Top250
 */
export async function getMovieTop250(start = 0): Promise<DoubanCategory> {
  const cacheKey = `top250-${start}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = `https://movie.douban.com/top250?start=${start}&filter=`;
  const html = await fetchDoubanPage(url);

  const items = html ? parseTop250(html) : [];

  const result: DoubanCategory = {
    name: '豆瓣 Top250',
    items: items.slice(0, 25),
    fetchedAt: Date.now(),
  };

  setCache(cacheKey, result);
  return result;
}

/**
 * 获取正在热映
 */
export async function getMovieHot(): Promise<DoubanCategory> {
  const cacheKey = 'hot';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = 'https://movie.douban.com/cinema/nowplaying/';
  const html = await fetchDoubanPage(url);

  const items = html ? parseMovieList(html, 'hot') : [];

  const result: DoubanCategory = {
    name: '正在热映',
    items: items.slice(0, 18),
    fetchedAt: Date.now(),
  };

  setCache(cacheKey, result);
  return result;
}

/**
 * 获取即将上映
 */
export async function getMovieComing(): Promise<DoubanCategory> {
  const cacheKey = 'coming';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = 'https://movie.douban.com/coming';
  const html = await fetchDoubanPage(url);

  const items = html ? parseMovieList(html, 'coming') : [];

  const result: DoubanCategory = {
    name: '即将上映',
    items: items.slice(0, 18),
    fetchedAt: Date.now(),
  };

  setCache(cacheKey, result);
  return result;
}

/**
 * 获取热门电视剧
 */
export async function getTvHot(): Promise<DoubanCategory> {
  const cacheKey = 'tv-hot';
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const url = 'https://movie.douban.com/tv/';
  const html = await fetchDoubanPage(url);

  const items = html ? parseTvList(html) : [];

  const result: DoubanCategory = {
    name: '热门电视剧',
    items: items.slice(0, 18),
    fetchedAt: Date.now(),
  };

  setCache(cacheKey, result);
  return result;
}

/**
 * 获取所有榜单（并行请求）
 */
export async function getAllCategories(): Promise<DoubanCategory[]> {
  const results = await Promise.allSettled([
    getMovieHot(),
    getMovieTop250(),
    getTvHot(),
    getMovieComing(),
  ]);

  return results
    .filter((r): r is PromiseFulfilledResult<DoubanCategory> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((c) => c.items.length > 0);
}

/**
 * 搜索豆瓣（根据标题）
 */
export async function searchDouban(query: string): Promise<DoubanItem[]> {
  if (!query.trim()) return [];

  const url = `https://www.douban.com/search?q=${encodeURIComponent(query)}&cat=1002`;
  const html = await fetchDoubanPage(url);

  if (!html) return [];

  const items: DoubanItem[] = [];
  const regex = /<a[^>]*href="([^"]*movie\.douban\.com\/subject\/\d+[^"]*)"[^>]*>[\s\S]*?<img[^>]*src="([^"]*)"[^>]*>[\s\S]*?class="title">([^<]+)<[\s\S]*?(?:class="rating_nums">([\d.]+)<)?/g;

  let match;
  while ((match = regex.exec(html)) !== null && items.length < 20) {
    const [, url, posterUrl, title, rating] = match;
    items.push({
      id: extractDoubanId(url) || `search-${items.length}`,
      title: title.trim(),
      posterUrl,
      rating: rating ? parseFloat(rating) : undefined,
      url,
    });
  }

  return items;
}

/**
 * 清除缓存
 */
export function clearDoubanCache(): void {
  cache.clear();
}
