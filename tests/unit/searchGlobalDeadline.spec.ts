/**
 * P3-2：全局搜索窗口必须真的收口「已经在跑的那一路」
 *
 * 真机实测（96 源全量订阅包）：一轮聚合搜索跑到 44.8s 才收敛，而设置页承诺「总窗口 28s」。
 * 原因是旧写法只把全局截止当作「要不要再领一个新源」的判据，领到手的源照样跑满自己那笔
 * 预算（站点 8s / 爬虫 20s，冷 jar 另加 45s 加载余量）——最后一批在 27.9s 领到，再各跑 20s。
 *
 * 现在按剩余预算钳制单源计时器，只保留 `SEARCH_BUDGET_MIN_MS` 的收尾下限；被打断的源仍抛
 * E_TIMEOUT 进 failed（不是 skipped），所以「重试失败源」这条路还在。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { sourceService } from '@/services/sourceService';
import { sourceRegistry } from '@/sources/registry';
import { TIMEOUT_SEARCH_SITE_MS } from '@/shared/constants';
import { AppError } from '@/shared/errors';
import type { AppErrorShape } from '@/types';
import type { MediaItem, SearchParams, SearchResult } from '@/types';

import { resetAll } from './helpers';

/**
 * 永远不返回、只在 abort 时 reject 的适配器：模拟「源还在跑」而不是「源跑完了」。
 * 顺便记下每一路被领取的时刻，用来判断它是窗口之前还是之后领到的。
 */
function hangUntilAborted(startedAt: number[]): (params: SearchParams) => Promise<MediaItem[]> {
  return (params) =>
    new Promise<MediaItem[]>((_resolve, reject) => {
      startedAt.push(Date.now());
      params.signal?.addEventListener('abort', () => reject(new AppError('E_ABORTED')), { once: true });
    });
}

interface Round {
  /** 每路源 settle 时的部分回调（渐进上屏那条链） */
  partials: Array<{ sourceId: string; error: AppErrorShape | null; done: number; total: number }>;
  /** 整轮是否已落地 + 落地那一刻的时钟；窗口处只收口在飞的路，不等于整轮结束 */
  over: { done: boolean; endedAt: number; result: SearchResult | null; thrown: AppError | null };
}

/** 起一轮扇出但不 await 它——需要在中途看时钟走到哪一步 */
function startRound(sourceIds: string[]): Round {
  const partials: Round['partials'] = [];
  const over: Round['over'] = { done: false, endedAt: 0, result: null, thrown: null };
  void libraryService
    .search({
      keyword: '绝命毒师',
      sourceIds,
      onPartial: (p) =>
        partials.push({ sourceId: p.sourceId, error: p.error, done: p.done, total: p.total }),
    })
    .then(
      (result) => {
        over.done = true;
        over.endedAt = Date.now();
        over.result = result;
      },
      (e: unknown) => {
        // 全部源失败时 search 是抛错返回的（OPT-13）
        over.done = true;
        over.endedAt = Date.now();
        over.thrown = e instanceof AppError ? e : null;
      },
    );
  return { partials, over };
}

async function createSiteSource(name: string, extTimeoutSec?: number) {
  return sourceService.create({
    name,
    type: 'site',
    baseUrl: `https://${name}.example.com`,
    ...(extTimeoutSec ? { ext: { timeout: extTimeoutSec } } : {}),
  });
}

describe('全局搜索窗口收口在飞单源（P3-2）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('单源自报 30s、窗口 28s：在第 28 秒被窗口打断，文案点明是窗口而不是它自己跑完', async () => {
    const slow = await createSiteSource('慢源', 30);
    // `resetAll()` 会重建适配器实例，引用必须在它之后取才拦得住
    const siteAdapter = sourceRegistry.get('site');
    const startedAt: number[] = [];
    vi.spyOn(siteAdapter, 'search').mockImplementation(hangUntilAborted(startedAt));

    vi.useFakeTimers();
    const t0 = Date.now();
    const round = startRound([slow.id]);
    await vi.advanceTimersByTimeAsync(32_000);

    expect(startedAt).toHaveLength(1);
    expect(round.over.done).toBe(true);
    expect(round.partials).toHaveLength(1);
    const failed = round.partials[0];
    expect(failed?.error?.code).toBe('E_TIMEOUT');
    expect(failed?.error?.message).toContain('本轮搜索窗口到期');
    expect(failed?.error?.message).toContain('28 秒');
    // 旧行为：这一路一直跑到第 30 秒，报「搜索超时（30 秒）」
    expect(failed?.error?.message).not.toContain('搜索超时');
    // 被窗口打断 ≠ 没领取：仍计入 done，进度不会停在 0/1
    expect(failed?.done).toBe(1);
    expect(failed?.total).toBe(1);
    // 全失败态把同一个原因带进错误里，「重试失败源」仍然看得到这一路
    expect(round.over.thrown?.code).toBe('E_TIMEOUT');
    expect(round.over.thrown?.meta?.failedSourceIds).toEqual([slow.id]);
    // 收口时刻：窗口 28s + 收尾下限 3s，而不是单源自报的 30s 之后
    expect(round.over.endedAt - t0).toBeLessThanOrEqual(31_000);
  });

  it('未超窗口的源保持原样：8 秒预算到期仍报「搜索超时（8 秒）」', async () => {
    const normal = await createSiteSource('普通源');
    const siteAdapter = sourceRegistry.get('site');
    const startedAt: number[] = [];
    vi.spyOn(siteAdapter, 'search').mockImplementation(hangUntilAborted(startedAt));

    vi.useFakeTimers();
    const round = startRound([normal.id]);
    await vi.advanceTimersByTimeAsync(TIMEOUT_SEARCH_SITE_MS - 1_000);
    // 单源预算（8s）比窗口先到，窗口不该抢先打断它
    expect(round.partials).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(round.partials[0]?.error?.message).toBe(
      `搜索超时（${Math.round(TIMEOUT_SEARCH_SITE_MS / 1000)} 秒）`,
    );
    expect(round.partials[0]?.error?.message).not.toContain('本轮搜索窗口到期');
  });

  it('窗口内正常的源不受影响：结果照常上屏', async () => {
    const quick = await createSiteSource('快源');
    const siteAdapter = sourceRegistry.get('site');
    const item = {
      id: 'site:quick-1',
      sourceId: quick.id,
      title: '绝命毒师',
      type: 'series',
    } as unknown as MediaItem;
    vi.spyOn(siteAdapter, 'search').mockResolvedValue([item]);

    vi.useFakeTimers();
    const round = startRound([quick.id]);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(round.over.thrown).toBeNull();
    expect(round.over.result?.failed).toEqual([]);
    expect(round.over.result?.items.map((i) => i.title)).toContain('绝命毒师');
  });

  it('最后一批在窗口边界才领到：只给 3s 收尾下限，整轮最坏「窗口 + 3s」结束', async () => {
    // 9 个 30s 慢源 + 并发 8 ⇒ 第 9 路只能在第一批于窗口处收口之后才领到
    const ids: string[] = [];
    for (let i = 0; i < 9; i += 1) ids.push((await createSiteSource(`慢源${i}`, 30)).id);
    const siteAdapter = sourceRegistry.get('site');
    const startedAt: number[] = [];
    vi.spyOn(siteAdapter, 'search').mockImplementation(hangUntilAborted(startedAt));

    vi.useFakeTimers();
    const t0 = Date.now();
    const round = startRound(ids);
    // 扇出起跑比调用时刻晚几毫秒（本地库读），多给一拍才跨过第一批的到期点
    await vi.advanceTimersByTimeAsync(28_000 + 200);
    // 收口与「领下一个源」都排在微任务链上，空转一拍让它们落地
    await vi.advanceTimersByTimeAsync(0);

    // 前 8 路在窗口处收口，第 9 路此刻才领到：整轮还没结束
    expect(startedAt).toHaveLength(9);
    expect(startedAt[8] ?? 0).toBe(startedAt[0] + 28_000);
    expect(round.partials).toHaveLength(8);
    expect(round.over.done).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(round.over.done).toBe(true);
    expect(round.partials).toHaveLength(9);
    for (const p of round.partials) {
      expect(p.error?.message).toContain('本轮搜索窗口到期');
      expect(p.error?.message).not.toContain('搜索超时');
    }
    // 旧行为：第 9 路从 28s 起再跑满 30s，整轮要到 58s
    expect(round.over.endedAt - (startedAt[0] ?? t0)).toBeLessThanOrEqual(31_000);
  });
});
