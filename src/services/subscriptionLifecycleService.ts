/**
 * 订阅生命周期服务（v1.7 / CHG-19，FR-51）
 *
 * 补上「导入之后」的半程：订阅会慢慢坏掉（jar 403、域名失效、家庭宽带掉线），
 * 没有闭环时用户只会在检索/播放时撞上死源。
 *
 * 五件事：
 * 1. `maybeAutoRefresh` —— 逐订阅 TTL 判定，距上次成功刷新超过 24h（TTL）的订阅
 *    后台静默刷新（并发 ≤2，失败只累计不打扰）；
 * 2. `bindAutoRefresh` / `autoRefreshIfDue` —— FIX-06（Q-05=A）：启动 + App 回前台
 *    触发刷新，触发层再做一次 24h TTL 去重与在途合并（不引入常驻定时器）；
 * 3. `summarize` —— 按 subscriptionId 聚合源数 / 存活 / 死亡 / jar 死 / 最近刷新；
 * 4. `applyHealthDegradation` —— 连续 3 次体检 bad 的源自动禁用（可 `restore` 一键恢复）；
 * 5. `evaluateMultiRepo` —— 多仓索引逐仓展开评测，供 UI 推荐最优仓库。
 *
 * 计数状态存 kv（`subscription-refresh-state` / `source-health-streak`），
 * 不新增 Source 字段以外的表；自动禁用标记在 `Source.autoDisabledAt`。
 * 触发闸门（`autoRefreshRunAt` / 在途 Promise）只存内存，不落库。
 */
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { onAppStateChange, type AppLifecycleState } from '@/native/appLifecycle';
import { isOnline } from '@/native/network';
import { importService, listImportRecords } from '@/services/importService';
import { subscriptionEvalService, type SubscriptionEvalResult } from '@/services/subscriptionEvalService';
import {
  SUBSCRIPTION_AUTO_DISABLE_STREAK,
  SUBSCRIPTION_REFRESH_CONCURRENCY,
  SUBSCRIPTION_REFRESH_TTL_MS,
} from '@/shared/constants';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import { sourceRegistry } from '@/sources/registry';
import type { Source, SubscriptionSummary } from '@/types';

const KV_REFRESH_STATE = 'subscription-refresh-state';
const KV_HEALTH_STREAK = 'source-health-streak';

type RefreshState = Record<string, number>;
/** 源 → 连续体检 bad 次数 */
export type HealthStreak = Record<string, number>;

/** 体检判坏口径（与 disableUnhealthy 一致：timeout 可能是瞬时慢，但连续多次即真死） */
function isBadHealth(source: Source): boolean {
  return (
    source.enabled &&
    source.builtin === false &&
    source.healthCheckedAt !== null &&
    source.health !== 'ok' &&
    source.health !== 'unknown'
  );
}

async function readMap<T>(key: string): Promise<Record<string, T>> {
  const value = await kvRepo.get<Record<string, T>>(key);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 自动禁用前复检（P0-3）。
 *
 * 只对爬虫源做：它们的探活要走 jar 下载 + dex 加载 + 防护初始化，与真实链路差异最大，
 * 体检抖动造成的「假死」几乎都出在这一类。复检成功则就地回写 `health=ok`，
 * 并让调用方跳过本次禁用——宁可多留一个源，也不要一次抖动误禁一批好源。
 *
 * 非爬虫源 / Web 环境直接返回 false（不做网络请求，保持体检耗时与单测确定性）。
 */
async function recheckAlive(source: Source): Promise<boolean> {
  if (source.type !== 'spider' || !isNative() || !sourceRegistry.has(source.type)) return false;
  try {
    const adapter = sourceRegistry.get(source.type);
    const result = await adapter.testConnection(source);
    if (!result.ok) return false;
    await sourceRepo.save({
      ...source,
      health: 'ok',
      healthCheckedAt: Date.now(),
      lastErrorCode: null,
      updatedAt: source.updatedAt,
    });
    logger.info('自动禁用前复检通过，保留该源', source.name);
    return true;
  } catch (e) {
    logger.warn('自动禁用前复检失败（按原结论处置）', source.name, e);
    return false;
  }
}

/** 单条订阅刷新（成功返回时间戳，失败返回 null 并静默） */
async function refreshOne(url: string): Promise<number | null> {
  try {
    await importService.refreshSubscription(url);
    return Date.now();
  } catch (e) {
    logger.warn('订阅自动刷新失败（静默）', url, e);
    return null;
  }
}

/** `maybeAutoRefresh` 的结果（刷新成功条数 / 失败条数） */
export interface SubscriptionRefreshResult {
  refreshed: number;
  failed: number;
}

/** 自动刷新触发来源：启动 / 回前台（仅用于日志与排查） */
export type AutoRefreshTrigger = 'startup' | 'resume';

/** 自动刷新闸门跳过原因：TTL 未过期 / 已有在途刷新 / 离线 */
export type AutoRefreshSkip = 'ttl' | 'inflight' | 'offline';

/** 触发层自动刷新的结果 */
export interface AutoRefreshOutcome extends SubscriptionRefreshResult {
  /** 本次调用是否真正发起了刷新（false 表示被闸门拦下或复用了在途刷新） */
  triggered: boolean;
  /** `triggered=false` 时的跳过原因；`triggered=true` 为 null */
  skipped: AutoRefreshSkip | null;
}

/**
 * 触发层闸门（模块级，不落库）。
 *
 * - `autoRefreshRunAt`：最近一次**发起**刷新的时刻，用于 24h TTL 去重（Q-05=A 口径：
 *   启动与回前台共用同一闸门，24h 内只拉一次，避免切来切去反复请求）。
 *   刻意不持久化：进程重启后由启动触发兜底，而逐订阅的 TTL 状态已存在 kv
 *   （`subscription-refresh-state`），重启后 `maybeAutoRefresh` 的 due 为空即直接返回，
 *   不会真的重复拉取。
 * - `autoRefreshInFlight`：在途刷新 Promise。快速连续回前台（切后台→回前台→再切）时
 *   复用同一次执行，既不并发拉取也不丢触发语义。
 */
let autoRefreshRunAt: number | null = null;
let autoRefreshInFlight: Promise<SubscriptionRefreshResult> | null = null;
let autoRefreshUnbind: (() => void) | null = null;
/** 上一次生命周期状态；null = 尚未收到过事件（首次 active 视为一次回前台） */
let lastAppState: AppLifecycleState | null = null;

/**
 * 启动 / 回前台触发：TTL 与并发去重后执行一次 `maybeAutoRefresh`。
 *
 * 不抛异常（失败只记 debug 日志），调用方可安全 fire-and-forget。
 * 手动刷新（源管理页「刷新全部」）走 `maybeAutoRefresh`，不受本闸门限制。
 */
async function autoRefreshIfDue(trigger: AutoRefreshTrigger): Promise<AutoRefreshOutcome> {
  if (autoRefreshInFlight) {
    const result = await autoRefreshInFlight;
    logger.debug('订阅自动刷新合并到在途任务', trigger);
    return { ...result, triggered: false, skipped: 'inflight' };
  }

  const now = Date.now();
  if (autoRefreshRunAt !== null && now - autoRefreshRunAt < SUBSCRIPTION_REFRESH_TTL_MS) {
    logger.debug('订阅自动刷新跳过（TTL 未过期）', trigger, now - autoRefreshRunAt);
    return { triggered: false, skipped: 'ttl', refreshed: 0, failed: 0 };
  }
  if (!isOnline()) {
    logger.debug('订阅自动刷新跳过（离线）', trigger);
    return { triggered: false, skipped: 'offline', refreshed: 0, failed: 0 };
  }

  // 先落闸门再执行：同步段无 await，两次连续触发不会都进入执行分支。
  // 失败（含抛出）不回退闸门——否则每次回前台都会重试，反而变成请求风暴；
  // 未刷成功的订阅在 `subscription-refresh-state` 里没有新时间戳，下个 24h 窗口还会被扫到。
  autoRefreshRunAt = now;
  const run = subscriptionLifecycleService.maybeAutoRefresh().catch((e: unknown) => {
    logger.debug('订阅自动刷新失败（静默）', trigger, e);
    return { refreshed: 0, failed: 0 };
  });
  autoRefreshInFlight = run;
  try {
    const result = await run;
    return { ...result, triggered: true, skipped: null };
  } finally {
    if (autoRefreshInFlight === run) autoRefreshInFlight = null;
  }
}

export const subscriptionLifecycleService = {
  /**
   * 启动/前台触发：距上次成功刷新超过 TTL 的订阅静默刷新（并发 ≤2）。
   * 返回 { refreshed, failed }；调用方无需提示（失败静默）。
   */
  async maybeAutoRefresh(signal?: AbortSignal): Promise<{ refreshed: number; failed: number }> {
    const records = await listImportRecords();
    if (records.length === 0) return { refreshed: 0, failed: 0 };
    const state = await readMap<number>(KV_REFRESH_STATE);
    const now = Date.now();

    const due = records.filter((record) => {
      const last = state[record.url];
      return last === undefined || now - last > SUBSCRIPTION_REFRESH_TTL_MS;
    });
    if (due.length === 0) return { refreshed: 0, failed: 0 };

    let refreshed = 0;
    let failed = 0;
    let cursor = 0;
    const nextState: RefreshState = { ...state };
    await Promise.all(
      Array.from({ length: Math.min(SUBSCRIPTION_REFRESH_CONCURRENCY, due.length) }, async () => {
        while (cursor < due.length) {
          const record = due[cursor];
          cursor += 1;
          if (!record || signal?.aborted) return;
          const at = await refreshOne(record.url);
          if (at !== null) {
            refreshed += 1;
            nextState[record.url] = at;
          } else {
            failed += 1;
          }
        }
      }),
    );
    if (refreshed > 0) await kvRepo.set(KV_REFRESH_STATE, nextState);
    return { refreshed, failed };
  },

  /**
   * FIX-06 / AC-119：启动 + App 回前台触发（Q-05=A）。
   *
   * 触发层再做一次 24h TTL 去重与在途合并；`skipped` 说明被拦原因。
   * 不抛异常，可 fire-and-forget。
   */
  autoRefreshIfDue,

  /**
   * 接线应用前后台切换：仅在「切到前台」时补触发一次（后台不做任何事）。
   *
   * 只在本模块注册一次（重复调用返回同一个 unbind，幂等），
   * 与 `downloadService.bindLifecycle()` 的做法一致。
   * 返回取消订阅函数（测试/热重载用）。
   */
  bindAutoRefresh(): () => void {
    if (autoRefreshUnbind) return autoRefreshUnbind;
    lastAppState = null;
    const unbindBase = onAppStateChange((state) => {
      if (state === lastAppState) return;
      lastAppState = state;
      if (state !== 'active') return;
      // 回前台：TTL 未过期 / 离线 / 已有在途刷新时由闸门直接跳过
      void subscriptionLifecycleService.autoRefreshIfDue('resume');
    });
    const unbind = (): void => {
      unbindBase();
      lastAppState = null;
      if (autoRefreshUnbind === unbind) autoRefreshUnbind = null;
    };
    autoRefreshUnbind = unbind;
    return unbind;
  },

  /** 测试辅助：清空触发闸门与生命周期订阅（不触发任何刷新） */
  __resetAutoRefreshState(): void {
    const unbind = autoRefreshUnbind;
    autoRefreshUnbind = null;
    lastAppState = null;
    autoRefreshRunAt = null;
    autoRefreshInFlight = null;
    unbind?.();
  },

  /** 按订阅来源聚合健康摘要（subscriptionId 为 null 的手工源不参与） */
  async summarize(): Promise<SubscriptionSummary[]> {
    const [sources, refreshState] = await Promise.all([
      sourceRepo.list(),
      readMap<number>(KV_REFRESH_STATE),
    ]);
    const bySubscription = new Map<string, Source[]>();
    for (const source of sources) {
      if (!source.subscriptionId) continue;
      const list = bySubscription.get(source.subscriptionId);
      if (list) list.push(source);
      else bySubscription.set(source.subscriptionId, [source]);
    }

    const out: SubscriptionSummary[] = [];
    for (const [subscriptionId, list] of bySubscription) {
      // subscriptionId 可能是 URL 或文件名：刷新时间只在 URL 形态下有记录
      const lastRefreshAt = refreshState[subscriptionId] ?? null;
      out.push({
        subscriptionId,
        sourceCount: list.length,
        alive: list.filter((s) => s.health === 'ok').length,
        dead: list.filter((s) => s.healthCheckedAt !== null && s.health !== 'ok' && s.health !== 'unknown').length,
        jarDead: list.filter((s) => (s.warning ?? '').includes('jar 不可达')).length,
        lastRefreshAt,
      });
    }
    return out.sort((a, b) => b.sourceCount - a.sourceCount);
  },

  /**
   * 体检后的退化处置：连续 `SUBSCRIPTION_AUTO_DISABLE_STREAK` 次 bad 的启用源
   * 自动禁用（`autoDisabledAt` 标记，源管理页可见并可一键恢复）。
   * 必须在每轮体检结束后调用；返回本次处置数量。
   */
  async applyHealthDegradation(): Promise<number> {
    const sources = await sourceRepo.list();
    const streaks = await readMap<number>(KV_HEALTH_STREAK);
    const now = Date.now();
    let degraded = 0;
    let dirty = false;

    for (const source of sources) {
      const key = source.id;
      if (isBadHealth(source)) {
        const streak = (streaks[key] ?? 0) + 1;
        streaks[key] = streak;
        dirty = true;
        if (streak >= SUBSCRIPTION_AUTO_DISABLE_STREAK && !source.autoDisabledAt) {
          // P0-3：禁用是不可逆的用户可见后果，先复检一次（爬虫源）
          if (await recheckAlive(source)) {
            delete streaks[key];
            dirty = true;
            continue;
          }
          await sourceRepo.save({
            ...source,
            enabled: false,
            autoDisabledAt: now,
            updatedAt: now,
          });
          streaks[key] = 0;
          degraded += 1;
          logger.warn('连续体检失败，已自动禁用', source.name, streak);
        }
      } else if (streaks[key] !== undefined) {
        // ok 或未检测：清零（未检测不累计也不清零？——清零更保守，避免一次性断网误禁）
        if (source.health === 'ok') {
          delete streaks[key];
          dirty = true;
        }
      }
    }
    if (dirty) await kvRepo.set(KV_HEALTH_STREAK, streaks);
    return degraded;
  },

  /** 恢复被自动禁用的源（清标记、重新启用） */
  async restore(sourceId: string): Promise<void> {
    const source = await sourceRepo.get(sourceId);
    if (!source) return;
    const streaks = await readMap<number>(KV_HEALTH_STREAK);
    delete streaks[sourceId];
    await kvRepo.set(KV_HEALTH_STREAK, streaks);
    await sourceRepo.save({
      ...source,
      enabled: true,
      autoDisabledAt: null,
      health: 'unknown',
      healthCheckedAt: null,
      updatedAt: Date.now(),
    });
  },

  /**
   * 多仓索引逐仓评测：先拉索引（识别 repos[]），再并发评测每个仓库。
   * 非多仓地址返回空数组（UI 回退到单订阅评测）。
   */
  async evaluateMultiRepo(
    url: string,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<SubscriptionEvalResult[]> {
    const preview = await importService.previewFromUrl(url, signal, { jarPrecheck: false });
    if (preview.repos.length === 0) return [];
    return subscriptionEvalService.evaluate(preview.repos, signal, onProgress);
  },
};
