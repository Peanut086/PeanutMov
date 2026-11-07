/**
 * 健康检查服务（AC-15 / AC-16）
 *
 * 与 `sourceService.checkHealth` 的区别：本模块提供"按需触发 + 结果缓存"的门面，
 * 供源管理页与启动流程复用（不做后台轮询）。
 */
import { sourceService } from '@/services/sourceService';
import { DIM_MAX_PERCENT } from '@/shared/constants';
import { AppError } from '@/shared/errors';
import { healthTierOf, type HealthTier } from '@/shared/healthTier';
import type { HealthCheckResult, SourceHealth } from '@/types';

export interface HealthSnapshot {
  checkedAt: number;
  results: Record<string, HealthCheckResult>;
  /** 本次检查中失败（非 ok）的源数量 */
  failedCount: number;
}

/** `checkAll` 的可选参数（OPT-03）：显式检测时绕过 10 分钟缓存，并支持取消 */
export interface CheckAllOptions {
  /** true：忽略缓存，强制重新探测（用户主动点「健康检查」） */
  force?: boolean;
  /** 取消信号：中止后 sourceService 停止调度剩余源并抛 `E_ABORTED` */
  signal?: AbortSignal;
}

let cachedSnapshot: HealthSnapshot | null = null;
let running: Promise<HealthSnapshot> | null = null;

// P1-4: 健康检查缓存 TTL（10 分钟）
const HEALTH_CACHE_TTL_MS = 10 * 60 * 1000;
const unreachableCooldowns = new Map<string, number>();

/** 执行一次探测并写缓存；取消时 sourceService 抛 E_ABORTED，不会写入半截快照 */
async function executeCheck(ids: string[] | undefined, signal?: AbortSignal): Promise<HealthSnapshot> {
  const results =
    ids === undefined
      ? await sourceService.checkHealth(undefined, signal)
      : await sourceService.checkHealth(ids, signal);
  // P1-4: 记录 unreachable 源冷却
  for (const [sourceId, result] of Object.entries(results)) {
    if (result.health === 'unreachable') {
      unreachableCooldowns.set(sourceId, Date.now());
    }
  }
  // REV-41 修复：子集检测（ids !== undefined）时合并而非替换 cachedSnapshot，
  // 避免未检测的源丢失 latency 数据导致 healthTier 误判为 bad。
  if (ids !== undefined && cachedSnapshot) {
    const merged = { ...cachedSnapshot.results, ...results };
    cachedSnapshot = {
      checkedAt: Date.now(),
      results: merged,
      failedCount: Object.values(merged).filter((r) => r.health !== 'ok').length,
    };
    return cachedSnapshot;
  }
  const snapshot: HealthSnapshot = {
    checkedAt: Date.now(),
    results,
    failedCount: Object.values(results).filter((result) => result.health !== 'ok').length,
  };
  cachedSnapshot = snapshot;
  return snapshot;
}

export const healthService = {
  /**
   * 检查全部启用源（并发上限 6）。
   *
   * 默认命中 10 分钟缓存；`force: true` 强制重测（用户主动触发）。
   * 传 `signal` 时支持取消：取消后立即抛 `E_ABORTED`，不写缓存。
   */
  async checkAll(options: CheckAllOptions = {}): Promise<HealthSnapshot> {
    const { force = false, signal } = options;
    if (signal?.aborted) throw new AppError('E_ABORTED');
    // 有取消信号时不走缓存、不并入共享 running，避免一次取消影响其它调用方
    if (signal) return executeCheck(undefined, signal);
    if (!force && cachedSnapshot && Date.now() - cachedSnapshot.checkedAt < HEALTH_CACHE_TTL_MS) {
      return cachedSnapshot;
    }
    if (running) return running;
    running = executeCheck(undefined);
    try {
      return await running;
    } finally {
      running = null;
    }
  },

  /** 检查指定源（OPT-03：支持取消；用于「仅检测失败源」） */
  async check(ids: string[], signal?: AbortSignal): Promise<HealthSnapshot> {
    return executeCheck(ids, signal);
  },

  /** 最近一次结果（无则 null） */
  lastSnapshot(): HealthSnapshot | null {
    return cachedSnapshot;
  },

  /** 单个源的健康状态（无记录视为 unknown） */
  healthOf(sourceId: string): SourceHealth {
    return cachedSnapshot?.results[sourceId]?.health ?? 'unknown';
  },

  /** 最近一次探测耗时（毫秒）；无记录 / 不可用 → null（CHG-05 / API-14 代理源） */
  latencyOf(sourceId: string): number | null {
    const latency = cachedSnapshot?.results[sourceId]?.latencyMs;
    return typeof latency === 'number' && Number.isFinite(latency) ? latency : null;
  },

  /** 单源质量档位（CHG-05）：分级口径只认 `healthTierOf` */
  tierOf(sourceId: string): HealthTier {
    return healthTierOf(this.healthOf(sourceId), this.latencyOf(sourceId));
  },

  /** 健康状态 → 中文文案（源管理列表用） */
  labelOf(health: SourceHealth): string {    switch (health) {
      case 'ok':
        return '正常';
      case 'auth_failed':
        return '认证失败';
      case 'timeout':
        return '连接超时';
      case 'unreachable':
        return '无法连接';
      case 'bad_config':
        return '配置有误';
      case 'empty':
        return '空壳';
      default:
        return '未检测';
    }
  },

  /** 测试辅助 */
  __reset(): void {
    cachedSnapshot = null;
    running = null;
  },
};

/** 亮度遮罩上限（UI 读取，避免重复魔法数） */
export const DIM_LIMIT_PERCENT = DIM_MAX_PERCENT;

export type HealthService = typeof healthService;
