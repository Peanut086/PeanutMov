/**
 * 原生通知适配（EXT-06 / FR-71，API-24）
 *
 * - 不新增原生插件：复用既有 `@capacitor/local-notifications@7`；
 * - Web 端 `ensurePermission()` 恒为 `unsupported`，`schedule` 直接拒绝，
 *   由 `reminderService` 降级为页内提示（不静默失败）；
 * - 动态 import 插件，避免 Web 首屏加载原生桥接代码。
 */
import { isNative } from '@/shared/platform';
import { logger } from '@/shared/logger';

export type NotificationPermission = 'granted' | 'denied' | 'unsupported';

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

  async schedule(item: ScheduledNotification): Promise<{ scheduled: boolean }> {
    const mod = await loadPlugin();
    if (!mod) throw new Error('当前平台不支持本地通知');
    await mod.LocalNotifications.schedule({
      notifications: [
        {
          id: item.nativeId,
          title: item.title,
          body: item.body,
          schedule: { at: normalizeAt(item.at), allowWhileIdle: true },
          extra: item.extra,
        },
      ],
    });
    return { scheduled: true };
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
