import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import { backupService } from '@/services/backupService';
import { settingsService } from '@/services/settingsService';
import { KV_KEY_IMPORT_RECORDS, KV_KEY_SETTINGS } from '@/shared/constants';
import type { AppSettings, BackupFile } from '@/types';

import { resetAll } from './helpers';

/**
 * 第二轮 / 项 5：备份要带走全部设置与散装用户数据
 *
 * 缺陷一：`collectBackup` 导出整个 `AppSettings`，`importData` 却只恢复手写的 8 个键，
 * 于是 WebDAV 云备份地址、网盘画质、弹幕、定时备份、搜索预算这些"备份里明明有"
 * 的配置，换机后一律回到默认 —— 用户看到"（含设置）"却什么都没回来。
 *
 * 缺陷二：订阅导入记录与弹幕点赞按 key 散放在 `kv` 表里，备份完全不带。
 * 现在走 `kvEntries`，并且导出/导入**共用白名单**：`kv` 里同时躺着
 * `app-settings` 与 `backup-encryption-key`，照单全收等于把恢复变成任意键写入通道。
 */

async function exportBackup(includeCredentials = true): Promise<BackupFile> {
  const blob = await backupService.exportData({ includeCredentials });
  return JSON.parse(await blob.text()) as BackupFile;
}

describe('备份纳入全部设置与 kv 用户数据', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('白名单外的设置项导出后还能原样回来（不再只恢复 8 个键）', async () => {
    await settingsService.update({
      webdav: { serverUrl: 'https://dav.example.com', username: 'u', password: 'p', backupPath: '/bm' },
      netdisk: { quality: '1080P', threadCount: 4 },
      danmaku: { enabled: true, fontSize: 20, merge: false },
      searchBudget: 'fast',
      smartPreloadEnabled: true,
      backgroundLineProbeEnabled: false,
      pauseHistoryRecording: true,
      showRecommendedSubscriptions: false,
      backup: { scheduleMode: 'daily', retentionCount: 9 },
    });
    const backup = await exportBackup();

    await settingsService.reset();
    expect((await settingsService.get()).searchBudget).toBe('standard');

    const report = await backupService.importData(backup, 'merge');
    const got = await settingsService.get();

    expect(report.settingsRestored).toBe(true);
    expect(got.webdav?.serverUrl).toBe('https://dav.example.com');
    expect(got.netdisk?.quality).toBe('1080P');
    expect(got.danmaku?.fontSize).toBe(20);
    expect(got.searchBudget).toBe('fast');
    expect(got.smartPreloadEnabled).toBe(true);
    expect(got.backgroundLineProbeEnabled).toBe(false);
    expect(got.pauseHistoryRecording).toBe(true);
    expect(got.showRecommendedSubscriptions).toBe(false);
    expect(got.backup?.scheduleMode).toBe('daily');
    expect(got.backup?.retentionCount).toBe(9);
  });

  it('schemaVersion 与 updatedAt 由设置服务自己维护，不被备份里的旧值盖掉', async () => {
    const backup = await exportBackup();
    const stale = { ...backup.settings, schemaVersion: 1, updatedAt: 1 } as unknown as AppSettings;
    await backupService.importData({ ...backup, settings: stale }, 'merge');

    const got = await settingsService.get();
    expect(got.schemaVersion).toBe(3);
    expect(got.updatedAt).toBeGreaterThan(1);
  });

  it('不含凭据时设置里的 WebDAV 密码与加密校验串一起脱敏', async () => {
    await settingsService.update({
      webdav: { serverUrl: 'https://dav.example.com', username: 'u', password: 'secret-dav', backupPath: '/bm' },
      backup: { encryptionEnabled: true, encryptionSalt: 'c2FsdA==', encryptionVerifier: 'dmVyaWZpZXI=' },
    });

    const maskedJson = JSON.stringify(await exportBackup(false));
    expect(maskedJson).not.toContain('secret-dav');
    expect(maskedJson).not.toContain('c2FsdA==');
    expect(maskedJson).not.toContain('dmVyaWZpZXI=');

    expect(JSON.stringify(await exportBackup(true))).toContain('secret-dav');
  });

  it('kv 用户数据随备份带走并在导入后落回原键', async () => {
    const records = [{ url: 'https://sub.example.com/a.json', name: '订阅 A', importedAt: 5, success: 3 }];
    await kvRepo.set(KV_KEY_IMPORT_RECORDS, records);
    await kvRepo.set('danmakuLikes:m1#1', { '1.0:abc': 1 });
    // 非白名单键：既不该被带走，也不该被带回来
    await kvRepo.set('danmaku-unrelated-cache', { nope: true });

    const backup = await exportBackup();
    expect(backup.kvEntries.map((entry) => entry.key).sort()).toEqual([
      'danmakuLikes:m1#1',
      KV_KEY_IMPORT_RECORDS,
    ]);

    await kvRepo.delete(KV_KEY_IMPORT_RECORDS);
    await kvRepo.delete('danmakuLikes:m1#1');
    expect(await kvRepo.get(KV_KEY_IMPORT_RECORDS)).toBeNull();

    const report = await backupService.importData(backup, 'merge');
    expect(report.kvEntries).toBe(2);
    expect(await kvRepo.get(KV_KEY_IMPORT_RECORDS)).toEqual(records);
    expect(await kvRepo.get('danmakuLikes:m1#1')).toEqual({ '1.0:abc': 1 });
    // 白名单外的既有键不受影响
    expect(await kvRepo.get('danmaku-unrelated-cache')).toEqual({ nope: true });
  });

  it('导入侧同样过白名单：伪造的 kvEntries 盖不掉 app-settings', async () => {
    const before = await settingsService.get();
    const backup = await exportBackup();
    const poisoned = {
      ...backup,
      kvEntries: [
        { key: KV_KEY_SETTINGS, value: { ...before, theme: 'light' } },
        { key: 'backup-encryption-key', value: 'attacker-key' },
        { key: 'danmakuLikes:ok#1', value: { '2.0:def': 1 } },
      ],
    };

    await backupService.importData(poisoned, 'merge');

    expect((await settingsService.get()).theme).toBe(before.theme);
    expect(await kvRepo.get('backup-encryption-key')).toBeNull();
    expect(await kvRepo.get('danmakuLikes:ok#1')).toEqual({ '2.0:def': 1 });
  });

  it('v2 及更早的备份没有 kvEntries：归一化为空且能正常导入', async () => {
    const backup = await exportBackup();
    const legacy = { ...backup, schemaVersion: 2 } as unknown as BackupFile;
    delete (legacy as Partial<BackupFile>).kvEntries;

    const report = await backupService.importData(legacy, 'merge');
    expect(report.kvEntries).toBe(0);
  });

  it('overwrite 只清白名单内的 kv 键，设置与备份自身元数据不受牵连', async () => {
    const backup = await exportBackup();
    // 备份之后本机新增的分桶：overwrite 语义下应被备份内容取代（即被删除）
    await kvRepo.set('danmakuLikes:old#1', { '3.0:ghi': 1 });
    await kvRepo.set('backup-index', [{ id: 'keep-me' }]);
    await kvRepo.set(KV_KEY_IMPORT_RECORDS, [{ url: 'https://x', name: 'x', importedAt: 1, success: 0 }]);

    await backupService.importData(backup, 'overwrite');

    expect(await kvRepo.get('danmakuLikes:old#1')).toBeNull();
    expect(await kvRepo.get('backup-index')).toEqual([{ id: 'keep-me' }]);
    expect(await kvRepo.get(KV_KEY_SETTINGS)).not.toBeNull();
  });
});
