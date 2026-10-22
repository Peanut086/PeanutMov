/**
 * 健康检查服务（AC-15 / AC-16）
 *
 * 与 `sourceService.checkHealth` 的区别：本模块提供"按需触发 + 结果缓存"的门面，
 * 供源管理页与启动流程复用（不做后台轮询）。
 */
import { sourceService } from '@/services/sourceService';
import { DIM_MAX_PERCENT } from '@/shared/constants';
import { healthTierOf, type HealthTier } from '@/shared/healthTier';
import type { HealthCheckResult, SourceHealth } from '@/types';

export interface HealthSnapshot {
  checkedAt: number;
  results: Record<string, HealthCheckResult>;
  /** 本次检查中失败（非 ok）的源数量 */
  failedCount: number;
}

let cachedSnapshot: HealthSnapshot | null = null;
let running: Promise<HealthSnapshot> | null = null;

export const healthService = {
  /** 检查全部启用源（并发上限 6，单源 3s 超时） */
  async checkAll(): Promise<HealthSnapshot> {
    if (running) return running;
    running = (async () => {
      const results = await sourceService.checkHealth();
      const snapshot: HealthSnapshot = {
        checkedAt: Date.now(),
        results,
        failedCount: Object.values(results).filter((result) => result.health !== 'ok').length,
      };
      cachedSnapshot = snapshot;
      return snapshot;
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  },

  /** 检查指定源 */
  async check(ids: string[]): Promise<HealthSnapshot> {
    const results = await sourceService.checkHealth(ids);
    const snapshot: HealthSnapshot = {
      checkedAt: Date.now(),
      results,
      failedCount: Object.values(results).filter((result) => result.health !== 'ok').length,
    };
    cachedSnapshot = snapshot;
    return snapshot;
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
