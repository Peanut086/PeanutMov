/**
 * 原生通知适配（EXT-06 / FR-71，API-24；P2-2 补投递诊断）
 *
 * - 不新增原生排期插件：复用既有 `@capacitor/local-notifications@7`；
 * - 排期显式带 `channelId`（P2-2）：不传时插件用自建的 `default` 渠道，
 *   「节目提醒」渠道（HIGH，可横幅）虽然建好了却一次也没被用上；
 * - 投递能力（通知权限 / 渠道 / 精确闹钟 / 电池优化）与系统授权页入口走自建
 *   `Reminder` 插件（`ReminderPlugin.java`）——官方插件读不到这些，也跳不过去；
 * - Web 端 `ensurePermission()` 恒为 `unsupported`，`schedule` 直接拒绝，
 *   由 `reminderService` 降级为页内提示（不静默失败）；
 * - 动态 import 插件，避免 Web 首屏加载原生桥接代码。
 */
import { registerPlugin } from '@capacitor/core';

import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';

export type NotificationPermission = 'granted' | 'denied' | 'unsupported';

/** 与 `ReminderNotifications.CHANNEL_ID` 一致：改一边必须改另一边 */
export const REMINDER_CHANNEL_ID = 'programme_reminders';

/** 可跳转的系统授权页 */
export type ReminderSettingsTarget = 'notifications' | 'exactAlarm' | 'battery';

/**
 * 原生侧读出的投递能力快照。
 *
 * `channelImportance` 用数值而不是枚举名：用户可以在系统设置里把渠道降级，
 * 三档判定要看真实值（`NotificationManager.IMPORTANCE_*`）。
 */
export interface ReminderDeliveryState {
  notificationsEnabled: boolean;
  channelExists: boolean;
  /** 渠道重要性；渠道不存在为 -1 */
  channelImportance: number;
  /** Android 12+ 精确闹钟授权；12 以下原生侧恒报 true */
  exactAlarmsAllowed: boolean;
  batteryOptimizationIgnored: boolean;
}

interface ReminderBridgePlugin {
  getDeliveryState(): Promise<ReminderDeliveryState>;
  openSettings(options: { target: ReminderSettingsTarget }): Promise<void>;
}

/** 插件缺失（Web / 老包）时抛错，由调用方降级，不在此处猜测状态 */
const ReminderBridge = registerPlugin<ReminderBridgePlugin>('Reminder');

export interface ScheduledNotification {
  /** 32 位正整数（Android 通知 id 限制） */
  nativeId: number;
  title: string;
  body: string;
  /** 触发时间（epoch ms）；`<= now` 时立即排期到 now + 5s */
  at: number;
  extra: Record<string, string>;
}

export interface NativeNotificationPayload {
  id: number;
  title?: string;
  body?: string;
  extra?: Record<string, unknown>;
}

type LocalNotificationsModule = typeof import('@capacitor/local-notifications');

let modulePromise: Promise<LocalNotificationsModule | null> | null = null;

async function loadPlugin(): Promise<LocalNotificationsModule | null> {
  if (!isNative()) return null;
  if (!modulePromise) {
    modulePromise = import('@capacitor/local-notifications').catch((error) => {
      logger.warn('本地通知插件不可用', error);
      modulePromise = null;
      return null;
    });
  }
  return modulePromise;
}

/** 排期时间兜底：已过期则排在 5s 后（避免"提前量选大了"直接失败） */
function normalizeAt(at: number, now = Date.now()): Date {
  return new Date(at <= now ? now + 5_000 : at);
}

export const notificationScheduler = {
  async ensurePermission(): Promise<NotificationPermission> {
    const mod = await loadPlugin();
    if (!mod) return 'unsupported';
    try {
      const current = await mod.LocalNotifications.checkPermissions();
      if (current.display === 'granted') return 'granted';
      if (current.display === 'denied') return 'denied';
      const requested = await mod.LocalNotifications.requestPermissions();
      return requested.display === 'granted' ? 'granted' : 'denied';
    } catch (error) {
      logger.warn('通知权限检查失败', error);
      return 'denied';
    }
  },

  /**
   * 只读权限，绝不弹授权框。
   * 界面刷新投递档位时用它：展示一次不该把用户推进权限弹窗，
   * 只有真正排期（`ensurePermission`）才请求授权。
   */
  async peekPermission(): Promise<NotificationPermission> {
    const mod = await loadPlugin();
    if (!mod) return 'unsupported';
    try {
      const current = await mod.LocalNotifications.checkPermissions();
      if (current.display === 'granted') return 'granted';
      if (current.display === 'denied') return 'denied';
      // prompt / limited：还没问过用户，按「未授权」披露，不代替排期去请求
      return 'denied';
    } catch (error) {
      logger.warn('通知权限只读检查失败', error);
      return 'denied';
    }
  },

  async schedule(item: ScheduledNotification): Promise<{ scheduled: boolean }> {
    const mod = await loadPlugin();
    if (!mod) throw new Error('当前平台不支持本地通知');
    await mod.LocalNotifications.schedule({
      notifications: [
        {
          id: item.nativeId,
          title: item.title,
          body: item.body,
          // P2-2：不带 channelId 时插件落自建 default 渠道，节目提醒渠道白建了
          channelId: REMINDER_CHANNEL_ID,
          schedule: { at: normalizeAt(item.at), allowWhileIdle: true },
          extra: item.extra,
        },
      ],
    });
    return { scheduled: true };
  },

  /**
   * 投递能力快照；Web / 插件缺失 / 读取失败返回 null（调用方按「仅 App 内提醒」披露）。
   * 不抛异常：这一页的目的就是说清"为什么提醒没响"，不能因为诊断本身失败而崩。
   */
  async getDeliveryState(): Promise<ReminderDeliveryState | null> {
    if (!isNative()) return null;
    try {
      const state = await ReminderBridge.getDeliveryState();
      return {
        notificationsEnabled: state.notificationsEnabled === true,
        channelExists: state.channelExists === true,
        channelImportance:
          typeof state.channelImportance === 'number' ? state.channelImportance : -1,
        exactAlarmsAllowed: state.exactAlarmsAllowed === true,
        batteryOptimizationIgnored: state.batteryOptimizationIgnored === true,
      };
    } catch (error) {
      logger.warn('读取提醒投递状态失败', error);
      return null;
    }
  },

  /** 打开系统授权页；失败返回原因，由界面显示（ROM 裁页是真实存在的） */
  async openSettings(
    target: ReminderSettingsTarget,
  ): Promise<{ opened: boolean; reason: string | null }> {
    if (!isNative()) return { opened: false, reason: '当前平台没有系统通知设置页' };
    try {
      await ReminderBridge.openSettings({ target });
      return { opened: true, reason: null };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('打开提醒相关设置页失败', target, error);
      return { opened: false, reason };
    }
  },

  async cancel(nativeIds: number[]): Promise<{ canceled: number }> {
    if (nativeIds.length === 0) return { canceled: 0 };
    const mod = await loadPlugin();
    if (!mod) return { canceled: 0 };
    try {
      await mod.LocalNotifications.cancel({
        notifications: nativeIds.map((id) => ({ id })),
      });
      return { canceled: nativeIds.length };
    } catch (error) {
      logger.warn('取消本地通知失败', error);
      return { canceled: 0 };
    }
  },

  async getPendingIds(): Promise<number[]> {
    const mod = await loadPlugin();
    if (!mod) return [];
    try {
      const pending = await mod.LocalNotifications.getPending();
      return pending.notifications.map((item) => item.id);
    } catch (error) {
      logger.warn('读取待触发通知失败', error);
      return [];
    }
  },

  /**
   * REV-10：读取待触发通知及其排期时间（对账时判断原生时间是否漂移）。
   * 插件返回的 `schedule.at` 可能是 Date、ISO 字符串或缺失；无法解析时 `at: null`。
   */
  async getPendingSchedules(): Promise<Array<{ nativeId: number; at: number | null }>> {
    const mod = await loadPlugin();
    if (!mod) return [];
    try {
      const pending = await mod.LocalNotifications.getPending();
      return pending.notifications.map((item) => {
        const raw = (item.schedule as { at?: unknown } | undefined)?.at;
        let at: number | null = null;
        if (raw instanceof Date) at = raw.getTime();
        else if (typeof raw === 'number') at = raw;
        else if (typeof raw === 'string') {
          const parsed = Date.parse(raw);
          at = Number.isFinite(parsed) ? parsed : null;
        }
        return { nativeId: item.id, at: Number.isFinite(at as number) ? at : null };
      });
    } catch (error) {
      logger.warn('读取待触发通知排期失败', error);
      return [];
    }
  },

  /** 前台收到通知（App 在前台也走这里，UI 负责不重复弹系统通知） */
  onReceived(callback: (payload: NativeNotificationPayload) => void): () => void {
    let disposed = false;
    let remove: (() => void) | null = null;
    void (async () => {
      const mod = await loadPlugin();
      if (!mod || disposed) return;
      const handle = await mod.LocalNotifications.addListener('localNotificationReceived', (n) =>
        callback({
          id: n.id,
          title: n.title,
          body: n.body,
          extra: (n.extra ?? {}) as Record<string, unknown>,
        }),
      );
      remove = () => void handle.remove();
    })();
    return () => {
      disposed = true;
      remove?.();
      remove = null;
    };
  },

  /** 点击通知 */
  onAction(callback: (payload: NativeNotificationPayload) => void): () => void {
    let disposed = false;
    let remove: (() => void) | null = null;
    void (async () => {
      const mod = await loadPlugin();
      if (!mod || disposed) return;
      const handle = await mod.LocalNotifications.addListener(
        'localNotificationActionPerformed',
        (action) => {
          const n = action.notification;
          callback({
            id: n.id,
            title: n.title,
            body: n.body,
            extra: (n.extra ?? {}) as Record<string, unknown>,
          });
        },
      );
      remove = () => void handle.remove();
    })();
    return () => {
      disposed = true;
      remove?.();
      remove = null;
    };
  },
};

export type NotificationScheduler = typeof notificationScheduler;
