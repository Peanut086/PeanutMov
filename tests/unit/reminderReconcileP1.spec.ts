import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reminderRepo } from '@/db/repositories/reminderRepo';
import { nativeIdOf, reminderService } from '@/services/reminderService';
import type { Reminder, ReminderState } from '@/types';

import { resetAll } from './helpers';

/**
 * EXT-06 P1 复审整改（REV-10 / REV-20）
 *
 * - REV-10：`reconcile` 必须比对原生排期时刻（`|pendingAt - notifyAt| > 60s` 才重排）；
 *   `startAutoReconcile` 返回的清理函数必须真正移除监听；
 *   `firedReminders` 通过回调交给 UI 做页内提示；
 * - REV-20：`leadMinutes = 0` 时 `notifyAt === startAt`（开播时刻提醒）。
 *
 * 这里把原生通知层整体 mock 成「已授权 + 可控待触发列表」，
 * web 环境的 `unsupported` 降级路径由 `reminderService.spec.ts` 覆盖。
 */

const { schedulerMock } = vi.hoisted(() => {
  const state = {
    pendingSchedules: [] as Array<{ nativeId: number; at: number | null }>,
  };
  return {
    schedulerMock: {
      state,
      ensurePermission: vi.fn(async () => 'granted' as const),
      schedule: vi.fn(async () => ({ scheduled: true })),
      cancel: vi.fn(async () => ({ canceled: 0 })),
      getPendingIds: vi.fn(async () => state.pendingSchedules.map((item) => item.nativeId)),
      getPendingSchedules: vi.fn(async () => state.pendingSchedules),
      onReceived: vi.fn(() => () => undefined),
      onAction: vi.fn(() => () => undefined),
    },
  };
});

vi.mock('@/native/notificationScheduler', () => ({ notificationScheduler: schedulerMock }));

const MINUTE = 60_000;
const CHANNEL_KEY = 'id:cctv1.hd';

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

function sleep(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 让挂起的 promise 链（对账 / 仓储读写）落地 */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await sleep(5);
}

beforeEach(async () => {
  await resetAll();
  schedulerMock.state.pendingSchedules = [];
  schedulerMock.ensurePermission.mockClear();
  schedulerMock.schedule.mockClear();
  schedulerMock.cancel.mockClear();
  schedulerMock.getPendingSchedules.mockClear();
  schedulerMock.onReceived.mockClear();
  schedulerMock.onAction.mockClear();
});

describe('REV-10：reconcile 比对原生排期时刻', () => {
  it('原生排期与 notifyAt 偏差 ≤ 60s → 不重排', async () => {
    const record = reminderOf({ id: 'r_drift_small' });
    await reminderRepo.save(record);
    schedulerMock.state.pendingSchedules = [
      { nativeId: record.nativeId, at: record.notifyAt + 45_000 },
    ];

    const result = await reminderService.reconcile(Date.now());
    expect(result.rescheduled).toBe(0);
    expect(schedulerMock.schedule).not.toHaveBeenCalled();
  });

  it('原生排期与 notifyAt 偏差 > 60s → 取消旧排期后按 notifyAt 重排', async () => {
    const record = reminderOf({ id: 'r_drift_big' });
    await reminderRepo.save(record);
    schedulerMock.state.pendingSchedules = [
      { nativeId: record.nativeId, at: record.notifyAt + 5 * MINUTE },
    ];

    const result = await reminderService.reconcile(Date.now());
    expect(result.rescheduled).toBe(1);
    expect(schedulerMock.schedule).toHaveBeenCalledTimes(1);
    const firstCall = schedulerMock.schedule.mock.calls[0] as unknown[];
    expect(firstCall[0]).toMatchObject({
      nativeId: record.nativeId,
      at: record.notifyAt,
    });
  });

  it('原生排期缺失（无 pending 记录）→ 补排', async () => {
    const record = reminderOf({ id: 'r_missing' });
    await reminderRepo.save(record);
    schedulerMock.state.pendingSchedules = [];

    const result = await reminderService.reconcile(Date.now());
    expect(result.rescheduled).toBe(1);
    expect(schedulerMock.schedule).toHaveBeenCalledTimes(1);
  });

  it('排期时间无法解析（at=null）时不误伤，保持原排期', async () => {
    const record = reminderOf({ id: 'r_unknown_at' });
    await reminderRepo.save(record);
    schedulerMock.state.pendingSchedules = [{ nativeId: record.nativeId, at: null }];

    const result = await reminderService.reconcile(Date.now());
    expect(result.rescheduled).toBe(0);
    expect(schedulerMock.schedule).not.toHaveBeenCalled();
  });
});

describe('REV-10：startAutoReconcile 的接线与清理', () => {
  it('启动即对账，回前台再对账；返回的清理函数移除监听', async () => {
    const off = reminderService.startAutoReconcile();
    await flush();
    const afterStart = schedulerMock.getPendingSchedules.mock.calls.length;
    expect(afterStart).toBeGreaterThan(0);
    expect(schedulerMock.onReceived).toHaveBeenCalledTimes(1);
    expect(schedulerMock.onAction).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    const afterResume = schedulerMock.getPendingSchedules.mock.calls.length;
    expect(afterResume).toBeGreaterThan(afterStart);

    off();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(schedulerMock.getPendingSchedules.mock.calls.length).toBe(afterResume);
  });

  it('到点提醒通过 onFired 回调交给 UI（页内提示数据源）', async () => {
    const now = Date.now();
    const due = reminderOf({
      id: 'r_due',
      startAt: now + 10 * MINUTE,
      endAt: now + 40 * MINUTE,
      notifyAt: now - 1_000,
      state: 'scheduled',
    });
    await reminderRepo.save(due);

    const fired: Reminder[] = [];
    const off = reminderService.startAutoReconcile((reminders) => fired.push(...reminders));
    await flush();

    expect(fired.map((item) => item.id)).toContain(due.id);
    const stored = await reminderRepo.get(due.id);
    expect(stored?.state).toBe('firing');
    off();
  });
});

describe('REV-20：leadMinutes = 0（开播时刻提醒）', () => {
  it('notifyAt 等于 startAt（不被 5s 兜底改写）', async () => {
    const startAt = Date.now() + 30 * MINUTE;
    const created = await reminderService.upsert({
      liveSourceId: 'live-a',
      channelKey: CHANNEL_KEY,
      channelName: 'CCTV-1 综合',
      programmeKey: `${startAt}:新闻联播`,
      programmeTitle: '新闻联播',
      startAt,
      endAt: startAt + 30 * MINUTE,
      leadMinutes: 0,
    });
    expect(created.leadMinutes).toBe(0);
    expect(created.notifyAt).toBe(startAt);
  });
});
