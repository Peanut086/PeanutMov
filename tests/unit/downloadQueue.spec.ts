import { describe, expect, it } from 'vitest';

import { canTransition, decideAfterFailure, DownloadQueue, isTerminal, transition } from '@/services/downloadQueue';
import { AppError } from '@/shared/errors';
import type { DownloadStatus, DownloadTask } from '@/types';

function task(overrides: Partial<DownloadTask> = {}): DownloadTask {
  const now = Date.now();
  return {
    id: overrides.id ?? 'task-1',
    sourceId: 'demo',
    mediaId: 'demo:m1',
    episodeId: 'demo:m1:e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://example.com/a.mp4',
    headers: {},
    format: 'mp4',
    quality: null,
    status: 'queued',
    priority: 1,
    totalBytes: 1000,
    downloadedBytes: 0,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: true,
    sink: 'idb-blob',
    filePath: null,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

describe('下载状态机（AC-74）', () => {
  it('10 条合法迁移全部允许，非法迁移抛 E_INVALID_STATE', () => {
    const legal: Array<[DownloadStatus, 'start' | 'pause' | 'resume' | 'done' | 'fail' | 'cancel' | 'retry', DownloadStatus]> = [
      ['queued', 'start', 'downloading'],
      ['downloading', 'pause', 'paused'],
      ['paused', 'resume', 'queued'],
      ['downloading', 'done', 'completed'],
      ['downloading', 'fail', 'failed'],
      ['downloading', 'cancel', 'canceled'],
      ['paused', 'cancel', 'canceled'],
      ['failed', 'retry', 'queued'],
      ['queued', 'retry', 'queued'],
      ['queued', 'cancel', 'canceled'],
    ];
    for (const [from, action, to] of legal) {
      const next = transition(task({ status: from }), action, 1234);
      expect(next.status, `${from} --${action}-->`).toBe(to);
      expect(next.updatedAt).toBe(1234);
    }
    // 另有一条 remove：completed/canceled 之后只允许删除记录，不产生新状态（由 service 处理）
    expect(canTransition('completed', 'remove')).toBe(true);
    expect(canTransition('canceled', 'remove')).toBe(true);
  });

  it('非法迁移：completed/canceled 终态不再接受任何动作', () => {
    for (const action of ['start', 'pause', 'resume', 'done', 'fail', 'cancel', 'retry'] as const) {
      expect(canTransition('completed', action)).toBe(false);
      expect(canTransition('canceled', action)).toBe(false);
    }
    expect(() => transition(task({ status: 'completed' }), 'start')).toThrowError(AppError);
    expect(() => transition(task({ status: 'canceled' }), 'retry')).toThrowError(/canceled→queued/);
    expect(() => transition(task({ status: 'queued' }), 'done')).toThrowError(/E_INVALID_STATE|状态/);
  });

  it('非法迁移不改变任务对象（抛错前不改状态）', () => {
    const original = task({ status: 'completed', downloadedBytes: 1000 });
    try {
      transition(original, 'start');
    } catch {
      // 忽略
    }
    expect(original.status).toBe('completed');
    expect(original.downloadedBytes).toBe(1000);
  });

  it('done 补齐 totalBytes/completedAt；retry 清空重试计数与错误', () => {
    const done = transition(task({ status: 'downloading', totalBytes: null, downloadedBytes: 800 }), 'done', 999);
    expect(done.totalBytes).toBe(800);
    expect(done.completedAt).toBe(999);

    const retried = transition(
      task({ status: 'failed', retries: 2, errorCode: 'E_NETWORK', errorMessage: '网络错误' }),
      'retry',
      1000,
    );
    expect(retried.status).toBe('queued');
    expect(retried.retries).toBe(0);
    expect(retried.errorCode).toBeNull();
    expect(retried.errorMessage).toBeNull();
  });

  it('重试退避：第 1 次 1s、第 2 次 3s，超过 maxRetries 直接 failed', () => {
    const first = decideAfterFailure(task({ retries: 0 }), { code: 'E_NETWORK', message: 'x' }, 1);
    expect(first.action).toBe('retry');
    expect(first.delayMs).toBe(1000);
    expect(first.task.retries).toBe(1);

    const second = decideAfterFailure(task({ retries: 1 }), { code: 'E_NETWORK', message: 'x' }, 1);
    expect(second.action).toBe('retry');
    expect(second.delayMs).toBe(3000);
    expect(second.task.retries).toBe(2);

    // 连续 3 次失败（retries 已达 2）→ failed 且 retries === 2（AC-74）
    const third = decideAfterFailure(task({ retries: 2 }), { code: 'E_NETWORK', message: 'x' }, 1);
    expect(third.action).toBe('fail');
    expect(third.task.retries).toBe(2);
    expect(third.task.errorCode).toBe('E_NETWORK');
  });

  it('isTerminal 仅对 completed/canceled 为 true', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('canceled')).toBe(true);
    expect(isTerminal('failed')).toBe(false);
    expect(isTerminal('paused')).toBe(false);
  });
});

describe('下载队列调度（AC-71）', () => {
  function makeQueue(concurrency: 1 | 2 | 3, tasks: DownloadTask[]) {
    const store = new Map(tasks.map((t) => [t.id, t]));
    const statusLog: Array<{ id: string; status: DownloadStatus }> = [];
    let active = 0;
    let peak = 0;

    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
        statusLog.push({ id: t.id, status: t.status });
      },
      onStatus: () => undefined,
      concurrency,
      sleep: async () => undefined,
    });

    queue.run(async (queued) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      store.set(queued.id, { ...queued, downloadedBytes: queued.totalBytes ?? 0 });
    });

    return { queue, store, statusLog, peak: () => peak };
  }

  it('并发 2 时入队 5 个，任一时刻 downloading ≤ 2，最终全部 completed', async () => {
    const tasks = Array.from({ length: 5 }, (_, i) => task({ id: `t${i}`, priority: i, createdAt: i }));
    const { queue, store, peak } = makeQueue(2, tasks);
    tasks.forEach((t) => queue.enqueue(t));

    // 等待全部完成（重试/调度在微任务链上，用轮询比 drain 更稳）
    for (let i = 0; i < 200 && [...store.values()].some((t) => t.status !== 'completed'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await queue.drain();

    expect(peak()).toBeLessThanOrEqual(2);
    expect([...store.values()].every((t) => t.status === 'completed')).toBe(true);
  });

  it('FIFO：按 priority 升序启动', async () => {
    const started: string[] = [];
    const store = new Map<string, DownloadTask>();
    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
      },
      concurrency: 1,
      sleep: async () => undefined,
    });
    queue.run(async (t) => {
      started.push(t.id);
    });

    const tasks = [
      task({ id: 'c', priority: 3, createdAt: 3 }),
      task({ id: 'a', priority: 1, createdAt: 1 }),
      task({ id: 'b', priority: 2, createdAt: 2 }),
    ];
    for (const t of tasks) store.set(t.id, t);
    // 乱序入队，队列内部按 priority 排序
    queue.enqueue(tasks[0]!);
    queue.enqueue(tasks[2]!);
    queue.enqueue(tasks[1]!);
    await queue.drain();
    expect(started).toEqual(['a', 'b', 'c']);
  });

  it('暂停会 abort 正在执行的任务，且状态为 paused 不是 completed', async () => {
    const store = new Map<string, DownloadTask>();
    const first = task({ id: 'x' });
    store.set(first.id, first);
    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
      },
      concurrency: 1,
      sleep: async () => undefined,
    });
    queue.run(
      (_t, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(new AppError('E_ABORTED')));
        }),
    );
    queue.enqueue(first);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const paused = await queue.pause('x');
    expect(paused.status).toBe('paused');
    await queue.drain();
    expect(store.get('x')?.status).toBe('paused');
  });

  it('失败自动重试，重试次数用尽后 failed（AC-74）', async () => {
    const store = new Map<string, DownloadTask>();
    const failed = task({ id: 'f', maxRetries: 2 });
    store.set(failed.id, failed);
    let attempts = 0;
    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
      },
      concurrency: 1,
      sleep: async () => undefined,
    });
    queue.run(async () => {
      attempts += 1;
      throw new AppError('E_NETWORK');
    });
    queue.enqueue(failed);
    await queue.drain();
    // 等待重试链结束
    for (let i = 0; i < 50 && store.get('f')?.status !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(attempts).toBe(3);
    expect(store.get('f')?.status).toBe('failed');
    expect(store.get('f')?.retries).toBe(2);
  });
});

describe('停滞误报收口（11-17）', () => {
  /** 并发 1、两条任务：第二条只能待在 pending 里 */
  function makeHoldQueue() {
    const store = new Map<string, DownloadTask>();
    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
      },
      concurrency: 1,
      sleep: async () => undefined,
    });
    return { queue, store };
  }

  it('isActive 认 pending：还在排队不等于没人负责，watchdog 不该判它停滞', async () => {
    const { queue, store } = makeHoldQueue();
    let releaseFirst: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    queue.run(async (t) => {
      if (t.id === 'hold-1') await blocked;
    });

    const a = task({ id: 'hold-1' });
    const b = task({ id: 'hold-2' });
    store.set(a.id, a);
    store.set(b.id, b);
    queue.enqueue(a);
    queue.enqueue(b);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(queue.isActive('hold-1')).toBe(true); // 在跑
    expect(queue.isActive('hold-2')).toBe(true); // 在排队，同样由队列负责
    releaseFirst();
    await queue.drain();
    expect(queue.isActive('hold-2')).toBe(false);
  });

  it('runner 被 abort 但状态还是 downloading：收口成后台暂停，不留死状态', async () => {
    const store = new Map<string, DownloadTask>();
    const statusLog: Array<[string, DownloadStatus]> = [];
    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
        statusLog.push([t.id, t.status]);
      },
      concurrency: 1,
      sleep: async () => undefined,
    });
    // 模拟 stopAll()：中止 runner，却没人先改库里的状态
    queue.run(async (t) => {
      store.set(t.id, { ...t, status: 'downloading' });
      throw new AppError('E_ABORTED');
    });

    const frozen = task({ id: 'abort-1' });
    store.set(frozen.id, { ...frozen, status: 'queued' });
    queue.enqueue({ ...frozen, status: 'queued' });
    await queue.drain();

    const row = store.get('abort-1');
    expect(row?.status).toBe('paused');
    expect(row?.pausedBy).toBe('background');
    // 留在 downloading 就是 watchdog 眼里的孤儿 → 用户看到「下载停滞」
    expect(row?.status).not.toBe('downloading');
  });
});

describe('暂停后立即继续的竞态（DL-P1-2）', () => {
  /**
   * 真机实测：「暂停 → 立刻继续」6 次里 5 次把任务永久留在等待中——状态是 `queued`，
   * 但 pending 里没有它、active 里也没有它，只能杀掉 App 才恢复。
   * 原因是旧 runner 还占着执行槽，`enqueue` 的 active 去重把这次入队直接吞掉。
   */
  it('旧 runner 尚未释放槽时，继续操作仍然会把任务重新跑起来', async () => {
    const store = new Map<string, DownloadTask>();
    const first = task({ id: 'race' });
    store.set(first.id, first);
    let runs = 0;

    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
      },
      concurrency: 1,
      sleep: async () => undefined,
    });
    queue.run(async (t, ctx) => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (ctx.signal.aborted) throw new AppError('E_ABORTED');
      store.set(t.id, { ...t, downloadedBytes: t.totalBytes ?? 0 });
    });

    queue.enqueue(first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.pause('race');
    await queue.resume('race');

    for (let i = 0; i < 100 && store.get('race')?.status !== 'completed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(store.get('race')?.status).toBe('completed');
    expect(runs).toBe(2);
  });

  it('已经卡在等待中的任务，用「重试」就能再进队列（自助出口）', async () => {
    const store = new Map<string, DownloadTask>();
    // 复现卡死现场：库里是 queued，队列里既不在 active 也不在 pending
    store.set('stranded', task({ id: 'stranded', status: 'queued' }));

    const queue = new DownloadQueue({
      load: async (id) => store.get(id) ?? null,
      save: async (t) => {
        store.set(t.id, t);
      },
      concurrency: 1,
      sleep: async () => undefined,
    });
    let started = false;
    queue.run(async (t) => {
      started = true;
      store.set(t.id, { ...t, downloadedBytes: t.totalBytes ?? 0 });
    });

    const retried = await queue.retry('stranded');
    expect(retried.status).toBe('queued');
    await queue.drain();

    expect(started).toBe(true);
    expect(store.get('stranded')?.status).toBe('completed');
  });
});
