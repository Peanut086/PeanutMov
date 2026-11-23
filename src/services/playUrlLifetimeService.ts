/**
 * 签名地址寿命学习（OPT-26 / P2-⑫）
 *
 * 爬虫/网盘交回的 `PlaybackSource.expiresAt` 基本恒为 null，于是 30 分钟的播放地址缓存
 * 把「十分钟就过期的签名直链」也一并当真：缓存命中那一次直接把过期地址交给引擎，
 * 而这条失败形态不留错误——ExoPlayer 一直说 buffering，WebView 连 waiting 都不报，
 * 用户看到的就是画面停住 25 秒、进度条还在、什么提示都没有。
 *
 * 这里不猜任何 TTL，只记观测：同一 host 的地址，从「发给播放器」到「确认看不下去」的
 * 真实时长，取样本里最小的那个当缓存下界。三条硬约束：
 *
 * - 样本不足 {@link MIN_STALE_SAMPLES} 次不参与决策：一次断流多半是用户自己的网络，
 *   不是地址寿命，凭一次就把每次起播都变成一次爬虫调用不值；
 * - 年龄不足 {@link MIN_STALE_SAMPLE_AGE_MS} 的样本丢弃：一分钟都没播开的问题在起播链路上，
 *   与签名过期无关；
 * - 只在公网 host 上学：本地代理（9978）与局域网地址的寿命是我们自己定的，
 *   从这里学到的只是噪声。
 *
 * 代价说清楚：判错一次 = 多跑一次解析（本来 30 分钟内可以省掉）。反过来不学，
 * 代价是一整集看不下去。所以宁可早一次重新取址。
 */
import { logger } from '@/shared/logger';

export interface UrlLifetimeEntry {
  /** 观测到的最短失效年龄：地址用到这个时长就播不下去了 */
  staleAgeMs: number;
  /** 失效样本数：不足两次不动缓存 */
  staleSamples: number;
  updatedAt: number;
}

const KV_KEY = 'play-url-lifetime-v1';
const MAX_HOSTS = 200;
const FLUSH_WINDOW_MS = 5_000;
const MIN_STALE_SAMPLES = 2;
/** 样本最短年龄：起播阶段的问题不是地址过期 */
const MIN_STALE_SAMPLE_AGE_MS = 60_000;
/** 学到的下界夹在此区间：短于下限等于每次起播都重解析，长于上限等于没学 */
const MIN_TTL_MS = 120_000;
const MAX_TTL_MS = 30 * 60_000;
/** `issued` 的容量：按地址记首次使用时间，够覆盖一次连看；超出按插入顺序淘汰 */
const MAX_ISSUED_URLS = 500;

const cache = new Map<string, UrlLifetimeEntry>();
const issued = new Map<string, number>();
const pendingFlush = new Map<string, UrlLifetimeEntry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

/**
 * 地址所属 host（寿命按 host 归并：同一条 CDN 的签名策略是 host 级的，不是视频级的）。
 * 环回/私网地址返回 null——那是本地代理与局域网源，寿命由我们自己决定，不参与学习。
 */
const PRIVATE_IPV4 =
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^192\.168\.\d{1,3}\.\d{1,3}$|^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$|^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^0\.0\.0\.0$/;
const LOOPBACK_NAMES = new Set(['localhost', '::1', '[::1]']);

function hostOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (LOOPBACK_NAMES.has(host)) return null;
  // 只按 IP 字面量判私网：`10.foo.com` 这样的域名不参与学习就等于永远学不到
  if (PRIVATE_IPV4.test(host)) return null;
  return host || null;
}

function clampTtl(staleAgeMs: number): number {
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, staleAgeMs));
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushPending();
  }, FLUSH_WINDOW_MS);
}

async function flushPending(): Promise<void> {
  if (pendingFlush.size === 0) return;
  const entries = [...pendingFlush.entries()];
  pendingFlush.clear();
  try {
    const { kvRepo } = await import('@/db/repositories/kvRepo');
    const existing = (await kvRepo.get<Record<string, UrlLifetimeEntry>>(KV_KEY)) ?? {};
    for (const [host, entry] of entries) existing[host] = entry;
    evictOverflow(existing);
    await kvRepo.set(KV_KEY, existing);
  } catch (e) {
    logger.debug('批量写入地址寿命失败', { error: (e as Error)?.message });
  }
}

function evictOverflow(store: Record<string, UrlLifetimeEntry>): void {
  const keys = Object.keys(store);
  if (keys.length <= MAX_HOSTS) return;
  keys
    .map((k) => ({ k, t: store[k]?.updatedAt ?? 0 }))
    .sort((a, b) => a.t - b.t)
    .slice(0, keys.length - MAX_HOSTS)
    .forEach(({ k }) => delete store[k]);
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { kvRepo } = await import('@/db/repositories/kvRepo');
    const existing = (await kvRepo.get<Record<string, UrlLifetimeEntry>>(KV_KEY)) ?? {};
    for (const [host, entry] of Object.entries(existing)) {
      // 读盘期间可能已经记了新样本（本次会话的观测比磁盘上的旧结论新），不能被覆盖
      const live = cache.get(host);
      if (live !== undefined && live.updatedAt >= entry.updatedAt) continue;
      cache.set(host, entry);
    }
  } catch (e) {
    logger.debug('加载地址寿命持久化失败', { error: (e as Error)?.message });
  }
}

export const playUrlLifetimeService = {
  /**
   * 登记「这个地址已经交给播放器了」。
   *
   * 只保留首次时间：同一个地址被缓存命中复用多次，年龄要从第一次算起——要判的就是
   * 「这个地址放久了还有效吗」，从最近一次复用算起等于永远不过期。
   */
  noteAddressIssued(url: string): void {
    void ensureLoaded();
    if (hostOf(url) === null) return;
    if (issued.has(url)) return;
    issued.set(url, Date.now());
    if (issued.size > MAX_ISSUED_URLS) {
      const oldest = issued.keys().next().value;
      if (oldest !== undefined) issued.delete(oldest);
    }
  },

  /** 这个地址从交给播放器到现在过了多久（没登记过返回 null） */
  addressAgeMs(url: string): number | null {
    const at = issued.get(url);
    if (at === undefined) return null;
    return Math.max(0, Date.now() - at);
  },

  /**
   * 记一次「地址用不下去了」的观测（播放页判定断流/中途断网时调用）。
   *
   * 返回本次采纳的年龄样本（秒），未采纳时返回 null——年龄太短的样本不进统计，
   * 那种失败发生在起播链路上，与签名寿命无关。
   */
  recordStale(url: string): number | null {
    void ensureLoaded();
    const host = hostOf(url);
    if (host === null) return null;
    const age = this.addressAgeMs(url);
    if (age === null || age < MIN_STALE_SAMPLE_AGE_MS) return null;
    const existing = cache.get(host);
    const entry: UrlLifetimeEntry = {
      // 取最小：学的是「这个 host 的地址最多能放多久」，一次侥幸不算证据
      staleAgeMs: existing === undefined ? age : Math.min(existing.staleAgeMs, age),
      staleSamples: (existing?.staleSamples ?? 0) + 1,
      updatedAt: Date.now(),
    };
    cache.set(host, entry);
    pendingFlush.set(host, entry);
    scheduleFlush();
    return Math.round(age / 1000);
  },

  /**
   * 缓存里这个地址还能不能用（不能用就该重新取址，而不是把过期直链交给引擎）。
   *
   * 返回 `null` = 没有可用的学习结论（样本不足或没登记过），调用方按原有
   * `expiresAt` / 30 分钟上限处理。
   */
  ttlOf(url: string): number | null {
    void ensureLoaded();
    const host = hostOf(url);
    if (host === null) return null;
    const entry = cache.get(host);
    if (entry === undefined || entry.staleSamples < MIN_STALE_SAMPLES) return null;
    return clampTtl(entry.staleAgeMs);
  },

  /** 读数（诊断导出用）：学到多少、样本几次、什么时候更新的 */
  entryOf(url: string): UrlLifetimeEntry | null {
    void ensureLoaded();
    const host = hostOf(url);
    if (host === null) return null;
    return cache.get(host) ?? null;
  },

  /** 测试辅助：清空内存与待写队列 */
  __reset(): void {
    cache.clear();
    issued.clear();
    pendingFlush.clear();
    loaded = false;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  },
};
