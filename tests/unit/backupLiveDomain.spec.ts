import { beforeEach, describe, expect, it } from 'vitest';

import { backupService, normalizeBackupFile, summarizeBackup } from '@/services/backupService';
import { channelPrefsRepo } from '@/db/repositories/channelPrefsRepo';
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { liveRepo } from '@/db/repositories/liveRepo';
import { reminderRepo } from '@/db/repositories/reminderRepo';
import { BUILTIN_EPG_SOURCE_ID } from '@/shared/constants';
import type { BackupFile, ChannelPrefs, EpgSource, LiveRecord, Reminder } from '@/types';

import { resetAll } from './helpers';

/**
 * 备份纳入直播域（A5）
 *
 * 缺陷：备份只覆盖 sources/favorites/history/settings/downloads，
 * `lives` / `epgSources` / `channelPrefs` / `reminders` 四张表完全不在范围内，
 * 换机或重装后直播源、EPG 源、分组排序、节目提醒全部丢失。
 *
 * 关键契约：
 * - v1 备份（无四字段）仍可导入，四表计数为 0；
 * - overwrite 不得清掉内置 EPG 源（由 DB 迁移一次性种入，清空后不会重建）；
 * - 提醒终态原样保留，避免换机后重复提醒。
 */

const NOW = 1_700_000_000_000;

function makeLive(overrides: Partial<LiveRecord> = {}): LiveRecord {
  return {
    id: 'live-1',
    name: '测试直播源',
    url: 'https://example.com/list.m3u?token=SECRET-TOKEN',
    format: 'm3u',
    channelCount: 120,
    subscriptionId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeEpgSource(overrides: Partial<EpgSource> = {}): EpgSource {
  return {
    id: 'epg-user-1',
    name: '用户 EPG 源',
    endpoint: 'https://epg.example.com/api?api_key=SECRET',
    protocol: 'diyp',
    matchMode: 'auto',
    priority: 2,
    enabled: true,
    builtin: false,
    lastProbeAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePrefs(overrides: Partial<ChannelPrefs> = {}): ChannelPrefs {
  return {
    liveSourceId: 'live-1',
    groups: [{ id: 'g1', name: '常看', order: 0, createdAt: NOW }],
    assignments: { 'nm:CCTV1': 'g1' },
    orders: { all: ['nm:CCTV1', 'nm:CCTV5'] },
    updatedAt: NOW,
    ...overrides,
  };
}

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'r_1',
    liveSourceId: 'live-1',
    epgSourceId: null,
    channelKey: 'nm:CCTV1',
    channelName: 'CCTV1',
    programmeKey: 'p1',
    programmeTitle: '新闻联播',
    startAt: NOW + 3_600_000,
    endAt: NOW + 5_400_000,
    leadMinutes: 5,
    notifyAt: NOW + 3_300_000,
    state: 'scheduled',
    nativeId: 12345,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function seedLiveDomain(): Promise<void> {
  await liveRepo.save(makeLive());
  await epgSourceRepo.save(makeEpgSource());
  await channelPrefsRepo.save(makePrefs());
  await reminderRepo.save(makeReminder());
}

describe('备份导出直播域四表（A5）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('导出包含 lives / epgSources / channelPrefs / reminders', async () => {
    await seedLiveDomain();

    const blob = await backupService.exportData({ includeCredentials: true });
    const json = JSON.parse(await blob.text()) as BackupFile;

    expect(json.schemaVersion).toBe(2);
    expect(json.lives).toHaveLength(1);
    expect(json.lives[0]?.name).toBe('测试直播源');
    // 内置源也在 epgSources 表里，一并导出
    expect(json.epgSources.map((s) => s.id)).toContain('epg-user-1');
    expect(json.epgSources.map((s) => s.id)).toContain(BUILTIN_EPG_SOURCE_ID);
    expect(json.channelPrefs).toHaveLength(1);
    expect(json.channelPrefs[0]?.orders['all']).toEqual(['nm:CCTV1', 'nm:CCTV5']);
    expect(json.reminders).toHaveLength(1);
    expect(json.reminders[0]?.programmeTitle).toBe('新闻联播');
  });

  it('默认脱敏直播源地址与 EPG 端点上的凭据', async () => {
    await seedLiveDomain();

    const blob = await backupService.exportData({ includeCredentials: false });
    const json = JSON.parse(await blob.text()) as BackupFile;

    expect(json.lives[0]?.url).not.toContain('SECRET-TOKEN');
    const userEpg = json.epgSources.find((s) => s.id === 'epg-user-1');
    expect(userEpg?.endpoint).not.toContain('SECRET');
  });

  it('summarizeBackup 给出直播域计数', async () => {
    await seedLiveDomain();
    const blob = await backupService.exportData({ includeCredentials: true });
    const summary = summarizeBackup(JSON.parse(await blob.text()) as BackupFile);

    expect(summary.lives).toBe(1);
    expect(summary.channelPrefs).toBe(1);
    expect(summary.reminders).toBe(1);
    expect(summary.epgSources).toBeGreaterThanOrEqual(1);
  });
});

describe('备份导入直播域四表（A5）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('round-trip：导出 → 清库 → 导入，四表数据回来', async () => {
    // 用未来时间：过期提醒会被导入后的 reconcile 正确判为 missed，
    // 这里要验的是"未到期提醒原样恢复"，故避开过期分支。
    const future = Date.now() + 86_400_000;
    await seedLiveDomain();
    await reminderRepo.save(
      makeReminder({ startAt: future, endAt: future + 1_800_000, notifyAt: future - 300_000 }),
    );
    const blob = await backupService.exportData({ includeCredentials: true });
    const parsed = normalizeBackupFile(JSON.parse(await blob.text()));

    await liveRepo.remove('live-1');
    await epgSourceRepo.remove('epg-user-1');
    await channelPrefsRepo.remove('live-1');
    await reminderRepo.remove('r_1');
    expect(await liveRepo.list()).toHaveLength(0);

    const report = await backupService.importData(parsed, 'merge');

    expect(report.lives).toBe(1);
    expect(report.channelPrefs).toBe(1);
    expect(report.reminders).toBe(1);
    expect((await liveRepo.get('live-1'))?.name).toBe('测试直播源');
    expect((await channelPrefsRepo.get('live-1'))?.assignments['nm:CCTV1']).toBe('g1');
    expect((await reminderRepo.get('r_1'))?.state).toBe('scheduled');
    expect((await epgSourceRepo.get('epg-user-1'))?.name).toBe('用户 EPG 源');
  });

  it('v1 备份（无直播域字段）可导入，四表计数为 0 且不报错', async () => {
    const v1 = {
      schemaVersion: 1,
      appVersion: '0.0.9',
      exportedAt: NOW,
      sources: [],
      favorites: [],
      history: [],
      settings: null,
      downloads: [],
    };
    const normalized = normalizeBackupFile(v1);

    expect(normalized.lives).toEqual([]);
    expect(normalized.epgSources).toEqual([]);
    expect(normalized.channelPrefs).toEqual([]);
    expect(normalized.reminders).toEqual([]);

    const report = await backupService.importData(normalized, 'overwrite');
    expect(report.lives).toBe(0);
    expect(report.reminders).toBe(0);
  });

  it('overwrite 保留内置 EPG 源（清空后迁移不会重建）', async () => {
    await epgSourceRepo.save(makeEpgSource());
    const v1 = normalizeBackupFile({
      schemaVersion: 1,
      appVersion: '0.0.9',
      exportedAt: NOW,
      sources: [],
      favorites: [],
      history: [],
      settings: null,
      downloads: [],
    });

    await backupService.importData(v1, 'overwrite');

    const remaining = await epgSourceRepo.list();
    expect(remaining.map((s) => s.id)).toContain(BUILTIN_EPG_SOURCE_ID);
    expect(remaining.map((s) => s.id)).not.toContain('epg-user-1');
  });

  it('overwrite 清掉旧的直播源/分组/提醒，再写入备份内容', async () => {
    await liveRepo.save(makeLive({ id: 'old-live', name: '旧源' }));
    await channelPrefsRepo.save(makePrefs({ liveSourceId: 'old-live' }));
    await reminderRepo.save(makeReminder({ id: 'r_old', liveSourceId: 'old-live' }));

    await seedLiveDomain();
    const blob = await backupService.exportData({ includeCredentials: true });
    const parsed = normalizeBackupFile(JSON.parse(await blob.text()));

    // 备份里已含 old-live，先删掉它模拟"备份来自另一台设备"
    parsed.lives = parsed.lives.filter((l) => l.id !== 'old-live');
    parsed.channelPrefs = parsed.channelPrefs.filter((p) => p.liveSourceId !== 'old-live');
    parsed.reminders = parsed.reminders.filter((r) => r.id !== 'r_old');

    await backupService.importData(parsed, 'overwrite');

    expect(await liveRepo.get('old-live')).toBeNull();
    expect(await channelPrefsRepo.get('old-live')).toBeNull();
    expect(await reminderRepo.get('r_old')).toBeNull();
    expect((await liveRepo.get('live-1'))?.name).toBe('测试直播源');
  });

  it('merge 不清空既有直播源', async () => {
    await liveRepo.save(makeLive({ id: 'keep-live', name: '本机已有' }));
    const parsed = normalizeBackupFile({
      schemaVersion: 2,
      appVersion: 'test',
      exportedAt: NOW,
      sources: [],
      favorites: [],
      history: [],
      settings: null,
      downloads: [],
      lives: [makeLive({ id: 'new-live', name: '备份带来' })],
      epgSources: [],
      channelPrefs: [],
      reminders: [],
    });

    await backupService.importData(parsed, 'merge');

    expect((await liveRepo.get('keep-live'))?.name).toBe('本机已有');
    expect((await liveRepo.get('new-live'))?.name).toBe('备份带来');
  });

  it('提醒终态原样保留，不在换机后重复提醒', async () => {
    const parsed = normalizeBackupFile({
      schemaVersion: 2,
      appVersion: 'test',
      exportedAt: NOW,
      sources: [],
      favorites: [],
      history: [],
      settings: null,
      downloads: [],
      lives: [],
      epgSources: [],
      channelPrefs: [],
      reminders: [
        makeReminder({ id: 'r_fired', state: 'fired' }),
        makeReminder({ id: 'r_cancelled', state: 'cancelled' }),
      ],
    });

    await backupService.importData(parsed, 'merge');

    expect((await reminderRepo.get('r_fired'))?.state).toBe('fired');
    expect((await reminderRepo.get('r_cancelled'))?.state).toBe('cancelled');
  });

  it('丢弃缺关键字段的非法条目，不污染四表', async () => {
    const normalized = normalizeBackupFile({
      schemaVersion: 2,
      appVersion: 'test',
      exportedAt: NOW,
      sources: [],
      favorites: [],
      history: [],
      settings: null,
      downloads: [],
      lives: [{ id: 'no-url' }, makeLive()],
      epgSources: [{ id: 'no-endpoint' }, makeEpgSource()],
      channelPrefs: [{ groups: [] }, makePrefs()],
      reminders: [{ id: 'no-time' }, makeReminder()],
    });

    expect(normalized.lives).toHaveLength(1);
    expect(normalized.epgSources).toHaveLength(1);
    expect(normalized.channelPrefs).toHaveLength(1);
    expect(normalized.reminders).toHaveLength(1);
  });
});