/**
 * 可播性预检服务（P0-1 / P0-3 / P0-FIX 性能修复）
 *
 * 搜索结果列表里每条 `MediaItem` 只带元数据，用户点进详情才发现「0 集可播」——
 * 网盘/盘搜类源尤其如此（搜索能返回，详情解析不出线路）。
 *
 * 本服务在搜索结果上屏后，对前排候选做轻量预检（只取 detail 看线路/集数），
 * 结果进 LRU 缓存（5 分钟 TTL / 200 条上限），供列表徽章与排序消费。
 *
 * P0-FIX 性能要点（搜索卡顿根因修复）：
 * - **零 DB 写入**：走 `libraryService.peekDetail()` 纯网络探活，不做 refreshDetail 的
 *   5 次 SQLite 写 + 事件广播（12 条 × 5 次曾致主线程阻塞数百 ms）；
 * - **批量响应式刷新**：内部用非响应式 Map 收集结果，定时批量刷入 reactive 缓存，
 *   一次只触发一轮 searchGroups 重算（原逐条 set 触发 24~36 轮全量重算+重渲染）；
 * - 空壳连败记录在批量刷新里合并（每源一次 kv 读写，不逐条打 DB）。
 *
 * 设计要点：
 * - 状态机：`unknown → verifying → playable | empty | error`，`error` 表示网络/解析失败，
 *   与 `empty`（详情成功但 0 集）严格区分，避免把瞬时故障误判为空壳；
 * - 并发上限 3（与搜索并发 8 错开，不抢网络），在途请求去重；
 * - 离线时不发起预检，保持 `unknown`（UI 不展示状态点）；
 * - DetailView 真实加载详情后调用 `record` 回填，保证缓存与真实数据一致。
 */
import { reactive } from 'vue';

import type { MediaItem } from '@/types';
import { isOnline } from '@/native/network';
import { logger } from '@/shared/logger';

export type PlayabilityStatus = 'unknown' | 'verifying' | 'playable' | 'empty' | 'error';

export interface PlayabilityEntry {
  status: PlayabilityStatus;
  /** 集数（`playable` 时 > 0，`empty` 时为 0） */
  episodeCount: number;
  /** 线路数（`playable` 时 > 0） */
  lineCount: number;
  /** 最近一次预检时间戳（ms） */
  checkedAt: number;
}

const PLAYABILITY_TTL_MS = 5 * 60 * 1000;
const PLAYABILITY_MAX_ENTRIES = 200;
const PLAYABILITY_CONCURRENCY = 3;
/** 批量刷新窗口（ms）：窗口内完成的检查合并为一次 reactive 触发 */
const FLUSH_WINDOW_MS = 120;

const cache = reactive(new Map<string, PlayabilityEntry>());
/** 非响应式：已完成待刷入的结果（批量刷新用） */
const pendingFlush = new Map<string, PlayabilityEntry>();
/** 批量刷新时按源合并的空壳计数（每源一次 kv 读写） */
const pendingEmptyCounts = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const inflight = new Map<string, Promise<PlayabilityEntry>>();
let running = 0;
const queue: Array<() => void> = [];

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPending();
  }, FLUSH_WINDOW_MS);
}

/** 把窗口内收集的结果一次性刷入 reactive 缓存 + 合并空壳连败记录 */
function flushPending(): void {
  if (pendingFlush.size === 0 && pendingEmptyCounts.size === 0) return;
  const entries = [...pendingFlush.entries()];
  pendingFlush.clear();
  const emptyCounts = [...pendingEmptyCounts.entries()];
  pendingEmptyCounts.clear();

  for (const [mediaId, entry] of entries) {
    cache.set(mediaId, entry);
  }
  evictIfNeeded();

  if (emptyCounts.length > 0) {
    void recordEmptyStreaks(emptyCounts).catch((e: unknown) => {
      logger.debug('批量记录空壳连败失败', { error: (e as Error)?.message });
    });
  }
}

/** 批量记录空壳连败：每源一次 kv 读写，达到阈值标 empty（P2-8） */
async function recordEmptyStreaks(counts: Array<[string, number]>): Promise<void> {
  const { kvRepo } = await import('@/db/repositories/kvRepo');
  const streaks = (await kvRepo.get<Record<string, number>>('source-empty-streak')) ?? {};
  const crossed: string[] = [];
  for (const [sourceId, count] of counts) {
    streaks[sourceId] = (streaks[sourceId] ?? 0) + count;
    if (streaks[sourceId] >= 3) crossed.push(sourceId);
  }
  await kvRepo.set('source-empty-streak', streaks);
  if (crossed.length > 0) {
    const { sourceService } = await import('@/services/sourceService');
    for (const sourceId of crossed) {
      await sourceService.markHealth(sourceId, 'empty');
      logger.warn('连续空壳，已标记源健康为 empty', { sourceId, streak: streaks[sourceId] });
    }
  }
}

function drainQueue(): void {
  while (running < PLAYABILITY_CONCURRENCY && queue.length > 0) {
    const next = queue.shift();
    if (next) next();
  }
}

function isFresh(entry: PlayabilityEntry): boolean {
  return entry.status !== 'unknown' && Date.now() - entry.checkedAt < PLAYABILITY_TTL_MS;
}

function evictIfNeeded(): void {
  while (cache.size >= PLAYABILITY_MAX_ENTRIES) {
    // LRU：Map 迭代顺序即插入顺序，最旧的在第一个
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function touch(mediaId: string): void {
  const entry = cache.get(mediaId);
  if (!entry) return;
  cache.delete(mediaId);
  cache.set(mediaId, entry);
}

async function fetchDetail(item: MediaItem): Promise<{ episodeCount: number; lineCount: number }> {
  // P0-FIX-1：peekDetail 纯网络探活，零 DB 写入、零事件广播
  const { libraryService } = await import('@/services/libraryService');
  return libraryService.peekDetail(item);
}

async function runCheck(mediaId: string, item: MediaItem): Promise<PlayabilityEntry> {
  running += 1;
  try {
    const { episodeCount, lineCount } = await fetchDetail(item);
    const entry: PlayabilityEntry = {
      status: episodeCount > 0 ? 'playable' : 'empty',
      episodeCount,
      lineCount,
      checkedAt: Date.now(),
    };
    if (entry.status === 'empty') {
      pendingEmptyCounts.set(item.sourceId, (pendingEmptyCounts.get(item.sourceId) ?? 0) + 1);
    }
    pendingFlush.set(mediaId, entry);
    scheduleFlush();
    return entry;
  } catch (e) {
    const entry: PlayabilityEntry = {
      status: 'error',
      episodeCount: 0,
      lineCount: 0,
      checkedAt: Date.now(),
    };
    pendingFlush.set(mediaId, entry);
    scheduleFlush();
    logger.debug('可播性预检失败', { mediaId, error: (e as Error)?.message });
    return entry;
  } finally {
    inflight.delete(mediaId);
    running -= 1;
    drainQueue();
  }
}

function enqueueCheck(mediaId: string, item: MediaItem): Promise<PlayabilityEntry> {
  return new Promise((resolve) => {
    const run = (): void => {
      void runCheck(mediaId, item).then(resolve);
    };
    if (running < PLAYABILITY_CONCURRENCY) run();
    else queue.push(run);
  });
}

export const playabilityService = {
  /** 读取当前状态（响应式：Vue 组件中调用会触发更新） */
  entryOf(mediaId: string): PlayabilityEntry | undefined {
    const entry = cache.get(mediaId);
    if (entry) touch(mediaId);
    return entry;
  },

  statusOf(mediaId: string): PlayabilityStatus {
    return cache.get(mediaId)?.status ?? 'unknown';
  },

  /**
   * 预检：缓存新鲜则直接返回，否则入队（在途去重 + 并发上限）。
   * 离线时不发起请求，返回 `unknown` 占位。
   */
  async ensure(mediaId: string, item: MediaItem): Promise<PlayabilityEntry> {
    const existing = cache.get(mediaId);
    if (existing && isFresh(existing)) {
      touch(mediaId);
      return existing;
    }
    const pending = inflight.get(mediaId);
    if (pending) return pending;
    if (!isOnline()) {
      const placeholder: PlayabilityEntry = existing ?? {
        status: 'unknown',
        episodeCount: 0,
        lineCount: 0,
        checkedAt: 0,
      };
      return placeholder;
    }
    const promise = enqueueCheck(mediaId, item);
    inflight.set(mediaId, promise);
    // 先写 verifying 占位（同步一次性），让 UI 立即看到状态变化
    cache.set(mediaId, {
      status: 'verifying',
      episodeCount: 0,
      lineCount: 0,
      checkedAt: existing?.checkedAt ?? 0,
    });
    return promise;
  },

  /** 批量预检（搜索结果上屏后触发） */
  async ensureMany(items: MediaItem[]): Promise<void> {
    await Promise.all(items.map((item) => playabilityService.ensure(item.id, item)));
  },

  /** DetailView 真实加载详情后回填（保证缓存与真实数据一致） */
  record(mediaId: string, episodeCount: number, lineCount: number): void {
    cache.set(mediaId, {
      status: episodeCount > 0 ? 'playable' : 'empty',
      episodeCount,
      lineCount,
      checkedAt: Date.now(),
    });
    evictIfNeeded();
  },

  /** 清除单条缓存（源健康变化 / 用户手动刷新时调用） */
  invalidate(mediaId: string): void {
    cache.delete(mediaId);
  },

  /** 清除全部缓存（清空搜索时调用） */
  clear(): void {
    cache.clear();
    inflight.clear();
    queue.length = 0;
    pendingFlush.clear();
    pendingEmptyCounts.clear();
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  },

  /** 测试辅助：重置内部状态 */
  __reset(): void {
    playabilityService.clear();
    running = 0;
  },
};
