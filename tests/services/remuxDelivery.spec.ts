import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P0-3：转封装交付的可回滚编排 + 开机对账
 *
 * 要锁的是「任何时刻至少留一份能引用的产物」这条不变量：
 * - 交付顺序固定为复检 → 改指落库 → 删输入，颠倒就可能出现「记录指 .mp4、盘上只有坏件」；
 * - 复检结论缺失（旧 APK / Web / 桥接异常）不算通过，宁可让 .ts 继续做成品；
 * - 开机对账只结算交付被打断的记录：孤儿 .mp4 复检通过就认领、不通过就删（没人引用它），
 *   记录指着的 .mp4 坏了就退回 .ts，两样都坏时只记结论——绝不删唯一剩下的产物。
 */

vi.mock('@/shared/platform', () => ({ isNative: () => true }));
vi.mock('@/native/mediaToolPlugin', () => ({
  isMediaToolAvailable: () => true,
  probeVerdictOf: (result?: { probeVerdict?: string } | null) =>
    typeof result?.probeVerdict === 'string' && result.probeVerdict ? result.probeVerdict : null,
  verifyRemuxedMedia: vi.fn(async () => null),
}));

import {
  decideRemuxDelivery,
  deliverRemux,
  reconcileRemuxDeliveries,
  REMUX_RECONCILE_LIMIT,
  type RemuxReconcileDeps,
} from '@/services/remuxDelivery';
import type { DownloadTask } from '@/types';

const TS = 'downloads/m1/e1.ts';
const MP4 = 'downloads/m1/e1.mp4';

function patchOf(patches: Array<Record<string, unknown>>, key: string): unknown {
  return patches.find((p) => p[key] !== undefined)?.[key];
}

describe('decideRemuxDelivery：六种结局分档', () => {
  it('复检通过才允许交付', () => {
    expect(decideRemuxDelivery({ result: { ok: true, skipped: false, probeVerdict: 'pass' } })).toMatchObject({
      status: 'done',
      outcome: 'done',
      deliverable: true,
    });
  });

  it('没有复检结论 = 未经校验，不交付', () => {
    expect(decideRemuxDelivery({ result: { ok: true, skipped: false } })).toMatchObject({
      status: 'failed',
      outcome: 'unverified',
      deliverable: false,
    });
  });

  it('复检失败结论按 verify-failed 档', () => {
    expect(
      decideRemuxDelivery({
        result: { ok: false, skipped: false, code: 'E_UNSUPPORTED_FORMAT', reason: 'verify-failed:tail-seek-miss', probeVerdict: 'tail-seek-miss' },
      }),
    ).toMatchObject({ status: 'failed', outcome: 'verify-failed', probeVerdict: 'tail-seek-miss' });
  });

  it('取消与超时分开档，不混成普通失败', () => {
    expect(decideRemuxDelivery({ result: { ok: false, skipped: false, code: 'E_CANCELED', reason: 'canceled' } })).toMatchObject({ outcome: 'canceled' });
    expect(decideRemuxDelivery({ result: { ok: false, skipped: false, code: 'E_TIMEOUT', reason: 'timeout' } })).toMatchObject({ outcome: 'timeout' });
    expect(decideRemuxDelivery({ error: new Error('remux timeout after 300000ms') })).toMatchObject({ outcome: 'timeout' });
    expect(decideRemuxDelivery({ error: new Error('user canceled') })).toMatchObject({ outcome: 'canceled' });
  });

  it('跳过档保留原生 reason 原文', () => {
    expect(decideRemuxDelivery({ result: { ok: false, skipped: true, reason: 'not-mpeg-ts' } })).toMatchObject({
      status: 'skipped',
      outcome: 'skipped',
      reason: 'not-mpeg-ts',
    });
  });

  it('桥接层双结算这类未知异常按失败档：交给开机对账认盘', () => {
    expect(decideRemuxDelivery({ error: new Error('响应已提交（重复 resolve/reject）') })).toMatchObject({
      status: 'failed',
      outcome: 'failed',
      reason: '响应已提交（重复 resolve/reject）',
      deliverable: false,
    });
  });
});

describe('deliverRemux：复检 → 落库 → 删输入', () => {
  beforeEach(() => vi.resetAllMocks());

  it('交付成功时按顺序写三笔，删输入排在改指之后', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const order: string[] = [];
    const delivery = await deliverRemux({
      taskId: 't1',
      inputPath: TS,
      outputPath: MP4,
      inputBytes: 200,
      result: { ok: true, skipped: false, outputBytes: 180, durationMs: 12, probeVerdict: 'pass' },
      decision: decideRemuxDelivery({ result: { ok: true, skipped: false, probeVerdict: 'pass' } }),
      deps: {
        update: async (patch) => {
          patches.push(patch as Record<string, unknown>);
          order.push('update');
        },
        removeInput: async () => {
          order.push('removeInput');
        },
      },
    });

    expect(order).toEqual(['update', 'update', 'removeInput', 'update']);
    // 第一笔是发布标记：崩在下一笔之前对账也能找到那份 .mp4
    expect((patches[0]?.remux as { delivery?: string }).delivery).toBe('published');
    expect(patches[1]).toMatchObject({ filePath: MP4, format: 'mp4', totalBytes: 180 });
    expect((patches[2]?.remux as { delivery?: string }).delivery).toBe('input-cleaned');
    expect(delivery).toMatchObject({ outcome: 'done', deliveredPath: MP4, phase: 'input-cleaned', inputRetained: false });
  });

  it('交付那一笔落库失败：保留两份产物、记录仍指 .ts，且不删输入', async () => {
    const order: string[] = [];
    const delivery = await deliverRemux({
      taskId: 't1',
      inputPath: TS,
      outputPath: MP4,
      inputBytes: 200,
      result: { ok: true, skipped: false, outputBytes: 180, probeVerdict: 'pass' },
      decision: decideRemuxDelivery({ result: { ok: true, skipped: false, probeVerdict: 'pass' } }),
      deps: {
        update: async (patch) => {
          order.push('update');
          if ((patch as Record<string, unknown>).filePath === MP4) throw new Error('IndexedDB quota exceeded');
        },
        removeInput: async () => {
          order.push('removeInput');
        },
      },
    });

    expect(order).toEqual(['update', 'update']);
    expect(delivery).toMatchObject({ outcome: 'db-commit-failed', deliveredPath: TS, phase: 'published', inputRetained: true });
  });

  it('删输入失败时停在 committed 档：交付已完成，残件交给对账', async () => {
    const patches: Array<Record<string, unknown>> = [];
    const delivery = await deliverRemux({
      taskId: 't1',
      inputPath: TS,
      outputPath: MP4,
      inputBytes: 200,
      result: { ok: true, skipped: false, outputBytes: 180, probeVerdict: 'pass' },
      decision: decideRemuxDelivery({ result: { ok: true, skipped: false, probeVerdict: 'pass' } }),
      deps: {
        update: async (patch) => {
          patches.push(patch as Record<string, unknown>);
        },
        removeInput: async () => {
          throw new Error('EBUSY');
        },
      },
    });

    expect(delivery).toMatchObject({ outcome: 'done', deliveredPath: MP4, phase: 'committed', inputRetained: true });
    // 最后一笔仍是 committed（没有假装删干净了）
    expect((patches.at(-1)?.remux as { delivery?: string }).delivery).toBe('committed');
  });

  it('未交付档一次都不删输入，且失败结论落库失败只记日志', async () => {
    let removed = 0;
    const delivery = await deliverRemux({
      taskId: 't1',
      inputPath: TS,
      outputPath: MP4,
      inputBytes: 200,
      decision: decideRemuxDelivery({ result: { ok: false, skipped: false, code: 'E_STORAGE_QUOTA', reason: 'insufficient-space' } }),
      deps: {
        update: async () => {
          throw new Error('库写不进去');
        },
        removeInput: async () => {
          removed += 1;
        },
      },
    });

    expect(removed).toBe(0);
    expect(delivery).toMatchObject({ outcome: 'failed', deliveredPath: TS, phase: 'none', inputRetained: true });
  });
});

interface FakeDisk {
  [path: string]: number | undefined;
}

function reconcileHarness(disk: FakeDisk, verdicts: Record<string, { ok: boolean; probeVerdict: string; outputBytes: number }>) {
  const tasks: DownloadTask[] = [];
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const removed: string[] = [];
  const verified: string[] = [];

  const deps: RemuxReconcileDeps = {
    list: async () => tasks,
    update: async (id, patch) => {
      patches.push({ id, patch: patch as Record<string, unknown> });
    },
    remove: async (path) => {
      removed.push(path);
      delete disk[path];
    },
    sizeOf: async (path) => disk[path] ?? null,
    verify: async (path) => {
      verified.push(path);
      return verdicts[path] ?? null;
    },
  };

  return { tasks, patches, removed, verified, deps, disk };
}

function record(over: Partial<DownloadTask>): DownloadTask {
  const now = Date.now();
  return {
    id: 't1',
    sourceId: 's1',
    mediaId: 'm1',
    episodeId: 'e1',
    episodeNumber: 1,
    title: '影片',
    episodeTitle: '第 1 集',
    posterUrl: null,
    url: 'https://cdn.example.com/master.m3u8',
    headers: {},
    format: 'hls',
    quality: null,
    status: 'completed',
    priority: 1,
    totalBytes: 200,
    downloadedBytes: 200,
    speedBps: 0,
    retries: 0,
    maxRetries: 2,
    resumable: false,
    sink: 'filesystem',
    filePath: TS,
    blobKey: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...over,
  } as DownloadTask;
}

describe('reconcileRemuxDeliveries：凭实际文件与复检结论恢复', () => {
  it('记录指 .ts + 盘上有复检通过的孤儿 .mp4：认领并清掉原件', async () => {
    const h = reconcileHarness({ [TS]: 200, [MP4]: 180 }, { [MP4]: { ok: true, probeVerdict: 'pass', outputBytes: 180 } });
    h.tasks.push(record({ filePath: TS }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary).toMatchObject({ checked: 1, adopted: 1, cleaned: 1, discarded: 0, repaired: 0 });
    expect(patchOf(h.patches.map((p) => p.patch), 'filePath')).toBe(MP4);
    expect(h.removed).toEqual([TS]);
    expect(h.patches.at(-1)?.patch).toMatchObject({ remux: { delivery: 'input-cleaned' } });
  });

  it('孤儿 .mp4 复检不过：删掉没被引用的它，记录仍指 .ts', async () => {
    const h = reconcileHarness({ [TS]: 200, [MP4]: 180 }, { [MP4]: { ok: false, probeVerdict: 'truncated', outputBytes: 180 } });
    h.tasks.push(record({ filePath: TS }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary).toMatchObject({ discarded: 1, adopted: 0 });
    expect(h.removed).toEqual([MP4]);
    expect(h.disk[TS]).toBe(200);
    expect(patchOf(h.patches.map((p) => p.patch), 'filePath')).toBeUndefined();
    expect(h.patches.at(-1)?.patch).toMatchObject({ remux: { outcome: 'verify-failed', probeVerdict: 'truncated' } });
  });

  it('记录指 .mp4 但那份坏了、.ts 还在：退回原件并删除坏件', async () => {
    const h = reconcileHarness({ [TS]: 200, [MP4]: 180 }, { [MP4]: { ok: false, probeVerdict: 'no-video-track', outputBytes: 180 } });
    h.tasks.push(record({ filePath: MP4, format: 'mp4', container: 'mp4', remux: { status: 'done', outcome: 'done' } }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary).toMatchObject({ repaired: 1 });
    expect(h.removed).toEqual([MP4]);
    expect(h.patches.some((p) => p.patch.filePath === TS)).toBe(true);
  });

  it('只剩一份坏产物：只记结论，绝不删文件也不改记账', async () => {
    const h = reconcileHarness({ [MP4]: 180 }, { [MP4]: { ok: false, probeVerdict: 'duration-drift-72', outputBytes: 180 } });
    h.tasks.push(record({ filePath: MP4, format: 'mp4', container: 'mp4', remux: { status: 'done', outcome: 'done' } }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary).toMatchObject({ noted: 1, repaired: 0 });
    expect(h.removed).toEqual([]);
    expect(h.disk[MP4]).toBe(180);
    expect(h.patches.every((p) => p.patch.filePath === undefined)).toBe(true);
    expect(h.patches.at(-1)?.patch).toMatchObject({ remux: { outcome: 'verify-failed', probeVerdict: 'duration-drift-72' } });
  });

  it('MP4 没了但 .ts 还在：记录退回 .ts', async () => {
    const h = reconcileHarness({ [TS]: 200 }, {});
    h.tasks.push(record({ filePath: MP4, format: 'mp4', container: 'mp4', remux: { status: 'done', outcome: 'done' } }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary).toMatchObject({ repaired: 1 });
    expect(h.patches.some((p) => p.patch.filePath === TS)).toBe(true);
  });

  it('已交付成功、原件是上次没删干净的残件：补删并记 input-cleaned', async () => {
    const h = reconcileHarness({ [TS]: 200, [MP4]: 180 }, { [MP4]: { ok: true, probeVerdict: 'pass', outputBytes: 180 } });
    h.tasks.push(record({ filePath: MP4, format: 'mp4', container: 'mp4', remux: { status: 'done', outcome: 'done' } }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary).toMatchObject({ cleaned: 1, adopted: 0 });
    expect(h.removed).toEqual([TS]);
    expect(h.patches.at(-1)?.patch).toMatchObject({ remux: { delivery: 'input-cleaned' } });
  });

  it('同目录没有 .mp4 时不做任何探测', async () => {
    const h = reconcileHarness({ [TS]: 200 }, {});
    h.tasks.push(record({ filePath: TS }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary.checked).toBe(1);
    expect(h.verified).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  it('已经 input-cleaned 的记录不再重复探测', async () => {
    const h = reconcileHarness({ [MP4]: 180 }, { [MP4]: { ok: true, probeVerdict: 'pass', outputBytes: 180 } });
    h.tasks.push(record({ filePath: MP4, format: 'mp4', container: 'mp4', remux: { status: 'done', delivery: 'input-cleaned' } }));

    await reconcileRemuxDeliveries(h.deps);

    expect(h.verified).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  it('复检能力缺席（Web / 旧 APK）时不动盘上任何东西', async () => {
    const h = reconcileHarness({ [TS]: 200, [MP4]: 180 }, {});
    h.tasks.push(record({ filePath: TS }));

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary).toMatchObject({ adopted: 0, discarded: 0, repaired: 0 });
    expect(h.removed).toEqual([]);
    expect(h.patches).toEqual([]);
  });

  it('单轮有条数上限：按最近更新先做，剩下的留给下轮', async () => {
    const disk: FakeDisk = {};
    const verdicts: Record<string, { ok: boolean; probeVerdict: string; outputBytes: number }> = {};
    for (let i = 0; i < REMUX_RECONCILE_LIMIT + 5; i += 1) {
      disk[`downloads/m1/e${i}.mp4`] = 180;
      verdicts[`downloads/m1/e${i}.mp4`] = { ok: true, probeVerdict: 'pass', outputBytes: 180 };
    }
    const h = reconcileHarness(disk, verdicts);
    for (let i = 0; i < REMUX_RECONCILE_LIMIT + 5; i += 1) {
      h.tasks.push(
        record({
          id: `t${i}`,
          filePath: `downloads/m1/e${i}.mp4`,
          format: 'mp4',
          container: 'mp4',
          remux: { status: 'done', outcome: 'done' },
          updatedAt: i,
        }),
      );
    }

    const summary = await reconcileRemuxDeliveries(h.deps);

    expect(summary.checked).toBe(REMUX_RECONCILE_LIMIT);
    expect(h.verified).toHaveLength(REMUX_RECONCILE_LIMIT);
    // 最近更新的那条排在最前，说明被截掉的是最旧的一批
    expect(h.verified[0]).toBe(`downloads/m1/e${REMUX_RECONCILE_LIMIT + 4}.mp4`);
  });
});
