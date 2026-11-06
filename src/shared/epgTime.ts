/**
 * EPG 时间工具（EXT-06 / FR-67，AC-159）
 *
 * 与既有 `epgService` 的解析器（`xmltvSec`/`hmOf` 等）并存：那部分行为被测试锁定不得修改，
 * 新增逻辑统一走本模块，负责「带时区偏移的绝对时间」与「设备本地日期」两种口径。
 */

const PAD = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, '0');

/** XMLTV 紧凑时间：`20261025200000 +0800` / `20261025200000+0800` / `20261025200000` */
const XMLTV_COMPACT = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?$/;
/** diyp 全时间戳：`2026-10-25 20:00:00`（无偏移时按设备本地时区解释） */
const DIYP_DASHED = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4})?$/;

function toDate(value: number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

function offsetMinutes(raw: string | undefined): number | null {
  if (!raw) return null;
  const sign = raw.startsWith('-') ? -1 : 1;
  const hours = Number(raw.slice(1, 3));
  const minutes = Number(raw.slice(3, 5));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * 解析 XMLTV / diyp 时间字符串为 epoch ms。
 * 带偏移（`+0800`）时换算成绝对时间；不带偏移时按设备本地时区解释。无法解析返回 null。
 */
export function parseXmltvTime(raw: string | null | undefined): number | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  const compact = XMLTV_COMPACT.exec(text);
  const dashed = compact ? null : DIYP_DASHED.exec(text);
  const match = compact ?? dashed;
  if (!match) return null;

  const [, y, mo, d, h = '0', mi = '0', s = '0', offset] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if ([year, month, day, hour, minute, second].some((v) => !Number.isFinite(v))) return null;

  const offsetMin = offsetMinutes(offset);
  if (offsetMin === null) {
    return new Date(year, month - 1, day, hour, minute, second, 0).getTime();
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMin * 60_000;
}

/** 设备本地日期键 `yyyy-MM-dd` */
export function localDateKey(value: number | Date = new Date()): string {
  const d = toDate(value);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}

/** 设备本地 `yyyyMMdd`（回看模板 `{date}`） */
export function localYmd(value: number | Date = new Date()): string {
  const d = toDate(value);
  return `${d.getFullYear()}${PAD(d.getMonth() + 1)}${PAD(d.getDate())}`;
}

/** 设备本地 `yyyyMMddHHmmss`（回看模板 `{start}` / `{end}`） */
export function localYmdHms(value: number | Date): string {
  const d = toDate(value);
  return `${localYmd(d)}${PAD(d.getHours())}${PAD(d.getMinutes())}${PAD(d.getSeconds())}`;
}

/** UTC `yyyyMMddHHmmss`（回看模板 `{utc}` / `{utcend}`） */
export function utcYmdHms(value: number | Date): string {
  const d = toDate(value);
  return (
    `${d.getUTCFullYear()}${PAD(d.getUTCMonth() + 1)}${PAD(d.getUTCDate())}` +
    `${PAD(d.getUTCHours())}${PAD(d.getUTCMinutes())}${PAD(d.getUTCSeconds())}`
  );
}

/** `HH:mm`（列表展示） */
export function hmOf(value: number | Date): string {
  const d = toDate(value);
  return `${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

/** 设备本地 0 点起的秒偏移（与既有 `startSec` 口径一致） */
export function secOfLocalDay(value: number | Date): number {
  const d = toDate(value);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

/** 设备本地当天 0 点的 epoch ms */
export function startOfLocalDay(value: number | Date = new Date()): number {
  const d = toDate(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 本地日期加减天数（返回 epoch ms） */
export function addLocalDays(value: number | Date, days: number): number {
  const d = toDate(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** 昨天的日期键（EpgView 三天切换用） */
export function shiftDateKey(key: string, days: number): string {
  const parts = key.split('-').map((v) => Number(v));
  if (parts.length !== 3 || parts.some((v) => !Number.isFinite(v))) return key;
  const [y, m, d] = parts;
  const shifted = new Date(y, m - 1, d + days);
  return localDateKey(shifted);
}
