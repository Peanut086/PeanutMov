/**
 * 弹幕卡顿诊断临时性能埋点（根因确认后整体移除，勿长期保留）
 *
 * 覆盖三类嫌疑：
 * 1. 时间锚点：tick 到达间隔、预测时间与实际时间的漂移、外推封顶（冻结）次数；
 * 2. 渲染帧：绘制帧间隔（>50ms 记掉帧）、单帧绘制耗时、单帧位图栅格化条数与耗时；
 * 3. 加载期：排序/解析/缓存读写等一次性长任务耗时。
 *
 * 数据出口：
 * - logger scope `danmaku-perf`（真机可 logcat 过滤 `danmaku-perf`）；
 * - `globalThis.__danmakuPerf.snapshot() / .reset()`（MuMu CDP 控制台实时读取）。
 */
import { logger } from '@/shared/logger';

const perfLog = logger.scope('danmaku-perf');
const SUMMARY_INTERVAL_MS = 5000;
const MAX_INTERVAL_SAMPLES = 400;
const SLOW_FRAME_MS = 50;

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[idx] ?? 0;
}

class DanmakuPerfProbe {
  enabled = true;

  private timer: ReturnType<typeof setInterval> | null = null;
  private subscribers = 0;
  private windowStartedAt = 0;

  // 渲染帧窗口
  private frames = 0;
  private intervals: number[] = [];
  private slowFrames = 0;
  private costSum = 0;
  private costMax = 0;
  private rasterBuilds = 0;
  private rasterMs = 0;
  private frameRasterMsMax = 0;
  private onScreenMax = 0;

  // 时间锚点窗口
  private anchorTicks = 0;
  private tickGapMaxMs = 0;
  private driftAbsSumMs = 0;
  private driftAbsMaxMs = 0;
  private seekResets = 0;
  private clampFrames = 0;
  private clampOverhangMaxMs = 0;

  acquire(): void {
    if (!this.enabled) return;
    this.subscribers += 1;
    if (this.timer === null) {
      this.windowStartedAt = performance.now();
      this.timer = setInterval(() => this.summarize(), SUMMARY_INTERVAL_MS);
    }
  }

  release(): void {
    if (this.subscribers > 0) this.subscribers -= 1;
    if (this.subscribers === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
      this.summarize();
    }
  }

  recordFrame(args: {
    intervalMs: number;
    costMs: number;
    rasterBuilds: number;
    rasterMs: number;
    onScreen: number;
  }): void {
    if (!this.enabled) return;
    this.frames += 1;
    if (args.intervalMs > 0) {
      if (this.intervals.length < MAX_INTERVAL_SAMPLES) this.intervals.push(args.intervalMs);
      if (args.intervalMs > SLOW_FRAME_MS) this.slowFrames += 1;
    }
    this.costSum += args.costMs;
    this.costMax = Math.max(this.costMax, args.costMs);
    this.rasterBuilds += args.rasterBuilds;
    this.rasterMs += args.rasterMs;
    this.frameRasterMsMax = Math.max(this.frameRasterMsMax, args.rasterMs);
    this.onScreenMax = Math.max(this.onScreenMax, args.onScreen);
  }

  recordAnchorTick(gapMs: number, driftSec: number, seekReset: boolean): void {
    if (!this.enabled) return;
    this.anchorTicks += 1;
    this.tickGapMaxMs = Math.max(this.tickGapMaxMs, gapMs);
    const absMs = Math.abs(driftSec) * 1000;
    this.driftAbsSumMs += absMs;
    this.driftAbsMaxMs = Math.max(this.driftAbsMaxMs, absMs);
    if (seekReset) this.seekResets += 1;
  }

  recordExtrapolationClamp(overhangSec: number): void {
    if (!this.enabled) return;
    this.clampFrames += 1;
    this.clampOverhangMaxMs = Math.max(this.clampOverhangMaxMs, overhangSec * 1000);
  }

  /** 一次性长任务（排序/解析/缓存读写）：即时上报，不等 5s 汇总 */
  recordLoadPhase(phase: string, ms: number, n: number): void {
    if (!this.enabled) return;
    perfLog.info('loadPhase', { phase, ms: Math.round(ms * 10) / 10, n });
  }

  snapshot(): Record<string, unknown> {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    return {
      windowSec: this.timer === null ? 0 : Math.round((performance.now() - this.windowStartedAt) / 100) / 10,
      frames: this.frames,
      intervalP50Ms: Math.round(percentile(sorted, 0.5) * 10) / 10,
      intervalP95Ms: Math.round(percentile(sorted, 0.95) * 10) / 10,
      intervalMaxMs: Math.round((sorted[sorted.length - 1] ?? 0) * 10) / 10,
      slowFrames: this.slowFrames,
      frameCostAvgMs: this.frames === 0 ? 0 : Math.round((this.costSum / this.frames) * 10) / 10,
      frameCostMaxMs: Math.round(this.costMax * 10) / 10,
      rasterBuilds: this.rasterBuilds,
      rasterMsTotal: Math.round(this.rasterMs * 10) / 10,
      rasterMsWorstFrame: Math.round(this.frameRasterMsMax * 10) / 10,
      onScreenMax: this.onScreenMax,
      anchorTicks: this.anchorTicks,
      tickGapMaxMs: Math.round(this.tickGapMaxMs),
      driftAvgMs: this.anchorTicks === 0 ? 0 : Math.round((this.driftAbsSumMs / this.anchorTicks) * 10) / 10,
      driftMaxMs: Math.round(this.driftAbsMaxMs * 10) / 10,
      seekResets: this.seekResets,
      clampFrames: this.clampFrames,
      clampOverhangMaxMs: Math.round(this.clampOverhangMaxMs),
    };
  }

  reset(): void {
    this.startNewWindow();
  }

  private startNewWindow(): void {
    this.windowStartedAt = performance.now();
    this.frames = 0;
    this.intervals = [];
    this.slowFrames = 0;
    this.costSum = 0;
    this.costMax = 0;
    this.rasterBuilds = 0;
    this.rasterMs = 0;
    this.frameRasterMsMax = 0;
    this.onScreenMax = 0;
    this.anchorTicks = 0;
    this.tickGapMaxMs = 0;
    this.driftAbsSumMs = 0;
    this.driftAbsMaxMs = 0;
    this.seekResets = 0;
    this.clampFrames = 0;
    this.clampOverhangMaxMs = 0;
  }

  private summarize(): void {
    if (this.frames === 0 && this.anchorTicks === 0) return;
    perfLog.info('summary', this.snapshot());
    this.startNewWindow();
  }
}

export const danmakuPerf = new DanmakuPerfProbe();

(globalThis as unknown as { __danmakuPerf: DanmakuPerfProbe }).__danmakuPerf = danmakuPerf;
