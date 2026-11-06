/**
 * 定时备份调度器（EXT-05 phase1）
 *
 * 触发链路（双通道，缺一不可）：
 * 1. **App 运行中**：`setInterval` 每 60s 检查一次（另有 `visibilitychange` 回到前台立即检查）；
 * 2. **App 未运行**：Capacitor LocalNotifications 在"下次触发时间"安排一条提醒通知
 *    （WebView 被回收后 JS 不会执行，因此原生侧只能做到"提醒 + 打开 App 即补执行"）。
 *
 * 补执行口径：以"最近一次应当触发的时间点"为准，`lastScheduledAt < 该时间点` 即视为漏跑，
 * 下次 `start()` / 回到前台 / 60s tick 时立即补做一次（同一时间点只补一次，因为执行后会写回
 * `lastScheduledAt = now`）。
 *
 * 失败处理：定时备份失败只写日志与 `settings.backup.lastError`，绝不抛到 UI，
 * 也不影响手动备份。
 */
import { appEvents } from '@/services/events';
import { settingsService } from '@/services/settingsService';
import { backupService, defaultBackupSettings, type RunBackupResult } from '@/services/backupService';
import { logger } from '@/shared/logger';
import { isNative } from '@/shared/platform';
import type { BackupScheduleMode, BackupSettings } from '@/types';

/** 运行态检查间隔（毫秒） */
export const SCHEDULER_TICK_MS = 60_000;
/** 原生提醒通知固定 id（重复 schedule 会覆盖同 id） */
export const BACKUP_NOTIFICATION_ID = 9105;

export type ScheduleLike = Pick<BackupSettings, 'scheduleMode' | 'scheduleHour' | 'scheduleWeekday'>;

const WEEKDAY_LABELS = ['', '一', '二', '三', '四', '五', '六', '日'] as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 归一化调度参数（非法值回落到默认：每天 03:00，周一） */
export function normalizeSchedule(input: Partial<ScheduleLike> | null | undefined): ScheduleLike {
  const mode: BackupScheduleMode =
    input?.scheduleMode === 'daily' || input?.scheduleMode === 'weekly' ? input.scheduleMode : 'off';
  const rawHour = Number(input?.scheduleHour);
  const hour = Number.isFinite(rawHour) ? Math.min(23, Math.max(0, Math.floor(rawHour))) : 3;
  const rawWeekday = Number(input?.scheduleWeekday);
  const weekday = Number.isFinite(rawWeekday) ? Math.min(7, Math.max(1, Math.floor(rawWeekday))) : 1;
  return { scheduleMode: mode, scheduleHour: hour, scheduleWeekday: weekday };
}

/** 星期映射：1=周一 … 7=周日（与 UI 文案一致），JS `getDay()` 0=周日 */
function jsWeekdayOf(weekday: number): number {
  return weekday === 7 ? 0 : weekday;
}

function atHour(base: Date, hour: number): Date {
  const d = new Date(base.getTime());
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * 下一次应当触发的时间点；`off` 返回 null。
 *
 * 语义：**严格大于** `from` 的最近一次计划时间（用于"下次定时备份"展示与原生提醒）。
 */
export function nextRunAt(schedule: ScheduleLike, from: number = Date.now()): number | null {
  const s = normalizeSchedule(schedule);
  if (s.scheduleMode === 'off') return null;
  const base = new Date(from);

  if (s.scheduleMode === 'daily') {
    const today = atHour(base, s.scheduleHour).getTime();
    if (today > from) return today;
    const tomorrow = atHour(base, s.scheduleHour);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.getTime();
  }

  const target = jsWeekdayOf(s.scheduleWeekday);
  const candidate = atHour(base, s.scheduleHour);
  const delta = (target - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + delta);
  if (candidate.getTime() > from) return candidate.getTime();
  candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}

/**
 * 最近一次"应当已触发"的时间点（≤ `from`）；`off` 返回 null。
 * 补执行判定与"是否已过点"都以它为准。
 */
export function previousRunAt(schedule: ScheduleLike, from: number = Date.now()): number | null {
  const s = normalizeSchedule(schedule);
  if (s.scheduleMode === 'off') return null;
  const base = new Date(from);

  if (s.scheduleMode === 'daily') {
    const today = atHour(base, s.scheduleHour).getTime();
    if (today <= from) return today;
    const yesterday = atHour(base, s.scheduleHour);
    yesterday.setDate(yesterday.getDate() - 1);
    return yesterday.getTime();
  }

  const target = jsWeekdayOf(s.scheduleWeekday);
  const candidate = atHour(base, s.scheduleHour);
  const back = (candidate.getDay() - target + 7) % 7;
  candidate.setDate(candidate.getDate() - back);
  if (candidate.getTime() <= from) return candidate.getTime();
  candidate.setDate(candidate.getDate() - 7);
  return candidate.getTime();
}

/**
 * 是否该补跑一次。
 *
 * `lastScheduledAt` 为空时按"从未执行"处理：只要当前时间已过最近一个计划点就算到期，
 * 因此启用定时备份时 UI 需要把 `lastScheduledAt` 写成 `now`，避免刚开启就立刻备份。
 */
export function isBackupDue(
  schedule: ScheduleLike,
  lastScheduledAt: number | null | undefined,
  now: number = Date.now(),
): boolean {
  const s = normalizeSchedule(schedule);
  if (s.scheduleMode === 'off') return false;
  const previous = previousRunAt(s, now);
  if (previous === null) return false;
  return (lastScheduledAt ?? 0) < previous;
}

/** 计划文案：「已关闭」/「每天 03:00」/「每周三 03:00」 */
export function describeSchedule(schedule: ScheduleLike): string {
  const s = normalizeSchedule(schedule);
  if (s.scheduleMode === 'off') return '已关闭';
  const time = `${pad2(s.scheduleHour)}:00`;
  if (s.scheduleMode === 'daily') return `每天 ${time}`;
  return `每周${WEEKDAY_LABELS[s.scheduleWeekday]} ${time}`;
}

/** 倒计时文案：「已关闭」/「今天 03:00」/「明天 03:00」/「11-09 03:00」 */
export function describeNextRun(schedule: ScheduleLike, from: number = Date.now()): string {
  const next = nextRunAt(schedule, from);
  if (next === null) return '已关闭';
  const target = new Date(next);
  const today = new Date(from);
  const sameDay =
    target.getFullYear() === today.getFullYear() &&
    target.getMonth() === today.getMonth() &&
    target.getDate() === today.getDate();
  const time = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  if (sameDay) return `今天 ${time}`;
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    target.getFullYear() === tomorrow.getFullYear() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getDate() === tomorrow.getDate();
  if (isTomorrow) return `明天 ${time}`;
  return `${pad2(target.getMonth() + 1)}-${pad2(target.getDate())} ${time}`;
}

/* ================= 运行态 ================= */

let timer: ReturnType<typeof setInterval> | null = null;
let listenersBound = false;
let running = false;
let visibilityHandler: (() => void) | null = null;
let settingsUnsubscribe: (() => void) | null = null;

function webdavReady(settings: Awaited<ReturnType<typeof settingsService.get>>): boolean {
  const webdav = settings.webdav;
  return Boolean(webdav?.serverUrl && webdav.username && webdav.password);
}

/**
 * 到点则执行一次定时备份。并发调用安全（`running` 门闩）：
 * 同一时刻最多一个定时备份在跑，重复 tick 直接返回 null。
 */
export async function runScheduledBackupIfDue(now: number = Date.now()): Promise<RunBackupResult | null> {
  if (running) return null;
  let due = false;
  let settings: Awaited<ReturnType<typeof settingsService.get>>;
  try {
    settings = await settingsService.get();
    const backup = settings.backup ?? defaultBackupSettings();
    due = isBackupDue(backup, backup.lastScheduledAt, now);
  } catch (e) {
    logger.warn('定时备份检查失败（读取设置）', e);
    return null;
  }
  if (!due) return null;

  running = true;
  try {
    const result = await backupService.runBackup({
      source: 'scheduled',
      local: true,
      // 配了 WebDAV 就同时上云；未配置时只写本机（不因云端缺失让定时备份失败）
      webdav: webdavReady(settings),
      now,
    });
    logger.info('定时备份完成', { records: result.records.length, encrypted: result.encrypted });
    return result;
  } catch (e) {
    // runBackup 已把失败原因写入 settings.backup.lastError；这里只记日志
    logger.warn('定时备份失败（不影响手动备份）', e);
    return null;
  } finally {
    running = false;
    await syncNativeReminder().catch(() => undefined);
  }
}

/** 在原生侧安排"下次定时备份"提醒（App 被回收时的唯一可见信号） */
export async function syncNativeReminder(): Promise<void> {
  if (!isNative()) return;
  try {
    const settings = await settingsService.get();
    const backup = settings.backup ?? defaultBackupSettings();
    const next = nextRunAt(backup);
    const { LocalNotifications } = await import('@capacitor/local-notifications');

    const pending = await LocalNotifications.getPending();
    if (pending.notifications.some((n) => n.id === BACKUP_NOTIFICATION_ID)) {
      await LocalNotifications.cancel({ notifications: [{ id: BACKUP_NOTIFICATION_ID }] });
    }
    if (next === null) return;

    let permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') {
      permission = await LocalNotifications.requestPermissions();
    }
    if (permission.display !== 'granted') return;

    await LocalNotifications.schedule({
      notifications: [
        {
          id: BACKUP_NOTIFICATION_ID,
          title: 'PeanutMov 定时备份',
          body: '打开 App 即可完成本次自动备份',
          schedule: { at: new Date(next), allowWhileIdle: true },
        },
      ],
    });
  } catch (e) {
    // 通知能力缺失/被拒时静默降级：定时仍然会在 App 内触发
    logger.debug('定时备份原生提醒安排失败', { error: String(e) });
  }
}

function bindListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  if (typeof document !== 'undefined') {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') void runScheduledBackupIfDue();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
  settingsUnsubscribe = appEvents.on('settings:changed', () => {
    // 改设置（含开关定时/加密）后重算提醒；真正的执行仍由 tick 统一判定
    void syncNativeReminder();
  });
}

function unbindListeners(): void {
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
  settingsUnsubscribe?.();
  settingsUnsubscribe = null;
  listenersBound = false;
}

/**
 * 启动调度器（幂等）。
 *
 * 调用点：备份页挂载、App 启动钩子（`settingsStore.load` 后 fire-and-forget）。
 * 启动即做一次"补执行"检查，覆盖"上次 App 未运行"的漏跑。
 */
export async function startBackupScheduler(): Promise<void> {
  bindListeners();
  if (timer === null) {
    timer = setInterval(() => {
      void runScheduledBackupIfDue();
    }, SCHEDULER_TICK_MS);
  }
  await runScheduledBackupIfDue();
  await syncNativeReminder().catch(() => undefined);
}

/** 停止调度器并解绑监听（页面卸载 / 测试清理） */
export function stopBackupScheduler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  unbindListeners();
}

/** 当前是否有定时备份在跑（UI 展示"正在备份"） */
export function isScheduledBackupRunning(): boolean {
  return running;
}

/** 测试辅助：彻底复位模块运行态 */
export function __resetBackupScheduler(): void {
  stopBackupScheduler();
  running = false;
}
