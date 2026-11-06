/**
 * 搜索预算（OPT-04，纯函数 + 常量）
 *
 * 真机实测（2026-10-28）：聚合检索「全量收敛」稳定贴住单源 20s 预算
 * （站点源 8s / 爬虫源 20s / 其它 5s），热门关键词必须等满最慢那个源。
 *
 * 本模块把「单源等待上限」从散落在适配器里的硬编码，收敛成一个**可配置档位**：
 * - `standard` 倍率 1 → 与既有硬编码逐字等价（默认值，行为不变）；
 * - `fast` / `patient` 只缩放适配器自报的 `searchTimeoutMs`，超时语义不变
 *   （仍是 AbortController 中止 + 该源计入失败列表，可「只重试失败源」）。
 *
 * 约束：无 IO、无 DOM、无 Pinia 依赖；档位值的持久化由 settings 负责
 * （`AppSettings.searchBudget`）。
 */
import { TIMEOUT_SEARCH_MS } from '@/shared/constants';

/** 搜索预算档位 */
export type SearchBudgetPreset = 'fast' | 'standard' | 'patient';

/** 档位全集（设置页渲染顺序 = 由紧到松） */
export const SEARCH_BUDGET_PRESETS: readonly SearchBudgetPreset[] = ['fast', 'standard', 'patient'];

/** 默认档位：保持既有行为 */
export const SEARCH_BUDGET_DEFAULT: SearchBudgetPreset = 'standard';

/** 档位倍率：快速 0.6 / 标准 1 / 耐心 1.5 */
export const SEARCH_BUDGET_SCALE: Record<SearchBudgetPreset, number> = {
  fast: 0.6,
  standard: 1,
  patient: 1.5,
};

/** 档位文案（设置页 / 无障碍标签共用） */
export const SEARCH_BUDGET_LABELS: Record<SearchBudgetPreset, string> = {
  fast: '快速',
  standard: '标准',
  patient: '耐心',
};

/** 单源预算下限：再低会误杀站点源（模板请求本身就要几秒） */
export const SEARCH_BUDGET_MIN_MS = 3000;
/** 单源预算上限：再高等于让长尾源拖住整轮聚合 */
export const SEARCH_BUDGET_MAX_MS = 30000;

/** 任意输入 → 是否合法档位（设置反序列化/测试夹具共用） */
export function isSearchBudgetPreset(value: unknown): value is SearchBudgetPreset {
  return typeof value === 'string' && (SEARCH_BUDGET_PRESETS as readonly string[]).includes(value);
}

/**
 * 单源搜索超时预算 = 适配器自报超时 × 档位倍率，再钳制到 [3s, 30s]。
 *
 * 非法入参（非有限数、≤0、未知档位）一律回落，任何输入都返回可用毫秒数，不抛错。
 */
export function resolveSearchTimeoutMs(baseMs: number, preset?: SearchBudgetPreset): number {
  const base = typeof baseMs === 'number' && Number.isFinite(baseMs) && baseMs > 0 ? baseMs : TIMEOUT_SEARCH_MS;
  const scale = preset && isSearchBudgetPreset(preset) ? SEARCH_BUDGET_SCALE[preset] : 1;
  const scaled = Math.round(base * scale);
  return Math.min(SEARCH_BUDGET_MAX_MS, Math.max(SEARCH_BUDGET_MIN_MS, scaled));
}
