import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sourceService } from '@/services/sourceService';
import { healthService } from '@/services/healthService';
import { settingsService } from '@/services/settingsService';
import { episodeRepo } from '@/db/repositories/episodeRepo';
import { favoriteRepo } from '@/db/repositories/favoriteRepo';
import { historyRepo } from '@/db/repositories/historyRepo';
import { lineRepo } from '@/db/repositories/lineRepo';
import { mediaRepo } from '@/db/repositories/mediaRepo';
import { categoryRepo } from '@/db/repositories/categoryRepo';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { appEvents } from '@/services/events';
import { DEMO_SOURCE_ID, DEMO_SOURCE_SORT } from '@/data/demo/demoSeed';
import { DEMO_ITEMS } from '@/data/demo/demoCatalog';
import { AppError, ERROR_MESSAGES } from '@/shared/errors';
import { TIMEOUT_TEST_CONNECTION_MS } from '@/shared/constants';
import { categoryIdFor } from '@/sources/base/normalize';
import { DEFAULT_HTTP_TIMEOUT_MS, httpClient, httpRequest, probeTimeoutFor } from '@/sources/base/httpClient';
import { mediaIdOf, lineIdOf, episodeIdOf, historyIdOf } from '@/shared/id';
import type { FavoriteRecord, HistoryRecord, MediaItem, Source } from '@/types';

import { resetAll } from './helpers';

async function createAlist(name: string, baseUrl = 'https://alist.example.com', key?: string): Promise<Source> {
  return sourceService.create({
    name,
    type: 'alist',
    baseUrl,
    key,
    ext: { username: 'u', password: 'p' },
  });
}

describe('源服务（AC-03 ~ AC-07）', () => {
  beforeEach(async () => {
    await resetAll();
    settingsService.__resetCache();
  });

  it('create：名称/地址校验、地址归一化、默认启用、按 sort 排序（AC-04、AC-05）', async () => {
    const a = await createAlist('源 A', 'https://Alist.Example.com/');
    expect(a.baseUrl).toBe('https://alist.example.com');
    expect(a.enabled).toBe(true);
    expect(a.builtin).toBe(false);
    expect(a.health).toBe('unknown');
    expect(a.key.length).toBeGreaterThan(0);

    const b = await createAlist('源 B');
    expect(b.name).toBe('源 B');
    const list = await sourceService.list();
    expect(list.map((s) => s.name)).toEqual(['源 A', '源 B']);

    await expect(sourceService.create({ name: '', type: 'alist', baseUrl: 'https://a.com' })).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });

    const longName = 'x'.repeat(31);
    await expect(
      sourceService.create({ name: longName, type: 'alist', baseUrl: 'https://a.com' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });

    await expect(
      sourceService.create({ name: 'ftp 源', type: 'alist', baseUrl: 'ftp://x' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });

  it('名称 30 字可保存（边界，AC-05）', async () => {
    const name = '名'.repeat(30);
    const created = await createAlist(name);
    expect(created.name).toHaveLength(30);
  });

  it('key 冲突抛 E_INVALID_INPUT（AC-04）', async () => {
    await createAlist('源 A', 'https://a.example.com', 'same-key');
    await expect(createAlist('源 B', 'https://b.example.com', 'same-key')).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
  });

  it('update：改名与地址变化会重置健康并清空缓存；内置源类型不可改', async () => {
    const created = await createAlist('源 A');
    const now = Date.now();
    const mediaId = mediaIdOf(created.id, 'm1');
    const media: MediaItem = {
      id: mediaId,
      sourceId: created.id,
      sourceItemId: 'm1',
      title: '缓存影片',
      originalTitle: null,
      type: 'movie',
      year: 2020,
      area: null,
      genres: [],
      tags: [],
      rating: null,
      posterUrl: null,
      backdropUrl: null,
      description: null,
      durationSec: null,
      episodeCount: 1,
      titleLower: '缓存影片',
      isDemo: false,
      cachedAt: now,
      updatedAt: now,
    };
    await mediaRepo.save(media);
    await categoryRepo.replaceForSource(created.id, [
      { id: categoryIdFor(created.id, 'movie'), sourceId: created.id, name: '电影', value: 'movie', order: 0 },
    ]);
    await lineRepo.saveMany([
      {
        id: lineIdOf(mediaId, 0),
        mediaId,
        sourceId: created.id,
        name: '线路',
        quality: null,
        format: 'mp4',
        index: 0,
      },
    ]);
    await episodeRepo.saveMany([
      {
        id: episodeIdOf(mediaId, lineIdOf(mediaId, 0), 1),
        mediaId,
        sourceId: created.id,
        lineId: lineIdOf(mediaId, 0),
        number: 1,
        title: '第 1 集',
        durationSec: 100,
        subtitles: [],
        updatedAt: now,
      },
    ]);
    await sourceService.markHealth(created.id, 'ok', null);

    const updated = await sourceService.update(created.id, {
      name: '源 A 改名',
      baseUrl: 'https://alist2.example.com/',
    });
    expect(updated.name).toBe('源 A 改名');
    expect(updated.baseUrl).toBe('https://alist2.example.com');
    expect(updated.health).toBe('unknown');
    expect(await mediaRepo.countBySource(created.id)).toBe(0);
    expect(await categoryRepo.listBySource(created.id)).toHaveLength(0);
  });

  it('内置源保护：不可删除、不可改类型（AC-01、AC-04）', async () => {
    await sourceService.ensureDemoSource();
    await expect(sourceService.remove(DEMO_SOURCE_ID)).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(
      sourceService.update(DEMO_SOURCE_ID, { type: 'alist', baseUrl: 'https://a.com' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    const demo = await sourceService.get(DEMO_SOURCE_ID);
    expect(demo?.builtin).toBe(true);
    expect(demo).not.toBeNull();
  });

  it('演示源排序恒为 9999 且永远在末尾（AC-01）', async () => {
    await createAlist('普通源');
    await sourceService.ensureDemoSource();
    const list = await sourceService.list();
    expect(list[list.length - 1]?.id).toBe(DEMO_SOURCE_ID);
    await sourceService.reorder([list[0]!.id]);
    const demo = await sourceService.get(DEMO_SOURCE_ID);
    expect(demo?.sort).toBe(DEMO_SOURCE_SORT);
  });

  it('disable/enable 改变启用列表且持久化（AC-06）', async () => {
    const a = await createAlist('源 A');
    await sourceService.setEnabled(a.id, false);
    expect((await sourceService.get(a.id))?.enabled).toBe(false);
    expect((await sourceService.list()).filter((s) => s.enabled)).toHaveLength(0);

    await sourceService.setEnabled(a.id, true);
    expect((await sourceService.get(a.id))?.enabled).toBe(true);
  });

  it('默认源被禁用后回退到第一个启用源（AC-07）', async () => {
    const a = await createAlist('源 A');
    const b = await createAlist('源 B');
    await sourceService.setDefault(a.id);
    expect((await sourceService.getDefault())?.id).toBe(a.id);

    await sourceService.setEnabled(a.id, false);
    const fallback = await sourceService.getDefault();
    expect(fallback?.id).toBe(b.id);
  });

  it('默认源为演示源且启用时按设置返回；禁用后回退到普通源（AC-07）', async () => {
    await sourceService.ensureDemoSource();
    await sourceService.setDefault(DEMO_SOURCE_ID);
    const normal = await createAlist('普通源');

    // 显式设置的默认源仍启用 → 尊重用户设置
    expect((await sourceService.getDefault())?.id).toBe(DEMO_SOURCE_ID);

    // 禁用后回退到第一个启用源（普通源优先，演示源排最后）
    await sourceService.setEnabled(DEMO_SOURCE_ID, false);
    expect((await sourceService.getDefault())?.id).toBe(normal.id);
  });

  it('全部源禁用时 getDefault 返回 null（AC-07）', async () => {
    const a = await createAlist('源 A');
    await sourceService.setEnabled(a.id, false);
    expect(await sourceService.getDefault()).toBeNull();
  });

  it('级联删除：清源缓存，收藏标记 sourceRemoved，历史保留（AC-07 / AC-35）', async () => {
    const created = await createAlist('源 A');
    const now = Date.now();
    const mediaId = mediaIdOf(created.id, 'm1');
    await mediaRepo.save({
      id: mediaId,
      sourceId: created.id,
      sourceItemId: 'm1',
      title: '影片',
      originalTitle: null,
      type: 'movie',
      year: 2020,
      area: null,
      genres: [],
      tags: [],
      rating: null,
      posterUrl: null,
      backdropUrl: null,
      description: null,
      durationSec: 100,
      episodeCount: null,
      titleLower: '影片',
      isDemo: false,
      cachedAt: now,
      updatedAt: now,
    });
    const favorite: FavoriteRecord = {
      id: historyIdOf(created.id, mediaId),
      sourceId: created.id,
      mediaId,
      title: '影片',
      posterUrl: null,
      type: 'movie',
      year: 2020,
      sourceRemoved: false,
      createdAt: now,
    };
    await favoriteRepo.save(favorite);
    const historyRecord: HistoryRecord = {
      id: historyIdOf(created.id, mediaId),
      sourceId: created.id,
      mediaId,
      episodeId: null,
      episodeNumber: null,
      title: '影片',
      posterUrl: null,
      positionSec: 30,
      durationSec: 100,
      progress: 0.3,
      finished: false,
      totalEpisodes: null,
      createdAt: now,
      updatedAt: now,
    };
    await historyRepo.save(historyRecord);

    await sourceService.remove(created.id);

    expect(await sourceService.get(created.id)).toBeNull();
    expect(await mediaRepo.countBySource(created.id)).toBe(0);
    const fav = await favoriteRepo.get(favorite.id);
    expect(fav?.sourceRemoved).toBe(true);
    const hist = await historyRepo.get(historyRecord.id);
    expect(hist).not.toBeNull();
  });

  it('移除默认源后设置中的 defaultSourceId 被清空', async () => {
    const a = await createAlist('源 A');
    await sourceService.setDefault(a.id);
    await sourceService.remove(a.id);
    expect((await settingsService.get()).defaultSourceId).toBeNull();
  });

  it('reorder 按给定顺序写入 sort（演示源固定最后）', async () => {
    const a = await createAlist('源 A');
    const b = await createAlist('源 B');
    const c = await createAlist('源 C');
    await sourceService.reorder([c.id, a.id, b.id]);
    const list = await sourceService.list();
    expect(list.map((s) => s.id)).toEqual([c.id, a.id, b.id]);
  });

  it('写操作触发 sources:changed 事件', async () => {
    const events: string[] = [];
    const off = appEvents.on('sources:changed', (payload) => {
      events.push(payload.reason);
    });
    const created = await createAlist('源 A');
    await sourceService.setEnabled(created.id, false);
    await sourceService.update(created.id, { name: '改名' });
    await sourceService.remove(created.id);
    off();
    expect(events).toEqual(['create', 'enable', 'update', 'remove']);
  });

  it('testConnection：地址非法时不发请求，返回 invalid_input', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await sourceService.testConnection({ type: 'alist', baseUrl: 'ftp://bad' });
    expect(result.ok).toBe(false);
    expect(result.health).toBe('bad_config');
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('未注册源类型 testConnection 返回失败而非抛错', async () => {
    const result = await sourceService.testConnection({
      type: 'unknown' as never,
      baseUrl: 'https://a.com',
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  describe('checkHealth（AC-15 / AC-16）', () => {
    it('并发上限 3：5 个源、每个探测 500ms，总耗时 < 2s', async () => {
      const sources: Source[] = [];
      for (let i = 0; i < 5; i += 1) {
        sources.push(await createAlist(`源 ${i}`, `https://s${i}.example.com`));
      }

      let inFlight = 0;
      let peak = 0;
      const adapter = {
        type: 'alist' as const,
        testConnection: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 500));
          inFlight -= 1;
          return {
            ok: true,
            latencyMs: 500,
            health: 'ok' as const,
            error: null,
            itemCount: 1,
          };
        },
        listCategories: async () => [],
        browse: async () => ({ items: [], page: 1, pageSize: 30, total: 0, hasMore: false }),
        search: async () => [],
        getDetail: async () => {
          throw new AppError('E_NOT_FOUND');
        },
        resolvePlayUrl: async () => {
          throw new AppError('E_NO_PLAY_URL');
        },
      };
      const { sourceRegistry } = await import('@/sources/registry');
      sourceRegistry.register(adapter);

      const started = Date.now();
      const results = await sourceService.checkHealth(sources.map((s) => s.id));
      const elapsed = Date.now() - started;

      expect(Object.keys(results)).toHaveLength(5);
      expect(peak).toBeLessThanOrEqual(3);
      expect(elapsed).toBeLessThanOrEqual(1600);
      expect(Object.values(results).every((r) => r.health === 'ok')).toBe(true);
    });

    it('单源失败不影响其它源（AC-16）', async () => {
      const a = await createAlist('好源', 'https://ok.example.com');
      const b = await createAlist('坏源', 'https://bad.example.com');

      const { sourceRegistry } = await import('@/sources/registry');
      sourceRegistry.register({
        type: 'alist',
        testConnection: async (source: Source) =>
          source.id === b.id
            ? {
                ok: false,
                latencyMs: 10,
                health: 'timeout' as const,
                error: { code: 'E_TIMEOUT' as const, message: '超时', detail: null, retryable: true, httpStatus: null },
                itemCount: null,
              }
            : { ok: true, latencyMs: 10, health: 'ok' as const, error: null, itemCount: 1 },
        listCategories: async () => [],
        browse: async () => ({ items: [], page: 1, pageSize: 30, total: 0, hasMore: false }),
        search: async () => [],
        getDetail: async () => {
          throw new AppError('E_NOT_FOUND');
        },
        resolvePlayUrl: async () => {
          throw new AppError('E_NO_PLAY_URL');
        },
      });

      const results = await sourceService.checkHealth();
      expect(results[a.id]?.health).toBe('ok');
      expect(results[b.id]?.health).toBe('timeout');

      const persisted = await sourceService.get(b.id);
      expect(persisted?.health).toBe('timeout');
      expect(persisted?.lastErrorCode).toBe('E_TIMEOUT');
    });
  });

  /**
   * AC-15 / FR-07：断网后 3s 内状态变「连接超时」
   *
   * 适配器探活内部的 `httpClient` 请求不传 `timeoutMs`（默认 10s），且多数 `probe` 拿不到
   * AbortSignal，因此断网最长要等 10s。现由 `httpClient.withProbeTimeout` 在探活窗口内把
   * 有效超时收到 `TIMEOUT_TEST_CONNECTION_MS` 并关闭重试；`E_TIMEOUT` → `'timeout'` →
   * `HealthBadge` 显示「连接超时」（UI 无需改动）。
   */
  describe('检查超时口径（AC-15）', () => {
    const realWithProbeTimeout = httpClient.withProbeTimeout.bind(httpClient);

    /** 缩短窗口但记录真实入参，避免用例真的等 3s */
    function shrinkProbeWindow(): number[] {
      const timeouts: number[] = [];
      vi.spyOn(httpClient, 'withProbeTimeout').mockImplementation((timeoutMs, fn, baseUrl) => {
        timeouts.push(timeoutMs);
        return realWithProbeTimeout(25, fn, baseUrl);
      });
      return timeouts;
    }

    /** 模拟断网：fetch 永不 resolve，仅在超时 abort 时以 AbortError 拒绝（与真实 fetch 一致） */
    function installHangingFetch(): () => number {
      let calls = 0;
      vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
        calls += 1;
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
          const signal = init?.signal;
          if (!signal) return; // 无 signal 则永远挂起
          if (signal.aborted) {
            onAbort();
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
        });
      });
      return () => calls;
    }

    async function createOfflineAlist(name = '断网源'): Promise<Source> {
      return sourceService.create({
        name,
        type: 'alist',
        baseUrl: 'https://offline.example.com',
        key: 'offline',
        auth: { mode: 'token', token: 'tok' },
        ext: { root: '/' },
      });
    }

    beforeEach(async () => {
      await resetAll();
      settingsService.__resetCache();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it('testConnection 以 3000ms 开窗；断网返回 timeout/E_TIMEOUT、只请求一次', async () => {
      expect(TIMEOUT_TEST_CONNECTION_MS).toBe(3000);
      expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(10_000); // 默认值保持不动
      const timeouts = shrinkProbeWindow();
      const fetchCalls = installHangingFetch();

      const result = await sourceService.testConnection({
        type: 'alist',
        baseUrl: 'https://offline.example.com',
        auth: { token: 'tok' },
      });

      expect(timeouts).toEqual([TIMEOUT_TEST_CONNECTION_MS]);
      expect(result.ok).toBe(false);
      expect(result.health).toBe('timeout');
      expect(result.error?.code).toBe('E_TIMEOUT');
      // 超时语义取自 ErrorCode 表（非 E_NETWORK），与 HealthBadge「连接超时」一致
      expect(result.error?.message).toBe(ERROR_MESSAGES.E_TIMEOUT);
      expect(fetchCalls()).toBe(1); // 窗口内不重试，否则会被拉长到 2×3s
    });

    it('边界：窗口内请求 2999ms 仍挂起、3000ms 以 E_TIMEOUT 返回', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const fetchCalls = installHangingFetch();
      const url = 'https://offline.example.com/api/fs/list';

      let settled = false;
      const scoped = httpClient
        .withProbeTimeout(
          TIMEOUT_TEST_CONNECTION_MS,
          () => httpRequest(url, { responseType: 'none' }),
          'https://offline.example.com',
        )
        .catch((e: unknown) => e)
        .finally(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCalls()).toBe(1);

      await vi.advanceTimersByTimeAsync(TIMEOUT_TEST_CONNECTION_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await scoped).toMatchObject({ code: 'E_TIMEOUT' });
      expect(fetchCalls()).toBe(1); // 不重试
    });

    it('窗口只收窄同一源；窗口外仍为 10s 默认值', async () => {
      const url = 'https://offline.example.com/api/fs/list';
      expect(probeTimeoutFor(url)).toBeNull();

      let inside: number | null = null;
      let otherSource: number | null = null;
      await httpClient.withProbeTimeout(
        TIMEOUT_TEST_CONNECTION_MS,
        async () => {
          inside = probeTimeoutFor(url);
          otherSource = probeTimeoutFor('https://other.example.com/api/fs/list');
        },
        'https://offline.example.com',
      );

      expect(inside).toBe(3000);
      expect(otherSource).toBeNull();
      expect(probeTimeoutFor(url)).toBeNull();
    });

    it('checkHealth 断网不抛穿：返回并落库 timeout/E_TIMEOUT（AC-16 单源失败不影响其它源）', async () => {
      const timeouts = shrinkProbeWindow();
      const fetchCalls = installHangingFetch();
      const created = await createOfflineAlist();

      const results = await sourceService.checkHealth();

      expect(timeouts).toEqual([TIMEOUT_TEST_CONNECTION_MS]);
      expect(results[created.id]?.health).toBe('timeout');
      expect(results[created.id]?.error?.code).toBe('E_TIMEOUT');
      expect(fetchCalls()).toBe(1);

      const persisted = await sourceRepo.get(created.id);
      expect(persisted?.health).toBe('timeout');
      expect(persisted?.lastErrorCode).toBe('E_TIMEOUT');
    });

    it('healthService 门面同样拿到「连接超时」，失败计数 1', async () => {
      shrinkProbeWindow();
      installHangingFetch();
      const created = await createOfflineAlist();

      const snapshot = await healthService.check([created.id]);

      expect(snapshot.results[created.id]?.health).toBe('timeout');
      expect(snapshot.failedCount).toBe(1);
      expect(healthService.labelOf('timeout')).toBe('连接超时');
    });
  });

  it('ensureDemoSource 幂等：重复调用条目数不变，且 12 条（AC-95、AC-97）', async () => {
    await sourceService.ensureDemoSource();
    const first = await mediaRepo.countBySource(DEMO_SOURCE_ID);
    expect(first).toBe(DEMO_ITEMS.length);

    await sourceService.ensureDemoSource();
    await sourceService.ensureDemoSource();
    expect(await mediaRepo.countBySource(DEMO_SOURCE_ID)).toBe(first);
    expect(first).toBeGreaterThanOrEqual(12);
    expect(await categoryRepo.listBySource(DEMO_SOURCE_ID)).toHaveLength(4);
  });

  it('restoreDemo：禁用后恢复启用并补齐条目（AC-97）', async () => {
    await sourceService.ensureDemoSource();
    const original = await mediaRepo.countBySource(DEMO_SOURCE_ID);
    await sourceService.setEnabled(DEMO_SOURCE_ID, false);
    expect((await sourceService.get(DEMO_SOURCE_ID))?.enabled).toBe(false);

    await mediaRepo.removeBySource(DEMO_SOURCE_ID);
    const restored = await sourceService.restoreDemo();
    expect(restored.enabled).toBe(true);
    expect(await mediaRepo.countBySource(DEMO_SOURCE_ID)).toBe(original);
  });
});
