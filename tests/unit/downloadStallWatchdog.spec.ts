import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAll } from './helpers';
import { downloadRepo } from '@/db/repositories/downloadRepo';
import { downloadService } from '@/services/downloadService';
import { libraryService } from '@/services/libraryService';
import type { DownloadTask, PlaybackSource } from '@/types';

/**
 * 11-17 下载停滞三连（真机日志定案）：
 * 1. 「下载停滞」是 watchdog 的孤儿分支贴上去的——`downloading` 但队列里没有 runner；
 * 2. 迟到的进度回写会把 failed/paused 复活成 `downloading`，制造出第 1 条的孤儿；
 * 3. 「继续」走 `resume()`，而刷新过期直链只写在 `retry()` 里 → 点继续必撞 402/403。
 * 三条一起测，缺一条都会复现用户看到的那串报错。
 */

const h = vi.hoisted(() => ({
  runs: [] as DownloadTask[],
  saveProgress: null as ((id: string, patch: Partial<DownloadTask>) => Promise<void>) | null,
}));

vi.mock('@/services/downloadEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/downloadEngine')>();
  return {
    ...actual,
    createDownloadEngine: (deps: { saveProgress: typeof h.saveProgress }) => {
      h.saveProgress = deps.saveProgress;
      return {
        run: async (task: DownloadTask) => {
          h.runs.push(task);
        },
      };
    },
  };
});

const OLD_URL = 'https://cdn.example.com/vod/ep1.m3u8?auth_key=1794912583-a-b-c';

function makeTask(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: 'task-stall',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    lineId: 'L1',
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: OLD_URL,
    headers: {},
    format: 'hls',
    quality: null,
    status: 'paused',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 500,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: 'E_HTTP_403',
    errorMessage: '获取 m3u8 清单失败：HTTP 402',
    completedSegments: [0, 1],
    hlsTotalSegments: 10,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function makePlayback(overrides: Partial<PlaybackSource> = {}): PlaybackSource {
  return {
    url: 'https://cdn.example.com/vod/ep1.m3u8?auth_key=1894912583-a-b-c',
    format: 'hls',
    headers: { Referer: 'https://new.example.com/' },
    subtitles: [],
    lineId: 'L1',
    quality: null,
    expiresAt: null,
    isLocal: false,
    ...overrides,
  };
}

async function settle(runs: number): Promise<void> {
  for (let i = 0; i < 200 && h.runs.length < runs; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(async () => {
  await resetAll();
  downloadService.__resetQueue();
  h.runs.length = 0;
  h.saveProgress = null;
  vi.restoreAllMocks();
  // 引擎记录器会让任务秒完成，连带触发附件/弹幕预取（真实网络）——与本用例无关
  vi.spyOn(downloadService, 'downloadAttachments').mockResolvedValue(undefined);
  // 队列（连同被 mock 的引擎）是懒创建的：巡检与 saveProgress 断言都要先把它拉起来
  await downloadService.setConcurrency(1);
});

describe('「继续」也要刷新过期直链', () => {
  it('直链失效类失败：继续前先换新地址（402/403 不再原地复读）', async () => {
    await downloadRepo.save(makeTask());
    const resolve = vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback());

    await downloadService.resume('task-stall');
    await settle(1);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(h.runs[h.runs.length - 1]?.url).toContain('auth_key=1894912583');
  });

  it('网络类失败不重新解析（地址没坏，白跑一次解析才是问题）', async () => {
    await downloadRepo.save(makeTask({ errorCode: 'E_NETWORK', errorMessage: '网络中断' }));
    const resolve = vi.spyOn(libraryService, 'resolvePlay');

    await downloadService.resume('task-stall');
    await settle(1);

    expect(resolve).not.toHaveBeenCalled();
    expect(h.runs[h.runs.length - 1]?.url).toBe(OLD_URL);
  });

  it('密钥解不开也先换链：过期直链取回的是错误页而不是密钥', async () => {
    await downloadRepo.save(makeTask({ errorCode: 'E_DRM_PROTECTED', errorMessage: '分片解密失败' }));
    const resolve = vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback());

    await downloadService.resume('task-stall');
    await settle(1);

    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('进度回写不许复活状态（停滞的制造源）', () => {
  it('失败后的迟到回写只更新字节，不把任务改回 downloading', async () => {
    await downloadRepo.save(makeTask({ status: 'failed' }));
    // 创建引擎时捕获 deps.saveProgress
    await downloadService.get('task-stall');
    const save = h.saveProgress;
    expect(save, '引擎未拿到 saveProgress').toBeTruthy();

    await save!('task-stall', { status: 'downloading', downloadedBytes: 900, updatedAt: Date.now() });

    const row = await downloadRepo.get('task-stall');
    expect(row?.status).toBe('failed');
    expect(row?.downloadedBytes).toBe(900);
  });

  it('queued → downloading 的回写仍然有效（原生下载器的启动回执）', async () => {
    await downloadRepo.save(makeTask({ status: 'queued' }));
    await downloadService.get('task-stall');
    const save = h.saveProgress!;

    await save('task-stall', { status: 'downloading', updatedAt: Date.now() });

    expect((await downloadRepo.get('task-stall'))?.status).toBe('downloading');
  });
});

describe('watchdog 巡检：孤儿任务交回队列，而不是判成「下载停滞」', () => {
  /** 造一条"10 分钟前更新、却没有任何 runner 在册"的任务 */
  async function seedOrphan(): Promise<void> {
    await downloadRepo.save(makeTask({ status: 'downloading', updatedAt: Date.now() - 10 * 60 * 1000 }));
    h.runs.length = 0;
  }

  it('无人负责的 downloading 会被重新入队续传，而不是留下停滞文案', async () => {
    await seedOrphan();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback());

    await downloadService.checkStalledTasks();
    await settle(1);

    const row = await downloadRepo.get('task-stall');
    expect(row?.status).not.toBe('failed');
    expect(row?.errorMessage ?? '').not.toContain('停滞');
    expect(h.runs.length).toBeGreaterThan(0);
    // 断点保留：已下的 500 字节与分片索引不能因为一次巡检被抹掉
    expect(h.runs[0]?.downloadedBytes).toBe(500);
    expect(h.runs[0]?.completedSegments).toEqual([0, 1]);
  });

  it('反复交回仍跑不动才判失败（有界，不会无限自我重入）', async () => {
    await seedOrphan();
    vi.spyOn(libraryService, 'resolvePlay').mockResolvedValue(makePlayback());

    for (let i = 0; i < 4; i += 1) {
      // 每轮都把任务还原成"陈旧孤儿"，模拟 runner 反复消失
      await downloadRepo.save(makeTask({ status: 'downloading', updatedAt: Date.now() - 10 * 60 * 1000 }));
      await downloadService.checkStalledTasks();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const row = await downloadRepo.get('task-stall');
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toContain('停滞');
  });
});
