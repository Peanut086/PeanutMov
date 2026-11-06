/**
 * 播放源前置守卫（AC-40 / FR-17）
 *
 * 目标：DASH（`.mpd`）与受 DRM 保护（`#EXT-X-KEY` / `#EXT-X-SESSION-KEY` 声明了
 * 非 AES-128 加密方式）的流 **明确拒绝且不尝试绕过**，而不是交给解码器失败后
 * 显示「视频解码失败」。
 *
 * 设计要点：
 * - 纯函数 / 只读清单：调用方（PlayerController / HlsEngine）决定何时调用；
 * - `src/shared/url.ts` 属 SCF 冻结（PKG-B 只读），因此 DASH 识别放在播放器侧，
 *   不改 `guessFormatFromUrl`、不改 `src/types/index.ts`；
 * - 返回 `AppError | null`：调用方直接 `throw`，错误码与文案来自 `shared/errors`，
 *   `PlayerErrorPanel` 的 code→文案映射可直接复用；
 * - 加密方式判定与下载侧（`hlsDownloader`）共用 `findProtectedKeyEvidence`：
 *   大小写不敏感（REV-30）、同时扫描 `SESSION-KEY`（REV-31），避免两套口径漂移。
 */
import { AppError } from '@/shared/errors';

import { MANIFEST_PREFLIGHT_TIMEOUT_MS } from '@/player/constants';

/** DASH 拒绝文案（AC-40：提示「暂不支持该格式」并点明格式） */
export const DASH_UNSUPPORTED_MESSAGE = '暂不支持 DASH(.mpd) 格式';

/**
 * 本地能无损解密的加密方式（其余一律按受保护内容拒绝）。
 * `NONE` 在解析层等价于无密钥；`AES-128` 由 hls.js / 下载侧各自解密。
 */
const SUPPORTED_KEY_METHODS = new Set(['NONE', 'AES-128']);

/** `#EXT-X-KEY` 与 `#EXT-X-SESSION-KEY`，标签名大小写不敏感（REV-30 / REV-31） */
const KEY_TAG_PATTERN = /^#EXT-X-(?:SESSION-)?KEY:(.*)$/i;

/** 属性名大小写不敏感、允许 `METHOD = "SAMPLE-AES"` 这类空白写法 */
function readAttribute(attributes: string, name: string): string | undefined {
  const regex = /([A-Za-z0-9-]+)\s*=\s*(?:"([^"]*)"|([^,]*))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(attributes)) !== null) {
    if ((match[1] ?? '').toUpperCase() === name.toUpperCase()) {
      return (match[2] ?? match[3] ?? '').trim();
    }
  }
  return undefined;
}

/** 归一化 METHOD 值：去空白、去单/双引号、转大写（`'aes-128'` 视为受支持） */
function normalizeKeyMethod(raw: string): string {
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .toUpperCase();
}

/**
 * 在清单文本中查找「不受支持加密方式」的证据。
 *
 * - 逐行扫描 `#EXT-X-KEY:` 与 `#EXT-X-SESSION-KEY:`（标签大小写不敏感）；
 * - `METHOD` 属性名大小写不敏感，值允许带双引号/单引号；
 * - 只读文本，不做任何解密/绕过尝试。
 *
 * @returns 命中的原始行（便于日志/自测定位）；未命中返回 `null`
 */
export function findProtectedKeyEvidence(manifest: string | null | undefined): string | null {
  if (typeof manifest !== 'string' || manifest.length === 0) return null;
  for (const raw of manifest.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line[0] !== '#') continue;
    const match = KEY_TAG_PATTERN.exec(line);
    if (!match) continue;
    const method = normalizeKeyMethod(readAttribute(match[1] ?? '', 'METHOD') ?? 'NONE');
    if (SUPPORTED_KEY_METHODS.has(method)) continue;
    return line;
  }
  return null;
}

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
 * 文本中是否出现不受支持的加密声明（SAMPLE-AES 等）。
 * 同时用于两处输入：manifest 全文（预检 fetch 的文本）、URL 自身（上游若把
 * 加密标记塞进地址片段，也能识别）。
 */
export function containsSampleAes(text: string | null | undefined): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (findProtectedKeyEvidence(text)) return true;
  // URL 片段（`.../index.m3u8#EXT-X-KEY:...`）不是独立行：按 `#` 切分后逐段判定
  return text
    .split('#')
    .some((fragment, index) => index > 0 && findProtectedKeyEvidence(`#${fragment}`) !== null);
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
 * 2. m3u8（或拿到了清单文本）且命中非 AES-128 的 KEY/SESSION-KEY → `E_DRM_PROTECTED`；
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
  return fetchManifestText(url, options);
}

/**
 * 拉取清单文本（不做后缀判断）。
 * 子清单地址来自 `#EXT-X-STREAM-INF`，即使没有 `.m3u8` 后缀也确定是清单，可直接复用。
 */
async function fetchManifestText(
  url: string,
  options: ManifestPreflightOptions = {},
): Promise<string | null> {
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

/* ---------- REV-27：master playlist → 子清单的 DRM 探测 ---------- */

/** 探测清单总数上限（含顶层），异常清单不得无限展开 */
const MAX_PREFLIGHT_MANIFESTS = 8;
/** 子清单并发数（单层内并发拉取，避免串行拖长起播） */
const PREFLIGHT_VARIANT_CONCURRENCY = 3;

/** 把清单里的相对地址解析成绝对地址；无法解析时返回 `null` */
function resolveManifestUrl(candidate: string, baseUrl: string): string | null {
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return /^https?:\/\//i.test(candidate) ? candidate : null;
  }
}

/**
 * 提取 master playlist 中的变体清单地址（`#EXT-X-STREAM-INF` 的下一行）。
 *
 * 标签名大小写不敏感（与 `findProtectedKeyEvidence` 同口径）；注释、空行跳过。
 */
export function extractVariantUrls(manifest: string, baseUrl: string): string[] {
  if (typeof manifest !== 'string' || manifest.length === 0) return [];
  const lines = manifest.split(/\r?\n/);
  const urls: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#EXT-X-STREAM-INF:/i.test(lines[i] ?? '')) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = (lines[j] ?? '').trim();
      if (candidate.length === 0) continue;
      if (candidate.startsWith('#')) break; // 该 STREAM-INF 没有紧随的 URI
      const resolved = resolveManifestUrl(candidate, baseUrl);
      if (resolved) urls.push(resolved);
      break;
    }
  }
  return urls;
}

export interface ManifestDrmEvidence {
  /** 命中证据所在清单地址（顶层或子清单） */
  url: string;
  /** 命中的原始行（`#EXT-X-KEY:...` / `#EXT-X-SESSION-KEY:...`） */
  evidence: string;
}

export interface ManifestDrmScanResult {
  /** 顶层清单文本；未取到（非 m3u8 / 网络失败 / 取消）为 `null` */
  manifestText: string | null;
  /** 实际探测过的清单地址（首个为顶层），用于自测与日志 */
  fetched: string[];
  /** 命中受保护内容时的证据；放行时为 `null` */
  drm: ManifestDrmEvidence | null;
}

/**
 * 扫描播放地址的清单链（REV-27 / AC-40）。
 *
 * 顶层清单里的 `#EXT-X-KEY` 只对自身分片生效；**加密标记通常写在变体清单里**，
 * 只拉顶层会漏判 SAMPLE-AES，随后 hls.js 解码失败（`E_DECODE`）还会误触发自动换线。
 * 因此：
 * - 顶层命中 → 立即返回证据；
 * - 顶层是 master（含 `#EXT-X-STREAM-INF`）→ 并发（≤3）拉取变体清单做同口径断言，
 *   变体本身仍是 master 时继续一层，总探测数上限 8；
 * - **任一子清单拉取失败（CORS/超时/非 2xx/取消）只跳过该子清单**，绝不判 DRM；
 * - 全程响应 `options.signal`，取消后不再发起新请求。
 */
export async function scanManifestForDrm(
  url: string,
  options: ManifestPreflightOptions = {},
): Promise<ManifestDrmScanResult> {
  const result: ManifestDrmScanResult = { manifestText: null, fetched: [], drm: null };
  if (!isM3u8Url(url)) return result;

  const rootText = await fetchManifestText(url, options);
  result.fetched.push(url);
  if (rootText === null) return result;
  result.manifestText = rootText;

  const rootEvidence = findProtectedKeyEvidence(rootText);
  if (rootEvidence) {
    result.drm = { url, evidence: rootEvidence };
    return result;
  }

  const seen = new Set<string>([url]);
  const queue = extractVariantUrls(rootText, url).filter((variantUrl) => !seen.has(variantUrl));

  while (queue.length > 0) {
    if (options.signal?.aborted) break;
    const room = MAX_PREFLIGHT_MANIFESTS - result.fetched.length;
    if (room <= 0) break;

    const batch = queue.splice(0, Math.min(PREFLIGHT_VARIANT_CONCURRENCY, room));
    for (const variantUrl of batch) seen.add(variantUrl);

    const texts = await Promise.all(batch.map((variantUrl) => fetchManifestText(variantUrl, options)));
    result.fetched.push(...batch);

    for (let i = 0; i < batch.length; i++) {
      const text = texts[i];
      // 子清单失败：放行（可能是防盗链/CORS），交给 hls.js 尝试
      if (text === null) continue;
      const evidence = findProtectedKeyEvidence(text);
      if (evidence) {
        result.drm = { url: batch[i]!, evidence };
        return result;
      }
      // 变体本身仍是 master（少见）时继续展开，仍受总上限约束
      for (const nested of extractVariantUrls(text, batch[i]!)) {
        if (!seen.has(nested)) queue.push(nested);
      }
    }
  }

  return result;
}
