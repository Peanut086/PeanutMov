import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEMO_ITEMS } from '@/data/demo/demoCatalog';
import { DEMO_SOURCE_ID, seedDemoData } from '@/data/demo/demoSeed';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { createDownloadEngine } from '@/services/downloadEngine';
import { downloadService, selectCompletedTask } from '@/services/downloadService';
import { libraryService } from '@/services/libraryService';
import { appEvents } from '@/services/events';
import { decideAfterFailure } from '@/services/downloadQueue';
import { isLocalArtifactUrl } from '@/player/sourceGuard';
import { mediaIdOf } from '@/shared/id';
import type { DownloadTask } from '@/types';

import { resetAll } from './helpers';

/**
 * P0-1 / P0-2 / P0-3：下载链路禁止本地地址 + 本地命中不跨集 + 存量坏任务清洗。
 *
 * 现场（真机 11-10）：《今天是太阳雨》第 1 集下载完成后点第 2 集下载，任务 `url`
 * 变成 `https://localhost/_capacitor_file_/…第1集.mp4`，原生与 JS 都取不到字节，
 * 自动重试 + 重启僵尸恢复反复入队 → 「启动很慢、进度一直 0」。
 * 链路：PlayerView → toDownloadInputs → resolvePlay → findLocalForMedia 的
 * 「唯一 completed 兜底」→ 本地桥地址写进新任务。
 */

const BRIDGE_URL = 'https://localhost/_capacitor_file_/data/user/0/com.qoder.cinema/files/mediaSeg/m1/1.mp4';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = 1_700_000_000_000;
  return {
    id: overrides.id ?? 't1',
    sourceId: DEMO_SOURCE_ID,
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/a.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'completed',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 1000,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'filesystem',
    filePath: 'mediaSeg/m1/1.mp4',
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

describe('P0-1 本地地址判定', () => {
  it('文件桥 / 只读协议 / 无端口回环 = 本地产物', () => {
    expect(isLocalArtifactUrl(BRIDGE_URL)).toBe(true);
    expect(isLocalArtifactUrl('capacitor://localhost/_capacitor_file_/x.mp4')).toBe(true);
    expect(isLocalArtifactUrl('file:///data/user/0/com.qoder.cinema/files/a.mp4')).toBe(true);
    expect(isLocalArtifactUrl('blob:https://localhost/8a1c')).toBe(true);
    expect(isLocalArtifactUrl('https://localhost/x.mp4')).toBe(true);
  });

  it('网络直链与本机代理（带端口）不误判', () => {
    expect(isLocalArtifactUrl('https://cdn.example.com/a.mp4')).toBe(false);
    expect(isLocalArtifactUrl('http://127.0.0.1:9978/proxy?url=x')).toBe(false);
    expect(isLocalArtifactUrl('http://localhost:8802/sub.json')).toBe(false);
    expect(isLocalArtifactUrl('')).toBe(false);
    expect(isLocalArtifactUrl(null)).toBe(false);
  });
});

describe('P0-1 下载三层防线', () => {
  beforeEach(async () => {
    await resetAll();
    await seedDemoData();
  });

  it('A 源头：toDownloadInputs 即使本地命中也只要网络源，且不发「本地文件缺失」提示', async () => {
    const mediaId = mediaIdOf(DEMO_SOURCE_ID, DEMO_ITEMS[0]?.itemId ?? '');
    const episodeId = `${mediaId}:ep1`;
    const findSpy = vi.spyOn(downloadService, 'findLocalForMedia').mockResolvedValue({
      url: BRIDGE_URL,
      format: 'mp4',
      headers: {},
      subtitles: [],
      lineId: 'local:t1',
      quality: null,
      expiresAt: null,
      isLocal: true,
    });
    const missingSpy = vi.spyOn(downloadService, 'localMissingForMedia');
    const listener = vi.fn();
    appEvents.on('local:missing', listener);

    const { inputs, failed } = await libraryService.toDownloadInputs({
      mediaId,
      episodeIds: [episodeId],
      lineId: null,
    });

    expect(findSpy).not.toHaveBeenCalled();
    expect(missingSpy).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    expect(failed).toHaveLength(0);
    expect(isLocalArtifactUrl(inputs[0]?.url ?? '')).toBe(false);
  });

  it('B 创建口：downloadService.create 拒绝本地桥地址（E_INVALID_INPUT）', async () => {
    await expect(
      downloadService.create({
        sourceId: DEMO_SOURCE_ID,
        mediaId: 'demo:m1',
        episodeId: 'demo:m1:e1',
        episodeNumber: 1,
        title: '影片',
        episodeTitle: '第 1 集',
        posterUrl: null,
        url: BRIDGE_URL,
        format: 'mp4',
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    expect(await downloadRepo.listAll()).toHaveLength(0);
  });

  it('C 引擎口：DownloadEngine.run 对本地地址快速失败，不发请求', async () => {
    const fetchImpl = vi.fn();
    const engine = createDownloadEngine({
      load: async () => task({ url: BRIDGE_URL, status: 'downloading' }),
      saveProgress: async () => undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(engine.run(task({ url: BRIDGE_URL }), new AbortController().signal)).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('不可重试的错误不再进退避重试循环', () => {
    const decision = decideAfterFailure(
      task({ status: 'downloading', retries: 0 }),
      { code: 'E_INVALID_INPUT', message: 'x', retryable: false },
      1,
    );
    expect(decision.action).toBe('fail');
    expect(decision.task.retries).toBe(0);
  });
});

describe('P0-2 本地命中不跨集', () => {
  const completed = [
    task({ id: 'ep1', episodeId: 'demo:m1:ep1', episodeNumber: 1 }),
    task({ id: 'ep2', episodeId: 'demo:m1:ep2', episodeNumber: 2 }),
  ];

  it('episodeId 精确优先，其次同集号跨线路', () => {
    expect(selectCompletedTask(completed, { episodeId: 'demo:m1:ep2', episodeNumber: 9 })?.id).toBe('ep2');
    expect(selectCompletedTask(completed, { episodeId: 'other-line', episodeNumber: 1 })?.id).toBe('ep1');
  });

  it('只下过第 1 集时，播第 2 集不再兜底命中第 1 集', () => {
    const onlyEp1 = [completed[0]!];
    expect(selectCompletedTask(onlyEp1, { episodeId: 'demo:m1:ep2', episodeNumber: 2 })).toBeNull();
    expect(selectCompletedTask(onlyEp1, { episodeId: 'demo:m1:ep2', episodeNumber: null })).toBeNull();
  });

  it('调用方未提供任何剧集身份时，唯一完成任务仍可兜底', () => {
    expect(selectCompletedTask([completed[0]!], {})?.id).toBe('ep1');
    expect(selectCompletedTask(completed, {})).toBeNull();
  });
});

describe('P0-3 存量坏任务启动清洗', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('queued / paused / downloading 的本地地址任务判失败，正常任务不动', async () => {
    await downloadRepo.save(task({ id: 'bad-queued', status: 'queued', url: BRIDGE_URL }));
    await downloadRepo.save(task({ id: 'bad-paused', status: 'paused', url: BRIDGE_URL }));
    await downloadRepo.save(task({ id: 'bad-downloading', status: 'downloading', url: BRIDGE_URL }));
    await downloadRepo.save(task({ id: 'ok', status: 'queued', url: 'https://cdn.example.com/a.mp4' }));

    expect(await downloadService.repairLocalArtifactTasks()).toBe(3);

    const rows = await downloadRepo.listAll();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const id of ['bad-queued', 'bad-paused', 'bad-downloading']) {
      expect(byId.get(id)?.status).toBe('failed');
      expect(byId.get(id)?.errorCode).toBe('E_INVALID_INPUT');
      expect(byId.get(id)?.errorMessage).toContain('请从详情页重新下载');
    }
    expect(byId.get('ok')?.status).toBe('queued');
    // 幂等：第二次跑没有新任务被改
    expect(await downloadService.repairLocalArtifactTasks()).toBe(0);
  });
});
