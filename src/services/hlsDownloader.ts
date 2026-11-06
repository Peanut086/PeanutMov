/**
 * HLS 分片下载与合并（Phase 2：完整支持）
 *
 * 特性：
 * - Master playlist 解析（#EXT-X-STREAM-INF）：自动选择最高码率
 * - AES-128 解密（#EXT-X-KEY）：下载密钥，解密分片
 * - fMP4 支持（#EXT-X-MAP）：处理初始化分片
 * - 并行分片下载：多连接并发提升速度
 * - 顺序合并到 sink（NativeFsSink 或 IdbBlobSink）
 * - 支持取消（通过 AbortSignal）
 */
import { AppError, toAppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import { LocalProxy } from '@/native/localProxy';
import { findProtectedKeyEvidence } from '@/player/sourceGuard';
import { createSink, type DownloadSink } from '@/services/downloadSink';
import type { DownloadTask } from '@/types';

export interface HlsDownloaderDeps {
  load: (id: string) => Promise<DownloadTask | null>;
  saveProgress: (id: string, patch: Partial<DownloadTask>) => Promise<void>;
  fetchImpl?: typeof fetch;
  createSinkImpl?: (kind: DownloadTask['sink']) => DownloadSink;
  now?: () => number;
  /** 并行分片数（默认 6） */
  parallelSegments?: number;
  /** P1-6: 下载质量选择（max=最高, 1080p=1080p封顶, 720p=720p封顶, auto=按网络） */
  quality?: 'max' | '1080p' | '720p' | 'auto';
}

/** HLS 变体流（master playlist 中的选项） */
interface HlsVariant {
  url: string;
  bandwidth: number;
  resolution?: { width: number; height: number };
  codecs?: string;
}

/** AES-128 密钥信息 */
interface HlsKey {
  method: string;
  uri: string;
  iv?: string;
}

/** fMP4 初始化分片 */
interface HlsInitSegment {
  url: string;
  data?: Uint8Array;
}

/** 媒体分片 */
interface HlsSegment {
  url: string;
  duration: number;
  key?: HlsKey;
  byteRange?: { offset: number; length: number };
}

/** 解析后的播放列表 */
interface HlsPlaylist {
  isMaster: boolean;
  variants?: HlsVariant[];
  targetDuration?: number;
  mediaSequence?: number;
  segments: HlsSegment[];
  initSegment?: HlsInitSegment;
  endList?: boolean;
}

/**
 * 清单文档：正文 + 解析基线（FIX-04）
 *
 * 清单里的相对引用必须按「302 跟随后的落地地址」解析，因此拉取清单时把基线一并带出，
 * 而不是在解析处一律使用任务里的原始请求地址。
 */
interface ManifestDocument {
  text: string;
  /** 解析相对引用应使用的基线地址（302 落地地址；取不到时为请求地址） */
  baseUrl: string;
}

/** 并行下载控制 */
const DEFAULT_PARALLEL_SEGMENTS = 6;
const MAX_SEGMENT_RETRIES = 2;
const RETRY_BACKOFF_MS = [500, 1500];

/**
 * 解析 m3u8 清单
 *
 * 验证：有效的 m3u8 必须以 `#EXTM3U` 开头（HLS 规范）。
 * 如果返回 HTML 或纯文本，抛 E_PARSE 避免把错误页面当分片列表。
 */
function parseM3u8(manifest: string, baseUrl: string): HlsPlaylist {
  const trimmed = manifest.trim();
  if (!trimmed.startsWith('#EXTM3U')) {
    const preview = trimmed.substring(0, 100);
    throw new AppError('E_PARSE', `无效的 m3u8 清单（缺少 #EXTM3U 头）：${preview}...`);
  }

  const lines = trimmed.split('\n').map((l) => l.trim());

  // 检查是否为 master playlist
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:'));

  if (isMaster) {
    return parseMasterPlaylist(lines, baseUrl);
  }
  return parseMediaPlaylist(lines, baseUrl);
}

/**
 * 解析 master playlist（多清晰度选择）
 */
function parseMasterPlaylist(lines: string[], baseUrl: string): HlsPlaylist {
  const variants: HlsVariant[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      // 解析属性
      const attrs = parseAttributes(line.substring('#EXT-X-STREAM-INF:'.length));
      const bandwidth = parseInt(attrs['BANDWIDTH'] || '0', 10);
      const resolution = attrs['RESOLUTION']?.split('x');
      const codecs = attrs['CODECS'];

      // 下一行是 URL
      const url = lines[i + 1];
      if (url && !url.startsWith('#')) {
        variants.push({
          url: resolveUrl(url, baseUrl),
          bandwidth,
          resolution: resolution ? { width: parseInt(resolution[0]), height: parseInt(resolution[1]) } : undefined,
          codecs,
        });
      }
    }
  }

  if (variants.length === 0) {
    throw new AppError('E_PARSE', 'master playlist 中未找到任何变体流');
  }

  // 按码率降序排序
  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  return {
    isMaster: true,
    variants,
    segments: [],
  };
}

/**
 * 解析 media playlist（分片列表）
 */
function parseMediaPlaylist(lines: string[], baseUrl: string): HlsPlaylist {
  const segments: HlsSegment[] = [];
  let currentDuration = 0;
  let currentKey: HlsKey | undefined;
  let targetDuration: number | undefined;
  let mediaSequence = 0;
  let initSegment: HlsInitSegment | undefined;
  let endList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.substring('#EXT-X-TARGETDURATION:'.length), 10);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.substring('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-KEY:'.length));
      if (attrs['METHOD'] && attrs['METHOD'] !== 'NONE') {
        currentKey = {
          method: attrs['METHOD'],
          uri: resolveUrl(attrs['URI'] || '', baseUrl),
          iv: attrs['IV'],
        };
      } else {
        currentKey = undefined;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MAP:'.length));
      if (attrs['URI']) {
        initSegment = { url: resolveUrl(attrs['URI'], baseUrl) };
      }
    } else if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      if (match) {
        currentDuration = parseFloat(match[1]);
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      // 字节范围（下一行的 URL 使用）
      const match = line.match(/#EXT-X-BYTERANGE:(\d+)@?(\d*)/);
      if (match) {
        const length = parseInt(match[1], 10);
        const offset = match[2] ? parseInt(match[2], 10) : 0;
        // 存储到临时变量，等下一行 URL 时使用
        (parseMediaPlaylist as any)._pendingByteRange = { offset, length };
      }
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line && !line.startsWith('#')) {
      // 分片 URL
      const url = resolveUrl(line, baseUrl);
      const byteRange = (parseMediaPlaylist as any)._pendingByteRange;
      delete (parseMediaPlaylist as any)._pendingByteRange;

      segments.push({
        url,
        duration: currentDuration,
        key: currentKey,
        byteRange,
      });
      currentDuration = 0;
    }
  }

  if (segments.length === 0) {
    throw new AppError('E_PARSE', 'media playlist 中未找到任何分片');
  }

  return {
    isMaster: false,
    targetDuration,
    mediaSequence,
    segments,
    initSegment,
    endList,
  };
}

/**
 * 解析 HLS 属性字符串
 *
 * 属性名统一转大写存储，消费侧（METHOD/URI/IV/CODECS…）只按大写取值，
 * 与 REV-30 的「属性名大小写不敏感」保持一致。
 */
function parseAttributes(str: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const regex = /([A-Za-z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    attrs[(match[1] ?? '').toUpperCase()] = (match[2] ?? match[3] ?? '').trim();
  }
  return attrs;
}

/**
 * 解析相对/绝对 URL
 */
function resolveUrl(url: string, baseUrl: string): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('//')) {
    return 'https:' + url;
  }
  if (url.startsWith('/')) {
    const base = new URL(baseUrl);
    return `${base.protocol}//${base.host}${url}`;
  }
  const base = new URL(baseUrl);
  const dir = base.pathname.substring(0, base.pathname.lastIndexOf('/') + 1);
  return `${base.protocol}//${base.host}${dir}${url}`;
}

/** 是否为本机回环地址（已是代理 URL 时不重复代理） */
function isLocalhostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === '127.0.0.1' || host === 'localhost';
  } catch {
    return false;
  }
}

/**
 * 清单解析基线（FIX-04）。
 *
 * 清单里的相对引用必须按「302 跟随后的落地地址」解析：签名地址常见
 * `/master.m3u8 → 302 → /real/dir/index.m3u8`，若仍按原始请求地址取目录，会把
 * `seg0.ts` 拼成 `/seg0.ts` → 404。
 *
 * `response.url` 是运行时自报的落地地址：直连 `fetch` 默认跟随跳转，这里拿到的就是
 * 跟随后的地址。本机回环代理地址（`127.0.0.1/p/{token}`）只有 token、不含上游路径
 * 语义，不能当基线；代理路径的落地方向已由原生侧以落地地址为基线改写清单体现
 * （见 `unwrapPlaylistUrls`），因此回落到请求地址。
 */
function manifestBaseUrl(reportedUrl: string | undefined, requestedUrl: string): string {
  if (!reportedUrl) return requestedUrl;
  if (isLocalhostUrl(reportedUrl)) return requestedUrl;
  return /^https?:\/\//i.test(reportedUrl) ? reportedUrl : requestedUrl;
}

/**
 * 还原本机代理改写过的资源地址。
 *
 * LocalProxy 转发 m3u8 时会把清单内的 URL 改写成 `/p/{token}/{urlencoded}`，
 * 而分片请求用的 token 只登记了清单地址，改写后的 token 不可复用。因此解析清单后
 * 先把这些回环地址还原成上游原始地址，再统一经 `resourceUrl()` 用当前任务的代理
 * 基址重新编码，避免「分片请求落到未登记的 token」而 404。
 */
function unwrapProxiedUrl(url: string, proxyBase: string | null): string {
  if (!proxyBase || !isLocalhostUrl(url)) return url;
  try {
    const target = new URL(url);
    const base = new URL(proxyBase);
    if (target.host !== base.host) return url;
    if (!target.pathname.startsWith('/p/')) return url;
    const rest = target.pathname.substring(3);
    const slash = rest.indexOf('/');
    if (slash <= 0) return url;
    // LocalProxy 用 java.net.URLEncoder：空格编码为 '+'，其余与 encodeURIComponent 一致
    const decoded = decodeURIComponent(rest.substring(slash + 1).replace(/\+/g, ' '));
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** 把代理改写过的清单 URL 还原成上游地址（变体/分片/初始化分片/密钥） */
function unwrapPlaylistUrls(playlist: HlsPlaylist, proxyBase: string | null): void {
  if (!proxyBase) return;
  for (const variant of playlist.variants ?? []) {
    variant.url = unwrapProxiedUrl(variant.url, proxyBase);
  }
  if (playlist.initSegment) {
    playlist.initSegment.url = unwrapProxiedUrl(playlist.initSegment.url, proxyBase);
  }
  for (const segment of playlist.segments) {
    segment.url = unwrapProxiedUrl(segment.url, proxyBase);
    if (segment.key) segment.key.uri = unwrapProxiedUrl(segment.key.uri, proxyBase);
  }
}

/**
 * 清单解析后、动手下载任何字节之前，先拒绝不支持的加密方式（AC-40 / FIX-03）。
 *
 * 目前只实现 AES-128 解密；SAMPLE-AES / SAMPLE-AES-CTR 等属于受保护内容，
 * 原样拼接会产出「任务完成但文件不可播」的坏产物，因此在解析阶段直接失败，
 * 不下载密钥、不创建 sink、不写入任何分片。
 *
 * REV-30 / REV-31：判定口径与播放侧共用 `findProtectedKeyEvidence`——
 * 标签名/属性名大小写不敏感（`#ext-x-key:`、`method = "SAMPLE-AES"` 同样命中），
 * 并同时扫描 `#EXT-X-SESSION-KEY`，避免两处实现漂移。
 */
function assertSupportedKeyMethods(manifest: string): void {
  const evidence = findProtectedKeyEvidence(manifest);
  if (!evidence) return;
  throw new AppError('E_DRM_PROTECTED', undefined, {
    detail: `不支持的 HLS 加密方式：${evidence}`,
    retryable: false,
  });
}

/**
 * 这个 CDN 的分片会 302 到图片地址，返回体是「截断的图片前缀 + TS 正文」，
 * 前缀长度不固定（120/126…字节，图片甚至没有 IEND），直接拼接会让 188 字节的
 * TS 包整体错位。这里按 TS 同步字节（0x47 每 188 字节出现一次）定位真正起点。
 */
const FMP4_BOX_TYPES = new Set(['ftyp', 'styp', 'moof', 'sidx', 'moov']);

function stripSegmentPrefix(data: Uint8Array): Uint8Array {
  const PROBE_PACKETS = 5;
  if (data.length < 188 * PROBE_PACKETS) return data;
  if (data[0] === 0x47) return data;
  const boxType = String.fromCharCode(data[4], data[5], data[6], data[7]);
  if (FMP4_BOX_TYPES.has(boxType)) return data;
  const limit = Math.min(data.length - 188 * PROBE_PACKETS, 8192);
  for (let offset = 0; offset <= limit; offset++) {
    let aligned = true;
    for (let i = 0; i < PROBE_PACKETS; i++) {
      if (data[offset + i * 188] !== 0x47) {
        aligned = false;
        break;
      }
    }
    if (aligned) return data.subarray(offset);
  }
  return data;
}

/**
 * AES-128 解密（Web Crypto API）
 */
async function decryptAes128(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['decrypt']);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return new Uint8Array(decrypted);
}

/**
 * 解析 IV（初始化向量）
 */
function parseIV(ivHex: string): Uint8Array {
  const hex = ivHex.startsWith('0x') || ivHex.startsWith('0X') ? ivHex.substring(2) : ivHex;
  const padded = hex.padStart(32, '0'); // 16 bytes = 32 hex chars
  const iv = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    iv[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return iv;
}

export class HlsDownloader {
  constructor(private readonly deps: HlsDownloaderDeps) {}

  async run(task: DownloadTask, signal: AbortSignal): Promise<void> {
    const fetchImpl = this.deps.fetchImpl ?? fetch.bind(globalThis);
    const sinkFactory = this.deps.createSinkImpl ?? createSink;
    const now = this.deps.now ?? Date.now;
    const parallelSegments = this.deps.parallelSegments ?? DEFAULT_PARALLEL_SEGMENTS;

    logger.debug('开始 HLS 下载', { taskId: task.id, url: task.url });

    /**
     * 清单 / 分片 / 密钥 / 初始化分片在 Android 上统一经本机回环代理转发：
     * 部分 CDN 的分片与清单地址返回 302，CapacitorHttp 拦截层不接受 3xx
     * （`statusCode can't be in the [300, 399] range`），而代理侧会手动跟随跳转。
     * 代理不可用或单次清单请求失败时回退直连，保证非原生环境与老旧链路可用。
     */
    const proxyBase = await this.resolveProxyBase(task);
    const resourceUrl = (url: string): string =>
      proxyBase && !isLocalhostUrl(url) ? `${proxyBase}/${encodeURIComponent(url)}` : url;
    const resourceHeaders = (extra?: Record<string, string>): Record<string, string> => ({
      ...(proxyBase ? {} : task.headers),
      ...(extra ?? {}),
    });

    // 1. 获取并解析播放列表
    let playlist: HlsPlaylist;
    try {
      const document = await this.fetchManifestText(task.url, task.headers, proxyBase, fetchImpl, signal, '获取 m3u8 清单失败');
      assertSupportedKeyMethods(document.text);
      // 相对引用按拉取到清单时的落地地址解析（302 后目录可能已变）
      playlist = parseM3u8(document.text, document.baseUrl);
      unwrapPlaylistUrls(playlist, proxyBase);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw toAppError(e, 'E_NETWORK');
    }

    // 2. 如果是 master playlist，选择码率并获取 media playlist
    if (playlist.isMaster && playlist.variants && playlist.variants.length > 0) {
      // P1-6: 按质量选择变体流
      const quality = this.deps.quality ?? 'max';
      const selected = this.selectVariant(playlist.variants, quality);
      logger.debug('选择变体流', {
        quality,
        bandwidth: selected.bandwidth,
        resolution: selected.resolution,
        codecs: selected.codecs,
      });

      try {
        const document = await this.fetchManifestText(selected.url, task.headers, proxyBase, fetchImpl, signal, '获取 media playlist 失败');
        assertSupportedKeyMethods(document.text);
        // 相对地址以「拉取到子清单的落地地址」为基准解析（代理返回的清单可能被改写成回环地址）
        playlist = parseM3u8(document.text, document.baseUrl);
        unwrapPlaylistUrls(playlist, proxyBase);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw toAppError(e, 'E_NETWORK');
      }
    }

    if (playlist.isMaster || playlist.segments.length === 0) {
      throw new AppError('E_PARSE', '无法解析有效的 media playlist');
    }

    logger.debug('解析到分片', { count: playlist.segments.length, hasKey: !!playlist.segments[0]?.key });

    // 3. 下载初始化分片（fMP4）
    if (playlist.initSegment) {
      try {
        const response = await fetchImpl(resourceUrl(playlist.initSegment.url), {
          method: 'GET',
          headers: resourceHeaders(),
          signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          throw this.mapHttpError(response.status, '获取初始化分片失败');
        }
        playlist.initSegment.data = new Uint8Array(await response.arrayBuffer());
        logger.debug('下载初始化分片', { size: playlist.initSegment.data.byteLength });
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw toAppError(e, 'E_NETWORK');
      }
    }

    // 4. 预加载密钥（如果有加密）
    const keyCache = new Map<string, Uint8Array>();
    const keysToLoad = new Set(playlist.segments.map((s) => s.key?.uri).filter(Boolean) as string[]);

    for (const keyUri of keysToLoad) {
      try {
        const response = await fetchImpl(resourceUrl(keyUri), {
          method: 'GET',
          headers: resourceHeaders(),
          signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          throw this.mapHttpError(response.status, `获取密钥失败: ${keyUri}`);
        }
        const keyData = new Uint8Array(await response.arrayBuffer());
        if (keyData.byteLength !== 16) {
          throw new AppError('E_PARSE', `密钥长度错误: ${keyData.byteLength} (应为 16)`);
        }
        keyCache.set(keyUri, keyData);
        logger.debug('加载密钥', { uri: keyUri });
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw toAppError(e, 'E_NETWORK');
      }
    }

    // 5. 初始化 sink
    const sink = sinkFactory(task.sink);
    // P0-3: 检查是否有已完成的分片（暂停续传）
    const completedSegments = task.completedSegments ?? [];
    const startBytes = completedSegments.length > 0 ? task.downloadedBytes : 0;
    await sink.begin({ task: { ...task, resumable: true }, startBytes });

    let downloaded = startBytes;
    let lastPersist = now();
    let lastSampleAt = now();
    let lastSampleBytes = startBytes;

    await this.deps.saveProgress(task.id, {
      status: 'downloading',
      downloadedBytes: startBytes,
      totalBytes: null,
      resumable: true,
      speedBps: 0,
      updatedAt: now(),
      completedSegments,
    });

    // 6. 写入初始化分片（如果尚未完成）
    if (playlist.initSegment?.data && !completedSegments.includes(-1)) {
      await sink.write(playlist.initSegment.data);
      downloaded += playlist.initSegment.data.byteLength;
      completedSegments.push(-1); // -1 表示初始化分片
      await this.deps.saveProgress(task.id, {
        downloadedBytes: downloaded,
        completedSegments,
        updatedAt: now(),
      });
    } else if (playlist.initSegment?.data) {
      // 初始化分片已完成，跳过写入但计入大小
      downloaded += playlist.initSegment.data.byteLength;
    }

    // 7. 并行下载分片
    try {
      // P0-3: 为每个分片登记索引，用于跳过已完成的分片
      const segmentsWithIndex = playlist.segments.map((seg, idx) => ({ segment: seg, index: idx }));
      const segmentBatches = this.createBatches(segmentsWithIndex, parallelSegments);
      // HLS 清单不带总大小，用「已完成分片平均体积 × 总分片数」估算总字节数，
      // 让进度条/剩余时间随下载推进收敛，下载完成后由实际大小覆盖。
      const totalSegments = playlist.segments.length;
      let completedCount = completedSegments.length;
      let segmentBytes = completedCount > 0 ? downloaded : 0;

      for (const batch of segmentBatches) {
        if (signal.aborted) throw new AppError('E_ABORTED');

        // P0-3: 过滤掉已完成的分片
        const pendingBatch = batch.filter(({ index }) => !completedSegments.includes(index));
        if (pendingBatch.length === 0) continue;

        // 并行下载当前批次（带重试）
        const results = await Promise.all(
          pendingBatch.map(async ({ segment, index }) => {
            let lastError: unknown;
            for (let attempt = 0; attempt <= MAX_SEGMENT_RETRIES; attempt++) {
              try {
                const response = await fetchImpl(resourceUrl(segment.url), {
                  method: 'GET',
                  headers: resourceHeaders(
                    segment.byteRange
                      ? { Range: `bytes=${segment.byteRange.offset}-${segment.byteRange.offset + segment.byteRange.length - 1}` }
                      : undefined,
                  ),
                  signal,
                  cache: 'no-store',
                });

                if (!response.ok) {
                  throw this.mapHttpError(response.status, `下载分片失败: ${segment.url}`);
                }

                let data = new Uint8Array(await response.arrayBuffer());

                // 解密（如果需要）
                if (segment.key && segment.key.method === 'AES-128') {
                  const key = keyCache.get(segment.key.uri);
                  if (!key) {
                    throw new AppError('E_PARSE', `密钥未找到: ${segment.key.uri}`);
                  }
                  const iv = segment.key.iv ? parseIV(segment.key.iv) : this.getDefaultIV(segment, playlist);
                  data = await decryptAes128(data, key, iv);
                }

                return { data: stripSegmentPrefix(data), index };
              } catch (e) {
                lastError = e;
                if (attempt < MAX_SEGMENT_RETRIES) {
                  const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
                  logger.warn('分片下载失败，重试中', { attempt: attempt + 1, backoff, url: segment.url, error: e });
                  await new Promise((resolve) => setTimeout(resolve, backoff));
                }
              }
            }
            throw lastError;
          }),
        );

        // 按顺序写入 sink
        for (const { data, index } of results) {
          await sink.write(data);
          downloaded += data.byteLength;
          segmentBytes += data.byteLength;
          completedCount += 1;
          completedSegments.push(index);

          // 进度上报（含分片索引，用于暂停续传）
          const currentTime = now();
          if (currentTime - lastPersist >= 1000) {
            const elapsedSec = Math.max((currentTime - lastSampleAt) / 1000, 0.001);
            const speedBps = Math.max(0, Math.round((downloaded - lastSampleBytes) / elapsedSec));
            const estimatedTotal =
              completedCount > 0
                ? Math.max(downloaded, Math.round((segmentBytes / completedCount) * totalSegments))
                : null;
            lastPersist = currentTime;
            lastSampleAt = currentTime;
            lastSampleBytes = downloaded;
            await this.deps.saveProgress(task.id, {
              downloadedBytes: downloaded,
              totalBytes: estimatedTotal,
              speedBps,
              updatedAt: currentTime,
              completedSegments,
            });
          }
        }
      }

      // 8. 完成
      const result = await sink.finish();
      await this.deps.saveProgress(task.id, {
        downloadedBytes: downloaded,
        totalBytes: downloaded,
        filePath: result.filePath,
        blobKey: result.blobKey,
        speedBps: 0,
        updatedAt: now(),
        completedAt: now(),
      });

      logger.debug('HLS 下载完成', { taskId: task.id, size: downloaded });
    } catch (e) {
      // 错误处理
      const appError = e instanceof AppError ? e : toAppError(e, 'E_UNKNOWN');
      if (task.sink === 'idb-blob') {
        await sink.abort().catch(() => undefined);
      } else {
        const currentTask = await this.deps.load(task.id);
        if (currentTask?.status === 'canceled') {
          await sink.abort().catch(() => undefined);
        } else {
          await sink.suspend().catch(() => undefined);
        }
      }
      throw appError;
    }
  }

  /**
   * 拉取清单文本（FIX-04）。
   *
   * 优先经本机回环代理：代理侧手动跟随 302，规避 CapacitorHttp 对 3xx 的硬拒绝；
   * 代理不可用、返回非 2xx 或抛错时回退直连（非原生环境本来就只有直连）。
   * 取消信号在两条路径上都生效，避免暂停/取消后仍挂住。
   *
   * 返回 `baseUrl`：清单内的相对引用按「302 落地地址」解析（见 `manifestBaseUrl`）。
   */
  private async fetchManifestText(
    url: string,
    headers: Record<string, string> | undefined,
    proxyBase: string | null,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
    label: string,
  ): Promise<ManifestDocument> {
    if (signal.aborted) throw new AppError('E_ABORTED');
    if (proxyBase && !isLocalhostUrl(url)) {
      try {
        const response = await fetchImpl(`${proxyBase}/${encodeURIComponent(url)}`, {
          method: 'GET',
          signal,
          cache: 'no-store',
        });
        if (response.ok) {
          return { text: await response.text(), baseUrl: manifestBaseUrl(response.url, url) };
        }
        logger.warn('清单代理请求返回非 2xx，回退直连', { url, status: response.status });
      } catch (e) {
        if (signal.aborted) throw new AppError('E_ABORTED');
        logger.warn('清单代理请求失败，回退直连', { url, error: (e as Error)?.message ?? String(e) });
      }
    }
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
      signal,
      cache: 'no-store',
    });
    if (!response.ok) throw this.mapHttpError(response.status, label);
    return { text: await response.text(), baseUrl: manifestBaseUrl(response.url, url) };
  }

  /**
   * 为资源请求登记一个本机回环代理基址（Android）。
   *
   * 仅登记一次（用任务 URL + headers 换 token），后续把「token/编码后的分片 URL」
   * 拼到基址上即可复用同一份注入头转发；分片上游 302 由原生侧跟随。
   * 非原生 / 插件不可用 → 返回 null，回退直连。
   */
  private async resolveProxyBase(task: DownloadTask): Promise<string | null> {
    if (!isNative()) return null;
    try {
      const result = await LocalProxy.proxy({ url: task.url, headers: task.headers });
      return result.url.replace(/\/+$/, '');
    } catch (e) {
      logger.warn('HLS 本机代理不可用，分片回退直连', (e as Error)?.message ?? String(e));
      return null;
    }
  }

  /**
   * P1-6: 按质量选择变体流
   */
  private selectVariant(variants: HlsVariant[], quality: 'max' | '1080p' | '720p' | 'auto'): HlsVariant {
    // variants 已按码率降序排序
    if (quality === 'max' || quality === 'auto') {
      return variants[0]!;
    }
    const maxHeight = quality === '1080p' ? 1080 : 720;
    // 找第一个高度 <= maxHeight 的变体
    for (const v of variants) {
      if (v.resolution && v.resolution.height <= maxHeight) {
        return v;
      }
    }
    // 都没找到，返回最低的
    return variants[variants.length - 1]!;
  }

  /**
   * 创建批次（并行下载控制）
   */
  private createBatches<T>(items: T[], batchSize: number): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * 默认 IV（序列号）
   */
  private getDefaultIV(segment: HlsSegment, playlist: HlsPlaylist): Uint8Array {
    const seq = (playlist.mediaSequence ?? 0) + playlist.segments.indexOf(segment);
    const iv = new Uint8Array(16);
    // 小端序写入序列号
    iv[12] = (seq >> 24) & 0xff;
    iv[13] = (seq >> 16) & 0xff;
    iv[14] = (seq >> 8) & 0xff;
    iv[15] = seq & 0xff;
    return iv;
  }

  /**
   * HTTP 错误映射
   */
  private mapHttpError(status: number, message: string): AppError {
    const code =
      status === 401 ? 'E_AUTH' :
      status === 403 ? 'E_HTTP_403' :
      status === 404 ? 'E_HTTP_404' :
      status >= 500 ? 'E_HTTP_5XX' :
      'E_HTTP_400';
    return new AppError(code, `${message}：HTTP ${status}`);
  }
}

export function createHlsDownloader(deps: HlsDownloaderDeps): HlsDownloader {
  return new HlsDownloader(deps);
}
