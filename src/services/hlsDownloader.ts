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
import { deleteFile } from '@/native/fs';
import { LocalProxy } from '@/native/localProxy';
import { MediaTool, getStorageInfo, isMediaToolAvailable } from '@/native/mediaToolPlugin';
import { settingsService } from '@/services/settingsService';
import { beginPhase, endPhase } from '@/services/downloadPhaseRegistry';
import {
  decideRemuxDelivery,
  deliverRemux,
  deliverRenamedArtifact,
  recordRemuxFailure,
  type RemuxDecision,
  type RemuxDelivery,
  type RemuxResultLike,
} from '@/services/remuxDelivery';
import { findProtectedKeyEvidence } from '@/player/sourceGuard';
import { createSink, type DownloadSink } from '@/services/downloadSink';
import { appEvents } from '@/services/events';
import { classifyConnectivityError } from '@/services/connectivityError';
import type { DownloadContainer, DownloadTask } from '@/types';

/**
 * 后处理阶段回调（EXT-04/FR-60）：转封装发生在分片写完之后，但任务状态要到
 * runner 整体返回才迁移为 `completed`——进度条已 100% 而界面仍写「下载中…」，
 * 长视频转封装能持续几分钟。阶段状态由这里带出，UI 据此显示「转封装中」。
 */
export type PostProcessNotifier = (
  task: DownloadTask,
  stage: 'remux' | 'subtitles',
  state: 'start' | 'progress' | 'done' | 'skipped' | 'failed',
  extra?: { progress?: number; reason?: string },
) => void;

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
  onPostProcess?: PostProcessNotifier;
  /**
   * DL-P0-2：在同一 `mediaId` 已完成的任务里找产物指纹相同的那一集，返回它的标题。
   * 由 `downloadService` 注入（下载器不认识库）；缺省不查，只少一道网。
   */
  findTwinArtifact?: (mediaId: string, taskId: string, digest: string) => Promise<string | null>;
}

/** HLS 变体流（master playlist 中的选项） */
export interface HlsVariant {
  url: string;
  bandwidth: number;
  resolution?: { width: number; height: number };
  codecs?: string;
}

/**
 * 按清晰度档位选择变体（AC-146 / AC-147）。
 *
 * 规则（与 P1-6 原实现一致，供 `HlsDownloader` 与 `downloadPreflight` 共用）：
 * - `max`/`auto` → 码率最高的变体（入参已按 BANDWIDTH 降序）；
 * - `1080p`/`720p` → 第一个 `RESOLUTION.height <= 档位高度` 的变体；
 * - 无 `RESOLUTION` 或全都不满足 → 取码率最低的变体（调用方负责写 note）。
 */
export function selectHlsVariantForQuality(
  variants: HlsVariant[],
  quality: 'max' | '1080p' | '720p' | 'auto',
): HlsVariant {
  if (variants.length === 0) throw new AppError('E_PARSE', '清单中没有可用变体');
  if (quality === 'max' || quality === 'auto') {
    return variants[0]!;
  }
  const maxHeight = quality === '1080p' ? 1080 : 720;
  for (const variant of variants) {
    if (variant.resolution && variant.resolution.height <= maxHeight) {
      return variant;
    }
  }
  return variants[variants.length - 1]!;
}

/** AES-128 密钥信息 */
export interface HlsKey {
  method: string;
  uri: string;
  iv?: string;
}

/** fMP4 初始化分片 */
export interface HlsInitSegment {
  url: string;
  data?: Uint8Array;
}

/** 媒体分片 */
export interface HlsSegment {
  url: string;
  duration: number;
  key?: HlsKey;
  byteRange?: { offset: number; length: number };
}

/** 解析后的播放列表 */
export interface HlsPlaylist {
  isMaster: boolean;
  variants?: HlsVariant[];
  targetDuration?: number;
  mediaSequence?: number;
  segments: HlsSegment[];
  initSegment?: HlsInitSegment;
  /**
   * P0-4：清单里出现过的**不同** `#EXT-X-MAP` URI 数量（按声明顺序去重）。
   *
   * 合并产物只有一个文件头，规范却允许中途换 init 段；`> 1` 意味着后半段的分片
   * 并不属于我们写进文件头的那一份初始化段。这个数不参与字节拼接，只用于把容器
   * 从 `fmp4` 降级（见 `detectHlsContainer`），别让一份头尾不匹配的产物被当成有效 fMP4 交付。
   */
  initMapCount?: number;
  endList?: boolean;
  /** FIX-PLAY-D1: #EXT-X-DISCONTINUITY 边界数（归因元数据，不参与下载行为） */
  discontinuityCount?: number;
  /**
   * P0-4：清单自身声明的产物容器（见 `detectHlsContainer`）。
   *
   * 此前只有预检用「有没有 init 段 + 首片扩展名」猜一次容器，合并、文件名、MIME、
   * 桥接、播放器四处各写死 `'ts'`，同一条 fMP4 线路在五层里是五种说法。
   * master playlist 没有分片，容器要等选中变体后才能判定，故留空。
   */
  container?: DownloadContainer;
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
  /** 响应 content-type：200 的错误页靠它识别（正文嗅探只是兜底） */
  contentType: string | null;
}

/** 并行下载控制 */
const DEFAULT_PARALLEL_SEGMENTS = 6;
const MAX_SEGMENT_RETRIES = 2;
const RETRY_BACKOFF_MS = [500, 1500];
/** FIX-D1：单分片获取超时（30s），超时后触发重试 */
const SEGMENT_FETCH_TIMEOUT_MS = 30_000;
/** FIX-D1：清单 / 密钥获取超时（15s） */
const MANIFEST_KEY_TIMEOUT_MS = 15_000;
/**
 * FIX-D1：主循环停滞阈值（60s 没有任何分片请求发起 → 判定调度卡死）。
 * 计数口径是"发起"而不是"完成"：一次「30s 超时 + 退避」的正常重试节奏约 31.5s，
 * 只认完成事件会把还在重试的窗口误判成停滞（用户看到的下载停滞中断之一）。
 */
const STALL_TIMEOUT_MS = 60_000;
/** 连续多少片解密失败就判这条线解不开（再多试只是空跑 987 片） */
const DECRYPT_FAILURE_LIMIT = 3;
/** P0-4：原生转封装超时。大片实测会跑满，同时也是给看门狗的阶段预算基准 */
const REMUX_TIMEOUT_MS = 300_000;
/** P0-4：阶段预算的宽限（桥接往返 + 复检本身）；超过它看门狗照旧判停滞，卡死的转封装不能终身免检 */
const REMUX_PHASE_GRACE_MS = 60_000;
/** P0-4：fMP4 交付只做一次全文件复检，不给转封装时长 */
const FMP4_DELIVERY_PHASE_BUDGET_MS = 120_000;
/** P0-4：转封装产物按输入体积留 15% 余量（与存量迁移 `MIN_FREE_RATIO` 同一口径） */
const REMUX_FREE_SPACE_RATIO = 1.15;

/**
 * 源侧返回的不是清单，而是网页 / 接口错误体（防盗链、限流、直链过期）。
 *
 * 这类响应常年带 200，重试同一个地址只会拿到同一张错误页；但它本质是**源侧暂时拒绝**，
 * 不是「清单格式坏了」。归到可重试的 E_SOURCE_UNAVAILABLE 并说人话，
 * 而不是把 `<!DOCTYPE html>` 原文塞进「缺少 #EXTM3U 头」里让用户无从下手。
 */
export function nonManifestBodyError(text: string, contentType?: string | null): AppError | null {
  const type = (contentType ?? '').toLowerCase();
  const head = text.trimStart().slice(0, 512).toLowerCase();
  const isHtml =
    type.includes('text/html') ||
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<head') ||
    head.includes('<body');
  const isJson = type.includes('application/json') || head.startsWith('{') || head.startsWith('[');
  if (!isHtml && !isJson) return null;
  return new AppError(
    'E_SOURCE_UNAVAILABLE',
    isHtml
      ? '源返回了网页而不是视频清单（直链可能过期或被限流），请稍后重试或换线路'
      : '源返回了接口错误而不是视频清单（直链可能过期或被限流），请稍后重试或换线路',
    { detail: text.trim().slice(0, 120) },
  );
}

/**
 * 解析 m3u8 清单
 *
 * 验证：有效的 m3u8 必须以 `#EXTM3U` 开头（HLS 规范）。
 * 如果返回 HTML 或纯文本，抛错避免把错误页面当分片列表。
 */
export function parseM3u8(manifest: string, baseUrl: string, contentType?: string | null): HlsPlaylist {
  const trimmed = manifest.trim();
  if (!trimmed.startsWith('#EXTM3U')) {
    const sourceError = nonManifestBodyError(trimmed, contentType);
    if (sourceError) throw sourceError;
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
  const initMapUris: string[] = [];
  let endList = false;
  // FIX-PLAY-D2：BYTERANGE 是「作用于下一条 URL」的局部状态。旧实现把它挂在
  // parseMediaPlaylist 函数对象上——两次解析之间会残留串话，且偏移缺省时一律当 0，
  // 而规范（RFC 8216 §4.3.6）要求缺省偏移从「上一个 range 的终点」隐式续接。
  let pendingByteRange: HlsSegment['byteRange'];
  let lastRangeEnd: number | undefined;
  // FIX-PLAY-D1：DISCONTINUITY 边界计数只做归因元数据，不改变拼接行为
  let discontinuityCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.substring('#EXT-X-TARGETDURATION:'.length), 10);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.substring('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
    } else if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuityCount += 1;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-KEY:'.length));
      // FIX-PLAY-D3：METHOD 归一为大写——`method="aes-128"` 这类源侧变体
      // 此前会同时逃过「非 NONE」判定与下载侧的 AES-128 解密分支（密文当明文拼接）。
      const method = (attrs['METHOD'] ?? '').toUpperCase();
      if (method && method !== 'NONE') {
        currentKey = {
          method,
          uri: resolveUrl(attrs['URI'] || '', baseUrl),
          iv: attrs['IV'],
        };
      } else {
        currentKey = undefined;
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.substring('#EXT-X-MAP:'.length));
      if (attrs['URI']) {
        const uri = resolveUrl(attrs['URI'], baseUrl);
        if (!initMapUris.includes(uri)) initMapUris.push(uri);
        /*
         * 文件头只认第一个声明：合并是从它开始的，后面再换 init 也救不了已经落盘的字节。
         * 旧实现在这里直接覆盖（后来者赢），于是头跟前面所有分片都对不上——数量记下来，
         * 容器判定才有降级的依据。
         */
        initSegment ??= { url: uri };
      }
    } else if (line.startsWith('#EXTINF:')) {
      const match = line.match(/#EXTINF:([\d.]+)/);
      if (match) {
        currentDuration = parseFloat(match[1]);
      }
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      // 字节范围（下一行的 URL 使用）
      const match = line.match(/#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/);
      if (match) {
        const length = parseInt(match[1]!, 10);
        const offset = match[2] !== undefined ? parseInt(match[2], 10) : (lastRangeEnd ?? 0);
        pendingByteRange = { offset, length };
        lastRangeEnd = offset + length;
      }
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line && !line.startsWith('#')) {
      // 分片 URL
      const url = resolveUrl(line, baseUrl);
      const byteRange = pendingByteRange;
      pendingByteRange = undefined;

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
    initMapCount: initMapUris.length,
    endList,
    discontinuityCount,
    container: detectHlsContainer({ initSegment, segments, initMapCount: initMapUris.length }),
  };
}

/**
 * P0-4：按清单自身的声明判定产物容器。
 *
 * 判据顺序就是证据强度：`#EXT-X-MAP` 是规范里 fMP4 的定义性标签（纯 TS 清单不会出现它），
 * 其次是首片扩展名，最后落到 `other`。宁可标成「不认得」让上层按原件兜底播放，
 * 也不能把一份 MP4 家族的文件叫成 TS——那会让转封装、文件名、MIME 与播放器四处一起错。
 *
 * 中途换过 init 段（`initMapCount > 1`）时不承诺 `fmp4`：那份产物只有一个文件头，
 * 后半段的分片对应的却是另一份初始化段，改名当成品交付等于交付一份头尾不匹配的 MP4。
 */
export function detectHlsContainer(
  playlist: Pick<HlsPlaylist, 'initSegment' | 'segments' | 'initMapCount'>,
): DownloadContainer {
  if (playlist.initSegment) return (playlist.initMapCount ?? 0) > 1 ? 'other' : 'fmp4';
  const first = playlist.segments[0]?.url ?? '';
  if (/\.ts(\?|$)/i.test(first)) return 'ts';
  if (/\.(m4s|mp4|m4a|m4v)(\?|$)/i.test(first)) return 'fmp4';
  return 'other';
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
export function manifestBaseUrl(reportedUrl: string | undefined, requestedUrl: string): string {
  if (!reportedUrl) return requestedUrl;
  if (isLocalhostUrl(reportedUrl)) return requestedUrl;
  return /^https?:\/\//i.test(reportedUrl) ? reportedUrl : requestedUrl;
}

/**
 * 还原本机代理改写过的资源地址。
 *
 * LocalProxy 转发 m3u8 时会把清单内的 URL 改写成 `/p/{token}/{urlencoded}`，
 * 而分片请求用的 token 只登记了清单地址，改写后的 token 不可复用。因此解析清单后
 * 先把这些回环地址还原成上游原始地址，再统一经 `fetchResourceWithFallback()` 用当前任务的代理
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
export function assertSupportedKeyMethods(manifest: string): void {
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

/* =========================================================
 * FIX-PLAY A2/A3：分片写盘前的字节级校验
 *
 * 症状：下载「完成」的 .ts 剧集播放中途报 MediaCodecVideoRenderer（format 1/256
 * 即 TS 的 PID 256）。链路里没有截断的显式失败——旧实现只查 HTTP 状态与
 * content-type，上游被掐断/污染时短包照样落盘，产物到播放器才暴露。
 * 这里把坏件拦在写盘之前：校验失败按可重试网络错误走既有退避重试，
 * 重试用尽则整任务失败（续传点仍在），绝不再产出「任务完成但播不了」的文件。
 * =======================================================*/

/** 常见 TS 包长：188 为主，个别老流带 4 字节时间码（192） */
const TS_PACKET_SIZES = [188, 192];

/** 允许出现在媒体分片开头的 fMP4 box（比 stripSegmentPrefix 的集合更宽） */
const SCREEN_FMP4_TYPES = new Set([...FMP4_BOX_TYPES, 'mdat', 'free', 'emsg', 'skip', 'prft']);

/** 校验失败统一构造可重试错误（E_NETWORK ∈ RETRYABLE_CODES） */
function segmentIntegrityError(reason: string, url: string): AppError {
  return new AppError('E_NETWORK', `分片数据异常：${reason}`, { detail: url });
}

/* ---------- DL-P0-2：占位内容闸门 ---------- */

/** 参与判定的最少分片数：不足此数时重复也可能只是「这条流本来就短」 */
const PLACEHOLDER_MIN_SEGMENTS = 8;
/** 不同内容占总分片数的比例下限：低于它判定为占位资源 */
const PLACEHOLDER_MIN_DISTINCT_RATIO = 0.2;
/** 指纹采样窗口（首尾各 8KB）：判的是"这两片是不是同一份字节"，全量散列在 5MB 分片上是白花的钱 */
const FINGERPRINT_SAMPLE_BYTES = 8192;

function fnv1a32(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 分片内容指纹：长度 + 首尾采样散列 */
function segmentFingerprint(data: Uint8Array): string {
  const tail =
    data.length > FINGERPRINT_SAMPLE_BYTES * 2
      ? data.subarray(data.length - FINGERPRINT_SAMPLE_BYTES)
      : new Uint8Array(0);
  const head = data.subarray(0, Math.min(FINGERPRINT_SAMPLE_BYTES, data.length));
  return `${data.length}:${fnv1a32(head).toString(16)}:${fnv1a32(tail).toString(16)}`;
}

/**
 * DL-P0-2：集级滚动指纹——把每一片的内容指纹按写入顺序折进一个整型值。
 * 顺序敏感（同一堆分片换个顺序就是另一个值），且不额外分配，边写边折零额外 I/O。
 * 只作「同一次比对内部是否相等」用，不当校验和、不当安全原语。
 */
function foldFingerprint(acc: number, part: string): number {
  let hash = acc;
  for (let i = 0; i < part.length; i += 1) {
    hash = Math.imul(hash ^ part.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 只描述清单分片结构，排除签名 URL、Cookie 与密钥 URI，避免换链即误判换片。 */
export function hlsPlaylistFingerprint(playlist: HlsPlaylist): string {
  const durations = playlist.segments
    .map((segment) => `${Math.round(segment.duration * 1000)}:${segment.byteRange?.length ?? 0}`)
    .join(',');
  const parts = [
    String(playlist.mediaSequence ?? 0),
    String(playlist.targetDuration ?? 0),
    String(playlist.segments.length),
    durations,
    String(playlist.discontinuityCount ?? 0),
    String(playlist.initMapCount ?? 0),
    playlist.container ?? '',
    playlist.endList ? '1' : '0',
  ];
  return foldFingerprint(0x811c9dc5, parts.join('|')).toString(16).padStart(8, '0');
}

/**
 * 源站失效后的常见形态之一：清单正常、每一片都是同一段素材，字节数/分片数/结构校验全能过，
 * 最后交出一部同一片重复 N 次拼成的假片——真机实测整批 13 集产物 md5 完全相同、时长 19.5 秒，
 * 却全部标成「已完成」。字节数、分片数、容器结构这些形式校验全能穿过去，
 * 所以在落盘前用内容指纹拦一次。
 *
 * 只按重复度判定，不按「产物时长 / 声明时长」的比例——短节目、片头本来就短，
 * 比例门槛会误杀；而字节完全一致的片段重复到八片以上，本来就没有可看内容。
 */
export function isPlaceholderContent(total: number, distinct: number): boolean {
  if (total < PLACEHOLDER_MIN_SEGMENTS) return false;
  return distinct / total < PLACEHOLDER_MIN_DISTINCT_RATIO;
}

/**
 * 分片数据落盘前的结构校验。返回可安全写入的字节（可能截掉尾部残包），
 * 判定为坏件时抛可重试 AppError。
 *
 * 判定顺序保守：先按内容特征（首字节/box 类型），再按 URL 与 content-type 线索。
 * 无任何 TS/fMP4 特征的未知格式分片维持旧行为原样通过，避免误杀小众源。
 */
export function screenSegmentBytes(
  data: Uint8Array,
  hints: { url: string; contentType?: string | null },
): Uint8Array {
  const path = hints.url.split(/[?#]/)[0]?.toLowerCase() ?? '';
  const contentType = (hints.contentType ?? '').toLowerCase();

  if (data.length === 0) throw segmentIntegrityError('响应体为空', hints.url);

  const firstBox = data.length >= 8 ? String.fromCharCode(data[4], data[5], data[6], data[7]) : '';
  if (SCREEN_FMP4_TYPES.has(firstBox)) {
    // box 头：size(4B) + type(4B)。size=0 表示到文件尾、1 表示 64 位 largesize，其余必须 ≥8 且不超界。
    const size = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
    if (size > 1 && (size < 8 || size > data.length)) {
      throw segmentIntegrityError(`fMP4 box 头长度异常（size=${size}，分片 ${data.length} 字节）`, hints.url);
    }
    return data;
  }

  // fMP4 分片（.m4s）没有 TS 同步字节可查，且首 box 已在白名单外——维持旧行为。
  // 真 TS 判据只对有 TS 线索的分片启用，防止把 ADTS/未知容器误杀。
  const tsLike = data[0] === 0x47 || path.endsWith('.ts') || contentType.includes('mp2t');
  if (!tsLike) return data;

  for (const packetSize of TS_PACKET_SIZES) {
    if (data.length < packetSize || data[0] !== 0x47) break;
    let badAt = -1;
    for (let i = packetSize; i < data.length; i += packetSize) {
      if (data[i] !== 0x47) {
        badAt = i;
        break;
      }
    }
    if (badAt >= 0) continue; // 该包长对不上：换下一个候选包长再试
    const remainder = data.length % packetSize;
    if (remainder === 0) return data;
    // 同步字节全过、仅尾部不足一个整包：上游被截断时切点通常落在包中间，
    // 前面的包是完整的。截掉残包保留完整部分，比整体判死更可用。
    logger.warn('分片尾部存在残缺 TS 包，已截掉', { url: hints.url, droppedBytes: remainder, packetSize });
    return data.subarray(0, data.length - remainder);
  }

  // 走到这里：TS 线索成立，但首包非 0x47（stripSegmentPrefix 定位失败/解密错位）
  // 或所有候选包长的同步扫描都不通过（正文被污染或错位）。
  throw segmentIntegrityError(
    data[0] !== 0x47
      ? 'TS 同步字节错位（首包非 0x47，疑似污染或解密失败）'
      : 'TS 包同步扫描失败（疑似截断或内容污染）',
    hints.url,
  );
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

/**
 * `AbortSignal.reason`（ES2022）读取：旧宿主没有该属性时返回 undefined。
 * 转发 reason 才有"为什么被中止"——丢掉 reason 会让 watchdog 的中止理由在半路变成
 * 一个空消息的 AbortError，最终洗成「操作失败，请重试」。
 */
function abortReasonOf(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason;
}

export class HlsDownloader {
  constructor(private readonly deps: HlsDownloaderDeps) {}

  /**
   * 一次下载 = 一个作用域信号（FIX-STALL）。
   *
   * 滑动窗口里的分片请求是 fire-and-forget：run 因停滞、首个错误或超时退出时，
   * 最多 `parallelSegments` 个在途 fetch（含退避 sleep）不会自动终止，而是变成僵尸请求
   * 继续打同一批 CDN 地址。实测同一 taskId 因此出现 3 轮重入、单轮 12 路并发，
   * 直接换来 429/403 与"进度永远 0"。退出即 abort 本作用域，僵尸请求一个不留。
   */
  async run(task: DownloadTask, parentSignal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const onParentAbort = (): void => controller.abort(abortReasonOf(parentSignal) ?? new AppError('E_ABORTED'));
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
    try {
      await this.runWithSignal(task, controller.signal);
    } finally {
      parentSignal.removeEventListener('abort', onParentAbort);
      controller.abort(new AppError('E_ABORTED', '下载已结束'));
    }
  }

  private async runWithSignal(task: DownloadTask, signal: AbortSignal): Promise<void> {
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
      playlist = parseM3u8(document.text, document.baseUrl, document.contentType);
      unwrapPlaylistUrls(playlist, proxyBase);
    } catch (e) {
      if (e instanceof AppError) throw e;
      // 清单一条都没拿到：先分清设备断网还是这个源/线路进不去（P1-6）
      throw classifyConnectivityError(e);
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
        playlist = parseM3u8(document.text, document.baseUrl, document.contentType);
        unwrapPlaylistUrls(playlist, proxyBase);
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw classifyConnectivityError(e);
      }
    }

    if (playlist.isMaster || playlist.segments.length === 0) {
      throw new AppError('E_PARSE', '无法解析有效的 media playlist');
    }

    const playlistFingerprint = hlsPlaylistFingerprint(playlist);
    if (task.hlsPlaylistFingerprint && task.hlsPlaylistFingerprint !== playlistFingerprint) {
      logger.warn('HLS 清单结构变化，旧分片索引不再可用', {
        taskId: task.id,
        previous: task.hlsPlaylistFingerprint,
        current: playlistFingerprint,
        completedSegments: task.completedSegments?.length ?? 0,
      });
      task = {
        ...task,
        downloadedBytes: 0,
        totalBytes: null,
        completedSegments: [],
        hlsTotalSegments: 0,
        hlsPlaylistFingerprint: playlistFingerprint,
        resumable: false,
        filePath: null,
        blobKey: null,
      };
      await this.deps.saveProgress(task.id, {
        downloadedBytes: 0,
        totalBytes: null,
        completedSegments: [],
        hlsTotalSegments: 0,
        hlsPlaylistFingerprint: playlistFingerprint,
        resumable: false,
        filePath: null,
        blobKey: null,
        updatedAt: now(),
      });
    }

    logger.debug('解析到分片', {
      count: playlist.segments.length,
      hasKey: !!playlist.segments[0]?.key,
      playlistFingerprint,
    });

    // 3. 下载初始化分片（fMP4）
    if (playlist.initSegment) {
      try {
        // FIX-D1：初始化分片获取超时
        const initController = new AbortController();
        const onAbort = (): void => initController.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        const initTimer = setTimeout(() => initController.abort(new AppError('E_NETWORK', '获取初始化分片超时')), MANIFEST_KEY_TIMEOUT_MS);
        try {
          const response = await this.fetchResourceWithFallback(
            playlist.initSegment.url,
            proxyBase,
            resourceHeaders(),
            task.headers,
            fetchImpl,
            initController.signal,
          );
          if (!response.ok) {
            throw this.mapHttpError(response.status, '获取初始化分片失败');
          }
          playlist.initSegment.data = new Uint8Array(await response.arrayBuffer());
        } finally {
          clearTimeout(initTimer);
          signal.removeEventListener('abort', onAbort);
        }
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
        // FIX-D1：密钥获取超时
        const keyController = new AbortController();
        const onKeyAbort = (): void => keyController.abort();
        signal.addEventListener('abort', onKeyAbort, { once: true });
        const keyTimer = setTimeout(() => keyController.abort(new AppError('E_NETWORK', `获取密钥超时: ${keyUri}`)), MANIFEST_KEY_TIMEOUT_MS);
        try {
          const response = await this.fetchResourceWithFallback(
            keyUri,
            proxyBase,
            resourceHeaders(),
            task.headers,
            fetchImpl,
            keyController.signal,
          );
          if (!response.ok) {
            throw this.mapHttpError(response.status, `获取密钥失败: ${keyUri}`);
          }
          const keyData = new Uint8Array(await response.arrayBuffer());
          if (keyData.byteLength !== 16) {
            throw new AppError('E_PARSE', `密钥长度错误: ${keyData.byteLength} (应为 16)`);
          }
          keyCache.set(keyUri, keyData);
        } finally {
          clearTimeout(keyTimer);
          signal.removeEventListener('abort', onKeyAbort);
        }
        logger.debug('加载密钥', { uri: keyUri });
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw toAppError(e, 'E_NETWORK');
      }
    }

    // 5. 初始化 sink
    const sink = sinkFactory(task.sink);
    // P0-3: 检查是否有已完成的分片（暂停续传）
    // 拷贝一份：这一路会就地 push，而 `transition()` 只做了浅拷贝，
    // 直接引用调用方数组会把上一跳持有的任务对象一起改写。
    let completedSegments = [...(task.completedSegments ?? [])];
    const startBytes = completedSegments.length > 0 ? task.downloadedBytes : 0;
    // P1-2: 以 .part 实际大小为准，与 DB 不一致时从头下载避免错位
    const firstBegin = await sink.begin({ task: { ...task, resumable: true }, startBytes });
    let started = firstBegin;
    // DL-R0：`adoptedArtifact` 意味着起点是 sink 采纳的已晋升成品——那份字节与
    // `completedSegments` 是同一轮产出（采纳前核过索引完备性），此时两者之差是
    // 「结算前最后一秒的节流没落库」，不是分片丢了。走下面那句清空重下会把一整集
    // 重新取一遍，而产物本来就是完整的。
    if (firstBegin.actualStartBytes !== startBytes && startBytes > 0 && !firstBegin.adoptedArtifact) {
      const fileBytes = firstBegin.actualStartBytes;
      if (fileBytes > startBytes && sink.truncateTo) {
        try {
          await sink.truncateTo(startBytes);
          started = { actualStartBytes: startBytes };
          logger.info('已截断未记账的下载尾部，保留分片断点', {
            taskId: task.id,
            dbBytes: startBytes,
            fileBytes,
            recoveredTailBytes: fileBytes - startBytes,
          });
        } catch (e) {
          logger.error('截断未记账尾部失败，停止追加并保留现场', {
            taskId: task.id,
            dbBytes: startBytes,
            fileBytes,
            error: toAppError(e).message,
          });
          throw new AppError('E_LOCAL_CORRUPT', '本地下载尾部与进度不一致且无法安全截断，已停止下载', {
            retryable: true,
            cause: e,
          });
        }
      } else {
        logger.warn(
          fileBytes > startBytes
            ? '磁盘比 DB 记账还多且当前 sink 不支持安全截断，从头下载'
            : '磁盘比 DB 记账少：分片确实丢了，从头下载',
          {
            taskId: task.id,
            dbBytes: startBytes,
            fileBytes,
            delta: fileBytes - startBytes,
          },
        );
        completedSegments = [];
        // P2-6：整集重下要烧掉一整份流量（实测一集 780MB），不能像现在这样只在日志里留一行。
        // 直链侧同样的处境早就有话术（`downloadEngine` 的「该地址不支持断点续传，将重新下载」），
        // 这里补齐，用户至少知道进度为什么没了、不是 App 在下错东西。
        appEvents.emit('toast', { text: '本地进度与文件对不上，本集将重新下载', type: 'info' });
        // 第二次 begin 会清空 .part 并从 0 重新计数；播种必须跟着换成它的返回值。
        // 沿用第一次的 actualStartBytes 会让计数器凭空多出一整份旧文件（真机实测
        // 磁盘 881,720 字节 / 计数 1,763,440 字节，正好两倍），进度条与大小校验一起失真。
        started = await sink.begin({ task: { ...task, resumable: false }, startBytes: 0 });
      }
    }

    let downloaded = started.actualStartBytes;
    let lastPersist = now();
    let lastSampleAt = now();
    let lastSampleBytes = downloaded;

    await this.deps.saveProgress(task.id, {
      status: 'downloading',
      downloadedBytes: downloaded,
      totalBytes: null,
      resumable: true,
      speedBps: 0,
      updatedAt: now(),
      completedSegments,
      hlsPlaylistFingerprint: playlistFingerprint,
    });

    // 6. 写入初始化分片（FIX-D5：用独立标志，不再向 completedSegments 写入 -1）
    // DL-R0：`-1` 从不进索引，所以「索引里没有 init」在采纳成品时是常态而不是缺片
    // 证据——成品文件头已经带着这份 init box，再写一次等于在 780MB 尾部拼接第二份。
    let initCompleted = completedSegments.includes(-1);
    const initSegmentSize = playlist.initSegment?.data?.byteLength ?? 0;
    if (playlist.initSegment?.data && !initCompleted && !started.adoptedArtifact) {
      await sink.write(playlist.initSegment.data);
      downloaded += playlist.initSegment.data.byteLength;
      initCompleted = true;
      await sink.flush?.();
      await this.deps.saveProgress(task.id, {
        downloadedBytes: downloaded,
        completedSegments,
        hlsPlaylistFingerprint: playlistFingerprint,
        updatedAt: now(),
      });
    } else if (playlist.initSegment?.data && !started.adoptedArtifact) {
      downloaded += playlist.initSegment.data.byteLength;
    }

    /**
     * 判废分支已经自己结算过账（删掉产物就清零、没删成就留给 DL-R0 接回）。
     * 外面那个 catch 会给「失败」统一补一次断点记账，若不隔开就会把刚清掉的
     * 780 MB 又写回库裡——「有记账、无文件」正是整集重下的起点。
     */
    let refusalSettled = false;

    // 7. 并行下载分片
    try {
      // P0-3: 为每个分片登记索引，用于跳过已完成的分片
      const segmentsWithIndex = playlist.segments.map((seg, idx) => ({ segment: seg, index: idx }));
      // HLS 清单不带总大小，用「已完成分片平均体积 × 总分片数」估算总字节数，
      // 让进度条/剩余时间随下载推进收敛，下载完成后由实际大小覆盖。
      const totalSegments = playlist.segments.length;
      // FIX-D8: completedCount 与 nextWriteIndex 用真实连续前缀，避免续传错位
      const doneSet = new Set(completedSegments.filter((i) => i >= 0));
      let completedCount = 0;
      while (doneSet.has(completedCount)) completedCount += 1;
      let segmentBytes = completedCount > 0 ? downloaded - initSegmentSize : 0;

      // 7. 滑动窗口并行下载分片（FIX-D8：用结果队列替代 Set<Promise>+Promise.race，
      //    避免 settle 结果被静默丢弃导致分片丢失、文件截断）
      // FIX-D5：过滤时排除 -1（旧数据兼容），只检查媒体分片
      const pendingSegments = segmentsWithIndex.filter(({ index }) => index >= 0 && !doneSet.has(index));
      const writeBuffer = new Map<number, Uint8Array>();
      /** DL-P0-2：本轮实际写入分片的内容指纹 → 次数（续传时只统计新写的尾巴，宁可漏判不误杀） */
      const contentDigests = new Map<string, number>();
      /**
       * DL-P0-2：整集产物指纹。把每一片的内容指纹按写入顺序折进一个滚动值——
       * 「不同集下到同一份素材」是集与集之间的现象，集内重复率看不见它（实测这条
       * 死线每集只有 2 片，进不了 ≥8 片的阈值），所以边写边折，零额外 I/O。
       * 断点续传的那一轮只折到本次新取的片，指纹会不同：只会漏判，不会误判。
       */
      let artifactDigest = 0x811c9dc5;
      let nextWriteIndex = completedCount;
      let queueIdx = 0;
      let inflight = 0;
      // 必须早于 downloadSegment/launchNext 声明：初始填充窗口在下面的主循环之前就
      // 调用了 launchNext，晚声明会踩到 TDZ（ReferenceError）。
      let lastActivityAt = now();
      let decryptFailures = 0;
      let firstError: unknown = null;
      let wake: (() => void) | null = null;
      const settled: Array<{ data: Uint8Array; index: number }> = [];

      const downloadSegment = async (seg: { segment: typeof playlist.segments[0]; index: number }) => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_SEGMENT_RETRIES; attempt++) {
          // 发起一次请求就算"有活动"：停滞闸门若只认完成事件，一个正常的
          // 「30s 超时 + 退避」节奏（≈31.5s×2）就会顶穿 60s，把还在重试的窗口判死。
          lastActivityAt = now();
          try {
            // FIX-D1：单分片超时，超时后 abort fetch 触发重试
            const segController = new AbortController();
            const onParentAbort = (): void => segController.abort(abortReasonOf(signal) ?? new AppError('E_ABORTED'));
            signal.addEventListener('abort', onParentAbort, { once: true });
            const timeoutId = setTimeout(() => segController.abort(new AppError('E_NETWORK', `分片下载超时 (${SEGMENT_FETCH_TIMEOUT_MS}ms)`)), SEGMENT_FETCH_TIMEOUT_MS);

            try {
              const rangeHeader = seg.segment.byteRange
                ? `bytes=${seg.segment.byteRange.offset}-${seg.segment.byteRange.offset + seg.segment.byteRange.length - 1}`
                : undefined;
              const response = await this.fetchResourceWithFallback(
                seg.segment.url,
                proxyBase,
                resourceHeaders(rangeHeader ? { Range: rangeHeader } : undefined),
                { ...(task.headers ?? {}), ...(rangeHeader ? { Range: rangeHeader } : {}) },
                fetchImpl,
                segController.signal,
              );

              if (!response.ok) {
                throw this.mapHttpError(response.status, `下载分片失败: ${seg.segment.url}`);
              }

              let data = new Uint8Array(await response.arrayBuffer());
              // FIX-PLAY-A2：上游声明了 Content-Length 就必须足量。
              // content-encoding 存在时跳过——自动解压后长度对应压缩前，比对必然失败。
              const declaredLength = Number(response.headers.get('content-length') ?? '');
              if (
                Number.isFinite(declaredLength)
                && declaredLength > 0
                && !response.headers.get('content-encoding')
                && data.byteLength !== declaredLength
              ) {
                throw segmentIntegrityError(
                  `正文缺量（${data.byteLength}/${declaredLength} 字节）`,
                  seg.segment.url,
                );
              }
              // 200 的错误页不能当分片写进文件——那会产出「任务完成但播不了」的坏产物。
              // 只认 content-type：加密分片的首字节是随机的，正文嗅探会误杀。
              const segmentType = (response.headers.get('content-type') ?? '').toLowerCase();
              if (segmentType.includes('text/html') || segmentType.includes('application/json')) {
                throw new AppError(
                  'E_SOURCE_UNAVAILABLE',
                  '源返回了错误页而不是视频分片（直链可能过期或被限流），请稍后重试或换线路',
                  { detail: seg.segment.url },
                );
              }

              if (seg.segment.key && seg.segment.key.method === 'AES-128') {
                const key = keyCache.get(seg.segment.key.uri);
                if (!key) {
                  throw new AppError('E_PARSE', `密钥未找到: ${seg.segment.key.uri}`);
                }
                const iv = seg.segment.key.iv ? parseIV(seg.segment.key.iv) : this.getDefaultIV(seg.segment, playlist);
                try {
                  data = await decryptAes128(data, key, iv);
                  decryptFailures = 0;
                } catch (decryptErr) {
                  /**
                   * 密钥解不开内容时 `crypto.subtle` 只给一个空消息的 OperationError，
                   * 上层洗成 E_UNKNOWN（「操作失败，请重试」，可重试）→ 987 片 ×3 次重试全部
                   * 空跑，进度永远 0，用户看到的正是"停滞 + 重试无意义"。
                   * 连续 3 片解不开就判死：要么直链过期把密钥换成了错误页（重试能救，见
                   * STALE_LINK_CODES），要么这条线的加密我们本来就解不了（只能换线）。
                   */
                  decryptFailures += 1;
                  if (decryptFailures >= DECRYPT_FAILURE_LIMIT) {
                    throw new AppError(
                      'E_DRM_PROTECTED',
                      `该线路分片解密失败（已连续 ${decryptFailures} 片，密钥与内容不匹配），请重试换新直链或切换线路`,
                      { detail: seg.segment.url, cause: decryptErr },
                    );
                  }
                  throw decryptErr;
                }
              }

              // A2/A3：结构校验放在解密与去前缀之后，检查的是最终要落盘的字节
              return { data: screenSegmentBytes(stripSegmentPrefix(data), { url: seg.segment.url, contentType: segmentType }), index: seg.index };
            } finally {
              clearTimeout(timeoutId);
              signal.removeEventListener('abort', onParentAbort);
            }
          } catch (e) {
            lastError = e;
            // 中止理由优先于本层异常：丢掉 reason 会让 watchdog 的判因在中途变成
            // 一个空消息 AbortError/OperationError，最后被洗成「操作失败，请重试」。
            if (signal.aborted) throw toAppError(abortReasonOf(signal) ?? e, 'E_ABORTED');
            // 可重试的 AppError（5xx / 429 / 超时 / 源侧暂时拒绝）必须走退避重试。
            // 之前「只要是 AppError 就立即抛」让 MAX_SEGMENT_RETRIES 形同虚设：
            // 一次网络抖动就整任务失败，用户看到的就是「偶发中断后再也下不动」。
            if (e instanceof AppError && !e.retryable) throw e;
            if (attempt < MAX_SEGMENT_RETRIES) {
              const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
              logger.warn('分片下载失败，重试中', {
                attempt: attempt + 1,
                backoff,
                // P0-4：带清单序号——「缺哪一片」要能直接对回清单，只有 URL 时归因要人肉数
                segmentIndex: seg.index,
                url: seg.segment.url,
                error: e,
              });
              await new Promise((resolve) => setTimeout(resolve, backoff));
            }
          }
        }
        throw lastError;
      };

      const launchNext = () => {
        if (queueIdx >= pendingSegments.length) return;
        const seg = pendingSegments[queueIdx++]!;
        inflight += 1;
        downloadSegment(seg)
          .then((r) => {
            settled.push(r);
          })
          .catch((e) => {
            firstError ??= e;
          })
          .finally(() => {
            inflight -= 1;
            const w = wake;
            wake = null;
            w?.();
          });
      };

      const writeCompleted = async () => {
        while (writeBuffer.has(nextWriteIndex)) {
          const data = writeBuffer.get(nextWriteIndex)!;
          writeBuffer.delete(nextWriteIndex);
          const digest = segmentFingerprint(data);
          contentDigests.set(digest, (contentDigests.get(digest) ?? 0) + 1);
          artifactDigest = foldFingerprint(artifactDigest, digest);
          await sink.write(data);
          downloaded += data.byteLength;
          segmentBytes += data.byteLength;
          completedCount += 1;
          completedSegments.push(nextWriteIndex);
          nextWriteIndex += 1;

          const currentTime = now();
          if (currentTime - lastPersist >= 1000) {
            await sink.flush?.();
            const elapsedSec = Math.max((currentTime - lastSampleAt) / 1000, 0.001);
            const speedBps = Math.max(0, Math.round((downloaded - lastSampleBytes) / elapsedSec));
            // FIX-D5：用纯媒体分片数估算，排除 init segment
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
              hlsTotalSegments: totalSegments,
              hlsDiscontinuities: playlist.discontinuityCount ?? 0,
              hlsPlaylistFingerprint: playlistFingerprint,
            });
          }
        }
      };

      const waitForActivity = (timeoutMs: number) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            wake = null;
            reject(new AppError('E_NETWORK', `下载停滞超过 ${Math.round(timeoutMs / 1000)}s，自动中断`));
          }, Math.max(timeoutMs, 1));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });

      // 初始填充窗口
      while (inflight < parallelSegments && queueIdx < pendingSegments.length) {
        launchNext();
      }

      // 滑动窗口主循环（FIX-D8：结果队列全量消费，绝不丢弃）
      while (true) {
        if (signal.aborted) throw new AppError('E_ABORTED');

        // 补满窗口
        while (inflight < parallelSegments && queueIdx < pendingSegments.length) {
          launchNext();
        }

        // 消费所有已完成的（关键修复：一次全部取走）
        if (settled.length > 0) {
          for (const r of settled) writeBuffer.set(r.index, r.data);
          settled.length = 0;
          lastActivityAt = now();
          await writeCompleted();
          continue;
        }

        if (firstError) throw firstError;
        if (inflight === 0 && queueIdx >= pendingSegments.length) break;

        // 等待至少一个分片完成或超时
        await waitForActivity(STALL_TIMEOUT_MS - (now() - lastActivityAt));
      }

      // 8. 完成前硬校验（FIX-D8：防止假完成）
      if (completedCount !== totalSegments || writeBuffer.size > 0 || nextWriteIndex !== totalSegments) {
        await sink.flush?.();
        await this.deps.saveProgress(task.id, {
          downloadedBytes: downloaded,
          resumable: true,
          updatedAt: now(),
          completedSegments,
          hlsTotalSegments: totalSegments,
          hlsDiscontinuities: playlist.discontinuityCount ?? 0,
          hlsPlaylistFingerprint: playlistFingerprint,
        });
        throw new AppError(
          'E_NETWORK',
          `HLS 分片不完整（已写 ${completedCount}/${totalSegments}），已保留断点等待续传`,
        );
      }

      /*
       * DL-P0-2：占位内容闸门。放在 finish() 之前——假片不该被 rename 成"成品"，
       * 也不该在库里留下可播的 filePath。判成不可重试：同一份清单重试只会再拿到
       * 同一堆重复分片，退避两次只是把失败推迟几秒、让列表反复闪「等待中」。
       */
      const digestTotal = [...contentDigests.values()].reduce((sum, count) => sum + count, 0);
      if (isPlaceholderContent(digestTotal, contentDigests.size)) {
        logger.error('HLS 分片内容高度重复，判定为占位资源', {
          taskId: task.id,
          segments: digestTotal,
          distinct: contentDigests.size,
        });
        throw new AppError(
          'E_FAKE_SOURCE_CONTENT',
          `该线路的分片高度重复（${digestTotal} 片只有 ${contentDigests.size} 种内容），像是占位资源，请更换线路或源`,
          { retryable: false },
        );
      }

      const result = await sink.finish();
      // FIX-D8: 用 sink 实际写入大小回写，保证 DB 与磁盘一致。
      // 大小对不上的硬拦截在 `NativeFsSink.finish()` 里做（只有它量得到磁盘），
      // 到这一步两边都是同一个真实字节数，剩下来的是 Web Blob 路径的兜底日志。
      if (result.size !== downloaded) {
        logger.error('HLS 产物大小与写入计数不一致', {
          taskId: task.id,
          sinkSize: result.size,
          downloaded,
        });
      }
      await this.deps.saveProgress(task.id, {
        downloadedBytes: result.size,
        totalBytes: result.size,
        filePath: result.filePath,
        blobKey: result.blobKey,
        speedBps: 0,
        updatedAt: now(),
        completedAt: now(),
        // FIX-D8：进度写入有 1s 节流，收尾这一段若不带索引，索引就永远少于
        // hlsTotalSegments，被 checkCorruptedHlsTasks 误判成"假完成"。
        completedSegments,
        hlsTotalSegments: totalSegments,
        hlsDiscontinuities: playlist.discontinuityCount ?? 0,
        hlsPlaylistFingerprint: playlistFingerprint,
        /*
         * P0-4：容器判定跟着产物一起落库。此前 `container` 只有转封装交付那几笔才会写，
         * 一条没转封装的 TS/fMP4 记录永远停在「尚未判定」，MIME、文件自检、播放器选型
         * 只能各自按扩展名再猜一次。
         */
        container: playlist.container ?? 'other',
        /*
         * DL-R0：本轮一片都没新写（采纳了已晋升的成品）时，滚动指纹还停在种子值上，
         * 那份数字不代表任何内容。写进库会让两条同样「只收尾」的任务互相认成双胞胎，
         * 而 DL-P0-2 的跨集查重正是拿它当证据的——等于凭空造出「同一份素材」的误判。
         * 没有新写入就保持原值（老记录本来就是 undefined，天然不参与查重）。
         */
        ...(pendingSegments.length === 0 ? {} : { contentDigest: artifactDigest.toString(16) }),
      });

      logger.debug('HLS 下载完成', {
        taskId: task.id,
        size: result.size,
        segments: completedCount,
        // FIX-PLAY-D1：边界数进日志，坏件归因时能直接看出这条流拼过几段
        discontinuities: playlist.discontinuityCount ?? 0,
        /*
         * P0-4：交付口径的三条清单证据。初始化段只记声明形态不记地址（URL 里带签名）；
         * `segmentIndex` 是连续写入水位，收尾时必须等于总分片数-1，短一截就是缺片。
         */
        initMap: playlist.initSegment ? 'declared' : 'none',
        initMapDistinct: playlist.initMapCount ?? 0,
        containerDetected: playlist.container ?? 'other',
        segmentIndex: nextWriteIndex - 1,
      });

      /*
       * D-06: HLS 下载完成后交付（无损，不重编码），让 WebView 原生播放器可播。
       * 转封装失败不阻断下载——保留 .ts 文件，播放时由 PlayerController 走原生引擎；
       * 时间轴自检也归这一类（原生侧就是按「丢弃 mp4、留住 ts」设计的，详见下面判废处的说明）。
       *
       * P0-3：原生侧一律 `deleteInput: false`——原件的删除权收回到 JS，且排在「复检通过 +
       * 记录改指 .mp4」之后（详见 `deliverRemux`）。此前 `deleteInput: true` 是原生在返回之前
       * 就删掉 `.ts`，于是「转封装当场报错」「进程停在发布与落库之间」都会留下
       * 一份没验证过的 .mp4 或一份没被引用的 .mp4，而记录还指着已经不存在的 .ts——
       * 用户侧就是「转封装过的视频报时间轴异常 / 整集重下」。
       *
       * P0-4：交付按清单声明的容器分流，并受 `download.remuxToMp4` 开关约束——
       * - fMP4 的字节本来就是 MP4 家族，请原生转封装只会拿到一句 `skipped: fmp4-passthrough`
       *   （什么都不做），所以这里只做「复检 → 改名 → 落库」，一次转码都不跑；
       * - TS 与「认不出来」（沿用旧口径，交给原生探测）走转封装；
       * - 开关关掉时新下载与存量任务都不转换，原件直接就是成品；
       * - 整段登记成 postprocess 阶段，看门狗不再把「正在后处理」读成「传输停滞」；
       *   用户取消要接到原生 `cancelRemux`，晚到的结果不许提交。
       */
      let deliveredPath = result.filePath;
      let delivery: RemuxDelivery | null = null;
      const detectedContainer: DownloadContainer = playlist.container ?? 'other';
      if ((playlist.initMapCount ?? 0) > 1) {
        // P0-4：中途换过初始化段——这份合并产物只有一个文件头，不能按有效 fMP4 交付
        logger.warn('P0-4：清单声明了多个初始化段，容器降级为 other 并按原件兜底交付', {
          taskId: task.id,
          initMapDistinct: playlist.initMapCount ?? 0,
          containerDetected: detectedContainer,
        });
      }
      if (isNative() && isMediaToolAvailable() && result.filePath && task.format === 'hls') {
        const notify = (state: 'start' | 'done' | 'skipped' | 'failed', reason?: string): void => {
          this.deps.onPostProcess?.(task, 'remux', state, reason ? { reason } : undefined);
        };
        const inputPath = result.filePath;
        // 交付名只认「合并产物叫 .ts」这一约定（见 `extensionOf`）：别的扩展名不去猜目标名
        const outputPath = inputPath.replace(/\.ts$/i, '.mp4');
        const remuxSetting = (await settingsService.get().catch(() => null))?.download.remuxToMp4;
        if (remuxSetting === false) {
          logger.info('P0-4：remuxToMp4 已关闭，跳过容器转换（原件即成品）', {
            taskId: task.id,
            containerDetected: detectedContainer,
            postProcessPhase: 'none',
          });
        } else if (outputPath === inputPath) {
          logger.info('P0-4：产物不是 TS 命名，不做容器交付', { taskId: task.id, inputPath });
        } else if (detectedContainer === 'fmp4') {
          notify('start');
          beginPhase(task.id, 'postprocess', 'fMP4 交付复检', FMP4_DELIVERY_PHASE_BUDGET_MS);
          try {
            delivery = await deliverRenamedArtifact({
              taskId: task.id,
              inputPath,
              outputPath,
              inputBytes: result.size,
              previousRemux: task.remux,
              container: 'fmp4',
              deps: { update: async (patch) => this.deps.saveProgress(task.id, patch) },
            });
          } finally {
            endPhase(task.id);
          }
          deliveredPath = delivery.deliveredPath;
          if (delivery.outcome === 'done') notify('done');
          else notify('failed', delivery.reason ?? delivery.outcome);
        } else {
          // P0-4：剩余空间放不下第二份产物时不去撞原生那句 insufficient-space——提前判定
          // 省掉一次「跑完大半才发现写不下」的白烧，原件不受影响。取不到空间信息时放行。
          const space = await getStorageInfo('downloads');
          if (space && space.freeBytes < result.size * REMUX_FREE_SPACE_RATIO) {
            logger.warn('P0-4：剩余空间不足以容纳转封装产物，跳过转换', {
              taskId: task.id,
              freeBytes: space.freeBytes,
              inputBytes: result.size,
            });
            notify('skipped', 'insufficient-space');
            delivery = await deliverRemux({
              taskId: task.id,
              inputPath,
              outputPath,
              inputBytes: result.size,
              decision: decideRemuxDelivery({ result: { skipped: true, reason: 'insufficient-space' } }),
              previousRemux: task.remux,
              deps: {
                update: async (patch) => this.deps.saveProgress(task.id, patch),
                removeInput: () => deleteFile(inputPath),
              },
            });
            deliveredPath = delivery.deliveredPath;
          } else {
            notify('start');
            beginPhase(task.id, 'postprocess', '转封装 MP4', REMUX_TIMEOUT_MS + REMUX_PHASE_GRACE_MS);
            let remuxResult: RemuxResultLike | null = null;
            let remuxError: unknown = null;
            const onCancel = (): void => {
              // P0-4：取消要真的打断原生那一笔，否则单线程 executor 还在写第二份产物、
              // 队列槽位被占住，用户看到的「取消」迟迟不生效。
              void MediaTool.cancelRemux({ taskId: task.id, inputPath })
                .then((ack) => logger.info('P0-4：取消已送达原生转封装', { taskId: task.id, cancelAck: ack?.canceled === true }))
                .catch((cancelErr) =>
                  logger.warn('P0-4：cancelRemux 未送达', {
                    taskId: task.id,
                    error: cancelErr instanceof Error ? cancelErr.message || String(cancelErr) : String(cancelErr),
                  }),
                );
            };
            signal.addEventListener('abort', onCancel, { once: true });
            try {
              logger.debug('开始转封装 TS → MP4', {
                taskId: task.id,
                inputPath,
                outputPath,
                containerDetected: detectedContainer,
              });
              remuxResult = await MediaTool.remuxMp4({
                inputPath,
                outputPath,
                taskId: task.id,
                /*
                 * P0-4：这一支只在清单说 TS 或「认不出来」时进入（fMP4 已在上一支交付）。
                 * 原生只按 `fmp4` 这一个值做 passthrough 分流，其余一律实测探测，
                 * 所以这里照实报判定的结果，不再替 `other` 认一份 TS。
                 */
                container: detectedContainer,
                deleteInput: false,
                timeoutMs: REMUX_TIMEOUT_MS,
              });
            } catch (remuxErr) {
              /* reason 是给支持者看的技术线索：未包装的异常会只剩「操作失败，请重试」 */
              remuxError = remuxErr;
              logger.warn('转封装抛出异常，按盘上实况对账', {
                taskId: task.id,
                error: remuxErr instanceof Error ? remuxErr.message || String(remuxErr) : String(remuxErr),
              });
            } finally {
              signal.removeEventListener('abort', onCancel);
              endPhase(task.id);
            }
            if (signal.aborted) {
              // P0-4：晚到结果不得提交。这一轮用户已经取消，产物归属交给下一轮 DL-R0 与开机对账；
              // 盘上若留下没被引用的 .mp4，对账会按复检结论认领或删除。
              const canceled: RemuxDecision = {
                status: 'failed',
                outcome: 'canceled',
                reason: 'canceled-during-remux',
                deliverable: false,
              };
              await recordRemuxFailure(canceled, { update: async (patch) => this.deps.saveProgress(task.id, patch) }, remuxResult?.durationMs);
              notify('failed', 'canceled');
              throw new AppError('E_ABORTED');
            }
            const decision = remuxError !== null
              ? decideRemuxDelivery({ error: remuxError })
              : decideRemuxDelivery({ result: remuxResult });
            delivery = await deliverRemux({
              taskId: task.id,
              inputPath,
              outputPath,
              inputBytes: result.size,
              decision,
              result: remuxResult,
              previousRemux: task.remux,
              deps: {
                update: async (patch) => this.deps.saveProgress(task.id, patch),
                removeInput: () => deleteFile(inputPath),
              },
            });
            deliveredPath = delivery.deliveredPath;
            if (delivery.outcome === 'done') notify('done');
            else if (delivery.status === 'skipped') notify('skipped', delivery.reason);
            else notify('failed', delivery.reason ?? delivery.outcome);
          }
        }
      }

      /*
       * DL-P0-2 闭环：跨集同指纹——同一部剧的不同集下到逐字节相同的素材，只可能是占位。
       * 集内重复率看不见它（实测这条死线每集只发 2 片，永远进不了 ≥8 片的阈值），
       * 所以要在这份产物晋升成成品之后再拦一次。判失败宁可让用户换线路，
       * 也不要一个「已完成」骗人到点开为止；顺手删掉被拒的产物，
       * 免得任务已失败、文件却还占着本地存储。
       *
       * 时间轴自检不在这道网里。原生侧对那条判决的定义正好相反
       * （`MediaRemuxer.inspectTimeline`：不合格就丢弃 `.mp4`、**输入 `.ts` 保留**，
       * 播放回落到原生引擎直接解封装 TS），拿它当占位证据等于把一整集真实内容删掉。
       * 真机实测一份 1920x1080 / 2h44m30s 的片子被判 ratchet=49%：121,787/246,820 视频样本
       * 时间戳回退、音频 0/28,627 回退，而 246,820 ÷ 9,870.08s = 25.0 fps、
       * 779,919,880 ÷ 246,820 = 3,160 B/样本——这是 B 帧流按解码序出样的正常形态，不是坏件。
       * 旧校准用的那批 881,720 字节假件太小，看不见这两种形态的重叠区。
       */
      // 查库失败只少一道网：一次读盘异常不该把已经下好的视频判成占位内容。
      const twinEpisode = await this.deps
        .findTwinArtifact?.(task.mediaId, task.id, artifactDigest.toString(16))
        .catch(() => null);
      if (twinEpisode) {
        const refusal = `与已下载的「${twinEpisode}」是同一份内容`;
        logger.error('HLS 产物被判为占位内容，拒绝交付', { taskId: task.id, reason: refusal, size: result.size });
        /*
         * 删得成就把账一起清零：产物已经不在了，库里却留着 779 MB 记账和一份 988/988 的
         * 分片索引，下一轮无论走重试、开机恢复还是僵尸交回，都会先撞「有记账、无文件」
         * 再整集重下——这一集今天已经这样烧掉三轮 780 MB。
         * 删不成（权限/IO 失败）时反过来要留账：文件还在盘上，DL-R0 的采纳门槛能拿它
         * 零流量接回，清零只是把一份可用产物换成一次 780 MB 的重下。
         */
        let artifactGone: boolean;
        if (deliveredPath && isNative()) {
          artifactGone = await deleteFile(deliveredPath).then(() => true).catch(() => false);
          /*
           * P0-3：`db-commit-failed` 时记录仍指 `.ts`，但盘上多了一份没被任何记录引用的 `.mp4`。
           * 任务既然判废，那份孤儿也必须一起清掉——否则它会在下次开机对账里被"认领"回来，
           * 把这一集已经烧掉的流量再算成一份有效成品。
           */
          if (delivery?.outcome === 'db-commit-failed') {
            await deleteFile(deliveredPath.replace(/\.ts$/, '.mp4')).catch(() => undefined);
          }
        } else {
          // Web 的 Blob 产物：`blobKey` 一清就再也指不回那份数据，等同已删除
          artifactGone = !deliveredPath;
        }
        refusalSettled = true;
        await this.deps
          .saveProgress(task.id, {
            filePath: null,
            blobKey: null,
            contentDigest: null,
            ...(artifactGone
              ? { downloadedBytes: 0, totalBytes: null, completedSegments: [], hlsTotalSegments: 0 }
              : {}),
            updatedAt: now(),
          })
          .catch(() => undefined);
        throw new AppError('E_FAKE_SOURCE_CONTENT', `该线路的产物疑似占位内容（${refusal}），请更换线路或源`, {
          retryable: false,
        });
      }
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
          const suspended = await sink.suspend().then(
            () => true,
            () => false,
          );
          if (!suspended) {
            logger.warn('暂停时落盘失败，保留上一份 DB 检查点', { taskId: task.id });
          }
          /**
           * DL-P1-4：`suspend()` 会把写盘缓冲刷干净——文件长度从此等于 `downloaded`，
           * 但 DB 里还是上一次节流（1s）的旧值。真机实测「暂停→立即继续」三次命中：
           * 47.8MB / 171MB / 254MB 的 .part 都比 DB 多一截，于是被判成损坏、
           * `completedSegments` 整段作废、重下全集。停笔即结算：刷完盘立刻把成对的真值写回去，
           * 下一轮 begin 就能对上号。
           *
           * 判废分支不走这段：它已经按「产物还在不在」自己结算过账，这里再写一遍等于把
           * 刚清零的 779 MB 记账恢复回去——真机那条 `dbBytes: 779919880 / fileBytes: 0`
           * 就是这么配对出来的。
           */
          if (!refusalSettled && suspended) {
            await this.deps
              .saveProgress(task.id, {
                downloadedBytes: downloaded,
                completedSegments,
                resumable: true,
                hlsPlaylistFingerprint: playlistFingerprint,
                updatedAt: now(),
              })
              .catch(() => undefined);
          }
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
        // FIX-D1：清单获取超时
        const manifestController = new AbortController();
        const onManifestAbort = (): void => manifestController.abort();
        signal.addEventListener('abort', onManifestAbort, { once: true });
        const manifestTimer = setTimeout(() => manifestController.abort(new AppError('E_NETWORK', `清单代理请求超时: ${url}`)), MANIFEST_KEY_TIMEOUT_MS);
        try {
          const response = await fetchImpl(`${proxyBase}/${encodeURIComponent(url)}`, {
            method: 'GET',
            signal: manifestController.signal,
            cache: 'no-store',
          });
          if (response.ok) {
            return {
              text: await response.text(),
              baseUrl: manifestBaseUrl(response.url, url),
              contentType: response.headers.get('content-type'),
            };
          }
          logger.warn('清单代理请求返回非 2xx，回退直连', { url, status: response.status });
        } finally {
          clearTimeout(manifestTimer);
          signal.removeEventListener('abort', onManifestAbort);
        }
      } catch (e) {
        if (signal.aborted) throw new AppError('E_ABORTED');
        logger.warn('清单代理请求失败，回退直连', { url, error: (e as Error)?.message ?? String(e) });
      }
    }
    // FIX-D1：直连清单也加超时
    const directController = new AbortController();
    const onDirectAbort = (): void => directController.abort();
    signal.addEventListener('abort', onDirectAbort, { once: true });
    const directTimer = setTimeout(() => directController.abort(new AppError('E_NETWORK', `清单直连请求超时: ${url}`)), MANIFEST_KEY_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
        signal: directController.signal,
        cache: 'no-store',
      });
    } finally {
      clearTimeout(directTimer);
      signal.removeEventListener('abort', onDirectAbort);
    }
    if (!response.ok) throw this.mapHttpError(response.status, label);
    return {
      text: await response.text(),
      baseUrl: manifestBaseUrl(response.url, url),
      contentType: response.headers.get('content-type'),
    };
  }

  /**
   * FIX-CORS: 资源请求（init/key/segment）代理失败时降级直连。
   *
   * 与 `fetchManifestText` 的兜底模式一致：代理路径抛 TypeError（CORS/连接失败）
   * 时回退直连；HTTP 状态码错误与 AppError 不降级，保持原有语义。
   */
  private async fetchResourceWithFallback(
    originalUrl: string,
    proxyBase: string | null,
    proxyHeaders: Record<string, string>,
    directHeaders: Record<string, string> | undefined,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
  ): Promise<Response> {
    if (proxyBase && !isLocalhostUrl(originalUrl)) {
      try {
        return await fetchImpl(`${proxyBase}/${encodeURIComponent(originalUrl)}`, {
          method: 'GET',
          headers: proxyHeaders,
          signal,
          cache: 'no-store',
        });
      } catch (e) {
        if (signal.aborted) throw new AppError('E_ABORTED');
        if (e instanceof AppError) throw e;
        logger.warn('资源代理请求失败，回退直连', { url: originalUrl, error: (e as Error)?.message ?? String(e) });
      }
    }
    return fetchImpl(originalUrl, {
      method: 'GET',
      headers: directHeaders && Object.keys(directHeaders).length > 0 ? directHeaders : undefined,
      signal,
      cache: 'no-store',
    });
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
   *
   * EXT-04/D-04：实现下沉为模块级导出函数，供预检模块复用同一口径（避免两套选流规则漂移）；
   * 行为与此前完全一致。
   */
  private selectVariant(variants: HlsVariant[], quality: 'max' | '1080p' | '720p' | 'auto'): HlsVariant {
    return selectHlsVariantForQuality(variants, quality);
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
      // 402 在这类 CDN 上就是「URL 里的签名过期/不被接受」（auth_key=<到期时间>-…-<md5>），
      // 归 403 同族才能进 STALE_LINK_CODES 换新直链；文案保留真实状态码，不改状态语义。
      status === 402 ? 'E_HTTP_403' :
      status === 403 ? 'E_HTTP_403' :
      status === 404 ? 'E_HTTP_404' :
      // 限流是可重试的：之前落到 E_HTTP_400（不可重试），一被限流就整任务判死
      status === 429 ? 'E_HTTP_429' :
      status >= 500 ? 'E_HTTP_5XX' :
      'E_HTTP_400';
    return new AppError(code, `${message}：HTTP ${status}`, { httpStatus: status });
  }
}

export function createHlsDownloader(deps: HlsDownloaderDeps): HlsDownloader {
  return new HlsDownloader(deps);
}
