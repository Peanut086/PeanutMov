/**
 * 线路健康记忆服务（批次1 核心）
 *
 * 记录每条线路（sourceId|sourceItemId|lineName）的播放成功/失败历史，
 * 供详情页默认线路选择与播放页 failover 换线使用。
 *
 * 设计要点：
 * - Key 用 flag（线路名）而非 lineId（mediaId:index），因为 index 会随源返回顺序漂移；
 * - 错误分类：瞬时网络/账号/取消不计线路失败，避免误伤；
 * - failStreak ≥ 2 才标 fail，防瞬时抖动；
 * - TTL：ok 24h / fail 30min（过期降 unknown 允许重试）；
 * - 真实播放反馈立即生效，不受 TTL 限制；
 * - 存储：内存 reactive Map + kvRepo 单 key 持久化，120ms 批量 flush，500 条 LRU。
 */
import { reactive } from 'vue';

import type { ErrorCode } from '@/types';
import { logger } from '@/shared/logger';

export type LineHealthStatus = 'ok' | 'fail' | 'unknown';

export interface LineHealthEntry {
  status: LineHealthStatus;
  /** 连败计数，≥2 才标 fail */
  failStreak: number;
  /** 累计成功次数 */
  successCount: number;
  /** 最近解析耗时（ms） */
  lastResolveMs: number | null;
  /** 最近失败错误码 */
  lastErrorCode: ErrorCode | null;
  /** 最近更新时间戳 */
  checkedAt: number;
}

const KV_KEY = 'line-health-v1';
const TTL_OK_MS = 24 * 60 * 60 * 1000;
const TTL_FAIL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;
const FLUSH_WINDOW_MS = 120;
const FAIL_STREAK_THRESHOLD = 2;

/** 计线路失败的错误码 */
const LINE_FAILURE_CODES = new Set<ErrorCode>([
  'E_NO_PLAY_URL',
  'E_PARSE',
  'E_DECODE',
  'E_UNSUPPORTED_FORMAT',
  'E_SOURCE_UNAVAILABLE',
  'E_TIMEOUT',
  'E_DRM_PROTECTED',
]);

/** 不计线路失败的错误码（账号/网络/取消） */
const NON_LINE_FAILURE_CODES = new Set<ErrorCode>([
  'E_NETDISK_LOGIN_REQUIRED',
  'E_NETWORK',
  'E_ABORTED',
  'E_CANCELED',
  'E_HTTP_401',
  'E_HTTP_403',
  'E_HTTP_429',
]);

const cache = reactive(new Map<string, LineHealthEntry>());
const pendingFlush = new Map<string, LineHealthEntry>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

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
    const existing = (await kvRepo.get<Record<string, LineHealthEntry>>(KV_KEY)) ?? {};
    for (const [key, entry] of entries) {
      existing[key] = entry;
    }
    evictInMemory(existing);
    await kvRepo.set(KV_KEY, existing);
  } catch (e) {
    logger.debug('批量写入线路健康失败', { error: (e as Error)?.message });
  }
}

function evictInMemory(store: Record<string, LineHealthEntry>): void {
  const keys = Object.keys(store);
  if (keys.length <= MAX_ENTRIES) return;
  keys
    .map((k) => ({ k, t: store[k]!.checkedAt }))
    .sort((a, b) => a.t - b.t)
    .slice(0, keys.length - MAX_ENTRIES)
    .forEach(({ k }) => delete store[k]);
}

function isFresh(entry: LineHealthEntry): boolean {
  if (entry.status === 'unknown') return false;
  const ttl = entry.status === 'ok' ? TTL_OK_MS : TTL_FAIL_MS;
  return Date.now() - entry.checkedAt < ttl;
}

function emptyEntry(): LineHealthEntry {
  return {
    status: 'unknown',
    failStreak: 0,
    successCount: 0,
    lastResolveMs: null,
    lastErrorCode: null,
    checkedAt: 0,
  };
}

function shouldCountAsFailure(code: ErrorCode): boolean {
  if (NON_LINE_FAILURE_CODES.has(code)) return false;
  if (LINE_FAILURE_CODES.has(code)) return true;
  // 未知错误码保守计失败
  return true;
}

export function lineKey(sourceId: string, sourceItemId: string, lineName: string): string {
  return `${sourceId}|${sourceItemId}|${lineName}`;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const { kvRepo } = await import('@/db/repositories/kvRepo');
    const existing = (await kvRepo.get<Record<string, LineHealthEntry>>(KV_KEY)) ?? {};
    for (const [key, entry] of Object.entries(existing)) {
      cache.set(key, entry);
    }
  } catch (e) {
    logger.debug('加载线路健康持久化失败', { error: (e as Error)?.message });
  }
}

export const lineHealthService = {
  /** 读取当前状态（响应式：Vue 组件中调用会触发更新） */
  entryOf(key: string): LineHealthEntry | undefined {
    return cache.get(key);
  },

  statusOf(key: string): LineHealthStatus {
    const entry = cache.get(key);
    if (!entry || !isFresh(entry)) return 'unknown';
    return entry.status;
  },

  /** 记录成功（真实播放反馈优先） */
  recordSuccess(key: string, resolveMs: number): void {
    const existing = cache.get(key) ?? emptyEntry();
    const entry: LineHealthEntry = {
      status: 'ok',
      failStreak: 0,
      successCount: existing.successCount + 1,
      lastResolveMs: resolveMs,
      lastErrorCode: null,
      checkedAt: Date.now(),
    };
    cache.set(key, entry);
    pendingFlush.set(key, entry);
    scheduleFlush();
  },

  /** 记录失败（按错误分类，failStreak ≥ 2 才标 fail） */
  recordFail(key: string, errorCode: ErrorCode): void {
    if (!shouldCountAsFailure(errorCode)) return;
    const existing = cache.get(key) ?? emptyEntry();
    const newStreak = existing.failStreak + 1;
    const entry: LineHealthEntry = {
      status: newStreak >= FAIL_STREAK_THRESHOLD ? 'fail' : existing.status,
      failStreak: newStreak,
      successCount: existing.successCount,
      lastResolveMs: existing.lastResolveMs,
      lastErrorCode: errorCode,
      checkedAt: Date.now(),
    };
    cache.set(key, entry);
    pendingFlush.set(key, entry);
    scheduleFlush();
  },

  /** 清除单条缓存（源健康变化 / 用户手动刷新时调用） */
  invalidate(key: string): void {
    cache.delete(key);
    pendingFlush.delete(key);
  },

  /** 清除全部缓存 */
  async clear(): Promise<void> {
    cache.clear();
    pendingFlush.clear();
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      const { kvRepo } = await import('@/db/repositories/kvRepo');
      await kvRepo.delete(KV_KEY);
    } catch (e) {
      logger.debug('清除线路健康持久化失败', { error: (e as Error)?.message });
    }
  },

  /** 初始化（应用启动时调用一次，加载持久化数据） */
  async init(): Promise<void> {
    await ensureLoaded();
  },

  /** 测试辅助：重置内部状态 */
  __reset(): void {
    cache.clear();
    pendingFlush.clear();
    loaded = false;
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  },

  /**
   * 批次2-5：计算源级线路可靠度（最近 N 条线路的成功率）
   * 用于搜索代表排序，让"全线路挂"的源沉底。
   */
  sourceReliability(sourceId: string): number {
    let successCount = 0;
    let failCount = 0;
    for (const [key, entry] of cache.entries()) {
      if (!key.startsWith(`${sourceId}|`)) continue;
      successCount += entry.successCount;
      failCount += entry.failStreak;
    }
    // 无数据时返回 0.5（中性），避免新源被误判
    const total = successCount + failCount;
    if (total === 0) return 0.5;
    return successCount / total;
  },
};
