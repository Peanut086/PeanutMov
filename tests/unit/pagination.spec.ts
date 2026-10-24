import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveHasMore } from '@/sources/base/pagination';
import { SiteAdapter } from '@/sources/site/SiteAdapter';
import type { Source } from '@/types';

/**
 * CHG-14：分页 hasMore 推导
 *
 * 根因回归：CMS/jar 源每页实际返回 20~25 条，与前端 PAGE_SIZE(30) 不一致，
 * 旧推导 `page * 前端pageSize < total` 在第 2 页后提前判"没有更多"，
 * 表现为上滑只加载到第二页。
 */
function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-site',
    key: 'src-site',
    name: '站点源',
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 1,
    baseUrl: 'https://site.example.com/api.php/provide/vod/',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** 服务端每页 20 行，共 total 行 */
function tvboxBody(total: number, rowCount = 20): string {
  return JSON.stringify({
    code: 1,
    total,
    page: 1,
    pagecount: Math.ceil(total / 20),
    limit: '20',
    list: Array.from({ length: rowCount }, (_, i) => ({
      vod_id: i + 1,
      vod_name: `影片${i + 1}`,
      vod_play_from: '线路1',
      vod_play_url: `第1集$https://cdn.example.com/${i + 1}.m3u8`,
    })),
  });
}

describe('deriveHasMore', () => {
  it('pagecount 优先：page < pagecount', () => {
    expect(deriveHasMore({ page: 2, rawCount: 20, total: null, pageCount: 3 })).toBe(true);
    expect(deriveHasMore({ page: 3, rawCount: 20, total: null, pageCount: 3 })).toBe(false);
  });

  it('无 pagecount 有 total：用本页实际行数估算（服务端每页 20、共 45 条，第 2 页仍有更多）', () => {
    expect(deriveHasMore({ page: 2, rawCount: 20, total: 45, pageCount: null })).toBe(true);
    // 短末页会低估（3×5<45 → true，多探测一页），但空页必须停（rawCount=0 守卫）
    expect(deriveHasMore({ page: 3, rawCount: 5, total: 45, pageCount: null })).toBe(true);
    expect(deriveHasMore({ page: 4, rawCount: 0, total: 45, pageCount: null })).toBe(false);
  });

  it('无 pagecount 无 total：本页有数据即继续，空页停止', () => {
    expect(deriveHasMore({ page: 2, rawCount: 20, total: null, pageCount: null })).toBe(true);
    expect(deriveHasMore({ page: 3, rawCount: 0, total: null, pageCount: null })).toBe(false);
  });

  it('total/pageCount 都为 0（空分类）→ false', () => {
    expect(deriveHasMore({ page: 1, rawCount: 0, total: 0, pageCount: 0 })).toBe(false);
  });
});

describe('SiteAdapter.browse hasMore（CHG-14 回归）', () => {
  const adapter = new SiteAdapter();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('total=45、服务端每页 20 条：第 2 页 hasMore=true（旧推导会误判 false）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(tvboxBody(45), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await adapter.browse({
      source: makeSource(),
      categoryId: null,
      filters: { type: null, area: null, yearFrom: null, yearTo: null },
      page: 2,
      pageSize: 30,
      signal: undefined,
    });
    expect(result.items).toHaveLength(20);
    expect(result.hasMore).toBe(true);
  });

  it('末页（第 3 页 5 条）hasMore=false', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(tvboxBody(45, 5), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const result = await adapter.browse({
      source: makeSource(),
      categoryId: null,
      filters: { type: null, area: null, yearFrom: null, yearTo: null },
      page: 3,
      pageSize: 30,
      signal: undefined,
    });
    expect(result.items).toHaveLength(5);
    expect(result.hasMore).toBe(false);
  });
});
