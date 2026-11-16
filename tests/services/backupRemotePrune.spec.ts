import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OPT-19：WebDAV 上传后的远端保留收敛
 *
 * 收敛原语 `pruneBackupRecords` 只看本机 KV 索引：换设备、重装或索引被清之后，
 * 服务器上那批 `backup_*.json` 就成了没人认领的孤儿——「保留 N 份」形同虚设。
 * 这里验证 `runBackup` 在 webdav 上传成功后按**目录实际内容**再收一次口，
 * 以及边界：只动可反解时间戳的命名、列目录失败时一票不删、本地备份不扫描远端。
 */

let remoteFiles: string[] = [];
let remoteHasOwnBackup = false;
const deleted: string[] = [];
const listingErrors: unknown[] = [];

vi.mock('@/services/webdavService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/webdavService')>();

  class FakeWebDAVClient {
    private dir: string;

    constructor(config: { serverUrl: string; backupPath: string }) {
      this.dir = config.backupPath;
    }

    async testConnection() {
      return true;
    }

    async ensureDirectory() {}

    async listDirectory() {
      const err = listingErrors.shift();
      if (err) throw err;
      return remoteFiles.map((name) => ({
        href: `${this.dir}/${name}`,
        name,
        size: 10,
        lastModified: 0,
        isDirectory: false,
      }));
    }

    async uploadFile(remotePath: string) {
      // 本次备份也要出现在目录清单里，否则「保留最新 N 份」无从比较
      if (remoteHasOwnBackup) remoteFiles = [...remoteFiles, remotePath.split('/').pop() ?? ''];
    }

    async deleteFile(url: string) {
      deleted.push(decodeURIComponent(url.split('/').pop() ?? ''));
    }
  }

  return { ...actual, WebDAVClient: FakeWebDAVClient };
});

import { backupService } from '@/services/backupService';
import { settingsService } from '@/services/settingsService';
import { resetAll } from '../unit/helpers';

/** WebDAV 配置 + 保留份数；远端只该留下最新的 N 个文件 */
async function enableWebdav(dir: string, retentionCount = 1): Promise<void> {
  await settingsService.update({
    webdav: { serverUrl: `https://dav.example/${dir}`, username: 'u', password: 'p', backupPath: `/${dir}` },
    backup: { retentionCount },
  });
}

function runWebdavBackup(): Promise<unknown> {
  return backupService.runBackup({ source: 'manual', local: false, webdav: true });
}

const ORPHANS = ['backup_20260101_100000.json', 'backup_20260101_100100.json', 'backup_20260101_100200.json'];

describe('OPT-19 远端备份保留收敛', () => {
  beforeEach(async () => {
    await resetAll();
    deleted.length = 0;
    listingErrors.length = 0;
    remoteHasOwnBackup = false;
    remoteFiles = [];
  });

  it('索引之外的孤儿包全部删除，只留本次上传的最新一份', async () => {
    await enableWebdav('a');
    // 本机索引是空的（换设备 / 重装），但目录里躺着 3 份旧包
    remoteFiles = [...ORPHANS];
    remoteHasOwnBackup = true;

    await runWebdavBackup();

    expect([...deleted].sort()).toEqual([...ORPHANS].sort());
  });

  it('保留份数内的最新文件不动', async () => {
    await enableWebdav('b', 2);
    remoteFiles = [...ORPHANS];
    remoteHasOwnBackup = true;

    await runWebdavBackup();

    // 4 份留 2 份：删最旧的两个，10:02 与本次上传保留
    expect([...deleted].sort()).toEqual(['backup_20260101_100000.json', 'backup_20260101_100100.json'].sort());
    expect(deleted).not.toContain('backup_20260101_100200.json');
  });

  it('用户手动放进去的文件一律不碰', async () => {
    await enableWebdav('c');
    remoteFiles = ['README.md', 'backup_20260101_100000.json', 'not-a-backup.json', 'backup_2026-01-01.json'];
    remoteHasOwnBackup = true;

    await runWebdavBackup();

    expect(deleted).toEqual(['backup_20260101_100000.json']);
  });

  it('列目录失败一票不删：拿不到完整清单就不做删除决定，且不拖累本次备份', async () => {
    await enableWebdav('d');
    remoteFiles = [...ORPHANS];
    listingErrors.push(new Error('offline'));

    await expect(runWebdavBackup()).resolves.toBeTruthy();

    expect(deleted).toEqual([]);
  });

  it('只做本地备份时不扫描远端目录', async () => {
    await enableWebdav('e');
    remoteFiles = [...ORPHANS];

    await backupService.runBackup({ source: 'manual', local: true, webdav: false });

    expect(deleted).toEqual([]);
  });
});
