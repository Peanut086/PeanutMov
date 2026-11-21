/**
 * 时间与进度格式化（SCF 冻结，PKG-B 只读）
 *
 * 全部为纯函数，不读取系统时区以外的状态（除 `formatRelativeTime` 的 `now` 参数兜底）。
 * 目标场景：播放器进度条、历史相对时间、"剩余 23 分钟"。
 */

/** 把秒规整为非负整数秒；非法值返回 0 */
export function safeSeconds(sec: number | null | undefined): number {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return 0;
  return Math.floor(sec);
}

/**
 * 播放器时钟格式。
 * - < 1 小时：`m:ss`（如 `12:30`、`0:05`）
 * - >= 1 小时：`h:mm:ss`（如 `1:02:03`）
 * 超过 99 小时按实际位数输出，不做截断。
 */
export function formatClock(sec: number | null | undefined): string {
  const total = safeSeconds(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

/**
 * 播放器界面时钟：分位补零（`00:05`），秒数跳动时宽度不抖。
 * 列表/历史等文案仍用 `formatClock` 的 `m:ss`，两者不互相替代。
 */
export function formatPlayerClock(sec: number | null | undefined): string {
  const total = safeSeconds(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad2 = (n: number): string => String(n).padStart(2, "0");
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${pad2(m)}:${pad2(s)}`;
}

/**
 * 时长的人类可读格式（列表、详情页"时长"字段）。
 * - < 60s：`45 秒`
 * - < 1min 的整分：`12 分钟`
 * - >= 1h：`1 小时 5 分钟` / 整点为 `2 小时`
 */
export function formatDuration(sec: number | null | undefined): string {
  const total = safeSeconds(sec);
  if (total < 60) return `${total} 秒`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h <= 0) return `${m} 分钟`;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/** 进度百分比文案，入参 0~1，出参如 `45%`；越界自动裁剪 */
export function formatProgress(progress: number | null | undefined): string {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return "0%";
  const clamped = Math.min(1, Math.max(0, progress));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * 剩余时长文案（首页继续观看卡片"剩余 23 分钟"）。
 * 按播放倍速折算：`剩余秒数 / rate`，再向上取整到分钟；不足 1 分钟显示"不足 1 分钟"。
 */
export function formatRemaining(
  positionSec: number | null | undefined,
  durationSec: number | null | undefined,
  rate = 1,
): string {
  const duration = safeSeconds(durationSec);
  const position = Math.min(safeSeconds(positionSec), duration);
  const safeRate =
    typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : 1;
  const remainSec = (duration - position) / safeRate;
  if (remainSec <= 0) return "已播完";
  if (remainSec < 60) return "不足 1 分钟";
  return `剩余 ${Math.ceil(remainSec / 60)} 分钟`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 历史记录相对时间。
 * - 未来或 < 60s：`刚刚`
 * - < 1h：`N 分钟前`
 * - 同一自然日：`N 小时前`
 * - 昨天：`昨天`
 * - 2~6 天前：`N 天前`
 * - 同年更早：`M月D日`
 * - 跨年：`YYYY年M月D日`
 */
export function formatRelativeTime(
  ts: number | null | undefined,
  now: number = Date.now(),
): string {
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  const diff = now - ts;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;

  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (dayDiff <= 0) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 7) return `${dayDiff} 天前`;

  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 历史分组标题：`今天` / `昨天` / `更早`（FR-26）。
 */
export function historyGroupOf(
  ts: number,
  now: number = Date.now(),
): "今天" | "昨天" | "更早" {
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (dayDiff <= 0) return "今天";
  if (dayDiff === 1) return "昨天";
  return "更早";
}

/** 备份文件名用的日期串：`2026-10-20` */
export function formatDateStamp(ts: number = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 时间戳规范化：非有限数/负数 → 0（落库前的守卫） */
export function normalizeTimestamp(ts: number | null | undefined): number {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts < 0) return 0;
  return Math.floor(ts);
}
