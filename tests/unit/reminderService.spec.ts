import { beforeEach, describe, expect, it } from 'vitest';

import { reminderRepo } from '@/db/repositories/reminderRepo';
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { nativeIdOf, reminderIdOf, reminderService } from '@/services/reminderService';
import { REMINDER_GRACE_MS, REMINDER_MAX } from '@/shared/constants';
import type { Reminder, ReminderState } from '@/types';

import { resetAll } from './helpers';

/**
 * EXT-06 / FR-71：节目提醒（AC-169）
 * - `id = r_${hash(channelKey:startAt)}` 确定性唯一键 → 重复设置落到同一条；
 * - 状态机 scheduled → firing → fired / missed（超过 startAt + 10min 宽限）；
 * - 上限 50 条（非终态）；Web/无权限降级为「仅 App 内提醒」不静默失败。
 */

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

function upsertInput(over: Partial<Parameters<typeof reminderService.upsert>[0]> = {}) {
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

describe('reminderIdOf / nativeIdOf（确定性唯一键）', () => {
  it('同一 (channelKey,startAt) 恒等；不同时间不同 id', () => {
    expect(reminderIdOf(CHANNEL_KEY, 1000)).toBe(reminderIdOf(CHANNEL_KEY, 1000));
    expect(reminderIdOf(CHANNEL_KEY, 1000)).not.toBe(reminderIdOf(CHANNEL_KEY, 2000));
    expect(reminderIdOf(CHANNEL_KEY, 1000)).not.toBe(reminderIdOf('nm:cctv1', 1000));
    expect(reminderIdOf(CHANNEL_KEY, 1000)).toMatch(/^r_[0-9a-f]{1,8}$/);
  });

  it('nativeId 是 32 位正整数且与 id 一一对应', () => {
    const id = reminderIdOf(CHANNEL_KEY, 1_700_000_000_000);
    const native = nativeIdOf(id);
    expect(native).toBeGreaterThan(0);
    expect(native).toBeLessThan(2_147_483_647);
    expect(nativeIdOf(id)).toBe(native);
  });
});

describe('reminderService.upsert（CRUD + 校验）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('设置提醒：落库为 scheduled，notifyAt = startAt - 提前量', async () => {
    const input = upsertInput({ leadMinutes: 10 });
    const created = await reminderService.upsert(input);
    expect(created.id).toBe(reminderIdOf(input.channelKey, input.startAt));
    expect(created.state).toBe('scheduled');
    expect(created.notifyAt).toBe(input.startAt - 10 * MINUTE);
    // Web/happy-dom 无原生通知 → 降级「仅 App 内提醒」，不静默失败
    expect(created.native.permission).toBe('unsupported');
    expect(created.native.scheduled).toBe(false);
    expect(created.lastError).toContain('仅 App 内提醒');
    // P2-2：档位与原因随记录落库，重启后界面显示的还是这一句
    expect(created.native.delivery.tier).toBe('in-app');
    expect(created.delivery).toBe('in-app');
    expect(created.deliveryNote).toBe(created.lastError);

    const stored = await reminderService.get(created.id);
    expect(stored?.state).toBe('scheduled');
  });

  it('已开始的节目不允许设置提醒（E_INVALID_STATE）', async () => {
    await expect(
      reminderService.upsert(upsertInput({ startAt: Date.now() - MINUTE, endAt: Date.now() })),
    ).rejects.toMatchObject({ code: 'E_INVALID_STATE' });
  });

  it('非法提前量被拒绝（只允许 0/5/10/15/30）', async () => {
    await expect(
      reminderService.upsert(upsertInput({ leadMinutes: 7 as unknown as 5 })),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });

  it('缺少频道标识 / 时间非法被拒绝', async () => {
    await expect(reminderService.upsert(upsertInput({ channelKey: '' }))).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(
      reminderService.upsert(upsertInput({ startAt: Number.NaN })),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });

  it('同一节目重复设置落到同一条记录（id 不变，createdAt 保留）', async () => {
    const input = upsertInput();
    const first = await reminderService.upsert(input);
    const second = await reminderService.upsert({ ...input, leadMinutes: 0 });
    expect(second.id).toBe(first.id);
    expect(second.nativeId).toBe(first.nativeId);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.leadMinutes).toBe(0);
    expect((await reminderService.list()).reminders).toHaveLength(1);
  });

  it('提前量大于剩余时间时 notifyAt 兜底为 now + 5s（Q-20 延后）', async () => {
    const now = Date.now();
    const created = await reminderService.upsert(
      upsertInput({ startAt: now + 2 * MINUTE, endAt: now + 32 * MINUTE, leadMinutes: 30 }),
    );
    expect(created.notifyAt).toBeGreaterThan(now);
    expect(created.notifyAt).toBeLessThanOrEqual(now + 10_000);
  });

  it(`非终态提醒上限 ${REMINDER_MAX} 条`, async () => {
    const now = Date.now();
    const seeds = Array.from({ length: REMINDER_MAX - 1 }, (_, i) =>
      reminderOf({
        id: `r_seed_${i}`,
        channelKey: `nm:seed${i}`,
        startAt: now + (i + 1) * MINUTE,
        notifyAt: now + (i + 1) * MINUTE - MINUTE,
      }),
    );
    await reminderRepo.saveMany(seeds);
    const input = upsertInput();
    // 49 条在册 → 第 50 条允许
    await reminderService.upsert(input);
    // 50 条在册 → 第 51 条拒绝
    await expect(
      reminderService.upsert({ ...input, channelKey: 'nm:another', programmeKey: 'p2' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_STATE' });
    // 覆盖已存在的那条不受上限影响
    const covered = await reminderService.upsert({ ...input, leadMinutes: 0 });
    expect(covered.state).toBe('scheduled');
  });

  it('取消后可再设置（终态不占上限名额）', async () => {
    const input = upsertInput();
    const created = await reminderService.upsert(input);
    await reminderService.cancel(created.id);
    expect(await reminderService.get(created.id)).toBeNull();
    await expect(reminderService.cancel(created.id)).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
    const again = await reminderService.upsert(input);
    expect(again.id).toBe(created.id);
  });
});

describe('reminderService.reconcile（状态机）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('scheduled 到点 → firing，并在 firedReminders 返回给前台提示', async () => {
    const now = Date.now();
    await reminderRepo.save(
      reminderOf({ id: 'r_a', notifyAt: now - MINUTE, startAt: now + 5 * MINUTE }),
    );
    const result = await reminderService.reconcile(now);
    expect(result).toMatchObject({ checked: 1, fired: 1, missed: 0 });
    expect(result.firedReminders.map((r) => r.id)).toEqual(['r_a']);
    expect((await reminderService.get('r_a'))?.state).toBe('firing');
  });

  it('firing 超过 60s → fired', async () => {
    const now = Date.now();
    await reminderRepo.save(
      reminderOf({
        id: 'r_b',
        state: 'firing',
        notifyAt: now - 2 * MINUTE,
        startAt: now + 5 * MINUTE,
      }),
    );
    const result = await reminderService.reconcile(now);
    expect(result.fired).toBe(0);
    expect((await reminderService.get('r_b'))?.state).toBe('fired');
  });

  it('超过 startAt + 10min 宽限仍未触发 → missed', async () => {
    const now = Date.now();
    await reminderRepo.save(
      reminderOf({
        id: 'r_c',
        notifyAt: now - 30 * MINUTE,
        startAt: now - REMINDER_GRACE_MS - MINUTE,
      }),
    );
    const result = await reminderService.reconcile(now);
    expect(result.missed).toBe(1);
    expect((await reminderService.get('r_c'))?.state).toBe('missed');
  });

  it('宽限内仍按 scheduled 保留（未到 notifyAt 不改状态）', async () => {
    const now = Date.now();
    await reminderRepo.save(
      reminderOf({ id: 'r_d', notifyAt: now + MINUTE, startAt: now + 10 * MINUTE }),
    );
    const result = await reminderService.reconcile(now);
    expect(result).toMatchObject({ checked: 1, fired: 0, missed: 0 });
    expect((await reminderService.get('r_d'))?.state).toBe('scheduled');
  });

  it('已 cancelled / fired 的终态不被改写', async () => {
    const now = Date.now();
    await reminderRepo.save(reminderOf({ id: 'r_e', state: 'fired', startAt: now - 60 * MINUTE }));
    await reminderService.reconcile(now);
    expect((await reminderService.get('r_e'))?.state).toBe('fired');
  });

  it('空库对账返回全 0（不抛错）', async () => {
    const result = await reminderService.reconcile(Date.now());
    expect(result).toMatchObject({ checked: 0, fired: 0, missed: 0, rescheduled: 0 });
  });

  it('Web 环境（无通知权限）不尝试补排原生通知', async () => {
    const now = Date.now();
    await reminderRepo.save(
      reminderOf({ id: 'r_f', notifyAt: now + MINUTE, startAt: now + 10 * MINUTE }),
    );
    const result = await reminderService.reconcile(now);
    expect(result.rescheduled).toBe(0);
  });
});

describe('reminderService 查询与批量取消', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('findFor 只返回非终态提醒', async () => {
    const now = Date.now();
    const id = reminderIdOf(CHANNEL_KEY, now + 60 * MINUTE);
    await reminderRepo.save(
      reminderOf({ id, startAt: now + 60 * MINUTE, notifyAt: now + 55 * MINUTE }),
    );
    expect((await reminderService.findFor(CHANNEL_KEY, now + 60 * MINUTE))?.id).toBe(id);
    await reminderRepo.save(reminderOf({ id, state: 'cancelled' }));
    expect(await reminderService.findFor(CHANNEL_KEY, now + 60 * MINUTE)).toBeNull();
  });

  it('cancelByChannel 清掉该频道全部提醒，返回数量', async () => {
    const now = Date.now();
    await reminderRepo.saveMany([
      reminderOf({ id: 'r_1', startAt: now + MINUTE, notifyAt: now }),
      reminderOf({ id: 'r_2', startAt: now + 2 * MINUTE, notifyAt: now }),
      reminderOf({ id: 'r_3', channelKey: 'nm:other', startAt: now + 3 * MINUTE, notifyAt: now }),
    ]);
    expect(await reminderService.cancelByChannel(CHANNEL_KEY)).toEqual({ canceled: 2 });
    expect((await reminderService.list()).reminders.map((r) => r.id)).toEqual(['r_3']);
  });

  it('直播源删除时 cancelBySource 级联清理', async () => {
    const now = Date.now();
    await reminderRepo.saveMany([
      reminderOf({ id: 'r_1', liveSourceId: 'live-a', startAt: now + MINUTE, notifyAt: now }),
      reminderOf({ id: 'r_2', liveSourceId: 'live-b', startAt: now + MINUTE, notifyAt: now }),
    ]);
    expect(await reminderService.cancelBySource('live-a')).toEqual({ canceled: 1 });
    expect((await reminderService.list()).reminders.map((r) => r.id)).toEqual(['r_2']);
  });

  it('EPG 源被移除的提醒标记 orphanEpgSource（节目单源已移除）', async () => {
    await epgSourceRepo.save({
      id: 'epg-builtin',
      name: '内置默认源',
      endpoint: 'https://epg.example.com',
      protocol: 'auto',
      matchMode: 'auto',
      priority: 1,
      enabled: true,
      builtin: true,
      lastProbeAt: null,
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const now = Date.now();
    await reminderRepo.saveMany([
      reminderOf({ id: 'r_ok', epgSourceId: 'epg-builtin', startAt: now + MINUTE, notifyAt: now }),
      reminderOf({ id: 'r_orphan', epgSourceId: 'epg_gone', startAt: now + MINUTE, notifyAt: now }),
    ]);
    const { reminders } = await reminderService.list();
    const orphan = reminders.find((r) => r.id === 'r_orphan');
    const ok = reminders.find((r) => r.id === 'r_ok');
    expect(orphan?.orphanEpgSource).toBe(true);
    expect(orphan?.epgSourceId).toBeNull();
    expect(ok?.orphanEpgSource).toBeUndefined();
    expect(ok?.epgSourceId).toBe('epg-builtin');
  });

  it('list 支持按状态与 notifyAt 起点的最小过滤', async () => {
    const now = Date.now();
    await reminderRepo.saveMany([
      reminderOf({ id: 'r_1', state: 'scheduled', notifyAt: now + MINUTE }),
      reminderOf({ id: 'r_2', state: 'fired', notifyAt: now + 2 * MINUTE }),
    ]);
    expect((await reminderService.list({ state: 'fired' })).reminders.map((r) => r.id)).toEqual([
      'r_2',
    ]);
    expect(
      (await reminderService.list({ from: now + 90 * 1000 })).reminders.map((r) => r.id),
    ).toEqual(['r_2']);
  });
});
