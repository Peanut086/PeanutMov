/**
 * 源健康治理中心数据服务（EXT-01）
 *
 * 职责边界：
 * 1. 汇总 / 失败分布 / 7 日趋势的**纯计算口径**（无 IO、无 Pinia，便于单测）；
 * 2. 趋势快照的本地持久化（通用 `kv` 键值仓，不新增 object store / 索引，
 *    因此不改动 `db/schema.ts` 与迁移）；
 * 3. 读写失败一律降级为空数组 / 静默，不阻断健康中心页面渲染。
 *
 * 不直接读源表：源列表由 `sourceStore` 传入，保证与 UI 展示同一份数据。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { logger } from '@/shared/logger';
import type { Source, SourceHealth } from '@/types';

/** 趋势快照在 `kv` 中的键名（唯一写入点：本模块） */
export const HEALTH_TREND_KV_KEY = 'health-center-trend';
/** 趋势图展示天数（含今天） */
export const HEALTH_TREND_DAYS = 7;
/** 快照保留上限（每日最多 1 条，30 条足够覆盖月度回看且读取恒定开销） */
export const HEALTH_TREND_MAX_SNAPSHOTS = 30;

/** 汇总口径：四个计数互斥（healthy + failed + unknown === total） */
export interface HealthCenterSummary {
  total: number;
  healthy: number;
  failed: number;
  unknown: number;
  /** 其中已禁用（enabled=false）的源数量，仅作上下文信息 */
  disabled: number;
}

/** 失败原因分类（与 `SourceHealth` 的失败态一一对应） */
export type FailureReason = 'timeout' | 'unreachable' | 'bad_config' | 'auth_failed';

export interface FailureBucket {
  reason: FailureReason;
  label: string;
  hint: string;
  count: number;
  /** 占失败源总数的比例 0~1 */
  ratio: number;
  /** 展示用百分比（四舍五入取整） */
  percent: number;
}

/** 单日健康快照（落库形态，字段全部为数字，读取时逐项校验） */
export interface HealthTrendSnapshot {
  /** 本地日期键 `YYYY-MM-DD` */
  date: string;
  total: number;
  healthy: number;
  failed: number;
  unknown: number;
}

export interface HealthTrendPoint extends HealthTrendSnapshot {
  /** 横轴短标签 `MM-DD` */
  label: string;
  /** 当日是否有采集记录；false 表示该天未打开过健康中心 */
  recorded: boolean;
  /** 健康率百分比（四舍五入取整）；total=0 时为 0 */
  healthRate: number;
}

/** 失败原因固定顺序（并列时保持稳定排序） */
export const HEALTH_FAILURE_REASONS: readonly FailureReason[] = [
  'timeout',
  'unreachable',
  'bad_config',
  'auth_failed',
];

/** 失败原因文案与处置建议（与 `healthService.labelOf` 逐字一致） */
export const FAILURE_REASON_META: Record<FailureReason, { label: string; hint: string }> = {
  timeout: { label: '连接超时', hint: '可能瞬时拥塞，建议复检' },
  unreachable: { label: '无法连接', hint: '源站不可达，建议清理' },
  bad_config: { label: '配置有误', hint: '地址或协议有误，需修改配置' },
  auth_failed: { label: '认证失败', hint: '账号或 Token 失效，需更新凭据' },
};

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 健康状态是否为「失败」（已检测且确定异常） */
export function isFailureHealth(health: SourceHealth): health is FailureReason {
  return (
    health === 'timeout' ||
    health === 'unreachable' ||
    health === 'bad_config' ||
    health === 'auth_failed'
  );
}

/** 汇总：健康 / 失败 / 未检测 + 已禁用数量 */
export function summarizeSources(sources: readonly Source[]): HealthCenterSummary {
  let healthy = 0;
  let failed = 0;
  let unknown = 0;
  let disabled = 0;
  for (const source of sources) {
    if (source.health === 'ok') healthy += 1;
    else if (isFailureHealth(source.health)) failed += 1;
    else unknown += 1;
    if (!source.enabled) disabled += 1;
  }
  return { total: sources.length, healthy, failed, unknown, disabled };
}

/**
 * 失败原因分布：只返回计数 > 0 的原因，按数量降序（并列按固定顺序）。
 * 空数组表示当前没有失败源，UI 展示成功态空提示。
 */
export function failureDistributionOf(sources: readonly Source[]): FailureBucket[] {
  const counts: Record<FailureReason, number> = {
    timeout: 0,
    unreachable: 0,
    bad_config: 0,
    auth_failed: 0,
  };
  let failedTotal = 0;
  for (const source of sources) {
    if (!isFailureHealth(source.health)) continue;
    counts[source.health] += 1;
    failedTotal += 1;
  }

  return HEALTH_FAILURE_REASONS.filter((reason) => counts[reason] > 0)
    .map((reason) => {
      const count = counts[reason];
      const ratio = failedTotal === 0 ? 0 : count / failedTotal;
      return {
        reason,
        ...FAILURE_REASON_META[reason],
        count,
        ratio,
        percent: Math.round(ratio * 100),
      };
    })
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return HEALTH_FAILURE_REASONS.indexOf(a.reason) - HEALTH_FAILURE_REASONS.indexOf(b.reason);
    });
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 本地日期键（用本地时区，避免 UTC 偏移把夜间记录算到次日） */
export function dateKeyOf(value: number | Date): string {
  const date = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `YYYY-MM-DD` → `MM-DD`；非法输入原样返回（不让轴标签变空白） */
export function trendLabelOf(date: string): string {
  return DATE_KEY_RE.test(date) ? date.slice(5) : date;
}

/** 汇总 → 快照（趋势落库入口） */
export function snapshotOf(summary: HealthCenterSummary, date: string): HealthTrendSnapshot {
  return {
    date,
    total: summary.total,
    healthy: summary.healthy,
    failed: summary.failed,
    unknown: summary.unknown,
  };
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 读取校验：丢弃非法条目、同日期后写覆盖先写、按日期升序、截取最近 N 条 */
export function normalizeSnapshots(raw: unknown): HealthTrendSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const byDate = new Map<string, HealthTrendSnapshot>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Partial<HealthTrendSnapshot>;
    if (typeof record.date !== 'string' || !DATE_KEY_RE.test(record.date)) continue;
    byDate.set(record.date, {
      date: record.date,
      total: toCount(record.total),
      healthy: toCount(record.healthy),
      failed: toCount(record.failed),
      unknown: toCount(record.unknown),
    });
  }
  return [...byDate.values()]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .slice(-HEALTH_TREND_MAX_SNAPSHOTS);
}

/** 写入当日快照：同日期覆盖，返回归一化后的完整序列 */
export function upsertSnapshot(
  snapshots: readonly HealthTrendSnapshot[],
  next: HealthTrendSnapshot,
): HealthTrendSnapshot[] {
  return normalizeSnapshots([...snapshots.filter((item) => item.date !== next.date), next]);
}

/**
 * 生成最近 N 天（含今天）的连续趋势点。
 * 缺数据的天补 0 并标记 `recorded: false`，保证横轴天数恒定、柱位不漂移。
 */
export function buildTrendSeries(
  snapshots: readonly HealthTrendSnapshot[],
  now: number = Date.now(),
  days: number = HEALTH_TREND_DAYS,
): HealthTrendPoint[] {
  const safeDays =
    typeof days === 'number' && Number.isFinite(days)
      ? Math.min(Math.max(Math.floor(days), 1), HEALTH_TREND_MAX_SNAPSHOTS)
      : HEALTH_TREND_DAYS;
  const byDate = new Map(snapshots.map((item) => [item.date, item]));
  const base = new Date(now);
  if (Number.isNaN(base.getTime())) return [];

  const points: HealthTrendPoint[] = [];
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offset);
    const date = dateKeyOf(day);
    const found = byDate.get(date);
    const total = found?.total ?? 0;
    const healthy = found?.healthy ?? 0;
    points.push({
      date,
      label: trendLabelOf(date),
      total,
      healthy,
      failed: found?.failed ?? 0,
      unknown: found?.unknown ?? 0,
      recorded: found !== undefined,
      healthRate: total > 0 ? Math.round((healthy / total) * 100) : 0,
    });
  }
  return points;
}

/** 读取本地快照；异常返回空数组（健康中心首屏可用，只是没有历史） */
export async function loadHealthTrend(): Promise<HealthTrendSnapshot[]> {
  try {
    return normalizeSnapshots(await kvRepo.get<unknown>(HEALTH_TREND_KV_KEY));
  } catch (e) {
    logger.warn('健康趋势快照读取失败', e);
    return [];
  }
}

/** 写入本地快照；失败静默（不阻断治理操作） */
export async function saveHealthTrend(snapshots: readonly HealthTrendSnapshot[]): Promise<void> {
  try {
    await kvRepo.set(HEALTH_TREND_KV_KEY, normalizeSnapshots(snapshots));
  } catch (e) {
    logger.warn('健康趋势快照写入失败', e);
  }
}

/** 记录当日快照并返回最新序列（每次进入健康中心 / 批量操作后调用） */
export async function recordHealthTrend(
  summary: HealthCenterSummary,
  now: number = Date.now(),
): Promise<HealthTrendSnapshot[]> {
  const current = await loadHealthTrend();
  const date = dateKeyOf(now);
  if (date === '') return current;
  const next = upsertSnapshot(current, snapshotOf(summary, date));
  await saveHealthTrend(next);
  return next;
}

/** 清除全部趋势快照（数据清理入口，当前无 UI 调用，供数据重置链路复用） */
export async function clearHealthTrend(): Promise<void> {
  try {
    await kvRepo.delete(HEALTH_TREND_KV_KEY);
  } catch (e) {
    logger.warn('健康趋势快照清除失败', e);
  }
}
