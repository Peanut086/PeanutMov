import { beforeEach, describe, expect, it } from 'vitest';

import { closeDb, deleteDatabase, getDb, resetDbConnection, withTx } from '@/db/index';
import { STORE_NAMES } from '@/db/schema';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { AppError } from '@/shared/errors';
import { COMPLIANCE_VERSION } from '@/shared/constants';
import type { MediaItem, Source } from '@/types';

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

  it('建表：17 个 store（v3 的 13 个 + epgSources / channelPrefs / reminders / subscriptions）与全部索引均存在', async () => {
    const db = await getDb();
    const stores = [...db.objectStoreNames].sort();
    expect(stores).toEqual(
      [
        'blobs',
        'categories',
        'channelPrefs',
        'danmakuCache',
        'downloads',
        'epgCache',
        'epgSources',
        'episodes',
        'favorites',
        'history',
        'kv',
        'lives',
        'lines',
        'media',
        'reminders',
        'sources',
        'subscriptions',
      ].sort(),
    );

    const tx = db.transaction(
      [
        'sources',
        'media',
        'episodes',
        'downloads',
        'history',
        'lives',
        'epgSources',
        'channelPrefs',
        'reminders',
        'subscriptions',
      ],
      'readonly',
    );
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
    // v5 新增 history.by-media：自愈按 mediaId 查历史，不再全表读
    expect([...tx.objectStore('history').indexNames].sort()).toEqual(
      ['by-media', 'by-source', 'by-updated'].sort(),
    );
    expect([...tx.objectStore('lives').indexNames].sort()).toEqual(['by-created']);
    // EXT-06（DB v4）新增索引
    expect([...tx.objectStore('epgSources').indexNames].sort()).toEqual(
      ['by-enabled', 'by-priority'].sort(),
    );
    expect([...tx.objectStore('channelPrefs').indexNames].sort()).toEqual(['by-updated']);
    expect([...tx.objectStore('reminders').indexNames].sort()).toEqual(
      ['by-channel', 'by-notifyAt', 'by-state'].sort(),
    );
    // v7（P1-2）新增 subscriptions：主键由来源标识派生，量级只有几十条，刻意不建索引
    expect([...tx.objectStore('subscriptions').indexNames]).toEqual([]);
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
    expect([...db.objectStoreNames].length).toBe(17);
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

    const { items: searched } = await mediaRepo.searchByTitle('影片 3');
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every((item) => item.titleLower.includes('影片 3'))).toBe(true);
  });

  it('mediaRepo 本地搜索按主演命中要显式开启（搜索页开、换源候选不开）', async () => {
    const now = Date.now();
    const mk = (n: number, title: string, actors: string[]): MediaItem => ({
      id: `demo:a${n}`,
      sourceId: 'demo',
      sourceItemId: `a${n}`,
      title,
      originalTitle: null,
      type: 'movie',
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
      titleLower: title.toLowerCase(),
      actors,
      isDemo: false,
      cachedAt: now,
      updatedAt: now,
    });
    await mediaRepo.upsertMany([mk(1, '飞驰人生', ['沈腾', '尹正']), mk(2, '独行月球', ['沈腾'])]);

    const { items: byActor } = await mediaRepo.searchByTitle('沈腾', 10, { matchActors: true });
    expect(byActor.map((item) => item.id).sort()).toEqual(['demo:a1', 'demo:a2']);

    // 默认口径不变：换源候选那条路径仍只认片名
    expect((await mediaRepo.searchByTitle('沈腾')).items).toEqual([]);
    // 单字查询不放开演员比对
    expect((await mediaRepo.searchByTitle('腾', 10, { matchActors: true })).items).toEqual([]);
  });

  /**
   * P1-4：子串阶段的召回口径（实测后维持主键序）
   *
   * 集合口径是硬约束：limit 够大时子串阶段必须与全表扫等价，一条不漏。
   * 截断时给的是 id 序的前几条而不是「最近缓存的那批」——这是刻意保留的取舍：
   * 沿 `by-cached` 倒序扫同样要在 limit 处收口（扫描深度不降），而索引游标每步多一次
   * 主键回表，2 万条语料受控 A/B 实测 +27%~32%，故否决。下面第二条用例把这个结论钉住。
   */
  it('mediaRepo 子串阶段：召回集合与全表扫等价，截断按主键序（by-cached 倒序已被实测否决）', async () => {
    const base = 1_700_000_000_000;
    const mk = (n: number, title: string, cachedAt: number): MediaItem => ({
      id: `demo:s${n}`,
      sourceId: 'demo',
      sourceItemId: `s${n}`,
      title,
      originalTitle: null,
      type: 'series',
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
      cachedAt,
      updatedAt: cachedAt,
    });

    // 「第 N 季」全部以「第」开头：前缀阶段一条不命中，只能走子串阶段
    const matched = Array.from({ length: 30 }, (_, i) => mk(i, `第 ${i + 1} 季`, base + i));
    const recent = Array.from({ length: 5 }, (_, i) => mk(100 + i, `新缓存 ${i + 1} 季`, base + 1000 + i));
    const noise = Array.from({ length: 10 }, (_, i) => mk(200 + i, `无关影片 ${i + 1}`, base + 500 + i));
    await mediaRepo.upsertMany([...matched, ...recent, ...noise]);

    const { items: everything, truncated: everythingTruncated } = await mediaRepo.searchByTitle('季', 100);
    expect(everythingTruncated).toBe(false);
    expect(everything.map((item) => item.id).sort()).toEqual(
      [...matched, ...recent].map((item) => item.id).sort(),
    );

    // 截断给主键序的前 3 条；by-cached 倒序会给 s104/s103/s102（最新缓存），已被实测否决
    const { items: top3 } = await mediaRepo.searchByTitle('季', 3);
    expect(top3.map((item) => item.id)).toEqual(['demo:s0', 'demo:s1', 'demo:s10']);

    // 前缀阶段与子串阶段共用 seen 去重：既命中前缀又含子串的条目不重复出现
    await mediaRepo.upsertMany([mk(300, '季节 变化', base + 2000), mk(301, '跨 季', base + 2001)]);
    const { items: both } = await mediaRepo.searchByTitle('季', 50);
    expect(both.map((item) => item.id).filter((id) => id === 'demo:s300')).toHaveLength(1);
  });
});
