import { beforeEach, describe, expect, it, vi } from 'vitest';

import { cacheRepo } from '@/db/repositories/cacheRepo';
import { epgSourceRepo } from '@/db/repositories/epgSourceRepo';
import { epgService, resetEpgInFlightForTest } from '@/services/epgService';
import { EPG_CACHE_KEY_PREFIX } from '@/shared/constants';
import type { EpgSource } from '@/types';

import { resetAll } from './helpers';

/**
 * EXT-06 / FR-67：多源合并 + 四级确定性匹配（AC-157 / AC-158 / AC-159 / AC-160）
 * 网络层整体 mock，DB 用 fake-indexeddb（真实仓储与缓存口径）。
 */

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(async (_url: string, _options?: unknown): Promise<string> => ''),
}));

vi.mock('@/sources/base/httpClient', () => ({
  httpClient: { request: requestMock, requestWithMeta: vi.fn(), requestBase: vi.fn() },
}));

const DATE = new Date(2026, 10, 6, 12, 0, 0);
const DATE_KEY = '2026-11-06';

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

/** 关掉内置源，让用例的源集合封闭（内置源默认启用且端点指向真实 EPG） */
async function disableBuiltin(): Promise<void> {
  const builtin = await epgSourceRepo.get('epg-builtin');
  if (builtin) await epgSourceRepo.save({ ...builtin, enabled: false });
}

function xmltvDoc(
  programmes: Array<{ channel: string; start: string; stop: string; title: string }>,
): string {
  const channels = [
    '<channel id="cctv1.hd"><display-name>CCTV-1 综合</display-name></channel>',
    '<channel id="cctv1.backup"><display-name>CCTV1 备用</display-name></channel>',
    '<channel id="hunan"><display-name>湖南卫视</display-name></channel>',
  ].join('');
  const items = programmes
    .map(
      (p) =>
        `<programme channel="${p.channel}" start="${p.start}" stop="${p.stop}"><title>${p.title}</title></programme>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><tv>${channels}${items}</tv>`;
}

const HUNAN_ONLY = xmltvDoc([
  { channel: 'hunan', start: '20261106190000', stop: '20261106200000', title: '快乐大本营' },
]);

const CCTV1_TODAY = xmltvDoc([
  { channel: 'cctv1.hd', start: '20261106190000', stop: '20261106200000', title: '新闻联播' },
  { channel: 'cctv1.hd', start: '20261106200000', stop: '20261106213000', title: '焦点访谈' },
]);

function diypPayload(title = '新闻联播'): string {
  return JSON.stringify([
    { start: '2026-11-06 19:00:00', end: '2026-11-06 20:00:00', title },
  ]);
}

describe('epgService.programmesFor（四级确定性匹配 AC-157）', () => {
  beforeEach(async () => {
    await resetAll();
    resetEpgInFlightForTest();
    requestMock.mockReset();
    await disableBuiltin();
    await epgSourceRepo.save(sourceOf({ id: 'A', protocol: 'xmltv', priority: 1 }));
    requestMock.mockResolvedValue(CCTV1_TODAY);
  });

  it('L1：tvg-id 命中（大小写/空白不敏感）', async () => {
    const result = await epgService.programmesFor(
      { name: '随便什么名字', tvgId: ' CCTV1.HD ', tvgName: null },
      DATE,
    );
    expect(result.matchedSource).toMatchObject({ id: 'A', matchLevel: 1 });
    expect(result.programmes.map((p) => p.title)).toEqual(['新闻联播', '焦点访谈']);
  });

  it('L2：tvg-id 未命中、tvg-name 命中 display-name', async () => {
    const result = await epgService.programmesFor(
      { name: '随便什么名字', tvgId: 'not-exist', tvgName: 'CCTV-1 综合' },
      DATE,
    );
    expect(result.matchedSource).toMatchObject({ id: 'A', matchLevel: 2 });
    expect(result.programmes).toHaveLength(2);
  });

  it('L3：tvg-id / tvg-name 都没有时按归一化名称命中', async () => {
    const result = await epgService.programmesFor(
      { name: 'cctv 1 高清', tvgId: null, tvgName: null },
      DATE,
    );
    expect(result.matchedSource).toMatchObject({ id: 'A', matchLevel: 3 });
    expect(result.programmes.map((p) => p.title)).toEqual(['新闻联播', '焦点访谈']);
  });

  it('L4：四级全未命中 → 空结果且不抛错', async () => {
    const result = await epgService.programmesFor(
      { name: '凤凰卫视', tvgId: null, tvgName: null },
      DATE,
    );
    expect(result.programmes).toEqual([]);
    expect(result.matchedSource).toBeNull();
    expect(result.errors).toEqual([]);
    expect(result.channelKey).toBe('nm:凤凰卫视');
    expect(result.date).toBe(DATE_KEY);
  });

  it('matchMode = xmltv-id 时跳过 L2/L3（只认 tvg-id）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', matchMode: 'xmltv-id', priority: 1 }));
    const missed = await epgService.programmesFor(
      { name: 'CCTV-1 综合', tvgId: null, tvgName: 'CCTV-1 综合' },
      DATE,
    );
    expect(missed.programmes).toEqual([]);
    const hit = await epgService.programmesFor(
      { name: 'X', tvgId: 'cctv1.hd', tvgName: null },
      DATE,
    );
    expect(hit.matchedSource?.matchLevel).toBe(1);
  });

  it('matchMode = channel-name 时跳过 L1（只认名称）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', matchMode: 'channel-name', priority: 1 }));
    const result = await epgService.programmesFor(
      { name: 'CCTV1', tvgId: 'cctv1.hd', tvgName: null },
      DATE,
    );
    expect(result.matchedSource?.matchLevel).toBe(3);
  });
});

describe('epgService.programmesFor（按优先级整源采纳 AC-158 / AC-160）', () => {
  beforeEach(async () => {
    await resetAll();
    resetEpgInFlightForTest();
    requestMock.mockReset();
    await disableBuiltin();
  });

  it('内置源默认参与合并，可作兜底（AC-155 可停用、不可删除）', async () => {
    const builtin = await epgSourceRepo.get('epg-builtin');
    await epgSourceRepo.save({ ...builtin!, enabled: true });
    requestMock.mockResolvedValue(CCTV1_TODAY);
    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.matchedSource?.id).toBe('epg-builtin');
    expect(result.programmes).toHaveLength(2);
  });

  it('命中高优先级源后立即返回，不再请求后续源（不拼接节目）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    await epgSourceRepo.save(sourceOf({ id: 'B', priority: 2 }));
    const full = xmltvDoc([
      { channel: 'cctv1.hd', start: '20261106180000', stop: '20261106190000', title: 'B 源节目 1' },
      { channel: 'cctv1.hd', start: '20261106190000', stop: '20261106200000', title: 'B 源节目 2' },
      { channel: 'cctv1.hd', start: '20261106200000', stop: '20261106210000', title: 'B 源节目 3' },
    ]);
    requestMock.mockImplementation(async (url: string) =>
      url.includes('/A') ? CCTV1_TODAY : full,
    );

    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.matchedSource?.id).toBe('A');
    expect(result.programmes).toHaveLength(2);
    expect(result.programmes.map((p) => p.title)).toEqual(['新闻联播', '焦点访谈']);
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('高优先级源失败 → 记录错误并回落下一源', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    await epgSourceRepo.save(sourceOf({ id: 'B', protocol: 'diyp', priority: 2 }));
    requestMock.mockImplementation(async (url: string) => {
      if (url.includes('/A')) throw new Error('network down');
      return diypPayload('B 源新闻');
    });

    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.matchedSource?.id).toBe('B');
    expect(result.programmes.map((p) => p.title)).toEqual(['B 源新闻']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.sourceId).toBe('A');
  });

  it('全部源失败 → 空结果 + 每源一条错误（不抛穿）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    await epgSourceRepo.save(sourceOf({ id: 'B', priority: 2 }));
    requestMock.mockRejectedValue(new Error('boom'));

    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.programmes).toEqual([]);
    expect(result.matchedSource).toBeNull();
    expect(result.errors.map((e) => e.sourceId)).toEqual(['A', 'B']);
  });

  it('停用的源不参与合并（全部停用 → 空态且不发请求）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1, enabled: false }));
    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.programmes).toEqual([]);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('sourceIds 过滤只查指定源', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    await epgSourceRepo.save(sourceOf({ id: 'B', priority: 2 }));
    requestMock.mockImplementation(async (url: string) => (url.includes('/B') ? HUNAN_ONLY : ''));

    const result = await epgService.programmesFor(
      { name: '湖南卫视', tvgId: null, tvgName: null },
      DATE,
      { sourceIds: ['B'] },
    );
    expect(result.matchedSource?.id).toBe('B');
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('同源内 (startAt,title) 去重 + 按时间升序', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockResolvedValue(
      xmltvDoc([
        { channel: 'cctv1.hd', start: '20261106200000', stop: '20261106213000', title: '焦点访谈' },
        { channel: 'cctv1.hd', start: '20261106190000', stop: '20261106200000', title: '新闻联播' },
        { channel: 'cctv1.hd', start: '20261106190000', stop: '20261106200000', title: '新闻联播' },
      ]),
    );
    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.programmes.map((p) => p.title)).toEqual(['新闻联播', '焦点访谈']);
  });

  it('跨天节目按设备本地日期归属过滤（AC-159）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockResolvedValue(
      xmltvDoc([
        { channel: 'cctv1.hd', start: '20261106190000', stop: '20261106200000', title: '今日节目' },
        { channel: 'cctv1.hd', start: '20261107010000', stop: '20261107020000', title: '次日节目' },
      ]),
    );
    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.programmes.map((p) => p.title)).toEqual(['今日节目']);
  });

  it('二次请求命中 24h 缓存，不再发网络请求', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockResolvedValue(CCTV1_TODAY);
    const first = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    const second = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(second.programmes).toEqual(first.programmes);
    expect(second.matchedSource?.matchLevel).toBe(first.matchedSource?.matchLevel);
  });

  it('网络失败但有过期缓存 → 返回 stale 数据（可用性优先）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    await cacheRepo.putEpgRecord({
      key: `${EPG_CACHE_KEY_PREFIX}:A:nm:cctv1:${DATE_KEY}`,
      programmes: [
        {
          start: '19:00',
          end: '20:00',
          title: '过期缓存节目',
          desc: null,
          startSec: 68400,
          endSec: 72000,
          startAt: new Date(2026, 10, 6, 19, 0, 0).getTime(),
          endAt: new Date(2026, 10, 6, 20, 0, 0).getTime(),
          key: 'stale',
          sourceId: 'A',
        },
      ],
      fetchedAt: Date.now() - 30 * 60 * 60 * 1000,
      matchLevel: 2,
    });
    requestMock.mockRejectedValue(new Error('offline'));

    const result = await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(result.stale).toBe(true);
    expect(result.programmes.map((p) => p.title)).toEqual(['过期缓存节目']);
    expect(result.matchedSource?.matchLevel).toBe(2);
  });

  it('clearSourceCache 按前缀清空该源缓存', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockResolvedValue(CCTV1_TODAY);
    await epgService.programmesFor({ name: 'CCTV1', tvgId: null, tvgName: null }, DATE);
    expect(
      await cacheRepo.getEpgRecord(`${EPG_CACHE_KEY_PREFIX}:A:nm:cctv1:${DATE_KEY}`),
    ).not.toBeNull();
    const removed = await epgService.clearSourceCache('A');
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await cacheRepo.getEpgRecord(`${EPG_CACHE_KEY_PREFIX}:A:nm:cctv1:${DATE_KEY}`),
    ).toBeNull();
  });

  it('同 key 并发调用共享同一 Promise（in-flight 去重）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', priority: 1 }));
    requestMock.mockResolvedValue(CCTV1_TODAY);
    const channel = { name: 'CCTV1', tvgId: null, tvgName: null };
    const [a, b] = await Promise.all([
      epgService.programmesFor(channel, DATE),
      epgService.programmesFor(channel, DATE),
    ]);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(a.programmes).toEqual(b.programmes);
  });

  it('prefetch：≤30 个频道、并发 ≤3（AC-160）', async () => {
    await epgSourceRepo.save(sourceOf({ id: 'A', protocol: 'diyp', priority: 1 }));
    let concurrent = 0;
    let peak = 0;
    requestMock.mockImplementation(async (_url: string) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return diypPayload();
    });
    const channels = Array.from({ length: 5 }, (_, i) => ({
      name: `CCTV${i + 1}`,
      tvgId: null,
      tvgName: null,
    }));
    const summary = await epgService.prefetch(channels, DATE);
    expect(summary.requested).toBe(5);
    expect(summary.ok + summary.failed).toBe(5);
    expect(peak).toBeLessThanOrEqual(3);
  });
});
