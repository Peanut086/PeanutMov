/**
 * 换线 / 换源会话（P0-2）
 *
 * 为什么要单独一个模块：`App.vue` 用 `current.fullPath` 给路由组件打 key，播放页不在
 * KeepAlive 名单里，于是每一次自动换线的 `router.replace` 都会**重建** PlayerView。
 * 预算过去记在实例的 ref 上（`failoverStartedAt` / `failoverLineTried` /
 * `failoverSourceTried`），重建即归零——真机表现就是"这一集反复在第 1、2 集之间跳，
 * 线路也一直在自动切，直到全部线路都失效"：每一轮都以为自己是第一次，35 秒窗口和
 * 3 条线的上限从来没有真正生效过。
 *
 * 这里把预算搬到一个跨路由存活的单例上，并固定五件事：
 * 1. **目标集**：一轮只服务用户点开的那一季/集（`anchor`），中途不得改；
 * 2. **截止**：整轮一个墙钟 deadline，候选搜索与解析共用剩余时间，到点只有一个终态；
 * 3. **额度**：`PLAYER_FAILOVER_MAX_LINES` 条其它线路 + `PLAYER_FAILOVER_MAX_SOURCES` 次换源，
 *    按 `sourceId|lineId|episodeId` 去重（线路候选还会跳过已试/隔离中的源）；
 * 4. **单入口**：`beginLoadAttempt` 是唯一的开轮/续轮入口。只要目标季/集相同且上一轮
 *    还没收口，就沿用上一轮预算（不重置 deadline、不重记额度）；换集 / 换片 / 上一轮
 *    已收口 / 用户明确动作（`userIntent`）才算新意图、开新一轮。换线引起的路由变化
 *    本身就是同一个目标，因此**拿不到新预算**——这正是修复点。
 * 5. **归属令牌**：`armNavigation` 声明"接下来这次卸载/挂载是我自己引起的路由变化"，
 *    播放页卸载据此决定要不要收回预算（用户真的离开才收回），带 5 秒有效期，
 *    过期或随本轮结束一起作废。令牌还带 `auto` 标记，区分"自动兜底链引起的候选导航"与
 *    "用户自己的动作"——会话快照据此决定要不要更新恢复目标（P0-5）。
 *
 * 关键取舍：**预算只能被"播放器真的推进了"重置**（`markAdvanced`），不能被"又一次进入
 * 起播流程"重置。后者正是过去那个死循环的来源；前者是本轮成功的唯一口径。推进之后
 * 会清掉线路/换源额度（同一个墙钟 deadline 不变），所以播放中途真的掉线时仍然会自动换线，
 * 但整轮不会因此续命。
 *
 * 纯状态机，不碰 router / 引擎，便于单测；副作用（日志、toast、面板）由调用方按快照决定。
 */
import {
  PLAYER_FAILOVER_MAX_LINES,
  PLAYER_FAILOVER_MAX_SOURCES,
  PLAYER_FAILOVER_WINDOW_MS,
} from '@/shared/constants';
import { logger } from '@/shared/logger';

/** 一轮唯一的终态原因；只会被写入一次 */
export type FailoverTerminalReason = 'deadline' | 'budget' | 'superseded' | 'cancelled';

export interface FailoverAnchor {
  seasonNumber: number | null;
  episodeNumber: number | null;
}

export interface BeginLoadOptions {
  /** 用户目标季/集 */
  anchor: FailoverAnchor;
  /** 触发来源，只进日志 */
  trigger: string;
  /** 本次加载的 `sourceId|lineId|episodeId`，见 `failoverAttemptKey` */
  key?: string | null;
  /** true = 用户明确动作（重试 / 手动换线 / 换集 / 换片）→ 旧一轮作废、预算重新开始 */
  userIntent?: boolean;
  /** 窗口长度，单测注入短时钟用 */
  budgetMs?: number;
}

export interface FailoverSnapshot {
  sessionId: number;
  attemptId: number;
  targetSeason: number | null;
  targetEpisode: number | null;
  trigger: string;
  lineId: string | null;
  linesTried: number;
  sourcesTried: number;
  triedCount: number;
  remainingMs: number;
  advanced: boolean;
  terminalReason: FailoverTerminalReason | null;
}

/** 换线尝试的唯一键：同一条线路上的同一集不重复消耗额度 */
export function failoverAttemptKey(
  sourceId: string | number | null | undefined,
  lineId: string | number | null | undefined,
  episodeId: string | number | null | undefined,
): string {
  return `${sourceId ?? '-'}|${lineId ?? '-'}|${episodeId ?? '-'}`;
}

function anchorsMatch(a: FailoverAnchor, b: FailoverAnchor): boolean {
  return a.seasonNumber === b.seasonNumber && a.episodeNumber === b.episodeNumber;
}

export class FailoverRound {
  /** 换线路由变化令牌的有效期：够一次真实的重建+详情补齐，又不至于让陈旧令牌长期白送预算 */
  private static readonly NAVIGATION_TOKEN_MS = 5000;

  readonly id: number;
  anchor: FailoverAnchor;
  trigger: string;
  startedAt: number;
  deadlineAt: number;
  attemptId = 0;
  /** 本轮正在使用的线路 id（仅用于日志归组） */
  lineId: string | null = null;

  private readonly tried = new Set<string>();
  /** 同一 attemptId 上解析错误与引擎错误只算一次失败 */
  private readonly failures = new Set<string>();
  private linesTried = 0;
  private sourcesTried = 0;
  /**
   * 换线引起的路由变化令牌：接下来这次「卸载 + 重建」属于本轮自己干的。
   *
   * 播放页卸载时据此决定要不要收回预算——用户真的离开才收回，本轮换线引起的重建不收回。
   * 只保留**一个**令牌（一次只可能有一次在飞的路由变化），并带 5 秒有效期：重建在几百毫秒
   * 内发生，令牌会被 `beginLoadAttempt` 取走；万一没被取走（路由被别的东西接管），过期作废，
   * 不能让一次陈旧的路由变化在几分钟后还替新起播保留"免收预算"的豁免。
   */
  private pendingNavigation = false;
  /**
   * P0-5：这次令牌是不是「自动兜底链」引起的。
   *
   * 令牌本身只回答"重建归谁"，但会话恢复还需要知道另一件事：路由里那条线路 / 那个集 id
   * 是自动候选（用户没确认过，且很可能正是刚把进程打死的那一次），还是用户自己点的。
   * 手动切线 / 手动换源 / 选集都是 `false`，自动换线与自动换源是 `true`。
   */
  private pendingNavigationAuto = false;
  private navigationTimer: ReturnType<typeof setTimeout> | null = null;
  private advanced = false;
  private terminal: FailoverTerminalReason | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: number, options: BeginLoadOptions, budgetMs: number) {
    this.id = id;
    this.anchor = options.anchor;
    this.trigger = options.trigger;
    this.startedAt = Date.now();
    this.deadlineAt = this.startedAt + budgetMs;
    this.attemptId = 1;
    this.triedKey(options.key ?? null);
    // 到点即收尾：即使一次错误事件都没等到（挂在解析里不动），也只会有一个终态
    this.armDeadline();
  }

  private armDeadline(): void {
    if (this.deadlineTimer !== null) clearTimeout(this.deadlineTimer);
    this.deadlineTimer = setTimeout(() => this.finish('deadline'), Math.max(0, this.deadlineAt - Date.now()));
  }

  /** 会话状态日志；模块级入口（`beginLoadAttempt`）也调用，故不设 private */
  log(event: string, extra?: Record<string, unknown>): void {
    logger.debug(`换线会话：${event}`, { ...this.snapshot(), ...extra });
  }

  private triedKey(key: string | null): void {
    if (key) this.tried.add(key);
  }

  snapshot(): FailoverSnapshot {
    return {
      sessionId: this.id,
      attemptId: this.attemptId,
      targetSeason: this.anchor.seasonNumber,
      targetEpisode: this.anchor.episodeNumber,
      trigger: this.trigger,
      lineId: this.lineId,
      linesTried: this.linesTried,
      sourcesTried: this.sourcesTried,
      triedCount: this.tried.size,
      remainingMs: this.remainingMs(),
      advanced: this.advanced,
      terminalReason: this.terminal,
    };
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  isTerminal(): boolean {
    return this.terminal !== null;
  }

  hasAdvanced(): boolean {
    return this.advanced;
  }

  /** 预算是否还开着（没到点、没有终态） */
  acceptsAttempts(): boolean {
    return this.terminal === null && this.remainingMs() > 0;
  }

  /** 还剩几条其它线路可试；传入 `lineId` 时同时要求这条线路本轮没试过 */
  allowLine(lineId?: string): boolean {
    if (!this.acceptsAttempts()) return false;
    if (lineId !== undefined && this.hasTriedLine(lineId)) return false;
    return this.linesTried < PLAYER_FAILOVER_MAX_LINES;
  }

  /** 还剩几次换源机会 */
  allowSource(): boolean {
    return this.acceptsAttempts() && this.sourcesTried < PLAYER_FAILOVER_MAX_SOURCES;
  }

  hasTried(key: string): boolean {
    return this.tried.has(key);
  }

  /**
   * 本轮是否已经试过这条线路。
   *
   * 已试集合按 `sourceId|lineId|episodeId` 记（换源后同一线路名会带不同集 id），
   * 线路候选的重复判定比对的是其中的 lineId 段。
   */
  hasTriedLine(lineId: string): boolean {
    for (const key of this.tried) {
      if (key.split('|')[1] === lineId) return true;
    }
    return false;
  }

  /**
   * 声明"接下来这次卸载/重建属于本轮"，让播放页卸载时不要收回预算。
   *
   * 沿用上一轮预算本身靠"目标季/集相同"判定，不依赖这里；令牌只回答"该不该在卸载时
   * 取消本轮"这一个问题。只保留一个、5 秒过期（见字段注释）。
   */
  armNavigation(auto = false): void {
    this.pendingNavigation = true;
    this.pendingNavigationAuto = auto;
    if (this.navigationTimer !== null) clearTimeout(this.navigationTimer);
    this.navigationTimer = setTimeout(() => {
      this.pendingNavigation = false;
      this.pendingNavigationAuto = false;
      this.navigationTimer = null;
    }, FailoverRound.NAVIGATION_TOKEN_MS);
  }

  /** 取走令牌：返回 true = 这次挂载属于本轮延续 */
  takeNavigation(): boolean {
    const owned = this.pendingNavigation;
    this.clearNavigation();
    return owned;
  }

  /** 令牌是否还在飞 */
  hasPendingNavigation(): boolean {
    return this.pendingNavigation;
  }

  /** P0-5：还在飞的这次路由变化是否由自动兜底链引起（候选，未经用户确认） */
  isPendingNavigationAuto(): boolean {
    return this.pendingNavigation && this.pendingNavigationAuto;
  }

  private clearNavigation(): void {
    this.pendingNavigation = false;
    this.pendingNavigationAuto = false;
    if (this.navigationTimer !== null) {
      clearTimeout(this.navigationTimer);
      this.navigationTimer = null;
    }
  }

  /**
   * 记一次进入起播流程的尝试。
   *
   * 延续（本轮换线引起的路由变化，或同目标且尚未推进）只递增 attemptId、登记 key，
   * **不动** deadline 与额度；其余情况由调用方另开新一轮。
   */
  noteContinuation(key: string | null): number {
    this.attemptId += 1;
    this.triedKey(key);
    return this.attemptId;
  }

  /**
   * 记账一次失败：同一次尝试（`attemptId`）无论来自解析还是引擎、无论上报几个错误码，
   * 只推进一条兜底链，返回 false 表示调用方不该因此再推进状态机。
   *
   * 本轮已收口时同样返回 false：迟到的引擎事件不再有权驱动换线。
   */
  noteFailure(attemptId: number): boolean {
    if (this.terminal !== null) return false;
    const key = String(attemptId);
    if (this.failures.has(key)) return false;
    this.failures.add(key);
    return true;
  }

  /** 换线动作消费一次线路额度，并把 `sourceId|lineId|episodeId` 记进已试集合 */
  chargeLineAttempt(key: string): void {
    this.linesTried += 1;
    this.tried.add(key);
  }

  /** 换源动作消费一次换源额度 */
  chargeSourceAttempt(): void {
    this.sourcesTried += 1;
  }

  /**
   * 播放器真的推进了 —— 本轮唯一表示成功的信号。
   *
   * 只清空额度（线路/换源计数、已试集合、失败去重），**不动 deadline**：
   * 与升级前"起播成功后各再试一次"的手感保持一致，播放中途真的掉线时仍然会自动换线，
   * 但整轮被同一个墙钟封顶——到点只剩一个终态，不会再无限续预算。
   */
  markAdvanced(): void {
    if (this.terminal !== null) return;
    const first = !this.advanced;
    this.advanced = true;
    this.linesTried = 0;
    this.sourcesTried = 0;
    this.tried.clear();
    this.failures.clear();
    if (first) {
      this.log('本轮播放器已推进，额度释放（deadline 不变）', { remainingMs: this.remainingMs() });
      // P0-5：推进 = 这条线路成了"最后稳定线路"，会话快照据此把它记下来
      const snapshot = this.snapshot();
      for (const listener of [...advancedListeners]) listener(this, snapshot);
    }
  }

  /** 结束本轮（到点 / 额度用尽 / 被新意图取代 / 取消）；只生效一次，只通知一次 */
  finish(reason: FailoverTerminalReason): boolean {
    if (this.terminal !== null) return false;
    this.terminal = reason;
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    this.clearNavigation();
    const snapshot = this.snapshot();
    logger.info('换线会话结束', { ...snapshot, usedMs: Date.now() - this.startedAt });
    for (const listener of [...terminalListeners]) listener(this, snapshot);
    return true;
  }
}

let seq = 0;
let current: FailoverRound | null = null;
const terminalListeners = new Set<(round: FailoverRound, snapshot: FailoverSnapshot) => void>();
const advancedListeners = new Set<(round: FailoverRound, snapshot: FailoverSnapshot) => void>();

/**
 * 起播 / 换线的唯一入口：拿到本轮该用的会话。
 *
 * - 用户明确动作（`userIntent`）：结束上一轮，开新一轮（预算重新开始）；
 * - 目标季/集相同且上一轮还开着：沿用上一轮，**不重置 deadline、不重记额度**——
 *   换线引起的路由重建就落在这里，这是"路由变化不再新开预算"的落点；
 * - 其余（换集 / 换片 / 上一轮已推进后重进同一集 / 已终态）：开新一轮。
 */
export function beginLoadAttempt(options: BeginLoadOptions): FailoverRound {
  const budgetMs = options.budgetMs ?? PLAYER_FAILOVER_WINDOW_MS;
  const previous = current;
  if (previous) {
    const reused =
      !options.userIntent &&
      !previous.isTerminal() &&
      anchorsMatch(previous.anchor, options.anchor);
    if (reused) {
      previous.takeNavigation(); // 令牌只服务"这次重建属于本轮"，取走即作废
      previous.trigger = options.trigger;
      previous.noteContinuation(options.key ?? null);
      previous.log('换线会话沿用上一轮预算', {
        reused: true,
        trigger: options.trigger,
        key: options.key ?? null,
      });
      return previous;
    }
    previous.finish('superseded');
  }
  seq += 1;
  const round = new FailoverRound(seq, options, budgetMs);
  current = round;
  round.log('换线会话开启', {
    trigger: options.trigger,
    budgetMs,
    key: options.key ?? null,
    userIntent: options.userIntent === true,
  });
  return round;
}

/**
 * 记账一次失败：同一次尝试（`attemptId`）上解析错误与引擎错误——或同一轮里重复上报——
 * 只推进一条兜底链，返回 false 表示调用方不该因此再推进状态机。
 *
 * 没有开启中的轮（本轮已收口/从未开启）时同样返回 false：迟到的引擎事件不能再驱动换线。
 */
export function noteFailoverFailure(attemptId: number): boolean {
  return current ? current.noteFailure(attemptId) : false;
}

/** 当前轮（可能已终态，用于读终态） */
export function currentFailoverRound(): FailoverRound | null {
  return current;
}

/** 仍开着预算的轮；已终态返回 null */
export function activeFailoverRound(): FailoverRound | null {
  return current && !current.isTerminal() ? current : null;
}

/**
 * 声明"接下来这次路由变化属于本轮"——换线 / 换源前调用。
 *
 * `auto: true` = 自动兜底链引起的候选导航（P0-5：会话快照据此不把它当成用户确认的目标）。
 */
export function armFailoverNavigation(auto = false): void {
  current?.armNavigation(auto);
}

/** 令牌是否还在飞：播放页卸载时用它区分"自己引起的重建"与"用户真的离开了" */
export function hasPendingFailoverNavigation(): boolean {
  return current?.hasPendingNavigation() === true;
}

/** 这一次在飞的路由变化是否由自动兜底链引起（未经用户确认的候选） */
export function hasPendingAutoFailoverNavigation(): boolean {
  return current?.isPendingNavigationAuto() === true;
}

/** 订阅「本轮播放器已推进」（一轮只回调一次）；返回取消订阅 */
export function onFailoverAdvanced(
  listener: (round: FailoverRound, snapshot: FailoverSnapshot) => void,
): () => void {
  advancedListeners.add(listener);
  return () => advancedListeners.delete(listener);
}

/** 订阅终态（一轮只回调一次）；返回取消订阅 */
export function onFailoverTerminal(
  listener: (round: FailoverRound, snapshot: FailoverSnapshot) => void,
): () => void {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}

/**
 * 会话取消（例如引擎被外部停止）：结束当前轮，禁止它在后台继续推进状态机。
 *
 * 注意播放页卸载**不**调用这里——预算必须跨路由重建存活，否则又回到老问题。
 */
export function cancelFailoverRound(reason: FailoverTerminalReason = 'cancelled'): void {
  current?.finish(reason);
}

/** 忙态原地等的上限（毫秒）：超过它，这一集已经被拖到「看起来像播放坏了」 */
export const BUSY_WAIT_MAX_MS = 8_000;

/**
 * P1-③-7：「该源正忙」时这一轮该怎么办。
 *
 * 忙态不是线路坏了：同一个源的其它线路共用那个还压着上一个请求的爬虫实例，换线只是白撞一次闸门。
 * 于是冷却在 `BUSY_WAIT_MAX_MS` 以内就原地等闸门放行（错误面板的倒计时到点会自动重试一次），
 * 超过它就不干等，跳过换线直接换源；非忙态按常规兜底。
 *
 * `retryAfterMs` 只有一个来源：`SpiderAdapter.busyStateOf` 换算的真实占用剩余，不许界面自己猜。
 */
export function busyFailoverPlan(
  code: string,
  retryAfterMs: number | null | undefined,
): "not-busy" | "wait" | "switch-source" {
  if (code !== "E_SOURCE_BUSY") return "not-busy";
  const remain = Math.max(0, retryAfterMs ?? 0);
  return remain <= BUSY_WAIT_MAX_MS ? "wait" : "switch-source";
}

/** 测试辅助：清掉模块级状态 */
export function __resetFailoverSession(): void {
  current?.finish('cancelled');
  current = null;
  seq = 0;
  terminalListeners.clear();
  advancedListeners.clear();
}
