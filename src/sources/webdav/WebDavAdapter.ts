/**
 * WebDAV 适配器（API-01）
 *
 * 实现：
 * - 目录浏览走 `PROPFIND Depth:1`（XML 见 `xmlParser.ts`）；
 * - 视频文件 → 条目；目录 → 条目（目录内的视频作为剧集）；
 * - 播放地址为该文件的 WebDAV 直链（Basic Auth 头随 PlaybackSource 返回，由播放器注入）；
 * - 分类为根目录（`ext.root` / `pathPrefix` / `/`）下的子目录。
 */
import { AppError } from '@/shared/errors';
import { episodeIdOf, lineIdOf, mediaIdOf } from '@/shared/id';
import { isValidHttpUrl, joinUrl, normalizeBaseUrl } from '@/shared/url';
import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import { basicAuthHeader, httpClient } from '@/sources/base/httpClient';
import {
  categoryIdFor,
  fallbackPoster,
  inferMediaType,
  normalizeFormat,
  normalizeTitle,
  parseCategoryValue,
} from '@/sources/base/normalize';
import { isSelfEntry, parseWebDavXml, type WebDavResource } from '@/sources/webdav/xmlParser';
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

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:getetag/>
  </d:prop>
</d:propfind>`;

interface WebDavExt {
  root?: string | null;
  username?: string | null;
  password?: string | null;
}

function extOf(source: Source): WebDavExt {
  return (source.ext ?? {}) as WebDavExt;
}

function rootPathOf(source: Source): string {
  const raw = extOf(source).root ?? source.pathPrefix ?? '/';
  const normalized = `/${raw}`.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

export class WebDavAdapter extends BaseAdapter {
  readonly type: SourceType = 'webdav';

  protected async probe(source: Source): Promise<ProbeResult> {
    this.assertEnabled(source);
    const resources = await this.propfind(source, rootPathOf(source), 1);
    return { itemCount: resources.length };
  }

  async listCategories(source: Source, signal?: AbortSignal): Promise<Category[]> {
    this.assertEnabled(source);
    const root = rootPathOf(source);
    const resources = await this.propfind(source, root, 1, signal);
    const dirs = resources
      .filter((resource) => resource.isDir && !isSelfEntry(resource, root))
      .sort((a, b) => naturalCompare(a.name, b.name));
    if (dirs.length === 0) {
      return [{ id: categoryIdFor(source.id, root), sourceId: source.id, name: '全部', value: root, order: 0 }];
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
    const resources = await this.propfind(source, dirPath, 1, params.signal);

    const entries = resources
      .filter((resource) => !isSelfEntry(resource, dirPath))
      .filter((resource) => resource.isDir || VIDEO_EXT.test(resource.name))
      .filter((resource) => filters.type === null || inferMediaType(null, resource.name) === filters.type)
      .sort((a, b) => naturalCompare(a.name, b.name));

    const start = (page - 1) * pageSize;
    const slice = entries.slice(start, start + pageSize);
    return {
      items: slice.map((entry) => this.entryToItem(source, entry)),
      page,
      pageSize,
      total: entries.length,
      hasMore: start + pageSize < entries.length,
    };
  }

  async search(params: SearchParams): Promise<MediaItem[]> {
    const { source, keyword } = params;
    this.assertEnabled(source);
    const kw = keyword.trim().toLowerCase();
    if (kw.length === 0) return [];
    const all = await this.walk(source, rootPathOf(source), params.signal, 3);
    return all
      .filter((resource) => resource.name.toLowerCase().includes(kw))
      .slice(0, params.pageSize)
      .map((resource) => this.entryToItem(source, resource));
  }

  async getDetail(params: GetDetailParams): Promise<MediaDetail> {
    const { source, sourceItemId } = params;
    this.assertEnabled(source);
    const isFile = VIDEO_EXT.test(sourceItemId);
    const title = normalizeTitle(baseName(sourceItemId.slice(sourceItemId.lastIndexOf('/') + 1)));

    let videos: WebDavResource[];
    let posterUrl: string | null = null;
    if (isFile) {
      videos = [
        {
          href: sourceItemId,
          path: sourceItemId,
          name: title,
          isDir: false,
          size: 0,
          lastModified: null,
          contentType: null,
          etag: null,
        },
      ];
    } else {
      const resources = await this.propfind(source, sourceItemId, 1, params.signal);
      videos = resources
        .filter((resource) => !resource.isDir && VIDEO_EXT.test(resource.name))
        .sort((a, b) => naturalCompare(a.name, b.name));
      const images = resources.filter((resource) => !resource.isDir && IMAGE_EXT.test(resource.name));
      const picked =
        images.find((image) => baseName(image.name).toLowerCase() === title.toLowerCase()) ?? images[0];
      posterUrl = picked ? this.fileUrl(source, picked.path) : null;
    }

    if (videos.length === 0) {
      throw new AppError('E_NOT_FOUND', '该目录下没有可播放的视频文件');
    }

    const now = Date.now();
    const item = this.makeItem(source, {
      sourceItemId,
      title: isFile ? title : normalizeTitle(sourceItemId.slice(sourceItemId.lastIndexOf('/') + 1)),
      type: inferMediaType(null, sourceItemId),
      posterUrl: posterUrl ?? fallbackPoster(title),
      episodeCount: videos.length,
      now,
    });

    const lineId = lineIdOf(item.id, 0);
    const line: PlayLine = {
      id: lineId,
      mediaId: item.id,
      sourceId: source.id,
      name: 'WebDAV',
      quality: null,
      format: normalizeFormat(videos[0]?.name ?? '', 'mp4'),
      index: 0,
    };
    const episodes: Episode[] = videos.map((resource, index) => ({
      id: episodeIdOf(item.id, lineId, index + 1),
      mediaId: item.id,
      sourceId: source.id,
      lineId,
      number: index + 1,
      title: baseName(resource.name),
      durationSec: null,
      subtitles: [],
      updatedAt: now,
    }));

    return { item, lines: [line], episodes };
  }

  async resolvePlayUrl(params: ResolvePlayParams): Promise<PlaybackSource> {
    const { source, sourceItemId, lineId, episodeId } = params;
    this.assertEnabled(source);

    let videos: WebDavResource[];
    let subtitles: WebDavResource[] = [];
    if (VIDEO_EXT.test(sourceItemId)) {
      videos = [
        {
          href: sourceItemId,
          path: sourceItemId,
          name: sourceItemId,
          isDir: false,
          size: 0,
          lastModified: null,
          contentType: null,
          etag: null,
        },
      ];
    } else {
      const resources = await this.propfind(source, sourceItemId, 1, params.signal);
      videos = resources
        .filter((resource) => !resource.isDir && VIDEO_EXT.test(resource.name))
        .sort((a, b) => naturalCompare(a.name, b.name));
      subtitles = resources.filter((resource) => !resource.isDir && SUBTITLE_EXT.test(resource.name));
    }

    const mediaId = mediaIdOf(source.id, sourceItemId);
    const index = videos.findIndex((_, i) => episodeIdOf(mediaId, lineId, i + 1) === episodeId);
    const picked = videos[index >= 0 ? index : 0];
    if (!picked) throw new AppError('E_NO_PLAY_URL');

    const tracks: SubtitleTrack[] = subtitles
      .filter((resource) => baseName(resource.name) === baseName(picked.name))
      .slice(0, 2)
      .map((resource, i) => ({
        id: `remote:${i}`,
        label: resource.name,
        lang: /chs|zh|中/i.test(resource.name) ? 'zh' : 'und',
        url: this.fileUrl(source, resource.path),
        format: resource.name.toLowerCase().endsWith('.srt') ? 'srt' : 'vtt',
        source: 'remote',
      }));

    return {
      url: this.fileUrl(source, picked.path),
      format: normalizeFormat(picked.name, 'mp4'),
      headers: this.playbackHeaders(source),
      subtitles: tracks,
      lineId,
      quality: null,
      expiresAt: null,
      isLocal: false,
    };
  }

  /* ---------------- 内部 ---------------- */

  private playbackHeaders(source: Source): Record<string, string> {
    const username = source.auth.username ?? extOf(source).username ?? null;
    const password = source.auth.password ?? extOf(source).password ?? null;
    const headers = this.headersWith(source);
    if (source.auth.mode === 'token' && source.auth.token) {
      headers.Authorization = source.auth.token;
    } else if (username !== null && password !== null) {
      headers.Authorization = basicAuthHeader(username, password);
    }
    return headers;
  }

  /** WebDAV 文件直链：baseUrl + （已编码的）path */
  private fileUrl(source: Source, path: string): string {
    const encoded = path
      .split('/')
      .map((segment) => (segment.length === 0 ? '' : encodeURIComponent(segment)))
      .join('/');
    return joinUrl(source.baseUrl, encoded);
  }

  private async propfind(
    source: Source,
    path: string,
    depth: 0 | 1,
    signal?: AbortSignal,
  ): Promise<WebDavResource[]> {
    if (!isValidHttpUrl(source.baseUrl)) {
      throw new AppError('E_INVALID_INPUT', 'WebDAV 地址不合法');
    }
    const url = joinUrl(source.baseUrl, path === '/' ? '/' : `${path}/`);
    const xml = await httpClient.request<string>(url, {
      method: 'PROPFIND',
      headers: this.headersWith(source, {
        ...this.playbackHeaders(source),
        Depth: String(depth),
        'Content-Type': 'application/xml; charset=utf-8',
      }),
      body: PROPFIND_BODY,
      responseType: 'text',
      signal,
    });
    return parseWebDavXml(xml);
  }

  private async walk(
    source: Source,
    path: string,
    signal: AbortSignal | undefined,
    depthLeft: number,
  ): Promise<WebDavResource[]> {
    const resources = await this.propfind(source, path, 1, signal);
    const out = resources.filter((resource) => !isSelfEntry(resource, path));
    if (depthLeft <= 0) return out;
    for (const dir of out.filter((resource) => resource.isDir)) {
      try {
        const children = await this.walk(source, dir.path, signal, depthLeft - 1);
        out.push(...children.filter((child) => !child.isDir || VIDEO_EXT.test(child.name)));
      } catch {
        // 单个目录失败不影响整体搜索
      }
    }
    return out;
  }

  private entryToItem(source: Source, entry: WebDavResource): MediaItem {
    const title = entry.isDir ? entry.name : baseName(entry.name);
    return this.makeItem(source, {
      sourceItemId: entry.path,
      title,
      type: inferMediaType(entry.contentType, entry.name),
      posterUrl: fallbackPoster(title),
      episodeCount: entry.isDir ? null : 1,
      now: Date.now(),
    });
  }
}

/** 归一化 WebDAV 根地址（暴露给 SourceService 校验用） */
export function normalizeWebDavBaseUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl);
}


