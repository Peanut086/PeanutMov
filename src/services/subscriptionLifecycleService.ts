/**
 * 订阅生命周期服务（v1.7 / CHG-19，FR-51）
 *
 * 补上「导入之后」的半程：订阅会慢慢坏掉（jar 403、域名失效、家庭宽带掉线），
 * 没有闭环时用户只会在检索/播放时撞上死源。
 *
 * 五件事：
 * 1. `maybeAutoRefresh` —— 逐订阅 TTL 判定，距上次成功刷新超过 24h（TTL）的订阅
 *    后台静默刷新（并发 ≤2）；P2-1 起每次尝试都落 `subscription-refresh-outcomes` 台账
 *    （最近尝试 / 最近成功 / 失败或部分成功原因），连续失败按 `backoffMsFor` 退避；
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
import { subscriptionRepo } from '@/db/repositories/subscriptionRepo';
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
import { formatRelativeTime } from '@/shared/time';
import { sourceRegistry } from '@/sources/registry';
import type { Source, SubscriptionSummary } from '@/types';

const KV_REFRESH_STATE = 'subscription-refresh-state';
/** P2-1：逐订阅刷新台账（最近尝试 / 最近成功 / 失败或部分成功原因） */
const KV_REFRESH_OUTCOMES = 'subscription-refresh-outcomes';
const KV_HEALTH_STREAK = 'source-health-streak';

type RefreshState = Record<string, number>;
/** 源 → 连续体检 bad 次数 */
export type HealthStreak = Record<string, number>;

/**
 * P2-1：单订阅刷新结果（持久化，重启后界面口径不变）。
 *
 * 三条口径写在这里，避免再出现"自动刷新失败了但界面上一片祥和"：
 * - `succeededAt` 只在刷新成功时前进；失败保留上一次成功时间，绝不把有效订阅写成"坏了"；
 * - `failReason` 是给用户看的一句话（对症到"是地址挂了还是解析变了"），
 *   `note` 记部分成功（新增未导入 / jar 判死 / 直播缺口）——那不算失败，但也不能说全绿；
 * - 自动重试按 `failCount` 退避（见 `backoffMsFor`），手动刷新不受退避限制。
 */
export interface SubscriptionRefreshOutcome {
  /** 最近一次**发起**刷新的时刻（成功或失败都算尝试） */
  attemptedAt: number;
  /** 最近一次成功刷新的时刻；从未成功过为 null */
  succeededAt: number | null;
  /** 最近一次失败原因；成功时清空 */
  failReason: string | null;
  /** 部分成功说明；完全成功为 null */
  note: string | null;
  /** 连续失败次数（成功即归零），决定自动重试退避 */
  failCount: number;
}

type OutcomeState = Record<string, SubscriptionRefreshOutcome>;

/**
 * 连续失败的自动重试间隔：越试不通离得越远，最长回到 24h 的常规节奏。
 *
 * 上限刻意不超过 TTL——订阅可能悄悄被源主修好，隔天再试一次的成本极低。
 */
export function backoffMsFor(failCount: number): number {
  if (failCount <= 0) return 0;
  const steps = [30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000];
  return failCount > steps.length ? SUBSCRIPTION_REFRESH_TTL_MS : (steps[failCount - 1] ?? 0);
}

/**
 * 这个订阅现在该不该刷。
 *
 * TTL 口径以**成功时间**为准（刷成功过才算"24h 内已刷新"）；失败只触发退避，
 * 退避期内不再自动重投，但手动刷新（`force`）随时可以。
 */
function isRefreshDue(
  url: string,
  successState: RefreshState,
  outcomes: OutcomeState,
  now: number,
  force: boolean,
): boolean {
  if (force) return true;
  const lastOk = successState[url];
  if (lastOk !== undefined && now - lastOk <= SUBSCRIPTION_REFRESH_TTL_MS) return false;
  const outcome = outcomes[url];
  if (outcome && outcome.failCount > 0) {
    if (now - outcome.attemptedAt < backoffMsFor(outcome.failCount)) return false;
  }
  return true;
}

/** 台账写入：成功与失败共用，保证两条路径（自动 / 手动）落在同一份记录上 */
async function writeOutcome(
  url: string,
  patch: { ok: boolean; reason?: string | null; note?: string | null },
): Promise<SubscriptionRefreshOutcome> {
  const outcomes = await readMap<SubscriptionRefreshOutcome>(KV_REFRESH_OUTCOMES);
  const prev = outcomes[url];
  const now = Date.now();
  const next: SubscriptionRefreshOutcome = patch.ok
    ? {
        attemptedAt: now,
        succeededAt: now,
        failReason: null,
        note: patch.note ?? null,
        failCount: 0,
      }
    : {
        attemptedAt: now,
        // 失败不覆盖上一次成功时间：有效订阅不会因为一次抖动在界面上变成"坏了"
        succeededAt: prev?.succeededAt ?? null,
        failReason: (patch.reason ?? '刷新失败').slice(0, 200),
        note: prev?.note ?? null,
        failCount: (prev?.failCount ?? 0) + 1,
      };
  await kvRepo.set(KV_REFRESH_OUTCOMES, { ...outcomes, [url]: next });
  return next;
}

/** 逐订阅刷新台账（订阅管理页展示用；只含当前已有的订阅） */
export async function listRefreshOutcomes(): Promise<OutcomeState> {
  return readMap<SubscriptionRefreshOutcome>(KV_REFRESH_OUTCOMES);
}

/** 台账一行话的语气：成功 / 有缺口 / 失败 */
export type RefreshOutcomeTone = 'ok' | 'warn' | 'bad';

/** 退避剩余的人话时长（步长是 30min/2h/8h/24h，分钟与小时够用） */
function formatWait(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.round(minutes / 60)} 小时`;
}

/**
 * 把一条台账记录说成一句用户能对症的话（P2-1，界面直接渲染）。
 *
 * 口径写在服务里，是为了让「刷新后看到的」和「重启后看到的」是同一段推导：
 * - 失败时保留并显示上一次成功时间——一次抖动不该让有效订阅看起来像坏了；
 * - 退避剩余要说清，否则用户以为后台还在持续重试；
 * - 部分成功不是失败，但缺口必须跟在后面，不能显示成全绿。
 */
export function describeRefreshOutcome(
  outcome: SubscriptionRefreshOutcome,
  now: number = Date.now(),
): { text: string; tone: RefreshOutcomeTone } {
  const attempted = formatRelativeTime(outcome.attemptedAt, now);
  if (outcome.failReason) {
    const lastOk =
      outcome.succeededAt === null ? '' : `，上次成功 ${formatRelativeTime(outcome.succeededAt, now)}`;
    const remain = outcome.attemptedAt + backoffMsFor(outcome.failCount) - now;
    const backoff =
      outcome.failCount > 0 && remain > 0
        ? `（连续 ${outcome.failCount} 次失败，约 ${formatWait(remain)}后自动重试）`
        : '';
    return { text: `${attempted}刷新失败：${outcome.failReason}${lastOk}${backoff}`, tone: 'bad' };
  }
  if (outcome.note) return { text: `${attempted}刷新成功，${outcome.note}`, tone: 'warn' };
  return { text: `${attempted}刷新成功`, tone: 'ok' };
}

/** 「全部刷新」提示的三档语气 */
export type RefreshSummaryTone = 'info' | 'success' | 'error';

/**
 * 订阅展示名（P0-1：源管理摘要与订阅管理页共用一份口径）。
 *
 * `subscriptionId` 是 URL 原文或文件名：URL 直接铺在屏幕上会撑满一行，
 * 文件名则要末段才认得出是哪份订阅。
 */
export function subscriptionLabel(subscriptionId: string): string {
  try {
    return new URL(subscriptionId).hostname;
  } catch {
    const clean = subscriptionId.split('?')[0] ?? subscriptionId;
    const parts = clean.split('/');
    return parts[parts.length - 1] || clean;
  }
}

/**
 * 「刷新全部」的一行文案（订阅管理页与源管理页共用一份口径）。
 *
 * 三档必须分开说：都没发起不是失败，把 deferred 省掉会让"TTL/退避跳过"显示成成功或失败。
 */
export function refreshSummaryText(result: SubscriptionRefreshResult): {
  tone: RefreshSummaryTone;
  text: string;
} {
  const { refreshed, failed, deferred } = result;
  if (refreshed === 0 && failed === 0) {
    return {
      tone: 'info',
      text:
        deferred > 0
          ? `已跳过 ${deferred} 个订阅（24h 内刷过或失败退避中）`
          : '没有可刷新的订阅（只支持 URL 导入的订阅）',
    };
  }
  const skipText = deferred > 0 ? `，${deferred} 个在 24h 或退避中未发起` : '';
  if (failed === 0) return { tone: 'success', text: `已刷新 ${refreshed} 个订阅${skipText}` };
  return {
    tone: 'error',
    text: `刷新完成：成功 ${refreshed}，失败 ${failed}${skipText}（原因见对应订阅行，可单条立即重试）`,
  };
}

/**
 * 刷一条订阅并记账（P2-1：自动与手动共用同一入口，口径才不会分叉）。
 *
 * 不抛异常：失败原因归化成一句话返回，由调用方决定是静默（自动）还是提示（手动）。
 * 成功时同步推进 `subscription-refresh-state`，所以手动刷过的订阅在自动链路里
 * 同样算"24h 内已刷新"。
 */
export async function refreshTracked(
  url: string,
): Promise<{
  ok: boolean;
  reason: string | null;
  outcome: SubscriptionRefreshOutcome;
  counts: { updated: number; newCount: number; jarDead: number; livesSynced: number; livesFailed: number } | null;
}> {
  try {
    const counts = await importService.refreshSubscription(url);
    // 部分成功不算失败（订阅本身刷到了），但缺口要留在台账里
    const parts: string[] = [];
    if (counts.newCount > 0) parts.push(`新增 ${counts.newCount} 条未导入`);
    if (counts.jarDead > 0) parts.push(`${counts.jarDead} 个 jar 已失效未覆盖`);
    if (counts.livesFailed > 0) parts.push(`${counts.livesFailed} 个直播源同步失败`);
    const outcome = await writeOutcome(url, { ok: true, note: parts.length > 0 ? parts.join('，') : null });
    const state = await readMap<number>(KV_REFRESH_STATE);
    await kvRepo.set(KV_REFRESH_STATE, { ...state, [url]: outcome.succeededAt ?? Date.now() });
    return { ok: true, reason: null, outcome, counts };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    const outcome = await writeOutcome(url, { ok: false, reason });
    logger.warn('订阅刷新失败（已记账）', url, reason);
    return { ok: false, reason, outcome, counts: null };
  }
}

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
 * 自动禁用前复检（P0-3 → P1-7 放开到全部联网源）。
 *
 * 禁用是不可逆的用户可见后果，而体检抖动造成的「假死」不只出在爬虫源：P1-7 实测口径下，
 * 内网 alist / webdav / jellyfin 首目录大或 NAS 唤醒慢时同样会被判 timeout，连续 3 次即误禁。
 * 故只要类型有适配器且真的联网，就复检一次：通过则就地回写 `health=ok`，
 * 并让调用方跳过本次禁用——宁可多留一个源，也不要一次抖动误禁一批好源。
 *
 * 演示源（无网络请求）、Web 环境（保持体检耗时与单测确定性）不做复检。
 */
async function recheckAlive(source: Source): Promise<boolean> {
  if (source.type === 'demo' || !isNative() || !sourceRegistry.has(source.type)) return false;
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

/** 单条订阅刷新（自动链路：失败静默，但一定记账） */
async function refreshOne(url: string): Promise<number | null> {
  const result = await refreshTracked(url);
  return result.ok ? result.outcome.succeededAt : null;
}

/** `maybeAutoRefresh` 的结果 */
export interface SubscriptionRefreshResult {
  refreshed: number;
  failed: number;
  /** P2-1：TTL 内或连续失败退避中、这一轮没有发起的订阅数 */
  deferred: number;
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
    return { triggered: false, skipped: 'ttl', refreshed: 0, failed: 0, deferred: 0 };
  }
  if (!isOnline()) {
    logger.debug('订阅自动刷新跳过（离线）', trigger);
    return { triggered: false, skipped: 'offline', refreshed: 0, failed: 0, deferred: 0 };
  }

  // 先落闸门再执行：同步段无 await，两次连续触发不会都进入执行分支。
  // 失败（含抛出）不回退闸门——否则每次回前台都会重试，反而变成请求风暴；
  // 未刷成功的订阅在台账里只推进 `attemptedAt`，按 `backoffMsFor` 退避到点再试，
  // 手动刷新走 `refreshTracked` 不受这两层限制。
  autoRefreshRunAt = now;
  const run = subscriptionLifecycleService.maybeAutoRefresh().catch((e: unknown) => {
    logger.debug('订阅自动刷新失败（静默）', trigger, e);
    return { refreshed: 0, failed: 0, deferred: 0 };
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
   *
   * `deferred` 是 P2-1 补上的第三档：连续失败的订阅在退避期内不重投，
   * 这既不是成功也不是这次失败，界面必须能区分开（否则"一个都没刷"会显示成"全部失败"）。
   * 逐订阅的成功时间/失败原因由 `refreshTracked` 就地记账，这里不再整表回写
   * `subscription-refresh-state`——整表写会把并发的手动刷新结果覆盖掉。
   */
  async maybeAutoRefresh(
    signal?: AbortSignal,
    options: { force?: boolean } = {},
  ): Promise<{ refreshed: number; failed: number; deferred: number }> {
    const records = await listImportRecords();
    if (records.length === 0) return { refreshed: 0, failed: 0, deferred: 0 };
    const state = await readMap<number>(KV_REFRESH_STATE);
    const outcomes = await readMap<SubscriptionRefreshOutcome>(KV_REFRESH_OUTCOMES);
    const now = Date.now();

    const due: string[] = [];
    let deferred = 0;
    for (const record of records) {
      if (isRefreshDue(record.url, state, outcomes, now, options.force === true)) due.push(record.url);
      else deferred += 1;
    }
    if (due.length === 0) return { refreshed: 0, failed: 0, deferred };

    let refreshed = 0;
    let failed = 0;
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(SUBSCRIPTION_REFRESH_CONCURRENCY, due.length) }, async () => {
        while (cursor < due.length) {
          const url = due[cursor];
          cursor += 1;
          if (!url || signal?.aborted) return;
          const at = await refreshOne(url);
          if (at !== null) refreshed += 1;
          else failed += 1;
        }
      }),
    );
    return { refreshed, failed, deferred };
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

    // P1-2：订阅实体（DB v7 `subscriptions`）。来源标识一直写在每个源上，但订阅本身没有记录，
    // 于是解析器给的名称只能从「最近 20 条」导入记录里临时捞，捞不到界面就退回主机名。
    // 这里顺带把缺失的实体补建出来：主键由来源标识派生，所以补建天然幂等，不需要版本号或迁移标记。
    const entities = new Map((await subscriptionRepo.list()).map((item) => [item.key, item] as const));
    const recordNames = new Map(
      (await listImportRecords()).map((record) => [record.url, record.name] as const),
    );

    const out: SubscriptionSummary[] = [];
    for (const [subscriptionId, list] of bySubscription) {
      let entity = entities.get(subscriptionId) ?? null;
      if (!entity) {
        const isUrl = /^https?:\/\//i.test(subscriptionId);
        try {
          entity = await subscriptionRepo.upsertKeyed({
            key: subscriptionId,
            url: isUrl ? subscriptionId : null,
            fileName: isUrl ? null : subscriptionId,
            name: recordNames.get(subscriptionId) ?? null,
          });
        } catch {
          // 补建只是把名称固化下来，失败不该让摘要读不出来：退回主机名口径（与改动前一致）
          entity = null;
        }
        if (entity) entities.set(subscriptionId, entity);
      }
      // subscriptionId 可能是 URL 或文件名：刷新时间只在 URL 形态下有记录
      const lastRefreshAt = refreshState[subscriptionId] ?? null;
      out.push({
        subscriptionId,
        name: entity?.name ?? null,
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
          // P0-3 / P1-7：禁用是不可逆的用户可见后果，先复检一次（全部联网源）
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
