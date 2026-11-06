import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheRepo } from '@/db/repositories/cacheRepo';
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { epgSourceService } from '@/services/epgSourceService';
import { settingsService } from '@/services/settingsService';
import { BUILTIN_EPG_SOURCE_ID, EPG_CACHE_KEY_PREFIX, EPG_SOURCE_MAX } from '@/shared/constants';
import type { EpgSource } from '@/types';

import { resetAll } from './helpers';

/**
 * EXT-06 / FR-66：多 EPG 源管理（AC-155 / AC-156）
 * - 内置源不可删；用户源 ≤10、同时启用 ≤5（可被设置覆盖）；
 * - 探测失败不落库、不占优先级；上限校验在探测之前；
 * - 删除源 / 改协议 / 改匹配模式清该源缓存。
 */

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(async (_url: string, _options?: unknown): Promise<string> => ''),
}));

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: requestMock, requestWithMeta: vi.fn(), requestBase: vi.fn() },
}));

const DIYP = JSON.stringify([
  { start: '2026-11-06 19:00:00', end: '2026-11-06 20:00:00', title: '新闻联播' },
]);

function userSource(id: string, overrides: Partial<EpgSource> = {}): EpgSource {
  return {
    id,
    name: id,
    endpoint: `https://epg.example.com/${id}`,
    protocol: 'auto',
    matchMode: 'auto',
    priority: 2,
    enabled: true,
    builtin: false,
    lastProbeAt: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('epgSourceService.limits（上限口径）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('缺省为 10 源 / 5 启用；内置源在库中且可停用', async () => {
    const limits = await epgSourceService.limits();
    expect(limits).toEqual({ maxSources: EPG_SOURCE_MAX, maxEnabled: 5 });
    const all = await epgSourceService.list();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: BUILTIN_EPG_SOURCE_ID, builtin: true, enabled: true });
    expect(epgSourceService.isBuiltin(BUILTIN_EPG_SOURCE_ID)).toBe(true);
    expect(epgSourceService.isBuiltin('epg_x')).toBe(false);
  });

  it('设置可覆盖上限（Q-15 记为启用 3 时无需改代码）', async () => {
    await settingsService.update({ epg: { maxSources: 6, maxEnabled: 3 } });
    expect(await epgSourceService.limits()).toEqual({ maxSources: 6, maxEnabled: 3 });
  });

  it('上限被写成非法值（0/NaN）时回落常量，不冻结功能', async () => {
    await settingsService.update({
      epg: { maxSources: 0, maxEnabled: Number.NaN } as unknown as { maxSources: number; maxEnabled: number },
    });
    expect(await epgSourceService.limits()).toEqual({ maxSources: EPG_SOURCE_MAX, maxEnabled: 5 });
  });
});

describe('epgSourceService.add / probe（AC-155 / AC-156）', () => {
  beforeEach(async () => {
    await resetAll();
    requestMock.mockReset();
    requestMock.mockResolvedValue(DIYP);
  });

  it('探测成功后落库：启用、优先级排在末尾、记录探测时间', async () => {
    const added = await epgSourceService.add({
      name: '  我的源  ',
      endpoint: 'https://epg.example.com/a',
    });
    expect(added).toMatchObject({
      name: '我的源',
      enabled: true,
      builtin: false,
      priority: 2,
      lastError: null,
    });
    expect(added.lastProbeAt).toBeGreaterThan(0);
    expect((await epgSourceService.list()).map((s) => s.id)).toEqual([
      BUILTIN_EPG_SOURCE_ID,
      added.id,
    ]);
  });

  it('auto/diyp 探测附带 ch + date 参数；xmltv 直取端点', async () => {
    await epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' });
    const autoUrl = requestMock.mock.calls[0]![0] as string;
    expect(autoUrl).toContain('ch=');
    expect(autoUrl).toContain('date=');

    requestMock.mockClear();
    await epgSourceService.add({
      name: 'B',
      endpoint: 'https://epg.example.com/b',
      protocol: 'xmltv',
    });
    expect(requestMock.mock.calls[0]![0]).toBe('https://epg.example.com/b');
  });

  it('端点返回 HTML / 空列表 → E_PARSE 且不落库（AC-156）', async () => {
    requestMock.mockResolvedValue('<html><body>404</body></html>');
    await expect(
      epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' }),
    ).rejects.toMatchObject({ code: 'E_PARSE' });
    expect(await epgSourceService.list()).toHaveLength(1);
  });

  it('网络失败 → 错误码上抛且不落库', async () => {
    requestMock.mockRejectedValue(new Error('timeout'));
    await expect(
      epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' }),
    ).rejects.toBeTruthy();
    expect(await epgSourceService.list()).toHaveLength(1);
  });

  it('名称/地址非法被拒绝，且不发探测请求', async () => {
    await expect(
      epgSourceService.add({ name: '', endpoint: 'https://epg.example.com/a' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await expect(
      epgSourceService.add({
        name: '这是一个非常非常非常长的EPG源名称超过二十个字符',
        endpoint: 'https://epg.example.com/a',
      }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    await expect(
      epgSourceService.add({ name: 'A', endpoint: 'ftp://epg.example.com' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('同一地址重复添加 → E_INVALID_INPUT（AC-155）', async () => {
    await epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' });
    requestMock.mockClear();
    await expect(
      epgSourceService.add({ name: 'A2', endpoint: 'https://epg.example.com/a' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it(`第 ${EPG_SOURCE_MAX + 1} 个用户源被拒绝（AC-155）`, async () => {
    const seeds = Array.from({ length: EPG_SOURCE_MAX - 1 }, (_, i) =>
      userSource(`epg_seed_${i}`, { enabled: false, priority: i + 2 }),
    );
    await epgSourceRepo.saveMany(seeds);
    // 此刻用户源 9 个 + 内置 1 个 → 第 10 个用户源允许
    await epgSourceService.add({ name: '倒数一个', endpoint: 'https://epg.example.com/last' });
    requestMock.mockClear();
    await expect(
      epgSourceService.add({ name: '超限', endpoint: 'https://epg.example.com/over' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_STATE' });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('第 6 个启用源被拒绝，且不静默降为停用（AC-155）', async () => {
    // 内置源已启用 + 4 个启用用户源 = 5
    await epgSourceRepo.saveMany(
      Array.from({ length: 4 }, (_, i) => userSource(`epg_on_${i}`, { priority: i + 2 })),
    );
    requestMock.mockClear();
    await expect(
      epgSourceService.add({ name: '第六个', endpoint: 'https://epg.example.com/6th' }),
    ).rejects.toMatchObject({ code: 'E_INVALID_STATE' });
    expect(requestMock).not.toHaveBeenCalled();
    expect(await epgSourceRepo.list()).toHaveLength(5);
  });
});

describe('epgSourceService.update / remove / reorder', () => {
  beforeEach(async () => {
    await resetAll();
    requestMock.mockReset();
    requestMock.mockResolvedValue(DIYP);
  });

  it('内置源不可删除；用户源删除后清理该源缓存', async () => {
    await expect(epgSourceService.remove(BUILTIN_EPG_SOURCE_ID)).rejects.toMatchObject({
      code: 'E_INVALID_STATE',
    });
    const added = await epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' });
    await cacheRepo.putEpgRecord({
      key: `${EPG_CACHE_KEY_PREFIX}:${added.id}:nm:cctv1:2026-11-06`,
      programmes: [],
      fetchedAt: Date.now(),
    });
    const result = await epgSourceService.remove(added.id);
    expect(result.removed).toBe(true);
    expect(result.clearedCacheKeys).toBe(1);
    expect(await epgSourceService.get(added.id)).toBeNull();
  });

  it('删除不存在的源报 E_NOT_FOUND', async () => {
    await expect(epgSourceService.remove('epg_missing')).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
  });

  it('reorder 整表重排 priority = index + 1；集合不一致被拒绝', async () => {
    const a = await epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' });
    const b = await epgSourceService.add({ name: 'B', endpoint: 'https://epg.example.com/b' });
    const reordered = await epgSourceService.reorder([b.id, BUILTIN_EPG_SOURCE_ID, a.id]);
    expect(reordered.map((s) => [s.id, s.priority])).toEqual([
      [b.id, 1],
      [BUILTIN_EPG_SOURCE_ID, 2],
      [a.id, 3],
    ]);
    // AC-155：重启后顺序不变（持久化）
    expect((await epgSourceService.list()).map((s) => s.id)).toEqual([
      b.id,
      BUILTIN_EPG_SOURCE_ID,
      a.id,
    ]);
    await expect(epgSourceService.reorder([a.id])).rejects.toMatchObject({
      code: 'E_INVALID_INPUT',
    });
    await expect(
      epgSourceService.reorder([a.id, b.id, b.id]),
    ).rejects.toMatchObject({ code: 'E_INVALID_INPUT' });
  });

  it('启用第 6 个源被拒绝，停用不限', async () => {
    await epgSourceRepo.saveMany(
      Array.from({ length: 4 }, (_, i) => userSource(`epg_on_${i}`, { priority: i + 2 })),
    );
    const off = userSource('epg_off', { enabled: false, priority: 6 });
    await epgSourceRepo.save(off);
    await expect(
      epgSourceService.update(off.id, { enabled: true }),
    ).rejects.toMatchObject({ code: 'E_INVALID_STATE' });

    const on = await epgSourceRepo.get('epg_on_0');
    const updated = await epgSourceService.update('epg_on_0', { enabled: false });
    expect(updated.enabled).toBe(false);
    expect(on?.enabled).toBe(true);
  });

  it('改协议 → 清该源缓存；改端点 → 需重新探测成功才保存', async () => {
    const a = await epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' });
    await cacheRepo.putEpgRecord({
      key: `${EPG_CACHE_KEY_PREFIX}:${a.id}:nm:cctv1:2026-11-06`,
      programmes: [],
      fetchedAt: Date.now(),
    });
    await epgSourceService.update(a.id, { protocol: 'xmltv' });
    expect(await cacheRepo.getEpgRecord(`${EPG_CACHE_KEY_PREFIX}:${a.id}:nm:cctv1:2026-11-06`)).toBeNull();

    requestMock.mockRejectedValueOnce(new Error('probe failed'));
    await expect(
      epgSourceService.update(a.id, { endpoint: 'https://epg.example.com/a2' }),
    ).rejects.toBeTruthy();
    expect((await epgSourceService.get(a.id))?.endpoint).toBe('https://epg.example.com/a');

    const renamed = await epgSourceService.update(a.id, { name: 'A2' });
    expect(renamed.name).toBe('A2');
  });

  it('markError 只记录原因，不改变启用状态', async () => {
    const a = await epgSourceService.add({ name: 'A', endpoint: 'https://epg.example.com/a' });
    await epgSourceService.markError(a.id, '上次失败：连接超时');
    const stored = await epgSourceService.get(a.id);
    expect(stored?.lastError).toBe('上次失败：连接超时');
    expect(stored?.enabled).toBe(true);
  });
});
