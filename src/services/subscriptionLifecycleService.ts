/**
 * 订阅生命周期服务（v1.7 / CHG-19，FR-51）
 *
 * 补上「导入之后」的半程：订阅会慢慢坏掉（jar 403、域名失效、家庭宽带掉线），
 * 没有闭环时用户只会在检索/播放时撞上死源。
 *
 * 四件事：
 * 1. `maybeAutoRefresh` —— 启动/前台触发，距上次成功刷新超过 24h（TTL）的订阅
 *    后台静默刷新（并发 ≤2，失败只累计不打扰）；
 * 2. `summarize` —— 按 subscriptionId 聚合源数 / 存活 / 死亡 / jar 死 / 最近刷新；
 * 3. `applyHealthDegradation` —— 连续 3 次体检 bad 的源自动禁用（可 `restore` 一键恢复）；
 * 4. `evaluateMultiRepo` —— 多仓索引逐仓展开评测，供 UI 推荐最优仓库。
 *
 * 计数状态存 kv（`subscription-refresh-state` / `source-health-streak`），
 * 不新增 Source 字段以外的表；自动禁用标记在 `Source.autoDisabledAt`。
 */
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
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
