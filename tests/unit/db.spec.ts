import { beforeEach, describe, expect, it } from 'vitest';

import { closeDb, deleteDatabase, getDb, resetDbConnection, withTx } from '@/db/index';
import { STORE_NAMES } from '@/db/schema';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { AppError } from '@/shared/errors';
import { COMPLIANCE_VERSION } from '@/shared/constants';
import type { Source } from '@/types';

import { resetAll } from './helpers';

function makeSource(overrides: Partial<Source> = {}): Source {
  const now = Date.now();
  return {
    id: overrides.id ?? 'source-1',
    key: overrides.key ?? 'source-1',
    name: overrides.name ?? '测试源',
    type: overrides.type ?? 'alist',
    enabled: overrides.enabled ?? true,
    builtin: overrides.builtin ?? false,
    sort: overrides.sort ?? 0,
    baseUrl: overrides.baseUrl ?? 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('DB 表结构与事务（AC-14）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('v3 建表：13 个 store（含 lives / danmakuCache / epgCache）与全部索引均存在', async () => {
    const db = await getDb();
    const stores = [...db.objectStoreNames].sort();
    expect(stores).toEqual(
      [
        'blobs',
        'categories',
        'danmakuCache',
        'downloads',
        'epgCache',
        'episodes',
        'favorites',
        'history',
        'kv',
        'lives',
        'lines',
        'media',
        'sources',
      ].sort(),
    );

    const tx = db.transaction(['sources', 'media', 'episodes', 'downloads', 'lives'], 'readonly');
    expect([...tx.objectStore('sources').indexNames].sort()).toEqual(
      ['by-enabled', 'by-key', 'by-sort', 'by-type'].sort(),
    );
    expect([...tx.objectStore('media').indexNames].sort()).toEqual(
      ['by-cached', 'by-demo', 'by-source', 'by-source-updated', 'by-title', 'by-type'].sort(),
    );
    expect([...tx.objectStore('episodes').indexNames].sort()).toEqual(
      ['by-line', 'by-media', 'by-media-number', 'by-source'].sort(),
    );
    expect([...tx.objectStore('downloads').indexNames].sort()).toEqual(
      ['by-created', 'by-media', 'by-priority', 'by-status'].sort(),
    );
    expect([...tx.objectStore('lives').indexNames].sort()).toEqual(['by-created']);
    await tx.done;
  });

  it('by-key 唯一索引阻止重复 key 写入', async () => {
    await sourceRepo.save(makeSource({ id: 'a', key: 'dup' }));
    await expect(sourceRepo.save(makeSource({ id: 'b', key: 'dup' }))).rejects.toMatchObject({
      code: 'E_DB',
    });
    expect(await sourceRepo.count()).toBe(1);
  });

  it('事务回滚：批量写入中途失败不留下部分数据', async () => {
    const good = makeSource({ id: 'a', key: 'a' });
    const bad = makeSource({ id: 'b', key: 'a' }); // 与上一条 key 冲突
    await expect(
      withTx(['sources'], 'readwrite', async (tx) => {
        const store = tx.objectStore(STORE_NAMES.sources);
        await store.put(good);
        await store.put(bad);
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(await sourceRepo.count()).toBe(0);
  });

  it('sourceRepo.list 演示源恒排最后', async () => {
    await sourceRepo.saveMany([
      makeSource({ id: 'demo', key: 'demo', builtin: true, sort: 9999 }),
      makeSource({ id: 'z', key: 'z', sort: 5 }),
      makeSource({ id: 'a', key: 'a', sort: 1 }),
    ]);
    const list = await sourceRepo.list();
    expect(list.map((source) => source.id)).toEqual(['a', 'z', 'demo']);
  });

  it('删除数据库后重新打开会重建所有 store（升级函数可重复执行）', async () => {
    await closeDb();
    await deleteDatabase();
    resetDbConnection();
    const db = await getDb();
    expect([...db.objectStoreNames].length).toBe(13);
    expect(await sourceRepo.count()).toBe(0);
  });

  it('kv 表可存设置对象（含合规版本）', async () => {
    await withTx(['kv'], 'readwrite', async (tx) => {
      await tx.objectStore('kv').put({
        key: 'app-settings',
        value: { complianceVersion: COMPLIANCE_VERSION },
        updatedAt: Date.now(),
      });
    });
    const row = await withTx(['kv'], 'readonly', (tx) => tx.objectStore('kv').get('app-settings'));
    expect(row?.value).toEqual({ complianceVersion: COMPLIANCE_VERSION });
  });

  it('mediaRepo 按源分页与标题搜索可用', async () => {
    const now = Date.now();
    const items = Array.from({ length: 35 }, (_, i) => ({
      id: `demo:m${i}`,
      sourceId: 'demo',
      sourceItemId: `m${i}`,
      title: `影片 ${i}`,
      originalTitle: null,
      type: 'movie' as const,
      year: 2020,
      area: '中国',
      genres: [],
      tags: [],
      rating: null,
      posterUrl: null,
      backdropUrl: null,
      description: null,
      durationSec: null,
      episodeCount: null,
      titleLower: `影片 ${i}`,
      isDemo: true,
      cachedAt: now,
      updatedAt: now + i,
    }));
    await mediaRepo.upsertMany(items);
    const firstPage = await mediaRepo.listBySource('demo', { limit: 30, offset: 0 });
    expect(firstPage).toHaveLength(30);
    // updatedAt 倒序：最大的 m34 在最前
    expect(firstPage[0]?.id).toBe('demo:m34');

    const searched = await mediaRepo.searchByTitle('影片 3');
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every((item) => item.titleLower.includes('影片 3'))).toBe(true);
  });
});
