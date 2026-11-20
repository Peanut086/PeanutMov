/**
 * 下载预检（API-19 / FR-65）
 *
 * 职责：入队**之前**判定"能不能下、下多大的、要多少空间、要不要用户确认"。
 * 本模块：
 * - 不创建任务、不写库（纯查询）；
 * - 清单解析复用 `hlsDownloader` 的解析/DRM 判定/302 基线（FIX-03/04 口径，禁止另写一套）；
 * - 网络请求优先走 LocalProxy（CapacitorHttp 拒 3xx），代理不可用才直连；
 * - 只做"清单 + 1 个分片 64KB"探测，**不逐分片 HEAD**、不发密钥请求（避免触发防盗链/限流）。
 *
 * UI 不直接 import 本模块（只能经 `downloadService.preflight` / `downloadStore.preflight`）。
 */
import {
  DOWNLOAD_PREFLIGHT_CACHE_MAX,
  DOWNLOAD_PREFLIGHT_CACHE_TTL_MS,
  DOWNLOAD_PREFLIGHT_MAX_PARALLEL,
  DOWNLOAD_PREFLIGHT_PROBE_BYTES,
  DOWNLOAD_PREFLIGHT_TIMEOUT_MS,
} from '@/shared/constants';
import { AppError, ERROR_MESSAGES } from '@/shared/errors';
import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';
import { LocalProxy } from '@/native/localProxy';
import { getNetworkStatus, isOnline, type NetworkStatus } from '@/native/network';
import { getStorageInfo, type StorageInfo } from '@/native/mediaToolPlugin';
import {
  assertSupportedKeyMethods,
  manifestBaseUrl,
  parseM3u8,
  selectHlsVariantForQuality,
  type HlsPlaylist,
  type HlsVariant,
} from '@/services/hlsDownloader';
import { settingsService } from '@/services/settingsService';
import type {
  CreateDownloadInput,
  DownloadContainer,
  DownloadSettings,
  DownloadTask,
  HlsQuality,
} from '@/types';

/* ---------------- 契约类型（API-16 §3.1.1） ---------------- */

export interface PreflightVariantView {
  index: number;
  label: string;
  width: number | null;
  height: number | null;
  bandwidth: number;
  estimatedBytes: number | null;
}

export interface PreflightSelectedVariant {
  index: number;
  label: string;
  height: number | null;
  bandwidth: number;
}

export interface PreflightProbeView {
  segmentOk: boolean;
  latencyMs: number;
  status: number | null;
  redirected: boolean;
}

export interface PreflightSubtitleView {
  lang: string;
  format: 'vtt' | 'srt';
  available: boolean;
}

export interface PreflightItem {
  episodeId: string;
  ok: boolean;
  format: CreateDownloadInput['format'];
  container: DownloadContainer | null;
  drmProtected: boolean;
  durationSec: number | null;
  variants: PreflightVariantView[];
  selectedVariant: PreflightSelectedVariant | null;
  estimatedBytes: number | null;
  estimatedBytesApproximate: boolean;
  probe: PreflightProbeView | null;
  subtitles: PreflightSubtitleView[];
  notes: string[];
}

export type PreflightBlockedReason = 'drm' | 'unsupported-format' | 'storage' | 'wifi-only' | 'unreachable';

export interface PreflightBlocked {
  reason: PreflightBlockedReason;
  code: keyof typeof ERROR_MESSAGES;
  message: string;
  episodeIds: string[];
}

export interface PreflightStorageView {
  freeBytes: number;
  requiredBytes: number;
  enough: boolean;
  reserveBytes: number;
}

export interface PreflightNetworkView {
  type: NetworkStatus['type'];
  wifiOnlyBlocked: boolean;
}

export interface PreflightResult {
  items: PreflightItem[];
  network: PreflightNetworkView;
  storage: PreflightStorageView;
  canStart: boolean;
  blocked: PreflightBlocked | null;
  elapsedMs: number;
}

export interface PreflightOptions {
  hlsQuality?: HlsQuality;
  probeSegment?: boolean;
  timeoutMs?: number;
  maxParallel?: number;
  /** 外部取消（UI 关闭面板） */
  signal?: AbortSignal;
}

/* ---------------- 内部：清单缓存与请求 ---------------- */

interface ManifestDoc {
  text: string;
  baseUrl: string;
}

interface CachedManifest extends ManifestDoc {
  at: number;
}

const manifestCache = new Map<string, CachedManifest>();

function hashHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  const entries = Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let hash = 0;
  const joined = entries.map(([k, v]) => `${k}:${v}`).join('|');
  for (let i = 0; i < joined.length; i += 1) {
    hash = (hash * 31 + joined.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function cacheKeyOf(url: string, headers: Record<string, string> | undefined): string {
  return `${url}::${hashHeaders(headers)}`;
}

function readCache(key: string, now: number): ManifestDoc | null {
  const hit = manifestCache.get(key);
  if (!hit) return null;
  if (now - hit.at > DOWNLOAD_PREFLIGHT_CACHE_TTL_MS) {
    manifestCache.delete(key);
    return null;
  }
  return { text: hit.text, baseUrl: hit.baseUrl };
}

function writeCache(key: string, doc: ManifestDoc, now: number): void {
  if (manifestCache.size >= DOWNLOAD_PREFLIGHT_CACHE_MAX) {
    const oldest = manifestCache.keys().next().value;
    if (oldest !== undefined) manifestCache.delete(oldest);
  }
  manifestCache.set(key, { ...doc, at: now });
}

/** 测试辅助：清空清单缓存 */
export function clearPreflightCache(): void {
  manifestCache.clear();
}

function isLocalhost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === '127.0.0.1' || hostname === 'localhost';
  } catch {
    return false;
  }
}

/** 为预检请求登记回环代理基址（Android）；非原生或失败返回 null */
async function resolveProxyBase(url: string, headers: Record<string, string> | undefined): Promise<string | null> {
  if (!isNative()) return null;
  try {
    const result = await LocalProxy.proxy({ url, headers });
    return result.url.replace(/\/+$/, '') || null;
  } catch (e) {
    logger.debug('预检代理不可用，回退直连', { error: (e as Error)?.message ?? String(e) });
    return null;
  }
}

interface FetchTextResult {
  text: string;
  baseUrl: string;
  redirected: boolean;
  status: number;
}

/** 经代理优先、失败回退直连的方式拉取文本资源（清单/分片探测共用） */
async function fetchText(
  url: string,
  headers: Record<string, string> | undefined,
  proxyBase: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
  byteRange?: string,
): Promise<FetchTextResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (proxyBase && !isLocalhost(url)) {
      try {
        const proxied = `${proxyBase}/${encodeURIComponent(url)}`;
        const response = await fetch(proxied, {
          method: 'GET',
          headers: byteRange ? { Range: byteRange } : undefined,
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.ok || response.status === 206) {
          return {
            text: await response.text(),
            baseUrl: manifestBaseUrl(response.url, url),
            redirected: response.redirected || response.url !== proxied,
            status: response.status,
          };
        }
        logger.debug('预检代理返回非 2xx，回退直连', { status: response.status });
      } catch (e) {
        if (signal?.aborted) throw e;
        logger.debug('预检代理请求失败，回退直连', { error: (e as Error)?.message ?? String(e) });
      }
    }
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        ...(headers ?? {}),
        ...(byteRange ? { Range: byteRange } : {}),
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    return {
      text: await response.text(),
      baseUrl: manifestBaseUrl(response.url, url),
      redirected: response.redirected,
      status: response.status,
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/* ---------------- 体积估算 ---------------- */

/** `bandwidth/8 × durationSec`；缺时长/码率时返回 null（不做猜测） */
export function estimateBytes(variant: { bandwidth: number } | null, durationSec: number | null): number | null {
  if (!variant || variant.bandwidth <= 0 || durationSec === null || durationSec <= 0) return null;
  return Math.round((variant.bandwidth / 8) * durationSec);
}

function labelOfVariant(variant: HlsVariant, index: number): string {
  if (variant.resolution) return `${variant.resolution.height}p`;
  if (variant.bandwidth > 0) return `${Math.round(variant.bandwidth / 1000)}kbps`;
  return `线路 ${index + 1}`;
}

function containerOf(playlist: HlsPlaylist): DownloadContainer {
  // P0-4：判定口径收归解析层（`detectHlsContainer`），预检不再第二遍猜容器。
  // 未判定（master 清单、解析降级）时留 `other`，与旧行为一致：预检的容器只用于展示
  // 与空间预留，不参与交付决策。
  return playlist.container ?? 'other';
}

function durationOf(playlist: HlsPlaylist): number | null {
  if (playlist.segments.length === 0) return null;
  const total = playlist.segments.reduce((sum, segment) => sum + (segment.duration || 0), 0);
  return total > 0 ? Math.round(total * 10) / 10 : null;
}

/* ---------------- 清单探测（API-19: probePlaylist） ---------------- */

export interface ProbePlaylistResult {
  variants: HlsVariant[];
  selected: HlsVariant | null;
  container: DownloadContainer | null;
  drmProtected: boolean;
  durationSec: number | null;
  segmentUrl: string | null;
  notes: string[];
  reachable: boolean;
}

export async function probePlaylist(
  url: string,
  headers: Record<string, string> | undefined,
  opts: { quality: HlsQuality; timeoutMs: number; signal?: AbortSignal },
): Promise<ProbePlaylistResult> {
  const notes: string[] = [];
  const key = cacheKeyOf(url, headers);
  const now = Date.now();
  const cacheHit = readCache(key, now);
  const proxyBase = await resolveProxyBase(url, headers);

  let doc = cacheHit;
  let redirected = false;
  if (doc) {
    notes.push('manifest-cached');
  } else {
    const fetched = await fetchText(url, headers, proxyBase, opts.timeoutMs, opts.signal);
    if (fetched.status < 200 || fetched.status >= 300) {
      notes.push('probe-failed');
      notes.push(`http-${fetched.status}`);
      return {
        variants: [],
        selected: null,
        container: null,
        drmProtected: false,
        durationSec: null,
        segmentUrl: null,
        notes,
        reachable: false,
      };
    }
    redirected = fetched.redirected;
    if (redirected) notes.push('manifest-302-followed');
    doc = { text: fetched.text, baseUrl: fetched.baseUrl };
    writeCache(key, doc, now);
  }

  // DRM 双保险的第一道：清单阶段发现受保护密钥即拒绝（不发起密钥/分片请求）
  try {
    assertSupportedKeyMethods(doc.text);
  } catch {
    notes.push('sample-aes');
    return {
      variants: [],
      selected: null,
      container: null,
      drmProtected: true,
      durationSec: null,
      segmentUrl: null,
      notes,
      reachable: true,
    };
  }

  let playlist = parseM3u8(doc.text, doc.baseUrl);
  let variants = playlist.variants ?? [];

  if (playlist.isMaster) {
    if (variants.length === 0) {
      notes.push('no-variants');
      return {
        variants: [],
        selected: null,
        container: null,
        drmProtected: false,
        durationSec: null,
        segmentUrl: null,
        notes,
        reachable: true,
      };
    }
    if (variants.every((variant) => !variant.resolution)) notes.push('variants-without-resolution');

    const selected = selectHlsVariantForQuality(variants, opts.quality);
    const mediaKey = cacheKeyOf(selected.url, headers);
    const mediaCached = readCache(mediaKey, Date.now());
    try {
      const media = mediaCached
        ? { text: mediaCached.text, baseUrl: mediaCached.baseUrl, redirected: false, status: 200 }
        : await fetchText(selected.url, headers, proxyBase, opts.timeoutMs, opts.signal);
      if (media.status >= 200 && media.status < 300) {
        writeCache(mediaKey, { text: media.text, baseUrl: media.baseUrl }, Date.now());
        assertSupportedKeyMethods(media.text);
        playlist = parseM3u8(media.text, media.baseUrl);
      } else {
        notes.push('media-playlist-failed');
      }
    } catch {
      notes.push('media-playlist-failed');
    }

    return {
      variants,
      selected,
      container: playlist.segments.length > 0 ? containerOf(playlist) : null,
      drmProtected: false,
      durationSec: durationOf(playlist),
      segmentUrl: playlist.segments[0]?.url ?? null,
      notes,
      reachable: true,
    };
  }

  variants = [];
  return {
    variants,
    selected: null,
    container: containerOf(playlist),
    drmProtected: false,
    durationSec: durationOf(playlist),
    segmentUrl: playlist.segments[0]?.url ?? null,
    notes,
    reachable: true,
  };
}

/* ---------------- 分片探测（API-19: probeSegment） ---------------- */

export async function probeSegment(
  segmentUrl: string,
  headers: Record<string, string> | undefined,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<PreflightProbeView> {
  const startedAt = Date.now();
  const proxyBase = await resolveProxyBase(segmentUrl, headers);
  try {
    const result = await fetchText(
      segmentUrl,
      headers,
      proxyBase,
      opts.timeoutMs,
      opts.signal,
      `bytes=0-${DOWNLOAD_PREFLIGHT_PROBE_BYTES - 1}`,
    );
    return {
      segmentOk: result.status >= 200 && result.status < 300,
      latencyMs: Date.now() - startedAt,
      status: result.status,
      redirected: result.redirected,
    };
  } catch (e) {
    logger.debug('预检分片探测失败', { error: (e as Error)?.message ?? String(e) });
    return { segmentOk: false, latencyMs: Date.now() - startedAt, status: null, redirected: false };
  }
}

/* ---------------- 直链探测 ---------------- */

interface DirectProbe {
  estimatedBytes: number | null;
  reachable: boolean;
  latencyMs: number;
  status: number | null;
}

async function probeDirect(
  url: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DirectProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { ...(headers ?? {}), Range: 'bytes=0-0' },
      cache: 'no-store',
      signal: controller.signal,
    });
    // 只读取响应头，立即释放 body（避免整片下载）
    void response.body?.cancel().catch(() => undefined);
    const range = response.headers.get('content-range');
    const total = range ? Number.parseInt(range.split('/')[1] ?? '', 10) : NaN;
    const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
    const size = Number.isFinite(total) && total > 0 ? total : Number.isFinite(length) && length > 1 ? length : null;
    return {
      estimatedBytes: size,
      reachable: response.ok || response.status === 206,
      latencyMs: Date.now() - startedAt,
      status: response.status,
    };
  } catch {
    return { estimatedBytes: null, reachable: false, latencyMs: Date.now() - startedAt, status: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/* ---------------- 汇总裁决（API-19: judge） ---------------- */

export function judge(
  items: PreflightItem[],
  storage: PreflightStorageView,
  network: PreflightNetworkView,
  settings: Pick<DownloadSettings, 'wifiOnly'>,
): { canStart: boolean; blocked: PreflightBlocked | null } {
  // wifiOnly 已在 `network.wifiOnlyBlocked` 中折算（含网络类型判断），这里只读该结果
  void settings;
  const idsOf = (predicate: (item: PreflightItem) => boolean): string[] =>
    items.filter(predicate).map((item) => item.episodeId);

  const drmIds = idsOf((item) => item.drmProtected);
  if (drmIds.length > 0) {
    return {
      canStart: false,
      blocked: {
        reason: 'drm',
        code: 'E_DRM_PROTECTED',
        message: ERROR_MESSAGES.E_DRM_PROTECTED,
        episodeIds: drmIds,
      },
    };
  }

  const unsupportedIds = idsOf((item) => item.format === 'other');
  if (unsupportedIds.length > 0) {
    return {
      canStart: false,
      blocked: {
        reason: 'unsupported-format',
        code: 'E_UNSUPPORTED_FORMAT',
        message: ERROR_MESSAGES.E_UNSUPPORTED_FORMAT,
        episodeIds: unsupportedIds,
      },
    };
  }

  if (!storage.enough) {
    return {
      canStart: false,
      blocked: {
        reason: 'storage',
        code: 'E_STORAGE_QUOTA',
        message: ERROR_MESSAGES.E_STORAGE_QUOTA,
        episodeIds: items.map((item) => item.episodeId),
      },
    };
  }

  if (network.wifiOnlyBlocked) {
    return {
      canStart: true,
      blocked: {
        reason: 'wifi-only',
        code: 'E_NETWORK',
        message: '仅 Wi-Fi 下载已开启，本次仍下载？',
        episodeIds: items.map((item) => item.episodeId),
      },
    };
  }

  const unreachableIds = idsOf((item) => !item.ok);
  if (unreachableIds.length === items.length && unreachableIds.length > 0) {
    // 不可达不阻断：预检失败按可下载入队，由引擎层按既有错误码呈现
    return {
      canStart: true,
      blocked: {
        reason: 'unreachable',
        code: 'E_NETWORK',
        message: '检测失败，已按可下载入队',
        episodeIds: unreachableIds,
      },
    };
  }

  return { canStart: true, blocked: null };
}

/* ---------------- 入口：preflight() ---------------- */

function subtitlesOf(input: CreateDownloadInput): PreflightSubtitleView[] {
  return (input.subtitleUrls ?? []).map((subtitle) => ({
    lang: subtitle.lang,
    format: subtitle.format,
    available: true,
  }));
}

function isHlsInput(input: CreateDownloadInput): boolean {
  return input.format === 'hls' || /\.m3u8(\?|$)/i.test(input.url);
}

function unsupported(input: CreateDownloadInput): boolean {
  return input.format === 'other';
}

async function concurrencyMap<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export const downloadPreflight = {
  /**
   * 预检一批（1~50）任务输入。同批同 master 只拉一次清单（60s 缓存）。
   */
  async preflight(inputs: CreateDownloadInput[], options: PreflightOptions = {}): Promise<PreflightResult> {
    const startedAt = Date.now();
    if (!isOnline()) {
      throw new AppError('E_NETWORK', '网络不可用，无法预检');
    }

    const settings = await settingsService.get();
    const quality: HlsQuality = options.hlsQuality ?? settings.download.hlsQuality ?? 'max';
    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DOWNLOAD_PREFLIGHT_TIMEOUT_MS;
    const maxParallel = Math.max(
      1,
      Math.min(options.maxParallel ?? DOWNLOAD_PREFLIGHT_MAX_PARALLEL, DOWNLOAD_PREFLIGHT_MAX_PARALLEL),
    );
    const shouldProbeSegment = options.probeSegment !== false;
    const signal = options.signal;

    const networkStatus = await getNetworkStatus();
    const storageInfo: StorageInfo | null = await getStorageInfo();

    const items = await concurrencyMap(inputs, maxParallel, async (input): Promise<PreflightItem> => {
      if (signal?.aborted) throw new AppError('E_ABORTED');
      const base: PreflightItem = {
        episodeId: input.episodeId,
        ok: true,
        format: input.format,
        container: null,
        drmProtected: false,
        durationSec: null,
        variants: [],
        selectedVariant: null,
        estimatedBytes: null,
        estimatedBytesApproximate: true,
        probe: null,
        subtitles: subtitlesOf(input),
        notes: [],
      };

      if (unsupported(input)) {
        return { ...base, ok: false, notes: ['unsupported-format'] };
      }

      if (isHlsInput(input)) {
        try {
          const probe = await probePlaylist(input.url, input.headers, {
            quality,
            timeoutMs,
            signal,
          });
          const variants: PreflightVariantView[] = probe.variants.map((variant, index) => ({
            index,
            label: labelOfVariant(variant, index),
            width: variant.resolution?.width ?? null,
            height: variant.resolution?.height ?? null,
            bandwidth: variant.bandwidth,
            estimatedBytes: estimateBytes(variant, probe.durationSec),
          }));
          const selectedHeight = probe.selected?.resolution?.height ?? null;
          const selectedIndex = probe.selected ? probe.variants.indexOf(probe.selected) : -1;
          const notes = [...probe.notes];
          if (probe.selected && selectedHeight === null) notes.push('quality-bandwidth-fallback');

          const estimated = estimateBytes(probe.selected ?? null, probe.durationSec);
          let segmentProbe: PreflightProbeView | null = null;
          if (shouldProbeSegment && probe.segmentUrl) {
            segmentProbe = await probeSegment(probe.segmentUrl, input.headers, { timeoutMs, signal });
            if (!segmentProbe.segmentOk) notes.push('segment-probe-failed');
          }

          return {
            ...base,
            ok: probe.reachable,
            container: probe.container,
            drmProtected: probe.drmProtected,
            durationSec: probe.durationSec,
            variants,
            selectedVariant: probe.selected
              ? {
                  index: selectedIndex >= 0 ? selectedIndex : 0,
                  label: labelOfVariant(probe.selected, selectedIndex >= 0 ? selectedIndex : 0),
                  height: selectedHeight,
                  bandwidth: probe.selected.bandwidth,
                }
              : null,
            estimatedBytes: estimated,
            probe: segmentProbe,
            notes,
          };
        } catch (e) {
          logger.debug('HLS 预检失败（按可下载处理）', {
            episodeId: input.episodeId,
            error: (e as Error)?.message ?? String(e),
          });
          return { ...base, ok: false, notes: ['probe-failed'] };
        }
      }

      // 直链：Range 0-0 探测可达性与总体积
      const direct = await probeDirect(input.url, input.headers, timeoutMs, signal);
      return {
        ...base,
        ok: direct.reachable,
        container: input.format === 'ts' ? 'ts' : input.format === 'mp4' ? 'mp4' : 'other',
        estimatedBytes: direct.estimatedBytes,
        probe: {
          segmentOk: direct.reachable,
          latencyMs: direct.latencyMs,
          status: direct.status,
          redirected: false,
        },
        notes: direct.reachable ? [] : ['probe-failed'],
      };
    });

    const storage = this.summarizeStorage(items, storageInfo, settings.download);
    const network: PreflightNetworkView = {
      type: networkStatus.type,
      wifiOnlyBlocked: Boolean(settings.download.wifiOnly) && networkStatus.type === 'cellular',
    };
    const verdict = judge(items, storage, network, settings.download);

    const result: PreflightResult = {
      items,
      network,
      storage,
      canStart: verdict.canStart,
      blocked: verdict.blocked,
      elapsedMs: Date.now() - startedAt,
    };
    logger.info('下载预检完成', {
      stage: 'preflight',
      count: items.length,
      drm: items.filter((item) => item.drmProtected).length,
      canStart: result.canStart,
      elapsedMs: result.elapsedMs,
    });
    return result;
  },

  /**
   * 空间裁决（§6.5）：`所需 = 估算 ×1.1`；需要转封装（TS → MP4）时额外预留 1× 估算
   * （输入 TS 与输出 `.mp4.part` 同时存在）。无估算值/查不到可用空间时不阻断。
   */
  summarizeStorage(
    items: PreflightItem[],
    info: StorageInfo | null,
    settings: Pick<DownloadSettings, 'remuxToMp4'>,
  ): PreflightStorageView {
    let estimatedTotal = 0;
    let remuxExtra = 0;
    for (const item of items) {
      if (item.estimatedBytes === null) continue;
      estimatedTotal += item.estimatedBytes;
      if (settings.remuxToMp4 !== false && item.container === 'ts') remuxExtra += item.estimatedBytes;
    }
    const reserveBytes = Math.round(estimatedTotal * 0.1);
    const requiredBytes = estimatedTotal > 0 ? Math.round(estimatedTotal * 1.1) + remuxExtra : 0;
    if (!info || estimatedTotal === 0) {
      return {
        freeBytes: info?.freeBytes ?? 0,
        requiredBytes,
        enough: true,
        reserveBytes,
      };
    }
    return {
      freeBytes: info.freeBytes,
      requiredBytes,
      enough: info.freeBytes >= requiredBytes,
      reserveBytes,
    };
  },

  /**
   * 预检结果 → 任务的可选字段片段（`create`/`createBatch` 落库用）。
   * 只保留摘要，不存变体明细（控制记录体积）。
   */
  digestOf(item: PreflightItem | undefined): Partial<DownloadTask> {
    if (!item) return {};
    return {
      estimatedBytes: item.estimatedBytes,
      selectedHeight: item.selectedVariant?.height ?? null,
      container: item.container,
      preflight: {
        at: Date.now(),
        drmProtected: item.drmProtected,
        latencyMs: item.probe?.latencyMs ?? null,
        notes: [...item.notes],
      },
    };
  },
};
