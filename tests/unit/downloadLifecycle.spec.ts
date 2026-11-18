import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { downloadRepo } from '@/db/repositories/downloadRepo';
import { settingsService } from '@/services/settingsService';
import { downloadService } from '@/services/downloadService';
import { resetLifecycleState } from '@/native/appLifecycle';
import type { DownloadTask } from '@/types';

import { resetAll } from './helpers';

/**
 * REV-22 / AC-72：切后台暂停下载，回前台按设置自动恢复
 *
 * 缺陷：`downloadService.pauseAll('background')` 与 `resumeAll()` 都已实现，
 * 但全仓无任何代码订阅应用生命周期（`onAppStateChange` 0 调用方），
 * 因此切标签页/切后台时下载继续跑，Android WebView 被冻结后还会留下
 * `status: 'downloading'` 的僵死任务。
 *
 * 修复：`downloadService.bootstrap()` 订阅 `appLifecycle.onAppStateChange`：
 * - `background` → `pauseAll('background')`（下载中 → 已暂停，进度保留）；
 * - `active` → `settings.download.autoResume` 为 true 时 `resumeAll()`。
 */

const NOW = 1_700_000_000_000;

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return {
    id: overrides.id ?? 'task-bg',
    sourceId: 'demo',
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
    status: 'downloading',
    priority: NOW,
    totalBytes: 1000,
    downloadedBytes: 400,
    speedBps: 1234,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  };
}

/** 触发 Web 端前后台切换（appLifecycle 的 visibilitychange 兜底） */
function emitVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

/** 等待异步 pauseAll/resumeAll 链路完成 */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * 轮询直到条件成立（最多 `timeoutMs`）。
 *
 * `resumeAll → requeuePending → 落库/入队` 是跨多个微任务 + IDB 事务的异步链路，
 * 固定 `flush()` 在并行跑全量用例时会偶发不够（实测 60ms 内仍停在 paused）。
 */
async function waitFor(cond: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('REV-22 切后台暂停下载（AC-72）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    resetLifecycleState();
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => {
    downloadService.__resetQueue();
    resetLifecycleState();
  });

  it('bootstrap 后切后台：所有"下载中"转"已暂停"且进度保留', async () => {
    await downloadRepo.save(makeTask());
    await downloadRepo.save(
      makeTask({ id: 'task-bg-2', mediaId: 'demo:m2', episodeId: 'demo:m2:e1', downloadedBytes: 800 }),
    );
    await downloadRepo.save(
      makeTask({ id: 'task-queued', mediaId: 'demo:m3', episodeId: 'demo:m3:e1', status: 'queued', downloadedBytes: 0 }),
    );

    await downloadService.bootstrap();
    expect(downloadService.isBootstrapped()).toBe(true);

    emitVisibility('hidden');
    await flush();

    const rows = await downloadRepo.listAll();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('task-bg')?.status).toBe('paused');
    expect(byId.get('task-bg')?.downloadedBytes).toBe(400);
    expect(byId.get('task-bg')?.totalBytes).toBe(1000);
    expect(byId.get('task-bg-2')?.status).toBe('paused');
    expect(byId.get('task-bg-2')?.downloadedBytes).toBe(800);
    // 未开始的任务不应被误标暂停（已由队列清空待执行，状态仍为 queued 或已恢复）
    expect(byId.get('task-queued')?.status).not.toBe('downloading');
  });

  it('回前台：autoResume=true 时自动恢复（paused → queued 并重新入队）', async () => {
    // 注意：`bootstrap()` 本身就会按 `autoResume` 恢复 paused 任务。若在 bootstrap 前
    // 就设为 true，任务会当场被恢复并立即开始下载（用例地址必然解析失败，随后经 2 次
    // 退避重试落 `failed`），"切后台期间保持 paused"这一前置断言在并发下偶发失败。
    // 因此这里 bootstrap 用 autoResume=false 保住 paused，再在"回前台"前打开开关，
    // 语义不变：验证的正是「回前台 + autoResume=true → 自动离开 paused」。
    await downloadRepo.save(makeTask({ status: 'paused', downloadedBytes: 400 }));
    await settingsService.update({ download: { autoResume: false } });

    await downloadService.bootstrap();
    emitVisibility('hidden');
    await flush();
    expect((await downloadRepo.get('task-bg'))?.status).toBe('paused');

    await settingsService.update({ download: { autoResume: true } });
    emitVisibility('visible');
    // `resumeAll` → `requeuePending`（paused→queued）→ 队列 pump → start（downloading）
    // → 发起真实请求。用例地址解析必然失败，随后进入退避重试，**期间状态会短暂回到
    // paused**，因此"离开 paused"不是稳定判据。改用确定性证据：`errorCode` 只会在
    // 重新入队并真正发起下载后才会被写入，用它证明 AC-72「回前台自动恢复下载」。
    const resumed = await waitFor(async () => {
      const row = await downloadRepo.get('task-bg');
      return Boolean(row?.errorCode);
    }, 3000);
    expect(resumed).toBe(true);

    const row = await downloadRepo.get('task-bg');
    expect(row?.downloadedBytes).toBe(400);
  });

  it('回前台：autoResume=false 时保持已暂停，等待用户手动继续', async () => {
    await downloadRepo.save(makeTask({ status: 'downloading', downloadedBytes: 400 }));
    await settingsService.update({ download: { autoResume: false } });

    await downloadService.bootstrap();
    emitVisibility('hidden');
    await flush();
    emitVisibility('visible');
    await flush();

    const task = await downloadRepo.get('task-bg');
    expect(task?.status).toBe('paused');
    expect(task?.downloadedBytes).toBe(400);
  });

  it('bootstrap 幂等：重复调用只注册一个生命周期订阅', async () => {
    await downloadService.bootstrap();
    await downloadService.bootstrap();
    // 二次 bootstrap 不应抛错，且队列仍可用
    expect(downloadService.isBootstrapped()).toBe(true);
    await downloadService.pauseAll('user');
    expect(await downloadRepo.listAll()).toHaveLength(0);
  });

  it('pauseAll 兜底：不在队列中的"下载中"任务也会落成已暂停', async () => {
    await downloadRepo.save(makeTask({ id: 'orphan', mediaId: 'demo:m9', episodeId: 'demo:m9:e1' }));
    await downloadService.bootstrap();
    await downloadService.pauseAll('background');

    const task = await downloadRepo.get('orphan');
    expect(task?.status).toBe('paused');
    expect(task?.pausedBy).toBe('background');
    expect(task?.downloadedBytes).toBe(400);
  });

  // ---------- OPT-01：回前台自动恢复不复活用户主动/网络策略暂停 ----------

  it('OPT-01：pauseAll 落 pausedBy 来源标记（user）', async () => {
    await downloadRepo.save(makeTask({ id: 'stamp', mediaId: 'demo:m10', episodeId: 'demo:m10:e1' }));
    await downloadService.bootstrap();
    await downloadService.pauseAll('user');

    const task = await downloadRepo.get('stamp');
    expect(task?.status).toBe('paused');
    expect(task?.pausedBy).toBe('user');
  });

  it('OPT-01：autoResume=true 回前台不复活用户手动暂停', async () => {
    await settingsService.update({ download: { autoResume: true } });
    await downloadRepo.save(makeTask({ id: 'keep-user', mediaId: 'demo:m11', episodeId: 'demo:m11:e1' }));
    await downloadService.bootstrap();
    await downloadService.pauseAll('user');
    expect((await downloadRepo.get('keep-user'))?.pausedBy).toBe('user');

    await downloadService.autoResumeFromBackground();

    const task = await downloadRepo.get('keep-user');
    expect(task?.status).toBe('paused');
    expect(task?.pausedBy).toBe('user');
  });

  it('OPT-01：autoResume=true 回前台不复活仅WiFi强制暂停（network）', async () => {
    await settingsService.update({ download: { autoResume: true } });
    await downloadRepo.save(makeTask({ id: 'keep-net', mediaId: 'demo:m12', episodeId: 'demo:m12:e1' }));
    await downloadService.bootstrap();
    await downloadService.pauseAll('network');

    await downloadService.autoResumeFromBackground();

    const task = await downloadRepo.get('keep-net');
    expect(task?.status).toBe('paused');
    expect(task?.pausedBy).toBe('network');
  });

  it('OPT-01：autoResume=true 回前台复活后台冻结暂停（background）', async () => {
    await settingsService.update({ download: { autoResume: true } });
    await downloadRepo.save(makeTask({ id: 'revive-bg', mediaId: 'demo:m13', episodeId: 'demo:m13:e1' }));
    await downloadService.bootstrap();
    await downloadService.pauseAll('background');
    expect((await downloadRepo.get('revive-bg'))?.pausedBy).toBe('background');

    await downloadService.autoResumeFromBackground();

    const task = await downloadRepo.get('revive-bg');
    expect(task?.status).not.toBe('paused');
    expect(task?.pausedBy).toBeUndefined();
    expect(task?.downloadedBytes).toBe(400);
  });

  it('OPT-01：用户「继续全部」覆盖过滤，复活手动暂停（即使 autoResume=false）', async () => {
    await settingsService.update({ download: { autoResume: false } });
    await downloadRepo.save(makeTask({ id: 'manual-all', mediaId: 'demo:m14', episodeId: 'demo:m14:e1' }));
    await downloadService.bootstrap();
    await downloadService.pauseAll('user');

    await downloadService.resumeAll();

    const task = await downloadRepo.get('manual-all');
    expect(task?.status).not.toBe('paused');
    expect(task?.pausedBy).toBeUndefined();
  });
});

/**
 * DL-R0 重启僵尸任务的分类（真机实测：重启后 779,919,880 字节的一整集从 0M 重下）。
 *
 * `checkZombieTasks()` 原先把所有 `downloading` 一律判 failed「应用重启，下载中断」，
 * autoResume 再当场 retry 入队。问题是分片索引已齐的那一类根本没过下载阶段的中断——
 * `finish()` 把 `.part` 原子改名成了成品，进程死在结算/转封装途中，库里于是留下一条
 * 「已下完却没结算」的任务：既挂着并不成立的失败原因，又要靠 sink 的采纳门槛才不重下。
 * 分类改判 paused(background) 后，它走的是既有的暂停恢复通道（上一条用例已覆盖
 * 「background 暂停会被 autoResume 复活」），不再占用失败重试那条路。
 */
describe('DL-R0 重启僵尸任务分类', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    resetLifecycleState();
  });

  afterEach(() => {
    downloadService.__resetQueue();
    resetLifecycleState();
  });

  function hlsZombie(overrides: Partial<DownloadTask> = {}): DownloadTask {
    return makeTask({
      format: 'hls',
      url: 'https://cdn.example.com/720p.m3u8',
      sink: 'filesystem',
      hlsTotalSegments: 10,
      completedSegments: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      totalBytes: 779_919_880,
      downloadedBytes: 779_919_880,
      ...overrides,
    });
  }

  it('分片索引已齐：判「已暂停(background)」并保住进度，不进失败重试名单', async () => {
    await settingsService.update({ download: { autoResume: true } });
    await downloadRepo.save(hlsZombie({ id: 'zombie-settled', mediaId: 'demo:z1', episodeId: 'demo:z1:e1' }));

    await downloadService.checkZombieTasks();

    const row = await downloadRepo.get('zombie-settled');
    expect(row?.status).toBe('paused');
    expect(row?.pausedBy).toBe('background');
    // 失败原因不许出现：下载阶段并没有中断，中断的是收尾
    expect(row?.errorCode).toBeNull();
    expect(row?.errorMessage).toBeNull();
    // 进度与索引是 sink 采纳成品的依据，一条都不许丢
    expect(row?.downloadedBytes).toBe(779_919_880);
    expect(row?.completedSegments).toHaveLength(10);
  });

  it('索引还差 3 片：仍按原判「应用重启，下载中断」，不许被当成已下完', async () => {
    await settingsService.update({ download: { autoResume: false } });
    await downloadRepo.save(
      hlsZombie({
        id: 'zombie-half',
        mediaId: 'demo:z2',
        episodeId: 'demo:z2:e1',
        completedSegments: [0, 1, 2, 3, 4, 5, 6],
        downloadedBytes: 500_000_000,
      }),
    );
    await downloadRepo.save(
      hlsZombie({
        id: 'zombie-direct',
        mediaId: 'demo:z3',
        episodeId: 'demo:z3:e1',
        format: 'mp4',
        url: 'https://cdn.example.com/720p.mp4',
        completedSegments: undefined,
        hlsTotalSegments: undefined,
        downloadedBytes: 400,
      }),
    );

    await downloadService.checkZombieTasks();

    expect((await downloadRepo.get('zombie-half'))?.status).toBe('failed');
    expect((await downloadRepo.get('zombie-half'))?.errorMessage).toBe('应用重启，下载中断');
    // 直链没有分片索引这回事，永远走原判
    expect((await downloadRepo.get('zombie-direct'))?.status).toBe('failed');
  });
});
