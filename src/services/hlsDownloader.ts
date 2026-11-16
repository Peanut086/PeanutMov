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
import { MediaTool, isMediaToolAvailable } from '@/native/mediaToolPlugin';
import { findProtectedKeyEvidence } from '@/player/sourceGuard';
import { createSink, type DownloadSink } from '@/services/downloadSink';
import type { DownloadTask } from '@/types';

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
/** FIX-D1：主循环停滞阈值（60s 无任何分片完成 → 判定卡死） */
const STALL_TIMEOUT_MS = 60_000;

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
        playlist = parseM3u8(document.text, document.baseUrl, document.contentType);
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
    let completedSegments = task.completedSegments ?? [];
    const startBytes = completedSegments.length > 0 ? task.downloadedBytes : 0;
    // P1-2: 以 .part 实际大小为准，与 DB 不一致时从头下载避免错位
    const beginResult = await sink.begin({ task: { ...task, resumable: true }, startBytes });
    if (beginResult.actualStartBytes !== startBytes && startBytes > 0) {
      logger.warn('续传状态与 .part 不一致，从头下载', {
        taskId: task.id,
        dbBytes: startBytes,
        fileBytes: beginResult.actualStartBytes,
      });
      completedSegments = [];
      await sink.begin({ task: { ...task, resumable: false }, startBytes: 0 });
    }

    let downloaded = beginResult.actualStartBytes;
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
    });

    // 6. 写入初始化分片（FIX-D5：用独立标志，不再向 completedSegments 写入 -1）
    let initCompleted = completedSegments.includes(-1);
    const initSegmentSize = playlist.initSegment?.data?.byteLength ?? 0;
    if (playlist.initSegment?.data && !initCompleted) {
      await sink.write(playlist.initSegment.data);
      downloaded += playlist.initSegment.data.byteLength;
      initCompleted = true;
      await this.deps.saveProgress(task.id, {
        downloadedBytes: downloaded,
        completedSegments,
        updatedAt: now(),
      });
    } else if (playlist.initSegment?.data) {
      downloaded += playlist.initSegment.data.byteLength;
    }

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
      let nextWriteIndex = completedCount;
      let queueIdx = 0;
      let inflight = 0;
      let firstError: unknown = null;
      let wake: (() => void) | null = null;
      const settled: Array<{ data: Uint8Array; index: number }> = [];

      const downloadSegment = async (seg: { segment: typeof playlist.segments[0]; index: number }) => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_SEGMENT_RETRIES; attempt++) {
          try {
            // FIX-D1：单分片超时，超时后 abort fetch 触发重试
            const segController = new AbortController();
            const onParentAbort = (): void => segController.abort();
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
                data = await decryptAes128(data, key, iv);
              }

              // A2/A3：结构校验放在解密与去前缀之后，检查的是最终要落盘的字节
              return { data: screenSegmentBytes(stripSegmentPrefix(data), { url: seg.segment.url, contentType: segmentType }), index: seg.index };
            } finally {
              clearTimeout(timeoutId);
              signal.removeEventListener('abort', onParentAbort);
            }
          } catch (e) {
            lastError = e;
            if (signal.aborted) throw toAppError(e, 'E_ABORTED');
            // 可重试的 AppError（5xx / 429 / 超时 / 源侧暂时拒绝）必须走退避重试。
            // 之前「只要是 AppError 就立即抛」让 MAX_SEGMENT_RETRIES 形同虚设：
            // 一次网络抖动就整任务失败，用户看到的就是「偶发中断后再也下不动」。
            if (e instanceof AppError && !e.retryable) throw e;
            if (attempt < MAX_SEGMENT_RETRIES) {
              const backoff = RETRY_BACKOFF_MS[attempt] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
              logger.warn('分片下载失败，重试中', { attempt: attempt + 1, backoff, url: seg.segment.url, error: e });
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
          await sink.write(data);
          downloaded += data.byteLength;
          segmentBytes += data.byteLength;
          completedCount += 1;
          completedSegments.push(nextWriteIndex);
          nextWriteIndex += 1;

          const currentTime = now();
          if (currentTime - lastPersist >= 1000) {
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
      let lastActivityAt = now();
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
        await this.deps.saveProgress(task.id, {
          downloadedBytes: downloaded,
          resumable: true,
          updatedAt: now(),
          completedSegments,
          hlsTotalSegments: totalSegments,
        });
        throw new AppError(
          'E_NETWORK',
          `HLS 分片不完整（已写 ${completedCount}/${totalSegments}），已保留断点等待续传`,
        );
      }

      const result = await sink.finish();
      // FIX-D8: 用 sink 实际写入大小回写，保证 DB 与磁盘一致
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
      });

      logger.debug('HLS 下载完成', { taskId: task.id, size: result.size, segments: completedCount });

      // D-06: HLS 下载完成后转封装 TS → MP4（无损，不重编码），让 WebView 原生播放器可播。
      // 转封装失败不阻断下载——保留 .ts 文件，播放时由 PlayerController 走原生引擎。
      if (isNative() && isMediaToolAvailable() && result.filePath && task.format === 'hls') {
        const inputPath = result.filePath;
        const outputPath = inputPath.replace(/\.ts$/, '.mp4');
        if (outputPath !== inputPath) {
          const notify = (state: 'start' | 'done' | 'skipped' | 'failed', reason?: string): void => {
            this.deps.onPostProcess?.(task, 'remux', state, reason ? { reason } : undefined);
          };
          /*
           * OPT-05：跳过/失败也要落库。此前只有成功才写 `remux`，任务停在 `remux: null`，
           * UI 分不清「没开转封装 / 转封装失败 / 还在转」，用户只能看到文件一直是 .ts。
           * 落库失败只记日志——转封装的任何问题都不该把已下好的视频判成下载失败。
           */
          const record = async (status: 'skipped' | 'failed', reason?: string): Promise<void> => {
            try {
              await this.deps.saveProgress(task.id, {
                remux: reason ? { status, reason } : { status },
                updatedAt: now(),
              });
            } catch (persistErr) {
              logger.warn('转封装状态落库失败', { taskId: task.id, error: toAppError(persistErr).message });
            }
          };
          notify('start');
          try {
            logger.debug('开始转封装 TS → MP4', { taskId: task.id, inputPath, outputPath });
            const remuxResult = await MediaTool.remuxMp4({
              inputPath,
              outputPath,
              taskId: task.id,
              container: 'ts',
              deleteInput: true,
              timeoutMs: 300_000,
            });
            if (remuxResult.ok && !remuxResult.skipped) {
              // P0-2: 转封装后体积会变（MP4 容器开销小于 TS 包头），
              // 一并回写字节数，否则「本地存储」与任务详情会一直显示旧的 TS 体积。
              const outputBytes = remuxResult.outputBytes ?? result.size;
              await this.deps.saveProgress(task.id, {
                filePath: outputPath,
                format: 'mp4',
                container: 'mp4',
                downloadedBytes: outputBytes,
                totalBytes: outputBytes,
                remux: { status: 'done', durationMs: remuxResult.durationMs },
                updatedAt: now(),
              });
              logger.info('转封装完成', { taskId: task.id, outputBytes });
              notify('done');
            } else if (remuxResult.skipped) {
              logger.debug('转封装跳过', { taskId: task.id, reason: remuxResult.reason });
              await record('skipped', remuxResult.reason);
              notify('skipped', remuxResult.reason);
            } else {
              logger.warn('转封装失败，保留 .ts', { taskId: task.id, code: remuxResult.code, reason: remuxResult.reason });
              await record('failed', remuxResult.reason ?? remuxResult.code);
              notify('failed', remuxResult.reason ?? remuxResult.code);
            }
          } catch (remuxErr) {
            /* reason 是给支持者看的技术线索：`toAppError` 会把无码异常统一洗成「操作失败，请重试」 */
            const message = remuxErr instanceof Error ? remuxErr.message || String(remuxErr) : String(remuxErr);
            logger.warn('转封装异常，保留 .ts', { taskId: task.id, error: message });
            await record('failed', message);
            notify('failed', message);
          }
        }
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
      status === 403 ? 'E_HTTP_403' :
      status === 404 ? 'E_HTTP_404' :
      // 限流是可重试的：之前落到 E_HTTP_400（不可重试），一被限流就整任务判死
      status === 429 ? 'E_HTTP_429' :
      status >= 500 ? 'E_HTTP_5XX' :
      'E_HTTP_400';
    return new AppError(code, `${message}：HTTP ${status}`);
  }
}

export function createHlsDownloader(deps: HlsDownloaderDeps): HlsDownloader {
  return new HlsDownloader(deps);
}
