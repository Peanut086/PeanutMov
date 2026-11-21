/**
 * 冷启动会话恢复（G3）
 *
 * 国产 ROM 会在 App 切后台后把进程整个杀掉（华为真机实证：`iAwareF[SystemManager]`
 * force-stop + `AK-LowMem` SIGKILL），用户看到的"闪退"其实是进程没了。原生侧已按
 * 退出原因归因（G1/G2），前端再补一刀体验：重新打开时直接回到上次那集，
 * 把"闪退了"变成"接着放"。
 *
 * 规则：
 * - 只记播放页与回看页（详情页不记：它没有可续的进度，用户主动杀掉后该落在主界面，
 *   "接着看"由首页的「继续观看」承接），且必须带齐拼出 URL 所需的路由参数；
 * - `?restart=1`（从头播放）不落盘——恢复的语义是"接着放"，不是"重播开头"，
 *   去掉后 PlayerView 自然按 history 里的 `positionSec` 续播；
 * - 离开可恢复页面即删除，所以「看完退回首页再重开」不会被塞回播放页；
 * - 只在「首帧落在首页」时接管一次，带 hash 的深链/提醒跳转等有明确目标的启动不动它；
 * - `pauseHistoryRecording`（隐私开关）打开时完全不写；
 * - 超过 TTL 的陈旧快照丢弃（读到时判定，不常驻定时器）。
 *
 * P0-5（不重放崩溃现场）在上面那条链路里补了三件事：
 * 1. 自动换线 / 自动换源引起的路由变化**不写快照**——那一刻路由里的集 id 与线路都是
 *    兜底链的候选，用户从没确认过，把它们记下来等于把"刚把进程打死的那一份现场"
 *    定为下次启动的目标（真机上就是"重开就在 ep1/ep2 之间跳、线路一路自动切到全废"）；
 *    候选真的把播放器推进了，才算"最后稳定线路"，那一刻补记一次；
 * 2. 上次退出按 `exitKindOf` 分档（正常退出 / 系统回收 / 原生崩溃 / Java 崩溃 / 未知）：
 *    低内存与后台清理照常续播，只有"进程自己倒下"且这份现场关联到**jar 级隔离**的源时，
 *    才不自动进播放页，改停在同片的详情页并带上集号等用户自己选；
 * 3. 恢复只改路由，不写历史：目标集定位失败由播放页的 P1-1 披露态拦在起播之前，
 *    进度写回因此不可能落到"错集"上。
 */
import type { Router } from 'vue-router';

import { historyRepo } from '@/db/repositories/historyRepo';
import { kvRepo } from '@/db/repositories/kvRepo';
import { hasPendingAutoFailoverNavigation, onFailoverAdvanced } from '@/player/failoverSession';
import { onAppStateChange } from '@/native/appLifecycle';
import { KV_KEY_LAST_SESSION } from '@/shared/constants';
import { sourceIdHintOfMediaId } from '@/shared/id';
import { logger } from '@/shared/logger';
import { isCrashExit, lastExitKind, matchHighConfidenceBlockedSource, type ExitKind } from '@/services/sourceBlockState';
import { settingsService } from '@/services/settingsService';

export interface SessionSnapshot {
  name: string;
  params: Record<string, string>;
  query: Record<string, string>;
  at: number;
}

/** 快照只消费 name/params/query，窄类型让单测能直接喂普通对象 */
interface RouteLike {
  name?: unknown;
  params?: unknown;
  query?: unknown;
}

/**
 * 可恢复的页面 → 拼出该页 URL 必填的路径参数。
 *
 * 白名单只放"有东西可续"的页面：详情页不在内——它没有播放进度可接，把它恢复成冷启动
 * 落点只会让用户觉得"我明明关掉了，为什么打开还是它"。
 * `planRestore` 的崩溃避让仍可以把落点改成 detail，那是一次性的落点，不是可记录页。
 */
const RESTORABLE_ROUTES: Record<string, string[]> = {
  player: ['mediaId'],
  replay: ['sourceId', 'programId'],
};

/** 恢复时丢弃的 query 键：restart=从头播；t=口令定位点（恢复语义该听黑匣子/历史，不该听别人的进度） */
const DROP_QUERY_KEYS = new Set(['restart', 't']);

/** 快照有效期：跨一夜就不再是"刚才那集"了 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 冷启动落点：只有首帧停在首页才接管 */
const COLD_START_ROUTE = 'home';

function textOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return typeof raw[0] === 'string' ? raw[0] : '';
  return '';
}

function flatten(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    const value = textOf(raw);
    if (value) out[key] = value;
  }
  return out;
}

/** 路由 → 快照；不可恢复的页面或缺必填参数时返回 null */
export function sessionSnapshotOf(route: RouteLike): SessionSnapshot | null {
  const name = typeof route.name === 'string' ? route.name : '';
  const required = RESTORABLE_ROUTES[name];
  if (!required) return null;

  const params = flatten(route.params);
  if (required.some((key) => !params[key])) return null;

  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(flatten(route.query))) {
    if (!DROP_QUERY_KEYS.has(key)) query[key] = value;
  }

  return { name, params, query, at: Date.now() };
}

/** 存储里读回来的东西是不可信输入：形状不合或过期都按"没有快照"处理 */
export function normalizeSessionSnapshot(raw: unknown): SessionSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const at = typeof candidate.at === 'number' ? candidate.at : 0;
  if (!at || at > Date.now() || Date.now() - at > SESSION_TTL_MS) return null;
  const snapshot = sessionSnapshotOf({
    name: candidate.name,
    params: candidate.params,
    query: candidate.query,
  });
  return snapshot ? { ...snapshot, at } : null;
}

/** 已落盘的快照（内存镜像），用于避免同一路由重复读写 */
let persisted: SessionSnapshot | null = null;
let detachLifecycle: (() => void) | null = null;
let detachAdvanced: (() => void) | null = null;

function samePlace(a: SessionSnapshot | null, b: SessionSnapshot | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.name === b.name &&
    JSON.stringify(a.params) === JSON.stringify(b.params) &&
    JSON.stringify(a.query) === JSON.stringify(b.query)
  );
}

/** 写入或删除当前快照；`force` 用于切后台时刷新时间戳 */
async function record(route: RouteLike, force = false): Promise<void> {
  try {
    /*
     * P0-5：自动兜底链引起的路由变化里，集 id 和线路都是"还没被用户确认过的候选"——
     * 换线时它可能正在失败、换源时它甚至换了片。把这些写进快照，下次冷启动就把崩溃现场
     * 当成用户目标再跑一遍。`hasPendingAutoFailoverNavigation()` 只在令牌还飞的这几毫秒为真：
     * 新实例挂载时 `beginLoadAttempt` 会取走令牌，所以"候选真的播起来了"那一轮之后
     * 由 `onFailoverAdvanced` 补记（见 `bindSessionRestore`）——那时它才成了"最后稳定线路"。
     * 切后台的补写同样受这条拦截约束：进程恰恰容易在被清掉的那一刻停在候选导航上。
     */
    if (hasPendingAutoFailoverNavigation()) {
      logger.debug('P0-5：自动换线/换源的候选导航不写入会话快照', {
        route: typeof route.name === 'string' ? route.name : '?',
      });
      return;
    }
    const settings = await settingsService.get();
    const next = settings.pauseHistoryRecording ? null : sessionSnapshotOf(route);
    if (!next && !persisted) return;
    if (!force && samePlace(persisted, next)) return;
    persisted = next;
    if (next) await kvRepo.set(KV_KEY_LAST_SESSION, next);
    else await kvRepo.delete(KV_KEY_LAST_SESSION);
  } catch (e) {
    logger.debug('会话快照写入失败', { error: (e as Error)?.message });
  }
}

/** 读出并一次性消费冷启动快照（含 TTL 与形状校验） */
export async function takeSessionSnapshot(): Promise<SessionSnapshot | null> {
  const stored = await kvRepo.get<unknown>(KV_KEY_LAST_SESSION);
  if (stored === null) return null;
  await kvRepo.delete(KV_KEY_LAST_SESSION);
  persisted = null;
  return normalizeSessionSnapshot(stored);
}

/**
 * P0-5：冷启动落点的判定结果。
 *
 * 六个字段就是这一项的验收口径（`restoreReason / matchedBy / exitKind / snapshotAge /
 * resumeEpisode / sourceSkipped`），既进日志也留给单测断言，避免"恢复了什么"只能靠人眼读路由。
 */
export interface RestorePlan {
  name: string;
  params: Record<string, string>;
  query: Record<string, string>;
  /** `resume` 照常续播 / `system_reclaim_resume` 被系统清掉后续播 / `crash_source_skipped` 崩溃且源被隔离 */
  restoreReason: 'resume' | 'system_reclaim_resume' | 'crash_source_skipped';
  /** 目标集是按什么对上的：路由里的集 id / query 的集号 / 只有片 id */
  matchedBy: 'episode-id' | 'ep-query' | 'episode-number' | 'media' | 'route';
  /** 上次退出的归因；读不到按 `unknown`（等同"不是崩溃"） */
  exitKind: ExitKind;
  /** 快照龄（ms）：判定 TTL 用，也用来区分"刚才那集"和"昨晚那集" */
  snapshotAge: number;
  /** 恢复过去的集号（拿不到为 null） */
  resumeEpisode: number | null;
  /** 因此次判定被跳过的源（没有跳过为 null） */
  sourceSkipped: string | null;
}

/** 集号优先信路由（用户最后确认的那一次），其次信历史（最后真的在播的那一次） */
function episodeNumberOf(snapshot: SessionSnapshot, recorded: number | null): number | null {
  const fromQuery = Number(snapshot.query.ep ?? '');
  if (Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery;
  return recorded;
}

/**
 * 快照 + 上次退出归因 → 这次启动该落在哪。
 *
 * 只有一件事会让它改写落点：**上次是进程自己倒下的（原生或 JVM 崩溃），而且这片子来自
 * 一个已被 jar 级隔离的源**。这时进播放页等于把刚把进程打死的解析/嗅探链再敲一遍，
 * 于是停在同片的详情页、带上集号，让用户自己选线路——「停在同集待选择」。
 * 低内存与后台清理（真机上占绝大多数）不是 App 的错，照常续播；短时冷却也不算高可信，
 * 那一档一半是误判，拿它拦恢复会把"被系统清了"变成"这集打不开"。
 */
export async function planRestore(snapshot: SessionSnapshot): Promise<RestorePlan> {
  const snapshotAge = Math.max(0, Date.now() - snapshot.at);
  const episodeId = snapshot.params.episodeId ?? null;
  const byRoute: RestorePlan['matchedBy'] =
    episodeId !== null ? 'episode-id' : Number(snapshot.query.ep ?? '') > 0 ? 'ep-query' : 'route';
  let exitKind: ExitKind = 'unknown';
  try {
    exitKind = (await lastExitKind()).kind;
  } catch (e) {
    logger.debug('P0-5：上次退出归因读取失败（按未知处理）', { error: (e as Error)?.message });
  }

  const mediaId = snapshot.params.mediaId ?? '';
  if (snapshot.name === 'player' && mediaId) {
    const recorded = await historyRepo.getByMedia(mediaId).catch(() => null);
    // 源的来历：历史记录里是真实 sourceId；读不到（清过缓存 / 第一次看）就用 mediaId 的
    // 头一段做线索——历史缺席不构成"放行崩溃现场"的理由。
    const sourceHint = recorded?.sourceId ?? sourceIdHintOfMediaId(mediaId);
    const skipped = isCrashExit(exitKind) ? matchHighConfidenceBlockedSource(sourceHint) : null;
    if (skipped !== null) {
      const episode = episodeNumberOf(snapshot, recorded?.episodeNumber ?? null);
      logger.warn('P0-5：上次崩溃现场关联到已隔离的源，恢复改停详情页等用户选线路', {
        restoreReason: 'crash_source_skipped',
        exitKind,
        sourceSkipped: skipped,
        matchedBy: episode !== null ? 'episode-number' : 'media',
        resumeEpisode: episode,
        snapshotAge,
      });
      return {
        name: 'detail',
        params: { mediaId },
        query: episode !== null ? { ep: String(episode) } : {},
        restoreReason: 'crash_source_skipped',
        matchedBy: episode !== null ? 'episode-number' : 'media',
        exitKind,
        snapshotAge,
        resumeEpisode: episode,
        sourceSkipped: skipped,
      };
    }
    return {
      name: snapshot.name,
      params: snapshot.params,
      query: snapshot.query,
      restoreReason: exitKind === 'system_reclaim' ? 'system_reclaim_resume' : 'resume',
      matchedBy: byRoute,
      exitKind,
      snapshotAge,
      resumeEpisode: episodeNumberOf(snapshot, recorded?.episodeNumber ?? null),
      sourceSkipped: null,
    };
  }

  return {
    name: snapshot.name,
    params: snapshot.params,
    query: snapshot.query,
    restoreReason: exitKind === 'system_reclaim' ? 'system_reclaim_resume' : 'resume',
    matchedBy: byRoute,
    exitKind,
    snapshotAge,
    resumeEpisode: episodeNumberOf(snapshot, null),
    sourceSkipped: null,
  };
}

/**
 * 接线：必须在 `app.use(router)` 之前调用，首帧导航才会被接管。
 *
 * 恢复由一次性 `beforeEach` 完成（不是安装后再 `replace`）——那样首页会先挂载、
 * 播放页再盖上去，用户看得见一次闪跳。
 */
export async function bindSessionRestore(router: Router): Promise<void> {
  // 隐私开关可能是后打开的：先擦掉此前留下的快照，避免关了历史记录还能"接着放"
  const settings = await settingsService.get();
  let plan: RestorePlan | null = null;
  if (settings.pauseHistoryRecording) await clearSessionSnapshot();
  else {
    const snapshot = await takeSessionSnapshot();
    // 落点判定放在守卫之外：`beforeEach` 必须同步返回，冷启动首帧不能等一次桥接往返
    if (snapshot) plan = await planRestore(snapshot);
  }
  let first = true;

  router.beforeEach((to) => {
    if (!first) return true;
    first = false;
    const target = plan;
    plan = null;
    if (!target || to.name !== COLD_START_ROUTE) return true;
    logger.info('P0-5：冷启动会话恢复落点', {
      restoreReason: target.restoreReason,
      matchedBy: target.matchedBy,
      exitKind: target.exitKind,
      snapshotAge: target.snapshotAge,
      resumeEpisode: target.resumeEpisode,
      sourceSkipped: target.sourceSkipped,
      targetRoute: target.name,
    });
    return { name: target.name, params: target.params, query: target.query, replace: true };
  });

  router.afterEach((to) => {
    void record(to);
  });

  /*
   * P0-5：候选被用户"用上了"才算稳定。自动换线 / 换源那一次导航不写快照（见 `record`），
   * 但播放器在本轮真的推进了，说明这条线路是当前唯一有证据可用的——此刻补记一次，
   * 下次启动就从它继续，而不是回到那条已经失败的线路。
   */
  detachAdvanced?.();
  detachAdvanced = onFailoverAdvanced(() => {
    void record(router.currentRoute.value, true);
  });

  // 切后台补写一次：进程随时可能被清掉，此刻的 `at` 才是"用户最后停留时间"
  detachLifecycle?.();
  detachLifecycle = onAppStateChange((state) => {
    if (state === 'background') void record(router.currentRoute.value, true);
  });
}

/** 清除快照（隐私开关切换 / 测试） */
export async function clearSessionSnapshot(): Promise<void> {
  persisted = null;
  await kvRepo.delete(KV_KEY_LAST_SESSION);
}

/** 测试辅助：重置内部状态 */
export function __resetSessionRestore(): void {
  persisted = null;
  detachLifecycle?.();
  detachLifecycle = null;
  detachAdvanced?.();
  detachAdvanced = null;
}
