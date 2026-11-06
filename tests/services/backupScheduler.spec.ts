/**
 * 定时备份调度纯函数单测（EXT-05 phase1）
 *
 * 覆盖：调度参数归一化、下次/上次触发时间（每天 / 每周，含"刚好到点"边界）、
 * 补执行判定（lastScheduledAt 口径）、文案、版本保留计算与受管理文件命名。
 *
 * 时间全部用"本地时区构造的固定日期"，避免 CI 时区差异导致用例飘。
 * 基准时间：2026-11-06（周五）10:30。
 */
import { describe, expect, it } from 'vitest';

import {
  backupFileNameOf,
  defaultBackupSettings,
  isManagedBackupName,
  pruneBackupRecords,
  timestampFromBackupName,
  BACKUP_RETENTION_DEFAULT,
  BACKUP_RETENTION_MAX,
} from '@/services/backupService';
import {
  describeNextRun,
  describeSchedule,
  isBackupDue,
  nextRunAt,
  normalizeSchedule,
  previousRunAt,
  SCHEDULER_TICK_MS,
  type ScheduleLike,
} from '@/services/backupScheduler';
import type { BackupRecord, BackupScheduleMode } from '@/types';

/** 本地时区构造（月份从 1 开始，便于对照日历） */
function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

const FRI_1030 = at(2026, 11, 6, 10, 30); // 周五 10:30
const daily3: ScheduleLike = { scheduleMode: 'daily', scheduleHour: 3, scheduleWeekday: 1 };
const weekly1: ScheduleLike = { scheduleMode: 'weekly', scheduleHour: 3, scheduleWeekday: 1 };
const weekly5: ScheduleLike = { scheduleMode: 'weekly', scheduleHour: 3, scheduleWeekday: 5 };

function makeRecord(
  id: string,
  timestamp: number,
  location: BackupRecord['location'] = 'local',
): BackupRecord {
  return {
    id,
    timestamp,
    size: 1024,
    source: 'scheduled',
    encrypted: false,
    path: `backups/${id}.json`,
    location,
    fileName: `${id}.json`,
  };
}

describe('normalizeSchedule', () => {
  it('空值回落到「关闭 / 03:00 / 周一」', () => {
    expect(normalizeSchedule(null)).toEqual({
      scheduleMode: 'off',
      scheduleHour: 3,
      scheduleWeekday: 1,
    });
    expect(normalizeSchedule(undefined).scheduleMode).toBe('off');
  });

  it('小时收敛到 0-23，星期收敛到 1-7', () => {
    expect(normalizeSchedule({ scheduleMode: 'daily', scheduleHour: -5, scheduleWeekday: 0 })).toEqual({
      scheduleMode: 'daily',
      scheduleHour: 0,
      scheduleWeekday: 1,
    });
    expect(normalizeSchedule({ scheduleMode: 'daily', scheduleHour: 99, scheduleWeekday: 9 })).toEqual({
      scheduleMode: 'daily',
      scheduleHour: 23,
      scheduleWeekday: 7,
    });
  });

  it('小时取整、非法数字回落默认，未知模式按关闭处理', () => {
    const s = normalizeSchedule({
      scheduleMode: 'hourly' as BackupScheduleMode,
      scheduleHour: Number.NaN,
      scheduleWeekday: 3.7,
    });
    expect(s.scheduleMode).toBe('off');
    expect(s.scheduleHour).toBe(3);
    expect(s.scheduleWeekday).toBe(3);
  });
});

describe('nextRunAt', () => {
  it('关闭时返回 null', () => {
    expect(nextRunAt({ scheduleMode: 'off', scheduleHour: 3, scheduleWeekday: 1 }, FRI_1030)).toBeNull();
  });

  it('每天：当天时间未到 → 今天；已过 → 明天', () => {
    expect(nextRunAt({ ...daily3, scheduleHour: 12 }, FRI_1030)).toBe(at(2026, 11, 6, 12));
    expect(nextRunAt(daily3, FRI_1030)).toBe(at(2026, 11, 7, 3));
  });

  it('每天：恰好到点算「已过」，顺延到明天（严格大于 from）', () => {
    expect(nextRunAt(daily3, at(2026, 11, 6, 3))).toBe(at(2026, 11, 7, 3));
  });

  it('每周：跨周计算（周五 → 下周一）', () => {
    expect(nextRunAt(weekly1, FRI_1030)).toBe(at(2026, 11, 9, 3));
  });

  it('每周：当天就是目标星期但时间已过 → 下周同日', () => {
    expect(nextRunAt(weekly5, FRI_1030)).toBe(at(2026, 11, 13, 3));
    expect(nextRunAt({ ...weekly5, scheduleHour: 12 }, FRI_1030)).toBe(at(2026, 11, 6, 12));
  });

  it('每周日（7）映射到 JS getDay() 的 0', () => {
    const weekly7: ScheduleLike = { scheduleMode: 'weekly', scheduleHour: 3, scheduleWeekday: 7 };
    // 2026-11-06 周五 → 最近的周日是 11-08
    expect(nextRunAt(weekly7, FRI_1030)).toBe(at(2026, 11, 8, 3));
  });
});

describe('previousRunAt', () => {
  it('关闭时返回 null', () => {
    expect(previousRunAt({ scheduleMode: 'off', scheduleHour: 3, scheduleWeekday: 1 }, FRI_1030)).toBeNull();
  });

  it('每天：当天已过 → 今天；未到 → 昨天', () => {
    expect(previousRunAt(daily3, FRI_1030)).toBe(at(2026, 11, 6, 3));
    expect(previousRunAt({ ...daily3, scheduleHour: 12 }, FRI_1030)).toBe(at(2026, 11, 5, 12));
  });

  it('每天：恰好到点算「已触发」（≤ from）', () => {
    expect(previousRunAt(daily3, at(2026, 11, 6, 3))).toBe(at(2026, 11, 6, 3));
  });

  it('每周：回退到最近的周一 / 本周五', () => {
    expect(previousRunAt(weekly1, FRI_1030)).toBe(at(2026, 11, 2, 3));
    expect(previousRunAt(weekly5, FRI_1030)).toBe(at(2026, 11, 6, 3));
  });
});

describe('isBackupDue', () => {
  it('关闭时永远不到期', () => {
    expect(isBackupDue({ scheduleMode: 'off', scheduleHour: 3, scheduleWeekday: 1 }, null, FRI_1030)).toBe(
      false,
    );
  });

  it('从未执行过（null）且有历史计划点 → 到期补跑', () => {
    expect(isBackupDue(daily3, null, FRI_1030)).toBe(true);
    expect(isBackupDue(weekly1, undefined, FRI_1030)).toBe(true);
  });

  it('本轮计划点已执行过 → 不到期', () => {
    expect(isBackupDue(daily3, at(2026, 11, 6, 3), FRI_1030)).toBe(false);
    expect(isBackupDue(weekly1, at(2026, 11, 2, 3), FRI_1030)).toBe(false);
    // 周五 03:00 之后才开启（lastScheduledAt = 启用时刻）→ 今晚不该再补
    expect(isBackupDue(weekly5, at(2026, 11, 6, 4), FRI_1030)).toBe(false);
  });

  it('上次执行早于本轮计划点 → 到期（跨天 / 跨周漏跑）', () => {
    expect(isBackupDue(daily3, at(2026, 11, 5, 3), FRI_1030)).toBe(true);
    expect(isBackupDue(weekly1, at(2026, 10, 26, 3), FRI_1030)).toBe(true);
    expect(isBackupDue(weekly5, at(2026, 11, 2, 3), FRI_1030)).toBe(true);
  });

  it('上次执行时间在未来（时钟回拨）→ 不到期', () => {
    expect(isBackupDue(daily3, at(2026, 11, 7, 3), FRI_1030)).toBe(false);
  });
});

describe('describeSchedule / describeNextRun', () => {
  it('计划文案', () => {
    expect(describeSchedule({ scheduleMode: 'off', scheduleHour: 3, scheduleWeekday: 1 })).toBe('已关闭');
    expect(describeSchedule(daily3)).toBe('每天 03:00');
    expect(describeSchedule(weekly1)).toBe('每周一 03:00');
    expect(describeSchedule({ scheduleMode: 'weekly', scheduleHour: 0, scheduleWeekday: 3 })).toBe(
      '每周三 00:00',
    );
  });

  it('倒计时文案：今天 / 明天 / 具体日期', () => {
    expect(describeNextRun({ scheduleMode: 'off', scheduleHour: 3, scheduleWeekday: 1 }, FRI_1030)).toBe(
      '已关闭',
    );
    expect(describeNextRun({ ...daily3, scheduleHour: 12 }, FRI_1030)).toBe('今天 12:00');
    expect(describeNextRun(daily3, FRI_1030)).toBe('明天 03:00');
    expect(describeNextRun(weekly1, FRI_1030)).toBe('11-09 03:00');
    expect(describeNextRun({ scheduleMode: 'weekly', scheduleHour: 0, scheduleWeekday: 7 }, FRI_1030)).toBe(
      '11-08 00:00',
    );
  });
});

describe('备份文件命名', () => {
  it('按 YYYYMMDD_HHmmss 生成，加密时扩展名为 .enc', () => {
    const ts = at(2026, 1, 6, 7) + 8 * 60_000 + 9_000; // 07:08:09
    expect(backupFileNameOf(ts, false)).toBe('backup_20260106_070809.json');
    expect(backupFileNameOf(ts, true)).toBe('backup_20260106_070809.enc');
  });

  it('文件名可反解回时间戳（秒级）', () => {
    const ts = at(2026, 11, 6, 3, 15);
    const name = backupFileNameOf(ts, true);
    expect(timestampFromBackupName(name)).toBe(ts);
  });

  it('非受管理命名不反解、不参与版本保留', () => {
    expect(timestampFromBackupName('peanutmov-backup-20261106.json')).toBeNull();
    expect(timestampFromBackupName('backup_20261106.json')).toBeNull();
    expect(timestampFromBackupName('backup_2026-11-06_030000.json')).toBeNull();

    expect(isManagedBackupName('backup_20261106_030000.json')).toBe(true);
    expect(isManagedBackupName('backup_20261106_030000.enc')).toBe(true);
    expect(isManagedBackupName('peanutmov-backup-20261106.json')).toBe(false);
    expect(isManagedBackupName('backup_20261106_030000.txt')).toBe(false);
  });
});

describe('pruneBackupRecords（版本保留）', () => {
  it('按时间倒序保留最近 N 份，其余进入 removed', () => {
    const records = [
      makeRecord('a', at(2026, 11, 1, 3)),
      makeRecord('b', at(2026, 11, 2, 3)),
      makeRecord('c', at(2026, 11, 3, 3)),
      makeRecord('d', at(2026, 11, 4, 3)),
    ];
    const { kept, removed } = pruneBackupRecords(records, 2);
    expect(kept.map((r) => r.id).sort()).toEqual(['c', 'd']);
    expect(removed.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('keep 越界时收敛到 [1, 20]', () => {
    const records = [makeRecord('a', 1), makeRecord('b', 2)];
    // keep=0 视为非法值 → 回落默认 5，全部保留
    expect(pruneBackupRecords(records, 0).removed).toHaveLength(0);
    // keep=-3 同理归一化到下限 1
    expect(pruneBackupRecords(records, -3).kept).toHaveLength(1);
    expect(pruneBackupRecords(records, 999).kept).toHaveLength(2);
  });

  it('指定 location 时只清理该位置，其它位置原样保留', () => {
    const records = [
      makeRecord('l1', at(2026, 11, 1, 3), 'local'),
      makeRecord('l2', at(2026, 11, 2, 3), 'local'),
      makeRecord('l3', at(2026, 11, 3, 3), 'local'),
      makeRecord('w1', at(2026, 11, 4, 3), 'webdav'),
      makeRecord('w2', at(2026, 11, 5, 3), 'webdav'),
    ];
    const { kept, removed } = pruneBackupRecords(records, 1, 'local');
    expect(kept.map((r) => r.id).sort()).toEqual(['l3', 'w1', 'w2']);
    expect(removed.map((r) => r.id).sort()).toEqual(['l1', 'l2']);
  });

  it('保留数量边界常量与默认值符合需求（1-20，默认 5）', () => {
    expect(BACKUP_RETENTION_DEFAULT).toBe(5);
    expect(BACKUP_RETENTION_MAX).toBe(20);
    expect(SCHEDULER_TICK_MS).toBe(60_000);
  });
});

describe('defaultBackupSettings', () => {
  it('默认关闭定时、每天 3 点、保留 5 份、不加密、无时间戳', () => {
    expect(defaultBackupSettings()).toEqual({
      scheduleMode: 'off',
      scheduleHour: 3,
      scheduleWeekday: 1,
      retentionCount: BACKUP_RETENTION_DEFAULT,
      encryptionEnabled: false,
      encryptionSalt: null,
      encryptionVerifier: null,
      lastScheduledAt: null,
      lastBackupAt: null,
      lastError: null,
    });
  });

  it('每次返回独立对象（避免调用方改动污染默认值）', () => {
    const a = defaultBackupSettings();
    a.retentionCount = 9;
    expect(defaultBackupSettings().retentionCount).toBe(BACKUP_RETENTION_DEFAULT);
  });
});
