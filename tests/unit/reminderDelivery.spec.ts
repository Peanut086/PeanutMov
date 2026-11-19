import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  REMINDER_DELIVERY_UNKNOWN_LABEL,
  assessReminderDelivery,
  describeReminderDelivery,
  nativeIdOf,
  openReminderDeliverySettings,
  probeReminderDelivery,
  reminderService,
  type ReminderDeliveryAssessment,
} from '@/services/reminderService';
import type { Reminder, ReminderState } from '@/types';
import type { ReminderDeliveryState } from '@/native/notificationScheduler';

import { resetAll } from './helpers';

/**
 * P2-2：提醒投递档位（可准时 / 可能被延迟 / 仅 App 内）
 *
 * 覆盖三件事：
 * 1. 档位判定只看真实闸门（通知开关 / 渠道 / 精确闹钟），电池豁免刻意不参与；
 * 2. 档位随每次排期入账——在系统里补授权后重排，台账必须跟着变，
 *    否则界面会长期挂着第一次设置时那句过期原因；
 * 3. 界面一行话的优先级：当前探测 > 排期台账 > 未记录，且不靠猜。
 */

const { schedulerMock, deliveryState } = vi.hoisted(() => {
  const state: ReminderDeliveryState = {
    notificationsEnabled: true,
    channelExists: true,
    channelImportance: 4,
    exactAlarmsAllowed: true,
    batteryOptimizationIgnored: false,
  };
  const pending: Array<{ nativeId: number; at: number | null }> = [];
  return {
    deliveryState: state,
    schedulerMock: {
      state,
      pending,
      ensurePermission: vi.fn(async (): Promise<NotificationPermission> => 'granted'),
      peekPermission: vi.fn(async (): Promise<NotificationPermission> => 'granted'),
      getDeliveryState: vi.fn(async () => ({ ...state })),
      openSettings: vi.fn(async () => ({ opened: true, reason: null })),
      schedule: vi.fn(async (item: { nativeId: number; at: number }) => {
        pending.push({ nativeId: item.nativeId, at: item.at });
        return { scheduled: true };
      }),
      getPendingIds: vi.fn(async () => pending.map((item) => item.nativeId)),
      getPendingSchedules: vi.fn(async () => pending),
      cancel: vi.fn(async (ids: number[]) => {
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          if (ids.includes(pending[i].nativeId)) pending.splice(i, 1);
        }
        return { canceled: ids.length };
      }),
      onReceived: vi.fn(() => () => undefined),
      onAction: vi.fn(() => () => undefined),
    },
  };
});

vi.mock('@/native/notificationScheduler', () => ({ notificationScheduler: schedulerMock }));

const MINUTE = 60_000;
const CHANNEL_KEY = 'id:cctv1.hd';

function upsertInput(over: Partial<{ leadMinutes: 0 | 5 | 10 | 15 | 30 }> = {}) {
  const startAt = Date.now() + 60 * MINUTE;
  return {
    liveSourceId: 'live-a',
    epgSourceId: null,
    channelKey: CHANNEL_KEY,
    channelName: 'CCTV-1 综合',
    programmeKey: `${startAt}:新闻联播`,
    programmeTitle: '新闻联播',
    startAt,
    endAt: startAt + 30 * MINUTE,
    leadMinutes: 5 as const,
    ...over,
  };
}

function reminderOf(over: Partial<Reminder> & { id: string }): Reminder {
  const now = Date.now();
  return {
    liveSourceId: 'live-a',
    epgSourceId: null,
    channelKey: CHANNEL_KEY,
    channelName: 'CCTV-1 综合',
    programmeKey: 'p1',
    programmeTitle: '新闻联播',
    startAt: now + 60 * MINUTE,
    endAt: now + 90 * MINUTE,
    leadMinutes: 5,
    notifyAt: now + 55 * MINUTE,
    state: 'scheduled' as ReminderState,
    nativeId: nativeIdOf(over.id),
    lastError: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function live(over: Partial<ReminderDeliveryAssessment> = {}): ReminderDeliveryAssessment {
  return { tier: 'delayed', reason: '未授权精确闹钟，待机或省电模式下可能延后触发', settingsTarget: 'exactAlarm', ...over };
}

beforeEach(async () => {
  schedulerMock.pending.length = 0;
  Object.assign(deliveryState, {
    notificationsEnabled: true,
    channelExists: true,
    channelImportance: 4,
    exactAlarmsAllowed: true,
    batteryOptimizationIgnored: false,
  });
  vi.clearAllMocks();
  await resetAll();
});

describe('assessReminderDelivery：档位只看真实闸门', () => {
  const fullGrant = { ...deliveryState };

  it('全绿且未申请电池豁免 → 仍判可准时（电池不参与判定是有意的取舍）', () => {
    const result = assessReminderDelivery('granted', { ...fullGrant, batteryOptimizationIgnored: false });
    expect(result).toEqual({ tier: 'exact', reason: null, settingsTarget: null });
  });

  it('系统通知总开关关闭 → 仅 App 内提醒，入口指向通知设置', () => {
    const result = assessReminderDelivery('granted', { ...fullGrant, notificationsEnabled: false });
    expect(result.tier).toBe('in-app');
    expect(result.reason).toContain('系统通知开关已关闭');
    expect(result.settingsTarget).toBe('notifications');
  });

  it('提醒渠道不可用 → 可能被延迟（落回默认渠道，不是"没提醒"）', () => {
    const result = assessReminderDelivery('granted', { ...fullGrant, channelExists: false });
    expect(result.tier).toBe('delayed');
    expect(result.reason).toContain('默认渠道');
    expect(result.settingsTarget).toBe('notifications');
  });

  it('未授权精确闹钟 → 可能被延迟，入口指向精确闹钟授权页', () => {
    const result = assessReminderDelivery('granted', { ...fullGrant, exactAlarmsAllowed: false });
    expect(result.tier).toBe('delayed');
    expect(result.reason).toContain('精确闹钟');
    expect(result.settingsTarget).toBe('exactAlarm');
  });

  it('渠道被降级为静默通知 → 可能被延迟并说清是渠道问题', () => {
    const result = assessReminderDelivery('granted', { ...fullGrant, channelImportance: 3 });
    expect(result.tier).toBe('delayed');
    expect(result.reason).toContain('静默通知');
    expect(result.settingsTarget).toBe('notifications');
  });

  it('插件已授权但原生诊断读不到 → 可能被延迟，不谎称精确也不谎称失败', () => {
    const result = assessReminderDelivery('granted', null);
    expect(result.tier).toBe('delayed');
    expect(result.reason).toContain('无法确认系统投递状态');
  });

  it('平台不支持 / 权限被拒 → 仅 App 内提醒（被拒时才给设置入口）', () => {
    expect(assessReminderDelivery('unsupported', null)).toEqual({
      tier: 'in-app',
      reason: '当前平台不支持系统通知，仅 App 内提醒',
      settingsTarget: null,
    });
    const denied = assessReminderDelivery('denied', null);
    expect(denied.tier).toBe('in-app');
    expect(denied.settingsTarget).toBe('notifications');
  });
});

describe('档位随排期入账（含授权后重排）', () => {
  it('缺精确闹钟时设置提醒：记 delayed 与原因，并把入口告诉界面', async () => {
    deliveryState.exactAlarmsAllowed = false;
    const created = await reminderService.upsert(upsertInput());
    expect(created.delivery).toBe('delayed');
    expect(created.deliveryNote).toContain('精确闹钟');
    expect(created.native.delivery.settingsTarget).toBe('exactAlarm');
    const stored = await reminderService.get(created.id);
    expect(stored?.delivery).toBe('delayed');
  });

  it('在系统里补授权后重排，档位改为可准时且旧原因不再挂着', async () => {
    deliveryState.exactAlarmsAllowed = false;
    const created = await reminderService.upsert(upsertInput());
    expect(created.delivery).toBe('delayed');

    deliveryState.exactAlarmsAllowed = true;
    // 让 reconcile 判定"原生排期漂移 > 60s"，走重排分支（与补授权后的重排同一条路）
    schedulerMock.pending[0].at = created.notifyAt - 5 * MINUTE;
    const result = await reminderService.reconcile();
    expect(result.rescheduled).toBe(1);

    const after = await reminderService.get(created.id);
    expect(after?.delivery).toBe('exact');
    expect(after?.deliveryNote).toBeNull();
    expect(after?.lastError).toBeNull();
  });

  it('排期本身失败 → 按仅 App 内提醒入账，不留空洞', async () => {
    schedulerMock.schedule.mockRejectedValueOnce(new Error('通知服务无响应'));
    const created = await reminderService.upsert(upsertInput());
    expect(created.delivery).toBe('in-app');
    expect(created.deliveryNote).toContain('仅 App 内提醒');
    expect(created.lastError).toContain('通知服务无响应');
  });
});

describe('describeReminderDelivery：界面一行话的优先级', () => {
  it('有当前探测结果就用它，并带上对症设置入口', () => {
    const view = describeReminderDelivery(live(), reminderOf({ id: 'r_1', delivery: 'exact' }));
    expect(view?.tier).toBe('delayed');
    expect(view?.text).toContain('可能被系统延迟：');
    expect(view?.text).not.toContain('上次');
    expect(view?.settingsTarget).toBe('exactAlarm');
    expect(view?.settingsLabel).toBe('授权精确闹钟');
  });

  it('可准时不拼原因', () => {
    const view = describeReminderDelivery(live({ tier: 'exact', reason: null, settingsTarget: null }), null);
    expect(view?.text).toBe('可准时提醒');
    expect(view?.settingsLabel).toBeNull();
  });

  it('没有探测结果时退回排期台账，并标明是上次排期结果、不给猜测的入口', () => {
    const record = reminderOf({ id: 'r_2', delivery: 'in-app', deliveryNote: '通知权限未授予，仅 App 内提醒' });
    const view = describeReminderDelivery(null, record);
    expect(view?.text).toBe('仅 App 内提醒：通知权限未授予，仅 App 内提醒（上次排期结果）');
    expect(view?.settingsTarget).toBeNull();
  });

  it('台账没有原因时只说档位', () => {
    const view = describeReminderDelivery(null, reminderOf({ id: 'r_3', delivery: 'delayed', deliveryNote: null }));
    expect(view?.text).toBe('可能被系统延迟（上次排期结果）');
  });

  it('老记录没有档位字段 → 说"未记录"，不默认成可准时', () => {
    const view = describeReminderDelivery(null, reminderOf({ id: 'r_4' }));
    expect(view?.text).toBe(REMINDER_DELIVERY_UNKNOWN_LABEL);
  });

  it('既没探测也没记录 → 不显示这一行', () => {
    expect(describeReminderDelivery(null, null)).toBeNull();
  });
});

describe('只读探测与系统设置入口', () => {
  it('走只读权限检查，绝不触发授权弹窗', async () => {
    await probeReminderDelivery();
    expect(schedulerMock.peekPermission).toHaveBeenCalled();
    expect(schedulerMock.ensurePermission).not.toHaveBeenCalled();
  });

  it('权限尚未授予 → 仅 App 内提醒 + 通知设置入口', async () => {
    schedulerMock.peekPermission.mockResolvedValueOnce('denied');
    const result = await probeReminderDelivery();
    expect(result.tier).toBe('in-app');
    expect(result.settingsTarget).toBe('notifications');
  });

  it('设置入口按缺口转发给原生桥，并原样返回结论（打不开时的原因由原生侧给出）', async () => {
    expect(await openReminderDeliverySettings('exactAlarm')).toEqual({ opened: true, reason: null });
    expect(schedulerMock.openSettings).toHaveBeenCalledWith('exactAlarm');
  });
});
