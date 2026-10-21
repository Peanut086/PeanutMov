/**
 * AList 适配器（API-01）
 *
 * 流程（技术方案 6 章）：
 * 1. `POST /api/auth/login` 取 token（`ext.token` / `auth.token` 优先，其次用户名密码登录）；
 * 2. 根目录（`ext.root` / `pathPrefix` / `/`）下的子目录 → 分类；
 * 3. `POST /api/fs/list` 浏览目录（视频文件即条目，同名图片作为海报）；
 * 4. `POST /api/fs/get` 取直链（`raw_url` / `url`）。
 *
 * 映射约定：
 * - `sourceItemId` = 条目在 AList 中的路径（目录或单个视频文件）；
 * - 目录条目 → 每集一个视频文件（自然序）；单文件条目 → 1 集；
 * - 线路固定 1 条（AList 无多线路概念）。
 */
import { AppError } from '@/shared/errors';
import { episodeIdOf, lineIdOf, mediaIdOf } from '@/shared/id';
import { joinUrl, toAbsoluteUrl } from '@/shared/url';
import { httpClient } from '@/sources/base/httpClient';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import {
  categoryIdFor,
  fallbackPoster,
  inferMediaType,
  normalizeFormat,
  normalizeTitle,
  parseCategoryValue,
  stripHtml,
} from '@/sources/base/normalize';
import {
  ALIST_OK,
  type AlistExt,
  type AlistGetData,
  type AlistListData,
  type AlistLoginData,
  type AlistResponse,
} from '@/sources/alist/types';
import type {
  BrowseParams,
  Category,
  Episode,
  GetDetailParams,
  MediaDetail,
  MediaItem,
  PageResult,
  PlaybackSource,
  PlayLine,
  ResolvePlayParams,
  SearchParams,
  Source,
  SourceType,
  SubtitleTrack,
} from '@/types';

const VIDEO_EXT = /\.(mp4|m4v|webm|ts|mov|mkv|avi|flv|m3u8|wmv)$/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|avif|bmp)$/i;
const SUBTITLE_EXT = /\.(vtt|srt)$/i;

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
/** token 缓存：sourceId → { token, expiresAt } */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

interface AlistEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: string;
  posterUrl: string | null;
}

function extOf(source: Source): AlistExt {
  return (source.ext ?? {}) as AlistExt;
}

function authTokenFromSource(source: Source): string | null {
  const fromAuth = source.auth.token;
  if (fromAuth && fromAuth.trim().length > 0) return fromAuth.trim();
  const extToken = extOf(source).token;
  return extToken && extToken.trim().length > 0 ? extToken.trim() : null;
}

function rootPathOf(source: Source): string {
  const raw = extOf(source).root ?? source.pathPrefix ?? '/';
  const normalized = `/${raw}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

function joinPath(base: string, name: string): string {
  if (name.startsWith('/')) return name.replace(/\/{2,}/g, '/');
  return `${base === '/' ? '' : base}/${name}`.replace(/\/{2,}/g, '/');
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 自然序（第 1 集 < 第 2 集 < 第 10 集） */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function apiUrl(source: Source, path: string): string {
  return joinUrl(source.baseUrl, path);
}

export class AlistAdapter extends BaseAdapter {
  readonly type: SourceType = 'alist';

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    const entries = await this.listDir(source, rootPathOf(source));
    return { itemCount: entries.length };
  }

  async listCategories(source: Source, signal?: AbortSignal): Promise<Category[]> {
    this.assertEnabled(source);
    const root = rootPathOf(source);
    const entries = await this.listDir(source, root, signal);
    const dirs = entries.filter((entry) => entry.isDir).sort((a, b) => naturalCompare(a.name, b.name));
    if (dirs.length === 0) {
      return [
        { id: categoryIdFor(source.id, root), sourceId: source.id, name: '全部', value: root, order: 0 },
      ];
    }
    return dirs.map((dir, index) => ({
      id: categoryIdFor(source.id, dir.path),
      sourceId: source.id,
      name: dir.name,
      value: dir.path,
      order: index,
    }));
  }

  async browse(params: BrowseParams): Promise<PageResult<MediaItem>> {
    const { source, categoryId, page, pageSize, filters } = params;
    this.assertEnabled(source);
    const dirPath = parseCategoryValue(source.id, categoryId) ?? rootPathOf(source);
    const entries = await this.listDir(source, dirPath, params.signal);

    const mediaEntries = entries
      .filter((entry) => entry.isDir || VIDEO_EXT.test(entry.name))
      .filter((entry) => filters.type === null || inferMediaType(null, entry.name) === filters.type)
      .sort((a, b) => naturalCompare(a.name, b.name));

    const start = (page - 1) * pageSize;
    const slice = mediaEntries.slice(start, start + pageSize);
    return {
      items: slice.map((entry) => this.entryToItem(source, entry)),
      page,
      pageSize,
      total: mediaEntries.length,
      hasMore: start + pageSize < mediaEntries.length,
    };
  }

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { source, keyword } = params;
    this.assertEnabled(source);
    const kw = keyword.trim().toLowerCase();
    if (kw.length === 0) return [];
    const flattened = await this.flatten(source, rootPathOf(source), params.signal, 3);
    return flattened
      .filter((entry) => entry.name.toLowerCase().includes(kw))
      .slice(0, params.pageSize)
      .map((entry) => this.entryToItem(source, entry));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    const resolved = await this.resolvePathEntries(source, sourceItemId, params.signal);
    const { title, videos, posterUrl } = resolved;

    const now = Date.now();
    const item = this.makeItem(source, {
      sourceItemId,
      title,
      type: inferMediaType(null, sourceItemId),
      description: null,
      posterUrl: posterUrl ?? fallbackPoster(title),
      episodeCount: videos.length,
      now,
    });

    const lineId = lineIdOf(item.id, 0);
    const line: PlayLine = {
      id: lineId,
      mediaId: item.id,
      sourceId: source.id,
      name: 'AList 直链',
      quality: null,
      format: normalizeFormat(videos[0]?.name ?? '', 'mp4'),
      index: 0,
    };
    const episodes: Episode[] = videos.map((entry, index) => ({
      id: episodeIdOf(item.id, lineId, index + 1),
      mediaId: item.id,
      sourceId: source.id,
      lineId,
      number: index + 1,
      title: baseName(entry.name),
      durationSec: null,
      subtitles: [],
      updatedAt: now,
    }));

    return { item, lines: [line], episodes };
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId } = params;
    this.assertEnabled(source);
    const { videos, subtitles } = await this.resolvePathEntries(source, sourceItemId, params.signal);
    const mediaId = mediaIdOf(source.id, sourceItemId);
    const index = videos.findIndex((_, i) => episodeIdOf(mediaId, lineId, i + 1) === episodeId);
    const picked = videos[index >= 0 ? index : 0];
    if (!picked) throw new AppError('E_NO_PLAY_URL');

    const url = await this.getDownloadUrl(source, picked.path, params.signal);

    const sameNameSubtitles = subtitles
      .filter((entry) => baseName(entry.name) === baseName(picked.name))
      .slice(0, 2);
    const tracks: SubtitleTrack[] = [];
    for (const [i, entry] of sameNameSubtitles.entries()) {
      try {
        const subtitleUrl = await this.getDownloadUrl(source, entry.path, params.signal);
        tracks.push({
          id: `remote:${i}`,
          label: entry.name,
          lang: /chs|zh|中/i.test(entry.name) ? 'zh' : 'und',
          url: subtitleUrl,
          format: entry.name.toLowerCase().endsWith('.srt') ? 'srt' : 'vtt',
          source: 'remote',
        });
      } catch {
        // 字幕失败不阻断播放（FR-19）
      }
    }

    return {
      url,
      format: normalizeFormat(picked.name, 'mp4'),
      headers: {},
      subtitles: tracks,
      lineId,
      quality: null,
      expiresAt: null,
      isLocal: false,
    };
  }

  /* ---------------- 内部 ---------------- */

  /**
   * 把 sourceItemId 解析为条目 + 剧集文件列表：
   * - 视频文件 → 单集；
   * - 目录 → 目录内视频文件（自然序）；
   * - 目录内只有一个子目录且无视频 → 递归一层（兼容"剧名/季/集"结构）。
   */
  private async resolvePathEntries(
    source: Source,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ title: string; videos: AlistEntry[]; subtitles: AlistEntry[]; posterUrl: string | null }> {
    const segment = lastSegment(path);
    if (VIDEO_EXT.test(segment)) {
      return {
        title: baseName(segment),
        videos: [{ name: segment, path, isDir: false, size: 0, modified: '', posterUrl: null }],
        subtitles: [],
        posterUrl: null,
      };
    }

    const entries = await this.listDir(source, path, signal);
    const videos = entries
      .filter((entry) => !entry.isDir && VIDEO_EXT.test(entry.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
    const subtitles = entries.filter((entry) => !entry.isDir && SUBTITLE_EXT.test(entry.name));
    const poster = this.pickPoster(entries, segment);

    if (videos.length > 0) {
      return { title: normalizeTitle(segment), videos, subtitles, posterUrl: poster };
    }

    const subDirs = entries.filter((entry) => entry.isDir);
    if (subDirs.length === 1 && subDirs[0]) {
      return this.resolvePathEntries(source, subDirs[0].path, signal);
    }

    throw new AppError('E_NOT_FOUND', '该位置没有可播放的视频文件');
  }

  private pickPoster(entries: AlistEntry[], baseTitle: string): string | null {
    const images = entries.filter((entry) => !entry.isDir && IMAGE_EXT.test(entry.name));
    const exact = images.find((entry) => baseName(entry.name).toLowerCase() === baseTitle.toLowerCase());
    const picked = exact ?? images.find((entry) => /poster|cover|folder|fanart/i.test(entry.name)) ?? images[0];
    return picked?.posterUrl ?? null;
  }

  /** 递归展开目录（限制深度，单目录失败不影响整体） */
  private async flatten(
    source: Source,
    path: string,
    signal: AbortSignal | undefined,
    depthLeft: number,
  ): Promise<AlistEntry[]> {
    const entries = await this.listDir(source, path, signal);
    const out: AlistEntry[] = entries.filter((entry) => !entry.isDir || VIDEO_EXT.test(entry.name));
    if (depthLeft <= 0) return out;
    for (const dir of entries.filter((entry) => entry.isDir)) {
      try {
        out.push(...(await this.flatten(source, dir.path, signal, depthLeft - 1)));
      } catch {
        // 忽略单个子目录失败
      }
    }
    return out;
  }

  private entryToItem(source: Source, entry: AlistEntry): MediaItem {
    const title = entry.isDir ? entry.name : baseName(entry.name);
    return this.makeItem(source, {
      sourceItemId: entry.path,
      title,
      type: inferMediaType(null, entry.name),
      posterUrl: entry.posterUrl ?? fallbackPoster(title),
      episodeCount: entry.isDir ? null : 1,
      now: Date.now(),
    });
  }

  private async tokenOf(source: Source, signal?: AbortSignal): Promise<string | null> {
    const direct = authTokenFromSource(source);
    if (direct) return direct;

    const cached = tokenCache.get(source.id);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const username = source.auth.username ?? extOf(source).username ?? null;
    const password = source.auth.password ?? extOf(source).password ?? null;
    if (!username || !password) return null;

    const response = await httpClient.request<AlistResponse<AlistLoginData>>(apiUrl(source, '/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headersWith(source) },
      body: JSON.stringify({ username, password }),
      signal,
      retries: 0,
    });
    if (response.code !== ALIST_OK || !response.data?.token) {
      throw new AppError('E_AUTH', undefined, { detail: response.message });
    }
    tokenCache.set(source.id, { token: response.data.token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return response.data.token;
  }

  private async authHeaders(source: Source, signal?: AbortSignal): Promise<Record<string, string>> {
    const token = await this.tokenOf(source, signal);
    return token ? { Authorization: token } : {};
  }

  private async listDir(source: Source, path: string, signal?: AbortSignal): Promise<AlistEntry[]> {
    const authHeaders = await this.authHeaders(source, signal);
    const response = await httpClient.request<AlistResponse<AlistListData>>(apiUrl(source, '/api/fs/list'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headersWith(source, authHeaders) },
      body: JSON.stringify({ path, password: '', page: 1, per_page: 500, refresh: false }),
      signal,
    });
    if (response.code !== ALIST_OK) {
      throw this.errorFromAlist(source, response.code, response.message);
    }
    const content = response.data?.content ?? [];
    const images = content.filter((item) => !item.is_dir && IMAGE_EXT.test(item.name));

    return content.map((item) => {
      const itemPath = joinPath(path, item.name);
      const poster =
        item.thumb && item.thumb.length > 0
          ? toAbsoluteUrl(joinUrl(source.baseUrl, '/'), item.thumb)
          : this.thumbnailOf(images, item);
      return {
        name: item.name,
        path: itemPath,
        isDir: item.is_dir,
        size: item.size,
        modified: item.modified,
        posterUrl: poster,
      };
    });
  }

  /** 目录条目找同名图片；视频文件找同名图片 */
  private thumbnailOf(
    images: Array<{ name: string; thumb: string; is_dir: boolean }>,
    item: { name: string; is_dir: boolean },
  ): string | null {
    const target = item.is_dir ? item.name : baseName(item.name);
    const match = images.find((image) => baseName(image.name).toLowerCase() === target.toLowerCase());
    return match && match.thumb.length > 0 ? match.thumb : null;
  }

  private async getDownloadUrl(source: Source, filePath: string, signal?: AbortSignal): Promise<string> {
    const authHeaders = await this.authHeaders(source, signal);
    const response = await httpClient.request<AlistResponse<AlistGetData>>(apiUrl(source, '/api/fs/get'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headersWith(source, authHeaders) },
      body: JSON.stringify({ path: filePath, password: '' }),
      signal,
    });
    if (response.code !== ALIST_OK) {
      throw this.errorFromAlist(source, response.code, response.message);
    }
    const raw = response.data?.raw_url || response.data?.url || '';
    if (!raw) throw new AppError('E_NO_PLAY_URL');
    return toAbsoluteUrl(source.baseUrl, raw) ?? raw;
  }

  private errorFromAlist(source: Source, code: number, message: string): AppError {
    const lowered = `${message}`.toLowerCase();
    // AC-39 / REV-16：401（凭据失效）→ E_AUTH；403（无权限）→ E_HTTP_403，二者不合并。
    if (code === 401) return new AppError('E_AUTH', undefined, { detail: message });
    if (code === 403) return new AppError('E_HTTP_403', undefined, { detail: message });
    if (/password|token|auth|unauthor/i.test(lowered)) {
      return new AppError('E_AUTH', undefined, { detail: message });
    }
    if (code === 404 || /not\s*found|不存在/i.test(lowered)) {
      return new AppError('E_NOT_FOUND', undefined, { detail: message });
    }
    if (/network|timeout|dial|connection/i.test(lowered)) {
      return new AppError('E_NETWORK', undefined, { detail: message });
    }
    return new AppError('E_SOURCE_UNAVAILABLE', undefined, {
      detail: `${source.name}: ${message || String(code)}`,
    });
  }
}

/** 测试辅助：清空 token 缓存 */
export function resetAlistTokenCache(): void {
  tokenCache.clear();
}

/** 未使用的占位导入抑制（stripHtml 保留给后续描述解析） */
export const __alistStripHtml = stripHtml;
