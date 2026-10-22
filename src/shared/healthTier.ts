/**
 * 线路质量分级与排序（技术方案 17.2 / 17.4，CHG-05）
 *
 * 约束（`shared/` 层）：
 * - 纯函数 + 常量，无 IO、无 DOM、无 Pinia 依赖；
 * - 唯一分级实现，UI 不得重复实现阈值判断；
 * - `healthTierOf` 任何输入都返回档位，不抛错。
 *
 * 唯一例外是排序偏好的读写：按契约存 `localStorage`（Web / Android WebView 同源可用），
 * 读写异常一律降级为 `'manual'`，写入失败静默吞掉。
 */
import type { Source, SourceHealth } from '@/types';

/** 线路质量档位（6 档，与 SourceHealth 正交：tier 是"给人看的质量"，health 是"给逻辑用的状态"） */
export type HealthTier = 'fast' | 'good' | 'fair' | 'slow' | 'bad' | 'unknown';

/** 阈值常量（毫秒）。单测与 UI 直接引用本对象，禁止写魔法数 */
export const HEALTH_TIER_THRESHOLDS = {
  /** ≤ 300ms → fast */
  fastMaxMs: 300,
  /** 301 ~ 800ms → good */
  goodMaxMs: 800,
  /** 801 ~ 2000ms → fair */
  fairMaxMs: 2000,
} as const;

/** 档位中文文案（HealthBadge / 排序菜单 / 无障碍标签共用） */
export const HEALTH_TIER_LABELS: Record<HealthTier, string> = {
  fast: '极速',
  good: '快速',
  fair: '一般',
  slow: '较慢',
  bad: '异常',
  unknown: '未检测',
};

/** 档位优先级（升序 = 越好越前）。排序与比较只认这个表 */
export const HEALTH_TIER_ORDER: Record<HealthTier, number> = {
  fast: 0,
  good: 1,
  fair: 2,
  slow: 3,
  bad: 4,
  unknown: 5,
};

/** 延迟是否可用于分级（有限非负数） */
function isUsableLatency(latencyMs: number | null): latencyMs is number {
  return typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0;
}

/**
 * 唯一分级入口。判定顺序必须按序短路：
 * unknown → 非 ok → 延迟不可用 → ≤fast → ≤good → ≤fair → slow
 */
export function healthTierOf(health: SourceHealth, latencyMs: number | null): HealthTier {
  if (health === 'unknown') return 'unknown';
  if (health !== 'ok') return 'bad';
  if (!isUsableLatency(latencyMs)) return 'bad';
  if (latencyMs <= HEALTH_TIER_THRESHOLDS.fastMaxMs) return 'fast';
  if (latencyMs <= HEALTH_TIER_THRESHOLDS.goodMaxMs) return 'good';
  if (latencyMs <= HEALTH_TIER_THRESHOLDS.fairMaxMs) return 'fair';
  return 'slow';
}

/* ---------- 排序模式（17.4.1） ---------- */

export type SourceSortMode = 'manual' | 'tier';

/** localStorage key（PM 指定点号；与 useTheme 的冒号风格不一致属已知项） */
export const SOURCE_SORT_MODE_STORAGE_KEY = 'peanutmov.sourceSortMode';

/** 读取排序偏好：缺省 / 非法 / 读写异常 → 'manual' */
export function readSourceSortMode(): SourceSortMode {
  try {
    const value = globalThis.localStorage?.getItem(SOURCE_SORT_MODE_STORAGE_KEY);
    return value === 'tier' || value === 'manual' ? value : 'manual';
  } catch {
    return 'manual';
  }
}

/** 写入排序偏好：失败静默吞掉（隐私模式 / 配额），内存态仍生效 */
export function writeSourceSortMode(mode: SourceSortMode): void {
  try {
    globalThis.localStorage?.setItem(SOURCE_SORT_MODE_STORAGE_KEY, mode);
  } catch {
    /* 静默：偏好仅本机记忆，写不进去不影响本次会话 */
  }
}

/* ---------- 排序（17.4.1） ---------- */

/** `manual`：与 `SourceListView` 既有 `ordered` 逐字等价（演示源恒最后） */
function compareManual(a: Source, b: Source): number {
  if (a.builtin !== b.builtin) return a.builtin ? 1 : -1;
  return a.sort - b.sort;
}

/** 无延迟（null / 非有限 / 负数）视为最大，排在有值项之后 */
function latencyRank(latencyMs: number | null): number {
  return isUsableLatency(latencyMs) ? latencyMs : Number.POSITIVE_INFINITY;
}

/**
 * 按模式排序（不修改入参，返回新数组）。
 *
 * - `manual`：builtin 升序 → sort 升序；
 * - `tier`：档位 → latency（null 最后）→ sort → name（zh-Hans-CN）→ id。
 */
export function sortSources(
  sources: readonly Source[],
  mode: SourceSortMode,
  latencyOf: (sourceId: string) => number | null,
): Source[] {
  const list = [...sources];
  if (mode === 'manual') return list.sort(compareManual);

  const rawCache = new Map<string, number | null>();
  const rawLatencyOf = (sourceId: string): number | null => {
    if (rawCache.has(sourceId)) return rawCache.get(sourceId) ?? null;
    const value = latencyOf(sourceId);
    rawCache.set(sourceId, value);
    return value;
  };

  return list.sort((a, b) => {
    const rawA = rawLatencyOf(a.id);
    const rawB = rawLatencyOf(b.id);
    const tierA = healthTierOf(a.health, rawA);
    const tierB = healthTierOf(b.health, rawB);
    if (tierA !== tierB) return HEALTH_TIER_ORDER[tierA] - HEALTH_TIER_ORDER[tierB];

    const latencyA = latencyRank(rawA);
    const latencyB = latencyRank(rawB);
    if (latencyA !== latencyB) return latencyA - latencyB;

    if (a.sort !== b.sort) return a.sort - b.sort;

    const byName = a.name.localeCompare(b.name, 'zh-Hans-CN');
    if (byName !== 0) return byName;

    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}
