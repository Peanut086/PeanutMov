/**
 * 进度上报（FR-21 / 技术方案 9.4）
 *
 * 规则：
 * - 播放中每 5s 采样一次，满足"距上次写库 ≥ 4s"才真正写（`PROGRESS_MIN_WRITE_GAP_MS`）
 * - pause / seeking 结束 / 结束 / 页面离开 → `flush()` 立即写
 * - `duration <= 0` 或非有限值 → 不写
 * - 进度 ≥ 95% 视为完结：写 `positionSec = 0` 且 `finished = true`（AC-51）
 *
 * 本类不直接调用 Service：写库动作通过 `save` 回调注入，便于单测与集成替换。
 */
import {
  PROGRESS_FINISHED_THRESHOLD,
  PROGRESS_MIN_WRITE_GAP_MS,
  PROGRESS_START_THRESHOLD,
  PROGRESS_WRITE_INTERVAL_MS,
} from '@/shared/constants';

export interface ProgressSnapshot {
  positionSec: number;
  durationSec: number;
  /** 0~1 */
  progress: number;
  finished: boolean;
}

export interface ProgressReporterOptions {
  /** 落库回调（由 View 注入 historyStore.save） */
  save: (snapshot: ProgressSnapshot) => void | Promise<void>;
  /** 采样间隔，默认 5000ms */
  intervalMs?: number;
  /** 最小写库间隔，默认 4000ms */
  minWriteGapMs?: number;
  /** 完结阈值，默认 0.95 */
  finishedThreshold?: number;
  /** 当前时间源（便于测试注入） */
  now?: () => number;
}

export class ProgressReporter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWriteAt = 0;
  private lastSnapshot: ProgressSnapshot | null = null;
  private positionSec = 0;
  private durationSec = 0;
  private readonly intervalMs: number;
  private readonly minWriteGapMs: number;
  private readonly finishedThreshold: number;
  private readonly now: () => number;
  private writing: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly options: ProgressReporterOptions) {
    this.intervalMs = options.intervalMs ?? PROGRESS_WRITE_INTERVAL_MS;
    this.minWriteGapMs = options.minWriteGapMs ?? PROGRESS_MIN_WRITE_GAP_MS;
    this.finishedThreshold = options.finishedThreshold ?? PROGRESS_FINISHED_THRESHOLD;
    this.now = options.now ?? (() => Date.now());
  }

  /** 开始周期采样（幂等） */
  start(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 更新播放位置；每次 timeupdate 调用，开销仅为赋值 */
  update(currentTime: number, duration: number): void {
    if (!Number.isFinite(currentTime) || currentTime < 0) return;
    this.positionSec = currentTime;
    if (Number.isFinite(duration) && duration > 0) this.durationSec = duration;
  }

  /** 周期采样：达到最小间隔才写 */
  async tick(): Promise<void> {
    if (this.disposed) return;
    if (!this.canWrite()) return;
    if (this.now() - this.lastWriteAt < this.minWriteGapMs) return;
    await this.write();
  }

  /**
   * 立即写回（pause/退出/切后台/结束）。
   *
   * 与 `tick()` 的区别：flush 是"事件驱动"的（暂停/退出），必须反映退出瞬间的位置，
   * 因此**不受 4s 间隔限制**；但会跳过"与上次完全相同的快照"，避免与 5s 采样双写。
   */
  async flush(): Promise<void> {
    if (this.disposed) return;
    if (!this.canWrite()) return;
    await this.write(false, true);
  }

  /** 播放结束时调用：完结则写 finished（position = 0），否则按当前进度写 */
  async finish(): Promise<void> {
    if (!Number.isFinite(this.durationSec) || this.durationSec <= 0) return;
    // 结束时把位置推进到末尾，确保 progress >= 阈值
    this.positionSec = this.durationSec;
    await this.write(true);
  }
  /** 当前快照（不写库） */
  snapshot(): ProgressSnapshot {
    const duration = this.durationSec;
    const progress = duration > 0 ? clamp01(this.positionSec / duration) : 0;
    const finished = progress >= this.finishedThreshold;
    return {
      positionSec: finished ? 0 : Math.max(0, this.positionSec),
      durationSec: duration,
      progress,
      finished,
    };
  }

  /** 起播位置：5%~95% 之间才续播，否则从 0（技术方案 9.4） */
  static resumePosition(recordedSec: number, durationSec: number): number {
    if (!Number.isFinite(recordedSec) || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
    const ratio = recordedSec / durationSec;
    if (ratio <= PROGRESS_START_THRESHOLD || ratio >= PROGRESS_FINISHED_THRESHOLD) return 0;
    return Math.max(0, Math.min(recordedSec, durationSec));
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
  }

  private canWrite(): boolean {
    return Number.isFinite(this.durationSec) && this.durationSec > 0 && this.positionSec >= 0;
  }

  private async write(force = false, allowGapBypass = false): Promise<void> {
    if (!this.canWrite()) return;
    // 已有写入进行中：等待其结束后再判定，避免并发写库
    if (this.writing) {
      await this.writing;
      if (!force && !allowGapBypass && this.now() - this.lastWriteAt < this.minWriteGapMs) return;
    }

    const snapshot = this.snapshot();
    if (!force && this.isSameAsLast(snapshot)) return;

    this.lastSnapshot = snapshot;
    this.lastWriteAt = this.now();
    const task = Promise.resolve()
      .then(() => this.options.save(snapshot))
      .catch(() => {
        /* 写库失败不阻断播放；下次采样会重试 */
      })
      .finally(() => {
        this.writing = null;
      });
    this.writing = task;
    await task;
  }

  /** 与上次写入的快照是否等价（位置差 < 0.5s 且完结标记一致） */
  private isSameAsLast(next: ProgressSnapshot): boolean {
    const last = this.lastSnapshot;
    if (!last) return false;
    return last.finished === next.finished && Math.abs(last.positionSec - next.positionSec) < 0.5;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
