/**
 * 播放源前置守卫（AC-40 / FR-17）
 *
 * 目标：DASH（`.mpd`）与受 DRM 保护（`#EXT-X-KEY:METHOD=SAMPLE-AES`）的流
 * **明确拒绝且不尝试绕过**，而不是交给解码器失败后显示「视频解码失败」。
 *
 * 设计要点：
 * - 纯函数、不发请求：调用方（PlayerController / HlsEngine）决定何时调用；
 * - `src/shared/url.ts` 属 SCF 冻结（PKG-B 只读），因此 DASH 识别放在播放器侧，
 *   不改 `guessFormatFromUrl`、不改 `src/types/index.ts`；
 * - 返回 `AppError | null`：调用方直接 `throw`，错误码与文案来自 `shared/errors`，
 *   `PlayerErrorPanel` 的 code→文案映射可直接复用。
 */
import { AppError } from '@/shared/errors';

import { MANIFEST_PREFLIGHT_TIMEOUT_MS } from '@/player/constants';

/** DASH 拒绝文案（AC-40：提示「暂不支持该格式」并点明格式） */
export const DASH_UNSUPPORTED_MESSAGE = '暂不支持 DASH(.mpd) 格式';

/**
 * DRM 关键标记：`#EXT-X-KEY:METHOD=SAMPLE-AES`（含 METHOD 带引号/多余空白的写法）。
 * 只做文本匹配，不做任何解密/绕过尝试。
 */
export const SAMPLE_AES_PATTERN = /#EXT-X-KEY:[^#\r\n]*METHOD\s*=\s*"?'?SAMPLE-AES/i;

/** 剥离 query / hash 后的 pathname（无法解析时按字符串手动剥离） */
export function pathnameOfUrl(url: string | null | undefined): string {
  if (typeof url !== 'string' || url.trim().length === 0) return '';
  const trimmed = url.trim();
  try {
    return new URL(trimmed).pathname;
  } catch {
    return trimmed.split('#')[0]!.split('?')[0]!;
  }
}

/** 是否为 DASH 清单地址（`.mpd` 结尾，忽略 query/hash 与大小写） */
export function isDashUrl(url: string | null | undefined): boolean {
  return pathnameOfUrl(url).toLowerCase().endsWith('.mpd');
}

/** 是否为 HLS 清单地址（`.m3u8` 结尾，忽略 query/hash） */
export function isM3u8Url(url: string | null | undefined): boolean {
  return pathnameOfUrl(url).toLowerCase().endsWith('.m3u8');
}

/**
 * 文本中是否出现 `#EXT-X-KEY:METHOD=SAMPLE-AES`。
 * 同时用于两处输入：manifest 全文（预检 fetch 的文本）、URL 自身（上游若把
 * 加密标记塞进地址片段，也能识别）。
 */
export function containsSampleAes(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return SAMPLE_AES_PATTERN.test(text);
}

/**
 * 识别"首版明确不支持"的播放源。
 *
 * @param url          播放地址（来自 `resolvePlay` 的 `PlaybackSource.url`）
 * @param manifestText m3u8 清单文本（可选；仅 HlsEngine 预检阶段提供）
 * @returns 需要拒绝时返回对应 `AppError`；放行返回 `null`
 *
 * 规则：
 * 1. pathname 以 `.mpd` 结尾 → `E_UNSUPPORTED_FORMAT`（不创建 video/hls、不发请求）；
 * 2. m3u8（或拿到了清单文本）且命中 SAMPLE-AES → `E_DRM_PROTECTED`；
 * 3. 其它（普通 m3u8 / mp4 / webm / ts）→ 放行。
 */
export function detectUnsupportedSource(
  url: string | null | undefined,
  manifestText?: string | null,
): AppError | null {
  if (isDashUrl(url)) {
    return new AppError('E_UNSUPPORTED_FORMAT', DASH_UNSUPPORTED_MESSAGE, { retryable: false });
  }

  const isHls = isM3u8Url(url) || (typeof manifestText === 'string' && manifestText.length > 0);
  if (!isHls) return null;

  if (containsSampleAes(manifestText) || containsSampleAes(url)) {
    // 文案取共享表「不支持受保护内容」，与 AC-40 表述一致，且不改 shared
    return new AppError('E_DRM_PROTECTED', undefined, { retryable: false });
  }
  return null;
}

/** 便捷断言：不合格时抛 `AppError`（播放器加载路径使用） */
export function assertSourceSupported(
  url: string | null | undefined,
  manifestText?: string | null,
): void {
  const blocked = detectUnsupportedSource(url, manifestText);
  if (blocked) throw blocked;
}

export interface ManifestPreflightOptions {
  /** 外部取消信号（切集/销毁时中止，避免旧请求继续占用） */
  signal?: AbortSignal;
  /** 站点源可能要求鉴权头（与 hls.js 的 xhrSetup 保持一致） */
  headers?: Record<string, string>;
  /** 超时毫秒数，默认 `MANIFEST_PREFLIGHT_TIMEOUT_MS` */
  timeoutMs?: number;
  /** 注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

/**
 * 预检 m3u8 清单文本（**仅**用于 DRM 探测）。
 *
 * 约定（AC-40 明确要求，避免误判）：
 * - 只对 `.m3u8` 地址发请求；`.mpd` 在更早的 `detectUnsupportedSource(url)` 已拒绝；
 * - 任何失败（CORS/网络/超时/非 2xx/取消）都返回 `null`，由调用方回退 hls.js 正常加载，
 *   绝不把网络抖动当成 DRM；
 * - 必须可被 `AbortSignal` 取消：外部中止或超时都会 abort 底层请求。
 */
export async function preflightManifest(
  url: string,
  options: ManifestPreflightOptions = {},
): Promise<string | null> {
  if (!isM3u8Url(url)) return null;
  const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;

  const timeoutMs = options.timeoutMs ?? MANIFEST_PREFLIGHT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer);
      return null;
    }
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await doFetch(url, {
      method: 'GET',
      headers: options.headers && Object.keys(options.headers).length > 0 ? options.headers : undefined,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    // 超时 / 取消 / CORS / 断网：一律放行给 hls.js，不判 DRM
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}
