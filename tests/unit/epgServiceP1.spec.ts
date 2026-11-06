import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheRepo } from '@/db/repositories/cacheRepo';
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { epgService, resetEpgInFlightForTest } from '@/services/epgService';
import { EPG_CACHE_TTL_MS, EPG_MERGE_CONCURRENCY } from '@/shared/constants';
import type { EpgSource } from '@/types';

import { resetAll } from './helpers';

/**
 * EXT-06 P1 复审整改（REV-15 / REV-16 / REV-17 / REV-19）
 *
 * - REV-15：`requestProgrammes` 网络段统一受全局并发闸门约束（≤ EPG_MERGE_CONCURRENCY），
 *   两个页面各自调 `programmesFor` 也不会超发；
 * - REV-16：`allowStale: false` 时不回落到过期缓存；
 * - REV-17：失败源 5 分钟退避，后续合并直接跳过（不再每次等超时）；
 * - REV-19：in-flight 键纳入 sourceIds / allowStale，不同条件的并发请求不共享结果。
 */

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(async (_url: string, _options?: unknown): Promise<string> => ''),
}));

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: requestMock, requestWithMeta: vi.fn(), requestBase: vi.fn() },
}));

const DATE = new Date(2026, 10, 6, 12, 0, 0);
const NEXT_DATE = new Date(2026, 10, 7, 12, 0, 0);

function sourceOf(overrides: Partial<EpgSource> & { id: string }): EpgSource {
  return {
    name: overrides.id,
    endpoint: `https://epg.example.com/${overrides.id}`,
    protocol: 'xmltv',
    matchMode: 'auto',
    priority: 1,
    enabled: true,
    builtin: false,
    lastProbeAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function disableBuiltin(): Promise<void> {
  const builtin = await epgSourceRepo.get('epg-builtin');
  if (builtin) await epgSourceRepo.save({ ...builtin, enabled: false });
}

const HUNAN_XML = `<?xml version="1.0" encoding="UTF-8"?><tv>
  <channel id="hunan"><display-name>湖南卫视</display-name></channel>
  <programme channel="hunan" start="20261106190000" stop="20261106200000"><title>快乐大本营</title></programme>
</tv>`;

const HUNAN_CHANNEL = { name: '湖南卫视', tvgId: null, tvgName: null };

function sleep(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立（避免固定 sleep 带来的偶发失败） */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`等待超时：${label}`);
}

beforeEach(async () => {
  await resetAll();
  resetEpgInFlightForTest();
  requestMock.mockReset();
  await disableBuiltin();
});

describe('REV-19：in-flight 键纳入 sourceIds / allowStale', () => {
  it('同一 (频道, 日期) 但 sourceIds 不同 → 不共享 Promise，各自结果独立', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    await epgSourceRepo.save(sourceOf({ id: 'B', priority: 2 }));

    const releases: Array<() => void> = [];
    requestMock.mockImplementation(async (url: string) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      if (url.includes('/B')) return HUNAN_XML;
      return '';
    });

    const fromB = epgService.programmesFor(HUNAN_CHANNEL, DATE, { sourceIds: ['B'] });
    const fromA = epgService.programmesFor(HUNAN_CHANNEL, DATE, { sourceIds: ['A'] });
    await waitFor(() => releases.length === 2, '两个来源各自发出请求');
    for (const release of releases.splice(0)) release();

    const [resultB, resultA] = await Promise.all([fromB, fromA]);
    expect(resultB.matchedSource?.id).toBe('B');
    expect(resultB.programmes).toHaveLength(1);
    // 若键忽略 sourceIds，resultA 会拿到 B 的合并结果
    expect(resultA.matchedSource).toBeNull();
    expect(resultA.programmes).toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('同一 (频道, 日期, sourceIds) 并发仍只发一次请求（去重能力保留）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockResolvedValue(HUNAN_XML);

    const [first, second] = await Promise.all([
      epgService.programmesFor(HUNAN_CHANNEL, DATE, { sourceIds: ['A'] }),
      epgService.programmesFor(HUNAN_CHANNEL, DATE, { sourceIds: ['A'] }),
    ]);
    expect(first).toBe(second);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});

describe('REV-15：全局并发闸门（≤ EPG_MERGE_CONCURRENCY）', () => {
  it('两个页面同时为多个频道拉节目单，网络峰值并发不超过 3', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));

    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    requestMock.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) =>
        releases.push(() => {
          active -= 1;
          resolve();
        }),
      );
      return '';
    });

    const pageOne = ['c1', 'c2', 'c3'].map((name) =>
      epgService.programmesFor({ name, tvgId: null, tvgName: null }, DATE, { sourceIds: ['A'] }),
    );
    const pageTwo = ['c4', 'c5'].map((name) =>
      epgService.programmesFor({ name, tvgId: null, tvgName: null }, DATE, { sourceIds: ['A'] }),
    );

    await waitFor(() => releases.length >= EPG_MERGE_CONCURRENCY, '并发达到上限');
    expect(peak).toBeLessThanOrEqual(EPG_MERGE_CONCURRENCY);

    // 逐个释放，允许排队任务依次进入
    while (releases.length > 0) {
      releases.shift()!();
      await sleep(1);
    }
    await Promise.all([...pageOne, ...pageTwo]);
    expect(peak).toBeLessThanOrEqual(EPG_MERGE_CONCURRENCY);
    expect(requestMock).toHaveBeenCalledTimes(5);
  });
});

describe('REV-16：allowStale 生效', () => {
  const CACHE_KEY = 'epgv2:A:nm:湖南卫视:2026-11-06';

  async function seedExpiredCache(): Promise<void> {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockResolvedValueOnce(HUNAN_XML);
    const fresh = await epgService.programmesFor(HUNAN_CHANNEL, DATE, { sourceIds: ['A'] });
    expect(fresh.programmes).toHaveLength(1);
    const record = await cacheRepo.getEpgRecord(CACHE_KEY, { allowExpired: true });
    expect(record).not.toBeNull();
    await cacheRepo.putEpgRecord({
      ...record!,
      fetchedAt: Date.now() - EPG_CACHE_TTL_MS - 60_000,
    });
    resetEpgInFlightForTest();
    requestMock.mockReset();
    requestMock.mockRejectedValue(new Error('E_NETWORK: 源不可达'));
  }

  it('默认（allowStale !== false）→ 网络失败回落到过期缓存并置 stale', async () => {
    await seedExpiredCache();
    const result = await epgService.programmesFor(HUNAN_CHANNEL, DATE, { sourceIds: ['A'] });
    expect(result.stale).toBe(true);
    expect(result.programmes).toHaveLength(1);
    expect(result.errors).toEqual([]);
  });

  it('allowStale=false → 不回落到过期缓存，错误上报到 errors', async () => {
    await seedExpiredCache();
    const result = await epgService.programmesFor(HUNAN_CHANNEL, DATE, {
      sourceIds: ['A'],
      allowStale: false,
    });
    expect(result.stale).toBe(false);
    expect(result.programmes).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourceId).toBe('A');
  });
});

describe('REV-17：失败源 5 分钟退避', () => {
  it('首次失败后，后续合并直接跳过该源（不再发请求/等超时）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    await epgSourceRepo.save(sourceOf({ id: 'B', priority: 2 }));
    requestMock.mockImplementation(async (url: string) => {
      if (url.includes('/A')) throw new Error('E_NETWORK: A 源挂了');
      return HUNAN_XML;
    });

    const first = await epgService.programmesFor(HUNAN_CHANNEL, DATE, {
      sourceIds: ['A', 'B'],
    });
    expect(first.matchedSource?.id).toBe('B');
    expect(first.errors.map((item) => item.sourceId)).toEqual(['A']);
    expect(requestMock).toHaveBeenCalledTimes(2);

    // 换一天（避开 24h 缓存与 in-flight 键），A 仍处于退避期 → 只请求 B
    const second = await epgService.programmesFor(HUNAN_CHANNEL, NEXT_DATE, {
      sourceIds: ['A', 'B'],
    });
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(second.errors).toEqual([]);
  });

  it('resetEpgInFlightForTest 同时清空退避表（测试隔离）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockRejectedValue(new Error('E_NETWORK: A 源挂了'));

    const failed = await epgService.programmesFor(HUNAN_CHANNEL, DATE, { sourceIds: ['A'] });
    expect(failed.errors).toHaveLength(1);
    expect(requestMock).toHaveBeenCalledTimes(1);

    resetEpgInFlightForTest();
    await epgService.programmesFor(HUNAN_CHANNEL, NEXT_DATE, { sourceIds: ['A'] });
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
