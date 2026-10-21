import { beforeEach, describe, expect, it } from 'vitest';

import { backupService, normalizeBackupFile, summarizeBackup } from '@/services/backupService';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { sourceService } from '@/services/sourceService';
import type { BackupFile, DownloadTask, FavoriteRecord, HistoryRecord } from '@/types';

import { resetAll } from './helpers';

/**
 * 备份契约（API-13 / FR-40 / CHG-04）
 *
 * FR-40：「导出：源配置（默认不含密码/Token，可选包含）、设置、收藏、历史、
 * **下载任务元数据**，生成 JSON 文件；不含视频文件与 Blob。」
 * 因此 `collectBackup` 必须真实导出下载任务，但只能是元数据：
 * 不含 `sink`/`filePath`/`blobKey`，不读 `blobs` 表。
 */

function sampleTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = 1_700_000_000_000;
  return {
    id: 'task-1',
    sourceId: 'src-1',
    mediaId: 'src-1:m1',
    episodeId: 'src-1:m1:e1',
    episodeNumber: 1,
    title: '测试影片',
    episodeTitle: '第 1 集',
    posterUrl: 'https://img.example.com/p.jpg',
    url: 'https://cdn.example.com/a.mp4?token=SECRET-TOKEN',
    headers: { Authorization: 'Bearer SECRET', 'User-Agent': 'PeanutMov' },
    format: 'mp4',
    quality: '1080p',
    status: 'completed',
    priority: now,
    totalBytes: 10_000,
    downloadedBytes: 10_000,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: 'blob-abc',
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

describe('backupService 导出下载任务元数据（FR-40 / CHG-04）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('包含下载任务，且剔除 sink / filePath / blobKey', async () => {
    await downloadRepo.save(sampleTask());
    await downloadRepo.save(
      sampleTask({ id: 'task-2', mediaId: 'src-1:m2', episodeId: 'src-1:m2:e1', sink: 'filesystem', filePath: 'downloads/x.mp4', blobKey: null }),
    );

    const blob = await backupService.exportData({ includeCredentials: false });
    const json = JSON.parse(await blob.text()) as BackupFile;

    expect(json.downloads).toHaveLength(2);
    for (const meta of json.downloads) {
      expect(meta).not.toHaveProperty('sink');
      expect(meta).not.toHaveProperty('filePath');
      expect(meta).not.toHaveProperty('blobKey');
    }
    // 元数据字段保留（供"曾下载过什么"查看/对账）
    expect(json.downloads[0]).toMatchObject({
      id: 'task-1',
      mediaId: 'src-1:m1',
      episodeId: 'src-1:m1:e1',
      title: '测试影片',
      status: 'completed',
      downloadedBytes: 10_000,
      speedBps: 0,
    });
    expect(json.downloads.map((d) => d.id).sort()).toEqual(['task-1', 'task-2']);
  });

  it('不含视频文件/Blob 内容：产物中无 blob 字段与 base64 大字段', async () => {
    await downloadRepo.save(sampleTask());
    const text = await (await backupService.exportData({ includeCredentials: true })).text();

    expect(text).not.toContain('data:video');
    expect(text).not.toContain('"blob":');
    expect(text).not.toContain('"blobKey"');
  });

  it('默认脱敏：下载元数据里的凭据 header 与 URL token 被剔除', async () => {
    await downloadRepo.save(sampleTask());

    const redacted = JSON.parse(
      await (await backupService.exportData({ includeCredentials: false })).text(),
    ) as BackupFile;
    const meta = redacted.downloads[0];
    expect(meta?.headers['Authorization']).toBeUndefined();
    expect(meta?.headers['User-Agent']).toBe('PeanutMov');
    expect(meta?.url).not.toContain('SECRET-TOKEN');

    // 显式包含凭据时才保留（与源配置 auth 的开关语义一致）
    const full = JSON.parse(
      await (await backupService.exportData({ includeCredentials: true })).text(),
    ) as BackupFile;
    expect(full.downloads[0]?.headers['Authorization']).toBe('Bearer SECRET');
    expect(full.downloads[0]?.url).toContain('SECRET-TOKEN');
  });

  it('无下载任务时 downloads 为 []（而不是缺字段）', async () => {
    const json = JSON.parse(
      await (await backupService.exportData({ includeCredentials: false })).text(),
    ) as BackupFile;
    expect(json.downloads).toEqual([]);
  });

  it('summarizeBackup 的 downloads 计数与真实任务数一致（备份页"下载 N"）', async () => {
    await downloadRepo.save(sampleTask());
    await downloadRepo.save(sampleTask({ id: 'task-2', mediaId: 'src-1:m2' }));

    const json = JSON.parse(
      await (await backupService.exportData({ includeCredentials: false })).text(),
    ) as BackupFile;

    expect(summarizeBackup(json).downloads).toBe(2);
  });
});

describe('backupService 导入：下载元数据不恢复、不污染现有数据', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('importData 不重新创建下载任务（元数据脱离文件无法续传）', async () => {
    await downloadRepo.save(sampleTask());
    const backup = JSON.parse(
      await (await backupService.exportData({ includeCredentials: false })).text(),
    ) as BackupFile;
    expect(backup.downloads).toHaveLength(1);

    // 模拟换机：清空下载表后再导入
    await downloadRepo.clear();
    const report = await backupService.importData(backup, 'merge');

    expect(report.downloads).toBe(1); // 报告"备份中携带的任务数"
    expect(await downloadRepo.listAll()).toHaveLength(0); // 但不落库
  });

  it('normalizeBackupFile 丢弃伪造的 sink/filePath/blobKey 与不可用条目', async () => {
    const normalized = normalizeBackupFile({
      schemaVersion: 1,
      sources: [],
      downloads: [
        { ...sampleTask(), sink: 'hacked', filePath: '/etc/passwd', blobKey: 'stolen' },
        { id: 'no-url' }, // 缺少 url/mediaId/episodeId → 丢弃
        'not-an-object',
      ],
    });

    expect(normalized.downloads).toHaveLength(1);
    const meta = normalized.downloads[0] as Record<string, unknown>;
    expect(meta['sink']).toBeUndefined();
    expect(meta['filePath']).toBeUndefined();
    expect(meta['blobKey']).toBeUndefined();
    expect(meta['id']).toBe('task-1');
  });

  it('round-trip：导出 → 再解析，下载条数与关键字段一致', async () => {
    await downloadRepo.save(sampleTask());
    const exported = await (await backupService.exportData({ includeCredentials: true })).text();
    const normalized = normalizeBackupFile(JSON.parse(exported));

    expect(normalized.downloads).toHaveLength(1);
    expect(normalized.downloads[0]).toMatchObject({
      id: 'task-1',
      mediaId: 'src-1:m1',
      episodeId: 'src-1:m1:e1',
      status: 'completed',
      format: 'mp4',
      quality: '1080p',
    });
  });
});

describe('backupService 既有契约回归（sources / favorites / history）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('源默认脱敏 password/token，勾选后保留明文', async () => {
    await sourceService.create({
      key: 'alist-a',
      name: '家里 AList',
      type: 'alist',
      baseUrl: 'https://alist.example.com',
      auth: { mode: 'basic', username: 'u', password: 'p', token: 't' },
    });

    const redacted = JSON.parse(
      await (await backupService.exportData({ includeCredentials: false })).text(),
    ) as BackupFile;
    expect(redacted.sources[0]?.auth.password).toBeNull();
    expect(redacted.sources[0]?.auth.token).toBeNull();
    expect(redacted.sources[0]?.auth.username).toBe('u');

    const full = JSON.parse(
      await (await backupService.exportData({ includeCredentials: true })).text(),
    ) as BackupFile;
    expect(full.sources[0]?.auth.password).toBe('p');
  });

  it('导入还原源/收藏/历史，且不修改下载表', async () => {
    const source = await sourceService.create({
      key: 'alist-a',
      name: '家里 AList',
      type: 'alist',
      baseUrl: 'https://alist.example.com',
    });
    const favorite: FavoriteRecord = {
      id: `${source.id}:m1`,
      sourceId: source.id,
      mediaId: 'm1',
      title: '收藏影片',
      posterUrl: null,
      type: 'movie',
      year: 2024,
      sourceRemoved: false,
      createdAt: Date.now(),
    };
    const history: HistoryRecord = {
      id: `${source.id}:m1`,
      sourceId: source.id,
      mediaId: 'm1',
      episodeId: 'm1:e1',
      episodeNumber: 1,
      title: '历史影片',
      posterUrl: null,
      positionSec: 30,
      durationSec: 100,
      progress: 0.3,
      finished: false,
      totalEpisodes: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await favoriteRepo.save(favorite);
    await historyRepo.save(history);
    await downloadRepo.save(sampleTask({ id: 'keep-me' }));

    const backup = JSON.parse(
      await (await backupService.exportData({ includeCredentials: false })).text(),
    ) as BackupFile;
    await resetAll();

    const report = await backupService.importData(backup, 'overwrite');

    expect(report.sources).toBe(1);
    expect(report.favorites).toBe(1);
    expect(report.history).toBe(1);
    expect(report.settingsRestored).toBe(true);
    expect(await downloadRepo.listAll()).toHaveLength(0);
  });

  it('导入版本过高 / 缺版本抛 E_VERSION_UNSUPPORTED，不改数据', async () => {
    await sourceService.create({ key: 'k', name: '源', type: 'alist', baseUrl: 'https://a.example.com' });

    await expect(
      backupService.importData({ schemaVersion: 99 } as BackupFile, 'overwrite'),
    ).rejects.toMatchObject({ code: 'E_VERSION_UNSUPPORTED' });
    await expect(
      backupService.importData({} as BackupFile, 'overwrite'),
    ).rejects.toMatchObject({ code: 'E_VERSION_UNSUPPORTED' });

    expect(await sourceService.list()).toHaveLength(1);
  });
});
