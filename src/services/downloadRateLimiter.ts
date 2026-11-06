/**
 * 全局限速令牌桶（EXT-04 / FR-63 / D-03）
 *
 * 设计要点（见技术方案 §6.2、§8.3-9）：
 * - **单一额度源**：JS 侧所有写盘流量都在 `DownloadSink.write()` 前 `consume(bytes)`，
 *   因此直链与 HLS 分片天然共用同一份额度，不需要改动 `hlsDownloader` 的下载主循环。
 * - **原生路径不重复扣减**：Android 走 OkHttp（`RangeDownloader` 内的原生令牌桶），
 *   这条链路不经过 JS sink，因此这里不会被调用。
 * - **`unlimited` 零开销**：`bytesPerSec === Infinity` 时不进桶、不 await，直接返回。
 * - **切档清桶**：新档位立即生效，最多在 3s 内收敛（AC-149）。
 * - **元数据不占额度**：m3u8 / 密钥 / 字幕 / 封面 / 预检探测一律不调用 `consume`。
 */
import { DOWNLOAD_RATE_WINDOW_MS, DOWNLOAD_SPEED_LIMITS } from '@/shared/constants';
import { AppError } from '@/shared/errors';
import type { DownloadSpeedLimit } from '@/types';

export interface RateStatsTask {
  taskId: string;
  bps: number;
}

export interface RateStats {
  windowMs: number;
  totalBps: number;
  tasks: RateStatsTask[];
}

export interface SpeedLimitApplied {
  limit: DownloadSpeedLimit;
  bytesPerSec: number;
  appliedAt: number;
}

const SPEED_LIMITS: readonly DownloadSpeedLimit[] = ['low', 'medium', 'high', 'unlimited'];

/** 桶容量下限：吸收单块 256KB 的粒度误差（§6.2 精度预算） */
const MIN_BUCKET_BYTES = 64 * 1024;
/** 单次睡眠上限：避免长时间挂起导致暂停/取消响应变慢 */
const MAX_WAIT_MS = 200;

export function isValidSpeedLimit(value: unknown): value is DownloadSpeedLimit {
  return typeof value === 'string' && SPEED_LIMITS.includes(value as DownloadSpeedLimit);
}

export function bytesPerSecOf(limit: DownloadSpeedLimit): number {
  return DOWNLOAD_SPEED_LIMITS[limit];
}

export interface RateLimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Sample {
  taskId: string;
  at: number;
  bytes: number;
}

export class DownloadRateLimiter {
  private limit: DownloadSpeedLimit = 'unlimited';
  private bytesPerSec = Infinity;
  private tokens = 0;
  private capacity = Infinity;
  private lastTick: number;
  private samples: Sample[] = [];

  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(deps: RateLimiterDeps = {}) {
    this.nowFn = deps.now ?? (() => Date.now());
    this.sleepFn = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.lastTick = this.nowFn();
  }

  getLimit(): DownloadSpeedLimit {
    return this.limit;
  }

  getBytesPerSec(): number {
    return this.bytesPerSec;
  }

  /** 切换档位：清空桶（避免旧额度残留），返回生效值（FR-63） */
  setLimit(limit: DownloadSpeedLimit): SpeedLimitApplied {
    if (!isValidSpeedLimit(limit)) throw new AppError('E_INVALID_INPUT', '不支持的限速档位');
    this.limit = limit;
    this.bytesPerSec = bytesPerSecOf(limit);
    this.capacity = Number.isFinite(this.bytesPerSec)
      ? Math.max(this.bytesPerSec * 1, MIN_BUCKET_BYTES)
      : Infinity;
    this.tokens = 0;
    this.lastTick = this.nowFn();
    return { limit, bytesPerSec: this.bytesPerSec, appliedAt: this.lastTick };
  }

  /**
   * 消费额度（写盘前调用）。
   *
   * 令牌可为负：单块字节数大于桶容量时按「欠账」方式按比例等待，
   * 既保证稳态速率，也不会因为块大于桶而永久阻塞。
   */
  async consume(bytes: number, taskId?: string): Promise<void> {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.record(taskId ?? 'unknown', bytes);
    if (!Number.isFinite(this.bytesPerSec)) return;

    this.refill();
    this.tokens -= bytes;
    while (this.tokens < 0) {
      const deficit = -this.tokens;
      const waitMs = Math.min(MAX_WAIT_MS, Math.max(1, Math.ceil((deficit / this.bytesPerSec) * 1000)));
      await this.sleepFn(waitMs);
      this.refill();
    }
  }

  /** 3s 滑窗速率（AC-148/AC-149 与 UI「当前合计速率」） */
  stats(windowMs: number = DOWNLOAD_RATE_WINDOW_MS): RateStats {
    const now = this.nowFn();
    this.prune(now, windowMs);
    const perTask = new Map<string, number>();
    let total = 0;
    for (const sample of this.samples) {
      total += sample.bytes;
      perTask.set(sample.taskId, (perTask.get(sample.taskId) ?? 0) + sample.bytes);
    }
    const windowSec = windowMs / 1000;
    const tasks: RateStatsTask[] = [...perTask.entries()]
      .map(([taskId, bytes]) => ({ taskId, bps: Math.round(bytes / windowSec) }))
      .sort((a, b) => b.bps - a.bps);
    return { windowMs, totalBps: Math.round(total / windowSec), tasks };
  }

  /** 测试辅助：清空桶与统计 */
  reset(): void {
    this.limit = 'unlimited';
    this.bytesPerSec = Infinity;
    this.capacity = Infinity;
    this.tokens = 0;
    this.lastTick = this.nowFn();
    this.samples = [];
  }

  private refill(): void {
    const now = this.nowFn();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    if (elapsed <= 0 || !Number.isFinite(this.bytesPerSec)) return;
    this.tokens = Math.min(this.capacity, this.tokens + (this.bytesPerSec * elapsed) / 1000);
  }

  private record(taskId: string, bytes: number): void {
    const now = this.nowFn();
    this.samples.push({ taskId, at: now, bytes });
    this.prune(now, DOWNLOAD_RATE_WINDOW_MS);
  }

  private prune(now: number, windowMs: number): void {
    const threshold = now - windowMs;
    if (this.samples.length === 0) return;
    let index = 0;
    while (index < this.samples.length && this.samples[index]!.at < threshold) index += 1;
    if (index > 0) this.samples = this.samples.slice(index);
  }
}

/** 全局单例：JS 侧唯一额度源，由 `downloadSink` 消费、由 `downloadService` 切档 */
export const downloadRateLimiter = new DownloadRateLimiter();
