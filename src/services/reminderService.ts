/**
 * 节目提醒（EXT-06 / FR-71，API-22）
 *
 * 状态机（严格）：
 *   scheduled ──notifyAt 到点──▶ firing ──60s──▶ fired
 *       │                          │
 *       └─超过 startAt+10min 未触发─┴─▶ missed
 *   cancelled：用户取消（终态）
 *
 * - 唯一键确定性：`id = r_${hash(channelKey:startAt)}`，重复设置落到同一条（AC-169 b）；
 * - 原生排期由 `notificationScheduler` 承担，权限被拒/Web 环境降级为「仅 App 内提醒」；
 * - 启动与回前台 `reconcile`（无常驻定时器，对齐 Q-05）。
 */
import { reminderRepo } from '@/db/repositories/reminderRepo';
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { notificationScheduler, type NotificationPermission } from '@/native/notificationScheduler';
import { onAppStateChange } from '@/native/appLifecycle';
import { REMINDER_GRACE_MS, REMINDER_LEAD_OPTIONS, REMINDER_MAX } from '@/shared/constants';
import { AppError } from '@/shared/errors';
import { logger } from '@/shared/logger';
import type { Reminder, ReminderState } from '@/types';

export type ReminderListItem = Reminder & { orphanEpgSource?: boolean };

export interface ReminderUpsertInput {
  liveSourceId: string;
  epgSourceId?: string | null;
  channelKey: string;
  channelName: string;
  programmeKey: string;
  programmeTitle: string;
  startAt: number;
  endAt: number;
  leadMinutes?: 0 | 5 | 10 | 15 | 30;
}

export interface ReminderReconcileResult {
  checked: number;
  fired: number;
  missed: number;
  rescheduled: number;
  elapsedMs: number;
  /** 本次到点需在前台提示的提醒（Web/前台降级用） */
  firedReminders: Reminder[];
}

/** FNV-1a 32 位哈希（稳定、无依赖） */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 提醒 id：`r_${hex(hash(channelKey:startAt))}` */
export function reminderIdOf(channelKey: string, startAt: number): string {
  return `r_${hash32(`${channelKey}:${startAt}`).toString(16)}`;
}

/** 原生通知 id：32 位正整数（与提醒一一对应，重复设置不变） */
export function nativeIdOf(reminderId: string): number {
  const value = hash32(reminderId) % 2_147_483_647;
  return value === 0 ? 1 : value;
}

const TERMINAL_STATES: ReminderState[] = ['fired', 'missed', 'cancelled'];

function isTerminal(state: ReminderState): boolean {
  return TERMINAL_STATES.includes(state);
}

function normalizeLead(lead: number | undefined): 0 | 5 | 10 | 15 | 30 {
  if (lead === undefined) return 5;
  if (!(REMINDER_LEAD_OPTIONS as readonly number[]).includes(lead)) {
    throw new AppError('E_INVALID_INPUT', '提前量只能是 0/5/10/15/30 分钟');
  }
  return lead as 0 | 5 | 10 | 15 | 30;
}

function scheduleText(reminder: Reminder): { title: string; body: string } {
  return {
    title: `${reminder.channelName} · ${reminder.programmeTitle}`,
    body: `节目将于 ${new Date(reminder.startAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 开始`,
  };
}

/** 原生排期（失败不抛：权限/系统限制走降级） */
async function scheduleNative(
  reminder: Reminder,
): Promise<{ permission: NotificationPermission; error: string | null }> {
  const permission = await notificationScheduler.ensurePermission();
  if (permission !== 'granted') {
    return { permission, error: permission === 'unsupported' ? '仅 App 内提醒' : '通知权限被拒，仅 App 内提醒' };
  }
  try {
    const text = scheduleText(reminder);
    await notificationScheduler.schedule({
      nativeId: reminder.nativeId,
      title: text.title,
      body: text.body,
      at: reminder.notifyAt,
      extra: {
        route: `/live?source=${reminder.liveSourceId}&channel=${encodeURIComponent(reminder.channelName)}`,
        reminderId: reminder.id,
      },
    });
    return { permission, error: null };
  } catch (error) {
    logger.warn('本地通知排期失败', error);
    return { permission, error: '本地通知排期失败，仅 App 内提醒' };
  }
}

export const reminderService = {
  /** 设置/覆盖提醒（同一节目落到同一条记录，原生 id 不变） */
  async upsert(
    input: ReminderUpsertInput,
  ): Promise<Reminder & { native: { scheduled: boolean; permission: NotificationPermission } }> {
    if (!input.channelKey) throw new AppError('E_INVALID_INPUT', '缺少频道标识');
    if (!Number.isFinite(input.startAt) || !Number.isFinite(input.endAt)) {
      throw new AppError('E_INVALID_INPUT', '节目时间无效');
    }
    const now = Date.now();
    if (input.startAt <= now) {
      throw new AppError('E_INVALID_STATE', '节目已开始，无法设置提醒');
    }
    const leadMinutes = normalizeLead(input.leadMinutes);

    const id = reminderIdOf(input.channelKey, input.startAt);
    const existing = await reminderRepo.get(id);
    const all = await reminderRepo.list();
    const activeCount = all.filter((item) => !isTerminal(item.state) && item.id !== id).length;
    if (activeCount >= REMINDER_MAX) {
      throw new AppError('E_INVALID_STATE', `待触发提醒已达上限（${REMINDER_MAX} 条）`);
    }

    // 覆盖：先取消旧排期，再按新提前量重排（原生 id 由 id 派生，保持不变）
    if (existing) await notificationScheduler.cancel([existing.nativeId]);

    let notifyAt = input.startAt - leadMinutes * 60_000;
    if (notifyAt <= now) notifyAt = now + 5_000;

    const record = {
      id,
      liveSourceId: input.liveSourceId,
      epgSourceId: input.epgSourceId ?? null,
      channelKey: input.channelKey,
      channelName: input.channelName,
      programmeKey: input.programmeKey,
      programmeTitle: input.programmeTitle,
      startAt: input.startAt,
      endAt: input.endAt,
      leadMinutes,
      notifyAt,
      state: 'scheduled' as ReminderState,
      nativeId: existing?.nativeId ?? nativeIdOf(id),
      lastError: null as string | null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const scheduled = await scheduleNative(record as Reminder);
    record.lastError = scheduled.error;
    await reminderRepo.save(record);

    const view: Reminder = { ...record };
    return {
      ...view,
      native: { scheduled: scheduled.error === null, permission: scheduled.permission },
    };
  },

  /** 列表（按 notifyAt 升序）；`epgSourceId` 已不存在的项标记 `orphanEpgSource` */
  async list(opts?: { state?: ReminderState; from?: number }): Promise<{ reminders: ReminderListItem[] }> {
    const all = await reminderRepo.list();
    let sources: Set<string> | null = null;
    try {
      sources = new Set((await epgSourceRepo.list()).map((source) => source.id));
    } catch (error) {
      logger.debug('读取 EPG 源失败（提醒孤儿判定跳过）', error);
    }
    const reminders = all
      .filter((item) => (opts?.state ? item.state === opts.state : true))
      .filter((item) => (opts?.from !== undefined ? item.notifyAt >= opts.from : true))
      .map((item) => {
        const view: ReminderListItem = { ...item };
        if (view.epgSourceId && sources && !sources.has(view.epgSourceId)) {
          view.epgSourceId = null;
          view.orphanEpgSource = true;
        }
        return view;
      });
    return { reminders };
  },

  async get(id: string): Promise<Reminder | null> {
    return reminderRepo.get(id);
  },

  /** 某节目是否已设置提醒（UI 铃铛状态） */
  async findFor(channelKey: string, startAt: number): Promise<Reminder | null> {
    const found = await reminderRepo.get(reminderIdOf(channelKey, startAt));
    if (!found || isTerminal(found.state)) return null;
    return found;
  },

  async cancel(id: string): Promise<{ canceled: boolean }> {
    const found = await reminderRepo.get(id);
    if (!found) throw new AppError('E_NOT_FOUND', '提醒不存在');
    await notificationScheduler.cancel([found.nativeId]);
    await reminderRepo.remove(id);
    return { canceled: true };
  },

  async cancelByChannel(channelKey: string): Promise<{ canceled: number }> {
    const all = await reminderRepo.list();
    const targets = all.filter((item) => item.channelKey === channelKey && !isTerminal(item.state));
    if (targets.length > 0) {
      await notificationScheduler.cancel(targets.map((item) => item.nativeId));
    }
    const canceled = await reminderRepo.removeByChannel(channelKey);
    return { canceled };
  },

  async cancelBySource(liveSourceId: string): Promise<{ canceled: number }> {
    const all = await reminderRepo.list();
    const targets = all.filter(
      (item) => item.liveSourceId === liveSourceId && !isTerminal(item.state),
    );
    if (targets.length > 0) {
      await notificationScheduler.cancel(targets.map((item) => item.nativeId));
    }
    const canceled = await reminderRepo.removeBySource(liveSourceId);
    return { canceled };
  },

  /**
   * 对账（启动 / 回前台 / 页内每分钟）：
   * - 过期未触发（now > startAt + grace）→ missed 并取消原生；
   * - 到点区间（notifyAt ≤ now ≤ startAt + grace）→ firing，并把提醒返回给 UI 做页内提示；
   * - firing 且已过 60s → fired；
   * - 其余保持 scheduled，原生排期缺失则补排（rescheduled）。
   */
  async reconcile(now: number = Date.now()): Promise<ReminderReconcileResult> {
    const startedAt = Date.now();
    const all = await reminderRepo.list();
    const changed: typeof all = [];
    const firedReminders: Reminder[] = [];
    let fired = 0;
    let missed = 0;
    let rescheduled = 0;

    for (const record of all) {
      if (record.state === 'scheduled') {
        if (now > record.startAt + REMINDER_GRACE_MS) {
          record.state = 'missed';
          record.updatedAt = now;
          changed.push(record);
          missed += 1;
          continue;
        }
        if (now >= record.notifyAt) {
          record.state = 'firing';
          record.updatedAt = now;
          changed.push(record);
          fired += 1;
          firedReminders.push({ ...record });
        }
        continue;
      }
      if (record.state === 'firing' && now >= record.notifyAt + 60_000) {
        record.state = 'fired';
        record.updatedAt = now;
        changed.push(record);
      }
    }

    if (changed.length > 0) await reminderRepo.saveMany(changed);

    // 终态项的原生排期取消（missed 的立即取消；fired 的已被系统消费，取消无害）
    const canceledIds = changed
      .filter((record) => record.state === 'missed' || record.state === 'fired')
      .map((record) => record.nativeId);
    if (canceledIds.length > 0) await notificationScheduler.cancel(canceledIds);

    // 原生排期对齐：仅当通知可用时检查（Web 恒 unsupported，避免每次白跑）
    const permission = await notificationScheduler.ensurePermission();
    if (permission === 'granted') {
      const pending = await notificationScheduler.getPendingSchedules();
      const pendingMap = new Map<number, number | null>(
        pending.map((item) => [item.nativeId, item.at]),
      );
      const stillScheduled = all.filter((record) => record.state === 'scheduled');
      for (const record of stillScheduled) {
        if (pendingMap.has(record.nativeId)) {
          // REV-10：原生排期时间与 notifyAt 偏差超过 60s 才重排（允许系统取整误差）
          const pendingAt = pendingMap.get(record.nativeId);
          if (pendingAt === null || pendingAt === undefined) continue;
          if (Math.abs(pendingAt - record.notifyAt) <= 60_000) continue;
        }
        const scheduled = await scheduleNative(record as Reminder);
        const updated = { ...record, lastError: scheduled.error, updatedAt: now };
        await reminderRepo.save(updated);
        if (scheduled.error === null) rescheduled += 1;
      }
    }

    return {
      checked: all.length,
      fired,
      missed,
      rescheduled,
      elapsedMs: Date.now() - startedAt,
      firedReminders,
    };
  },

  /** 全量对齐原生排期（取消不该触发的、补齐缺失的） */
  async syncNative(): Promise<{
    scheduled: number;
    canceled: number;
    permission: NotificationPermission;
  }> {
    const permission = await notificationScheduler.ensurePermission();
    const all = await reminderRepo.list();
    if (permission !== 'granted') return { scheduled: 0, canceled: 0, permission };

    const pendingIds = new Set(await notificationScheduler.getPendingIds());
    const active = all.filter((record) => record.state === 'scheduled');

    // 只取消「本模块登记过、但已不该触发」的通知（避免误伤下载通知）
    const staleIds = all
      .filter((record) => isTerminal(record.state) && pendingIds.has(record.nativeId))
      .map((record) => record.nativeId);
    const canceled = staleIds.length > 0 ? (await notificationScheduler.cancel(staleIds)).canceled : 0;

    let scheduled = 0;
    for (const record of active) {
      if (pendingIds.has(record.nativeId)) continue;
      const result = await scheduleNative(record as Reminder);
      if (result.error === null) scheduled += 1;
    }
    return { scheduled, canceled, permission };
  },

  /**
   * 订阅原生通知（前台收到 / 点击动作）。
   * 回调给出提醒与跳转路由；点击只定位频道，不自动播放（AC-168）。
   */
  onNativeReceived(
    callback: (event: { reminder: Reminder | null; route: string | null; kind: 'received' | 'action' }) => void,
  ): () => void {
    const handle = async (
      payload: { id: number; extra?: Record<string, unknown> },
      kind: 'received' | 'action',
    ): Promise<void> => {
      const all = await reminderRepo.list();
      const found = all.find((record) => record.nativeId === payload.id) ?? null;
      let route: string | null = null;
      if (found) {
        const nextState: ReminderState = kind === 'received' ? 'fired' : found.state;
        if (nextState !== found.state) {
          await reminderRepo.save({ ...found, state: nextState, updatedAt: Date.now() });
        }
        if (kind === 'action') {
          route = `/live?source=${found.liveSourceId}&channel=${encodeURIComponent(found.channelName)}`;
        }
      }
      callback({ reminder: found ? { ...found } : null, route, kind });
    };

    const offReceived = notificationScheduler.onReceived((payload) =>
      void handle(payload, 'received'),
    );
    const offAction = notificationScheduler.onAction((payload) => void handle(payload, 'action'));
    return () => {
      offReceived();
      offAction();
    };
  },

  /**
   * 启动自动对账：立即对账一次 + 回前台再对账 + 订阅原生通知（前台到达也走页内提示）。
   * 返回取消函数（页面卸载时调用，避免监听泄漏）。
   */
  startAutoReconcile(
    onFired?: (reminders: Reminder[]) => void,
  ): () => void {
    let disposed = false;
    const run = (): void => {
      if (disposed) return;
      void reminderService
        .reconcile()
        .then((result) => {
          if (result.firedReminders.length > 0) onFired?.(result.firedReminders);
        })
        .catch((error) => logger.debug('提醒对账失败', error));
    };
    run();
    const offState = onAppStateChange((state) => {
      if (state === 'active') run();
    });
    // 前台收到原生通知时也给出页内提示（真机场景；Web 恒无事件）
    const offNative = reminderService.onNativeReceived((event) => {
      if (disposed) return;
      if (event.kind === 'received' && event.reminder) onFired?.([event.reminder]);
    });
    return () => {
      disposed = true;
      offState();
      offNative();
    };
  },
};

export type ReminderService = typeof reminderService;
