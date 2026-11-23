/**
 * OPT-21：本地子串扫描的时间预算
 *
 * 真机标定（华为 DCO-AL00 / Android 12 / WebView Chrome 132）：子串兜底这一趟 60~64 µs/行，
 * 整表扫 2 万行 1.19 s、10 万行外推约 5.9 s，而它串在远程扇出之前。闸门因此只挂在这一趟：
 * - 前缀阶段凑满 `limit` 时整趟不进入，一次钟都不取；
 * - 被预算收口时丢掉的是**主键序靠后的一段**（= 整片源），不是均匀尾批，所以 `truncated`
 *   必须一路传到屏幕，否则「库里其实有」会被读成「没搜到」。
 *
 * 时钟用假 `performance.now()`（与播放器用例同一手法）：每取一次钟推进固定步长，
 * 「扫到第几行停下」从概率变成可断言的整数。
 */
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mediaRepo } from '@/db/repositories/mediaRepo';
import { libraryService } from '@/services/libraryService';
import { settingsService } from '@/services/settingsService';
import { useLibraryStore } from '@/stores/libraryStore';
import { AppError } from '@/shared/errors';
import { SEARCH_SUBSTRING_BUDGET_MS, SEARCH_SUBSTRING_CHECK_ROWS } from '@/shared/constants';
import type { MediaItem, SearchResult } from '@/types';

import { resetAll } from './helpers';

const FIXED = 1_700_000_000_000;

function mk(n: number, title: string): MediaItem {
  const id = `demo:s${String(n).padStart(4, '0')}`;
  return {
    id,
    sourceId: 'demo',
    sourceItemId: `s${n}`,
    title,
    originalTitle: null,
    type: 'movie',
    year: 2024,
    area: null,
    genres: [],
    tags: [],
    rating: null,
    posterUrl: null,
    backdropUrl: null,
    description: null,
    durationSec: null,
    episodeCount: null,
    titleLower: title.toLowerCase(),
    isDemo: false,
    cachedAt: FIXED + n,
    updatedAt: FIXED + n,
  };
}

/** 前 n 行为无关片名、尾部 `tail` 行才含「大结局」的语料（主键序 = 写入序） */
async function seedTail(n: number, tail: number): Promise<void> {
  const rows: MediaItem[] = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(mk(i, i >= n - tail ? `影片 ${i} 大结局` : `影片 ${i} 平凡生活`));
  }
  await mediaRepo.upsertMany(rows);
}

/** 每取一次钟前进 stepMs（stepMs=0 ⇒ 时间永不流逝），并回报取钟次数 */
function fakeClock(stepMs: number): { calls: () => number } {
  let calls = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    calls += 1;
    return calls * stepMs;
  });
  return { calls: () => calls };
}

describe('OPT-21：子串扫描闸门', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('前缀阶段凑满 limit：子串那一趟根本不进入，一次钟都不取', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => mk(i, `庆余年 第 ${i + 1} 季`));
    await mediaRepo.upsertMany(rows);
    const clock = fakeClock(10_000);

    const scan = await mediaRepo.searchByTitle('庆余');
    expect(scan.items).toHaveLength(50);
    expect(scan.visited).toBe(0);
    expect(scan.truncated).toBe(false);
    // 浅层路径不得变慢：闸门连 startedAt 都不该取
    expect(clock.calls()).toBe(0);
  });

  it('语料不足一个检查粒度（255 行）：预算再紧也不会截断，召回与不启用闸门逐条等价', async () => {
    await seedTail(255, 20);
    const clock = fakeClock(10_000);

    const scan = await mediaRepo.searchByTitle('大结局');
    expect(scan.items).toHaveLength(20);
    expect(scan.truncated).toBe(false);
    expect(scan.visited).toBe(255);
    expect(clock.calls()).toBe(1);
  });

  it('跨过预算时恰好在第 256 行收口：丢的是靠后整段，一条不剩', async () => {
    await seedTail(300, 20);
    fakeClock(1_000);

    const scan = await mediaRepo.searchByTitle('大结局');
    expect(scan.visited).toBe(SEARCH_SUBSTRING_CHECK_ROWS);
    expect(scan.truncated).toBe(true);
    // 尾部 20 条命中全在主键序 280~299，被截断后一条都拿不到 —— 这就是必须披露的那件事
    expect(scan.items).toHaveLength(0);
  });

  it('同样的语料、时间不流逝：与不启用闸门完全等价（20 条尾部命中全回来）', async () => {
    await seedTail(300, 20);
    fakeClock(0);

    const scan = await mediaRepo.searchByTitle('大结局');
    expect(scan.truncated).toBe(false);
    expect(scan.visited).toBe(300);
    expect(scan.items.map((item) => item.id)).toEqual([
      ...Array.from({ length: 20 }, (_, i) => `demo:s${String(280 + i).padStart(4, '0')}`),
    ]);
  });

  it('取钟频率钉死在每 256 行一次（1000 行 = 1 次起点 + 3 次检查）', async () => {
    await seedTail(1000, 0);
    const clock = fakeClock(0);

    const scan = await mediaRepo.searchByTitle('大结局');
    expect(scan.visited).toBe(1000);
    expect(scan.truncated).toBe(false);
    expect(clock.calls()).toBe(1 + Math.floor(1000 / SEARCH_SUBSTRING_CHECK_ROWS));
  });

  it('预算值本身可核对：步长 100 ms 时要到第 4 次取钟才够 250 ms', async () => {
    await seedTail(1000, 0);
    fakeClock(Math.ceil(SEARCH_SUBSTRING_BUDGET_MS / 3) + 1);

    const scan = await mediaRepo.searchByTitle('大结局');
    expect(scan.truncated).toBe(true);
    // 起点 85 ms，第 2/3 次检查（170/255）过 85/170 ms 都不够，第 4 次过 255 ms 才越过 250 ms 预算
    expect(scan.visited).toBe(SEARCH_SUBSTRING_CHECK_ROWS * 3);
  });

  it('真链路：libraryService.search 把截断带回 SearchResult.localTruncated', async () => {
    await seedTail(300, 20);
    fakeClock(1_000);
    const truncated = await libraryService.search({ keyword: '大结局' });
    expect(truncated.localTruncated).toBe(true);

    vi.restoreAllMocks();
    fakeClock(0);
    const full = await libraryService.search({ keyword: '大结局' });
    expect(full.localTruncated).toBe(false);
    expect(full.items.length).toBeGreaterThan(0);
  });
});

describe('OPT-21：截断状态在 store 层的口径', () => {
  function result(overrides: Partial<SearchResult>): SearchResult {
    return {
      items: [],
      sourceIds: [],
      failed: [],
      candidates: 3,
      filteredOut: 0,
      skippedSourceIds: [],
      localTruncated: false,
      ...overrides,
    };
  }

  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('随结果带回，新一轮搜索开始时清零', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search').mockResolvedValue(result({ localTruncated: true }));
    await store.search('甲');
    expect(store.searchLocalTruncated).toBe(true);

    vi.spyOn(libraryService, 'search').mockResolvedValue(result({ localTruncated: false }));
    await store.search('乙');
    expect(store.searchLocalTruncated).toBe(false);
  });

  it('全源失败是抛错返回的，截断要从 meta 里捞回来', async () => {
    const store = useLibraryStore();
    vi.spyOn(libraryService, 'search').mockRejectedValue(
      new AppError('E_NETWORK', '全部源搜索失败', { meta: { skippedSourceIds: ['s9'], localTruncated: true } }),
    );
    await store.search('甲');
    expect(store.searchState).toBe('error');
    expect(store.searchLocalTruncated).toBe(true);
  });

  it('「继续搜索剩余」把截断只置真、不置假', async () => {
    const store = useLibraryStore();
    store.searchKeyword = '甲';
    store.searchSkippedIds = ['s9'];
    vi.spyOn(libraryService, 'search').mockResolvedValue(result({ localTruncated: true }));
    await store.continueSearchSkipped();
    expect(store.searchLocalTruncated).toBe(true);
  });
});
