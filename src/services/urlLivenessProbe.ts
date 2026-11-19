/**
 * 线路地址「拿不拿得到字节」的轻量探测（P1-4）
 *
 * 为什么需要它：真机 27 条线路里默认第一条指向 `mv.gzlcl.com`，那个域名根本解析不了，
 * 但 `resolvePlay` 照样答得干脆（爬虫只是把地址交出来，不校验可达性）。旧探测把
 * 「爬虫答了」当成「线路可播」并在此停住，于是默认线路永远是那条死线路，
 * 用户点播放/下载才撞上失败。这里补上第二种证据：对解析出来的地址做一次
 * `Range: bytes=0-0` 的空读，只验通不通，不拉数据。
 *
 * 判定口径（对齐 `jarProbe` 的「超时 ≠ 挂死」）：
 * - 任一通路读到 2xx/206 → `alive`；
 * - 明确的 4xx（404/410/403）→ `dead`；
 * - 代理与直连**都**建立不起连接 → `dead`（下载引擎自己走的就是这两条路，
 *   它取不到字节，这条线路就是不可用）；
 * - 超时、5xx、代理侧的假 404（token 过期）、非原生下被 CORS 挡住的读不到 → `unknown`，
 *   **既不记成功也不记失败**：宁可留白，也不给线路泼脏水。
 *
 * 走原生回环代理（`LocalProxy`）而不是裸 fetch：CDN 一般不发 CORS 头，
 * 裸 fetch 在 WebView 里对活着的地址也会抛 `TypeError`，那条证据不可归因。
 */
import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';
import { TIMEOUT_TEST_CONNECTION_MS } from '@/shared/constants';
import { LocalProxy } from '@/native/localProxy';

/** 单次探测超时（与源健康检查同档） */
const LIVENESS_TIMEOUT_MS = TIMEOUT_TEST_CONNECTION_MS;
/** 结论缓存时长：死线路没必要每次进详情都再撞一遍，活线路也不必反复验 */
const VERDICT_TTL_MS = 5 * 60 * 1000;

export type LivenessVerdict = 'alive' | 'dead' | 'unknown';

export interface LivenessResult {
  verdict: LivenessVerdict;
  /** 从发出到拿到可判读响应头的耗时（ms）；`unknown` 时为整次尝试耗时 */
  latencyMs: number;
  /** 最后一次读到的 HTTP 状态码，连接没建立起来时为 null */
  status: number | null;
  /** 结论是否由原生回环代理通路得出（false = 直连通路或未知通路） */
  viaProxy: boolean;
}

interface CachedVerdict {
  result: LivenessResult;
  checkedAt: number;
}

const verdictCache = new Map<string, CachedVerdict>();

interface AttemptResult {
  status: number | null;
  /** 连接层是否失败（含代理侧「上游连不上就直接断掉响应」的形态） */
  connectFailed: boolean;
  timedOut: boolean;
  latencyMs: number;
  /** 404 时读到的极小响应体，用来识别代理自己的「token 过期」假 404 */
  snippet: string;
}

function normalizeProbeUrl(url: string): string {
  return url.trim();
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** 登记原生回环代理基址；非原生或插件不可用 → null（与 `downloadPreflight` 同一形态） */
async function resolveProxyBase(url: string, headers: Record<string, string> | undefined): Promise<string | null> {
  if (!isNative()) return null;
  try {
    const result = await LocalProxy.proxy({ url, headers });
    return result.url.replace(/\/+$/, '') || null;
  } catch (e) {
    logger.debug('探活代理不可用，改走直连', { error: (e as Error)?.message ?? String(e) });
    return null;
  }
}

/** 一次空读请求：`Range: bytes=0-0`，只读响应头，body 立刻取消 */
async function attemptRead(
  target: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });
    const snippet = response.status === 404 ? (await response.text().catch(() => '')).slice(0, 128) : '';
    void response.body?.cancel().catch(() => undefined);
    return { status: response.status, connectFailed: false, timedOut: false, latencyMs: Date.now() - startedAt, snippet };
  } catch (e) {
    logger.debug('探活请求失败', {
      error: (e as Error)?.message ?? String(e),
      timedOut,
    });
    return {
      status: null,
      connectFailed: !timedOut,
      timedOut,
      latencyMs: Date.now() - startedAt,
      snippet: '',
    };
  } finally {
    clearTimeout(timer);
  }
}

function readableStatus(result: AttemptResult): boolean {
  return result.status !== null && result.status >= 200 && result.status < 300;
}

/** 代理侧的「token 未命中/已过期」也会写成 404，那不是上游的答案 */
function isProxyTokenArtifact(result: AttemptResult): boolean {
  return result.status === 404 && /proxy token/i.test(result.snippet);
}

function verdictOf(status: number | null): LivenessVerdict {
  if (status !== null && status >= 200 && status < 300) return 'alive';
  if (status === 403 || status === 404 || status === 410) return 'dead';
  return 'unknown';
}

/**
 * 探测一个播放地址是否真的可取。
 *
 * 结论按完整 URL 缓存 5 分钟（含 `alive`/`dead`），同一集换线路解析出相同地址时
 * 第二次零流量复用——这正是真机上线路 0/1/2 指向同一个地址的形态。
 */
export async function probeUrlLiveness(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = LIVENESS_TIMEOUT_MS,
): Promise<LivenessResult> {
  const key = normalizeProbeUrl(url);
  if (!isHttpUrl(key)) {
    return { verdict: 'unknown', latencyMs: 0, status: null, viaProxy: false };
  }
  const cached = verdictCache.get(key);
  if (cached && Date.now() - cached.checkedAt < VERDICT_TTL_MS) return cached.result;

  const startedAt = Date.now();
  const proxyBase = await resolveProxyBase(key, headers);
  let proxyConnectFailed = false;

  if (proxyBase) {
    const proxied = await attemptRead(`${proxyBase}/${encodeURIComponent(key)}`, { Range: 'bytes=0-0' }, timeoutMs);
    if (readableStatus(proxied)) {
      return remember(key, { verdict: 'alive', latencyMs: proxied.latencyMs, status: proxied.status, viaProxy: true });
    }
    if (proxied.timedOut) {
      // 代理挂住：整条预算已经用完，不再补一次直连（直连同样会挂满超时）
      return { verdict: 'unknown', latencyMs: Date.now() - startedAt, status: null, viaProxy: true };
    }
    if (proxied.connectFailed) {
      // 回环代理接了请求却没写出响应 = 上游连不上（`LocalProxyPlugin` 的失败形态）；
      // 但这条证据单独不判死，还要看直连是否同样建立不起来
      proxyConnectFailed = true;
    } else if (!isProxyTokenArtifact(proxied)) {
      const verdict = verdictOf(proxied.status);
      if (verdict !== 'unknown') {
        return remember(key, { verdict, latencyMs: proxied.latencyMs, status: proxied.status, viaProxy: true });
      }
    }
  }

  const direct = await attemptRead(key, { ...(headers ?? {}), Range: 'bytes=0-0' }, timeoutMs);
  if (readableStatus(direct)) {
    return remember(key, { verdict: 'alive', latencyMs: direct.latencyMs, status: direct.status, viaProxy: false });
  }
  const verdict = verdictOf(direct.status);
  if (verdict !== 'unknown') {
    return remember(key, { verdict, latencyMs: direct.latencyMs, status: direct.status, viaProxy: false });
  }
  if (direct.connectFailed && proxyConnectFailed) {
    // 代理与直连都建立不起连接：下载引擎用同一个地址也拿不到字节 → 判死
    return remember(key, { verdict: 'dead', latencyMs: Date.now() - startedAt, status: null, viaProxy: true });
  }
  return { verdict: 'unknown', latencyMs: Date.now() - startedAt, status: direct.status, viaProxy: false };
}

function remember(key: string, result: LivenessResult): LivenessResult {
  verdictCache.set(key, { result, checkedAt: Date.now() });
  return result;
}

/** 测试辅助：清空结论缓存 */
export function __resetUrlLivenessProbe(): void {
  verdictCache.clear();
}
