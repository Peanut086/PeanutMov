/**
 * 下载状态机与调度队列（API-09 状态机单一实现）
 *
 * 合法迁移（技术方案 6 章）：
 * ```
 * queued      --start-->   downloading
 * downloading --pause-->   paused
 * paused      --resume-->  queued
 * downloading --done-->    completed
 * downloading --fail-->    failed        (retries >= maxRetries)
 * downloading --cancel-->  canceled
 * paused      --cancel-->  canceled
 * failed      --retry-->   queued
 * queued      --cancel-->  canceled
 * completed/canceled --remove--> (删除记录)
 * ```
 * 其余组合 → `E_INVALID_STATE`（message 含 `from→to`）。
 *
 * 队列只管"状态 + 并发"，实际下载由 `downloadEngine` 注入的 runner 完成，
 * 便于单测用假 runner 验证并发上限、FIFO 与重试退避。
 */
import { AppError } from '@/shared/errors';
import { DOWNLOAD_DEFAULT_CONCURRENCY, DOWNLOAD_MAX_RETRIES, DOWNLOAD_RETRY_BACKOFF_MS } from '@/shared/constants';
import type { DownloadPausedBy, DownloadStatus, DownloadTask } from '@/types';

export type DownloadAction = 'start' | 'pause' | 'resume' | 'done' | 'fail' | 'cancel' | 'retry' | 'remove';

/** 迁移表：action → 允许的源状态 */
const TRANSITIONS: Record<Exclude<DownloadAction, 'remove'>, DownloadStatus[]> = {
  start: ['queued'],
  pause: ['downloading'],
  resume: ['paused'],
  done: ['downloading'],
  fail: ['downloading'],
  cancel: ['downloading', 'paused', 'queued'],
  retry: ['failed'],
};

/** 动作 → 目标状态（remove 无目标状态） */
const TARGETS: Record<Exclude<DownloadAction, 'remove'>, DownloadStatus> = {
  start: 'downloading',
  pause: 'paused',
  resume: 'queued',
  done: 'completed',
  fail: 'failed',
  cancel: 'canceled',
  retry: 'queued',
};

/** 终态：仅允许 remove */
const TERMINAL: ReadonlySet<DownloadStatus> = new Set(['completed', 'canceled']);

export function canTransition(from: DownloadStatus, action: DownloadAction): boolean {
  if (action === 'remove') return true;
  return TRANSITIONS[action].includes(from);
}

/**
 * 计算迁移后的任务（不写库）。非法迁移抛 `E_INVALID_STATE`。
 * `now` 可注入，便于测试断言 completedAt。
 */
export function transition(
  task: DownloadTask,
  action: DownloadAction,
  now: number = Date.now(),
): DownloadTask {
  if (action === 'remove') return task;
  if (!canTransition(task.status, action)) {
    throw new AppError('E_INVALID_STATE', `任务状态不允许该操作：${task.status}→${TARGETS[action]}`, {
      detail: `${task.status} --${action}--> ${TARGETS[action]}`,
    });
  }
  const next: DownloadTask = {
    ...task,
    status: TARGETS[action],
    updatedAt: now,
  };
  switch (action) {
    case 'start':
      next.speedBps = 0;
      next.errorCode = null;
      next.errorMessage = null;
      break;
    case 'pause':
      next.speedBps = 0;
      break;
    case 'resume':
      next.speedBps = 0;
      delete next.pausedBy;
      break;
    case 'done':
      next.speedBps = 0;
      next.completedAt = now;
      next.downloadedBytes = next.totalBytes ?? next.downloadedBytes;
      if (next.totalBytes === null) next.totalBytes = next.downloadedBytes;
      next.errorCode = null;
      next.errorMessage = null;
      break;
    case 'fail':
      next.speedBps = 0;
      break;
    case 'cancel':
      next.speedBps = 0;
      break;
    case 'retry':
      next.speedBps = 0;
      next.retries = 0;
      next.errorCode = null;
      next.errorMessage = null;
      next.completedAt = null;
      break;
  }
  return next;
}

/** 是否终态 */
export function isTerminal(status: DownloadStatus): boolean {
  return TERMINAL.has(status);
}

/** 自动重试判定：下载中失败且 retries < maxRetries → 退避后重试 */
export interface FailureDecision {
  /** 直接置为 failed 还是重试 */
  action: 'fail' | 'retry';
  /** 重试前的等待毫秒数（仅 action=retry 有意义） */
  delayMs: number;
  /** 重试后的任务（retries+1） */
  task: DownloadTask;
}

export function decideAfterFailure(
  task: DownloadTask,
  error: { code: DownloadTask['errorCode']; message: string | null; retryable?: boolean },
  now: number = Date.now(),
): FailureDecision {
  const maxRetries = task.maxRetries >= 0 ? task.maxRetries : DOWNLOAD_MAX_RETRIES;
  const withError: DownloadTask = {
    ...task,
    errorCode: error.code,
    errorMessage: error.message,
    speedBps: 0,
    updatedAt: now,
  };
  // P0-1：错误模型判定不可重试（E_INVALID_INPUT / E_HTTP_403 / E_UNSUPPORTED_FORMAT…）
  // 时直接落终态。坏地址退避重试只是把失败推迟 4 秒，还会让列表反复闪「等待中」。
  if (error.retryable === false) {
    return { action: 'fail', delayMs: 0, task: withError };
  }
  if (task.retries >= maxRetries) {
    return { action: 'fail', delayMs: 0, task: withError };
  }
  const nextRetries = task.retries + 1;
  const delayMs =
    DOWNLOAD_RETRY_BACKOFF_MS[Math.min(nextRetries - 1, DOWNLOAD_RETRY_BACKOFF_MS.length - 1)] ?? 1000;
  return {
    action: 'retry',
    delayMs,
    task: { ...withError, retries: nextRetries },
  };
}

/* =========================================================
 * 队列调度
 * =======================================================*/

export interface DownloadRunnerContext {
  /** 任务被调度执行 */
  signal: AbortSignal;
}

/** runner 负责真正下载；成功 resolve，失败抛错 */
export type DownloadRunner = (task: DownloadTask, ctx: DownloadRunnerContext) => Promise<void>;

export interface DownloadQueueOptions {
  /** 读任务（由 downloadService 注入，通常来自 DB） */
  load: (id: string) => Promise<DownloadTask | null>;
  /** 写任务（状态变化时调用） */
  save: (task: DownloadTask) => Promise<void>;
  /** 状态变化回调（发事件用） */
  onStatus?: (task: DownloadTask, previous: DownloadStatus) => void;
  concurrency?: 1 | 2 | 3;
  /** 重试等待实现（测试可替换为立即返回） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('E_ABORTED'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AppError('E_ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

interface ActiveEntry {
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * 下载队列：并发调度 + FIFO + 自动重试。
 *
 * 关键约束：
 * - 任一时刻 `downloading` 数量 ≤ concurrency（AC-71）；
 * - FIFO 按 priority 升序、createdAt 升序；同优先级先入队先执行；
 * - 暂停/取消会 abort 正在进行的下载，runner 需响应 signal。
 */
export class DownloadQueue {
  private concurrency: 1 | 2 | 3;
  private readonly active = new Map<string, ActiveEntry>();
  /** 待执行队列：按 priority 升序、createdAt 升序（FIFO） */
  private readonly pending: Array<{ id: string; priority: number; createdAt: number }> = [];
  private readonly pausedSet = new Set<string>();
  /** 失败的退避重试：等当前执行槽释放后再入队，避免被 active 去重逻辑吞掉 */
  private readonly retryAfterActive = new Set<string>();
  private disposed = false;
  /** 合并同一轮同步 enqueue 的调度，保证按 priority 排序后再启动 */
  private pumpScheduled = false;
  // P1-3: 每个任务的互斥锁，防止并发操作导致状态回写竞态
  private readonly taskLocks = new Map<string, Promise<void>>();

  constructor(private readonly opts: DownloadQueueOptions) {
    this.concurrency = opts.concurrency ?? DOWNLOAD_DEFAULT_CONCURRENCY;
  }

  /** P1-3: 获取任务互斥锁，确保同一任务的操作串行执行 */
  private async withTaskLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.taskLocks.get(id) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    this.taskLocks.set(id, next);
    await prev;
    try {
      return await fn();
    } finally {
      release!();
      // 清理已完成的锁
      if (this.taskLocks.get(id) === next) {
        this.taskLocks.delete(id);
      }
    }
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * FIX-D3：检查指定任务是否正在活跃执行中。
   *
   * 除在跑的外，还认"已入队待跑"和"退避重试等槽位"：这两种情况下任务同样由队列负责，
   * 若只认 active，watchdog 会把刚被恢复、还在 pending 里的任务当孤儿判成「下载停滞」。
   */
  isActive(id: string): boolean {
    return this.active.has(id) || this.pending.some((entry) => entry.id === id) || this.retryAfterActive.has(id);
  }

  /** FIX-D3：强制中断指定任务的执行（watchdog 检测到卡死时调用） */
  abortTask(id: string, reason: string): void {
    const entry = this.active.get(id);
    if (entry) {
      entry.controller.abort(new AppError('E_NETWORK', `watchdog: ${reason}`));
    }
  }

  get pendingIds(): string[] {
    return this.pending.map((entry) => entry.id);
  }

  getConcurrency(): 1 | 2 | 3 {
    return this.concurrency;
  }

  setConcurrency(n: 1 | 2 | 3): void {
    this.concurrency = n;
    this.pump();
  }

  /** 加入待执行队列（去重；按 priority/createdAt 排序保证 FIFO，AC-71） */
  enqueue(task: DownloadTask): void {
    if (this.active.has(task.id)) return;
    if (this.pending.some((entry) => entry.id === task.id)) return;
    this.pending.push({ id: task.id, priority: task.priority, createdAt: task.createdAt });
    this.pending.sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.createdAt - b.createdAt,
    );
    this.schedulePump();
  }

  /** 延迟到微任务再调度：批量入队时先排序，避免"先 enqueue 的先跑"破坏 FIFO/优先级 */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  /** 从队列移除（删除任务时调用） */
  dequeue(id: string): void {
    const index = this.pending.findIndex((entry) => entry.id === id);
    if (index >= 0) this.pending.splice(index, 1);
  }

  /** 注册 runner 并启动调度 */
  run(runner: DownloadRunner): void {
    this.runner = runner;
    this.pump();
  }

  private runner: DownloadRunner | null = null;

  /**
   * 调度：填满并发槽位（并发上限 AC-71）。
   * 槽位在同步阶段占位，避免 async 初始化期间被重复计入。
   */
  pump(): void {
    if (this.disposed || !this.runner) return;
    const runner = this.runner;
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const entry = this.pending.shift();
      if (!entry) break;
      if (this.active.has(entry.id)) continue;
      const controller = new AbortController();
      const placeholder = { controller, promise: Promise.resolve() };
      this.active.set(entry.id, placeholder);
      placeholder.promise = this.startOne(entry.id, runner, controller);
    }
  }

  private async startOne(id: string, runner: DownloadRunner, controller: AbortController): Promise<void> {
    try {
      const task = await this.opts.load(id);
      if (!task || task.status !== 'queued') {
        // 已被其它入口改变状态（暂停/取消），跳过
        return;
      }

      const now = this.opts.now ?? Date.now;
      const started = transition(task, 'start', now());
      await this.opts.save(started);
      this.opts.onStatus?.(started, task.status);

      try {
        await runner(started, { signal: controller.signal });
        await this.complete(started.id);
      } catch (e) {
        await this.handleFailure(started.id, e);
      }
    } finally {
      this.active.delete(id);
      if (this.retryAfterActive.delete(id)) {
        const current = await this.opts.load(id);
        if (current && current.status === 'queued') this.enqueue(current);
      }
      this.pump();
    }
  }

  private async complete(id: string): Promise<void> {
    const task = await this.opts.load(id);
    if (!task) return;
    if (task.status !== 'downloading') return; // 已被取消/暂停
    const now = this.opts.now ?? Date.now;
    const next = transition(task, 'done', now());
    await this.opts.save(next);
    this.opts.onStatus?.(next, task.status);
  }

  private async handleFailure(id: string, cause: unknown): Promise<void> {
    const task = await this.opts.load(id);
    if (!task) return;
    if (task.status !== 'downloading') return; // 用户已暂停/取消

    const now = this.opts.now ?? Date.now;
    const error = cause instanceof AppError ? cause : new AppError('E_UNKNOWN', undefined, { detail: String(cause) });
    if (error.code === 'E_ABORTED' || error.code === 'E_CANCELED') {
      /**
       * 中止了 runner 却没先改状态的路径（`stopAll()`、`dispose()`、迟到的一次 abort）
       * 会把任务永久留在 `downloading`：没有 runner、没有进度，最终被 watchdog 判成
       * 「下载停滞」。这里收口成后台暂停，交给回前台的自动恢复续传，而不是留个死状态。
       */
      const stopped = transition(task, 'pause', now());
      stopped.pausedBy = 'background';
      await this.opts.save(stopped);
      this.opts.onStatus?.(stopped, task.status);
      return;
    }

    const decision = decideAfterFailure(
      task,
      { code: error.code, message: error.message, retryable: error.retryable },
      now(),
    );
    if (decision.action === 'fail') {
      const next = transition(decision.task, 'fail', now());
      await this.opts.save(next);
      this.opts.onStatus?.(next, task.status);
      return;
    }

    // 自动重试：先置为 paused 表示等待，再回 queued（保留进度）
    const waiting: DownloadTask = { ...decision.task, status: 'paused', updatedAt: now() };
    await this.opts.save(waiting);
    this.opts.onStatus?.(waiting, task.status);

    const sleep = this.opts.sleep ?? defaultSleep;
    try {
      await sleep(decision.delayMs);
    } catch {
      // 等待被中断：按取消处理
      return;
    }
    if (this.disposed) return;
    const current = await this.opts.load(id);
    if (!current) return;
    if (current.status !== 'paused') {
      // 用户在退避期间手动继续/取消 → 以用户操作为准
      if (current.status === 'queued') this.enqueue(current);
      return;
    }

    const resumed = transition({ ...current }, 'resume', now());
    await this.opts.save(resumed);
    this.opts.onStatus?.(resumed, current.status);
    // 当前执行槽尚未释放（本函数在 runner 的 promise 内）→ 交给 finally 重新入队
    if (this.active.has(id)) {
      this.retryAfterActive.add(id);
    } else {
      this.enqueue(resumed);
    }
  }

  /** 暂停：abort 正在进行的下载（下载中）或标记等待（queued 不合法） */
  async pause(id: string, reason: DownloadPausedBy = 'user'): Promise<DownloadTask> {
    return this.withTaskLock(id, async () => {
      const task = await this.opts.load(id);
      if (!task) throw new AppError('E_NOT_FOUND');
      const now = this.opts.now ?? Date.now;
      const next = transition(task, 'pause', now());
      next.pausedBy = reason;
      this.pausedSet.add(id);
      const entry = this.active.get(id);
      // P0-1: 传递 pause reason，让 downloadEngine 区分暂停与取消
      entry?.controller.abort({ reason: 'pause' });
      await this.opts.save(next);
      this.opts.onStatus?.(next, task.status);
      return next;
    });
  }

  async resume(id: string): Promise<DownloadTask> {
    return this.withTaskLock(id, async () => {
      const task = await this.opts.load(id);
      if (!task) throw new AppError('E_NOT_FOUND');
      const now = this.opts.now ?? Date.now;
      const next = transition(task, 'resume', now());
      this.pausedSet.delete(id);
      await this.opts.save(next);
      this.opts.onStatus?.(next, task.status);
      this.enqueue(next);
      return next;
    });
  }

  async retry(id: string): Promise<DownloadTask> {
    return this.withTaskLock(id, async () => {
      const task = await this.opts.load(id);
      if (!task) throw new AppError('E_NOT_FOUND');
      const now = this.opts.now ?? Date.now;
      const next = transition(task, 'retry', now());
      await this.opts.save(next);
      this.opts.onStatus?.(next, task.status);
      this.enqueue(next);
      return next;
    });
  }

  async cancel(id: string): Promise<DownloadTask> {
    return this.withTaskLock(id, async () => {
      const task = await this.opts.load(id);
      if (!task) throw new AppError('E_NOT_FOUND');
      const now = this.opts.now ?? Date.now;
      const next = transition(task, 'cancel', now());
      this.dequeue(id);
      const entry = this.active.get(id);
      // P0-1: 传递 cancel reason，让 downloadEngine 区分暂停与取消
      entry?.controller.abort({ reason: 'cancel' });
      await this.opts.save(next);
      this.opts.onStatus?.(next, task.status);
      return next;
    });
  }

  /** 全部暂停（切后台，AC-72） */
  async pauseAll(reason: DownloadPausedBy = 'user'): Promise<DownloadTask[]> {
    const ids = [...this.active.keys(), ...this.pending.map((entry) => entry.id)];
    const out: DownloadTask[] = [];
    for (const id of ids) {
      try {
        const task = await this.opts.load(id);
        if (task && task.status === 'downloading') out.push(await this.pause(id, reason));
      } catch {
        // 单条失败不影响其它任务
      }
    }
    this.pending.length = 0;
    return out;
  }

  /** 全部恢复 */
  async resumeAll(): Promise<DownloadTask[]> {
    const out: DownloadTask[] = [];
    for (const id of [...this.pausedSet]) {
      try {
        out.push(await this.resume(id));
      } catch {
        // 忽略单条失败
      }
    }
    return out;
  }

  /** 等待所有活跃与待执行任务结束（测试用） */
  async drain(): Promise<void> {
    for (let guard = 0; guard < 10_000; guard += 1) {
      if (this.active.size === 0 && this.pending.length === 0) {
        // 再等一轮微任务，确保 finally 中的 pump 已执行
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.active.size === 0 && this.pending.length === 0) return;
      }
      const entries = [...this.active.values()];
      if (entries.length > 0) {
        await Promise.allSettled(entries.map((entry) => entry.promise));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.active.values()) entry.controller.abort();
    this.active.clear();
    this.pending.length = 0;
    this.pausedSet.clear();
    this.taskLocks.clear();
  }
}
