/**
 * 订阅生命周期单测（v1.7 / CHG-19，AC-117）
 *
 * P1-7 追加：自动禁用前复检的覆盖面（从「仅爬虫源」放开到「全部联网源」）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readKv, resetAll } from './helpers';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { BaseAdapter } from '@/sources/base/BaseAdapter';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import type { ConnectionResult, Source, SourceType } from '@/types';

function makeSource(overrides: Partial<Source> = {}): Source {
  const now = Date.now();
  return {
    id: overrides.id ?? 'source-1',
    key: overrides.key ?? 'source-1',
    name: overrides.name ?? '测试源',
    type: overrides.type ?? 'site',
    enabled: overrides.enabled ?? true,
    builtin: overrides.builtin ?? false,
    sort: overrides.sort ?? 0,
    baseUrl: overrides.baseUrl ?? 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: overrides.subscriptionId ?? 'sub-a',
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** 模拟一轮体检结果：直接把 health 写入源再触发退化处置 */
async function roundOf(id: string, health: Source['health']): Promise<number> {
  const source = await sourceRepo.get(id);
  await sourceRepo.save({ ...source!, health, healthCheckedAt: Date.now() });
  return subscriptionLifecycleService.applyHealthDegradation();
}

describe('applyHealthDegradation / restore（AC-117）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('连续 3 次 bad → 自动禁用并标记 autoDisabledAt', async () => {
    await sourceRepo.save(makeSource({ id: 'a', key: 'a' }));
    expect(await roundOf('a', 'timeout')).toBe(0);
    expect(await roundOf('a', 'timeout')).toBe(0);
    expect(await roundOf('a', 'timeout')).toBe(1);

    const source = await sourceRepo.get('a');
    expect(source!.enabled).toBe(false);
    expect(source!.autoDisabledAt).toBeGreaterThan(0);
  });

  it('中间恢复 ok → 计数清零，不触发禁用', async () => {
    await sourceRepo.save(makeSource({ id: 'b', key: 'b' }));
    await roundOf('b', 'unreachable');
    await roundOf('b', 'unreachable');
    await roundOf('b', 'ok');
    expect(await roundOf('b', 'unreachable')).toBe(0);
    const source = await sourceRepo.get('b');
    expect(source!.enabled).toBe(true);
  });

  it('恢复：restore 清标记、重新启用、健康复位', async () => {
    await sourceRepo.save(makeSource({ id: 'c', key: 'c' }));
    await roundOf('c', 'bad_config');
    await roundOf('c', 'bad_config');
    await roundOf('c', 'bad_config');
    await subscriptionLifecycleService.restore('c');

    const source = await sourceRepo.get('c');
    expect(source!.enabled).toBe(true);
    expect(source!.autoDisabledAt).toBeNull();
    expect(source!.health).toBe('unknown');
  });

  it('未体检 / ok / 演示源不参与退化', async () => {
    await sourceRepo.save(makeSource({ id: 'd', key: 'd', healthCheckedAt: null }));
    await sourceRepo.save(makeSource({ id: 'demo', key: 'demo', builtin: true, health: 'timeout', healthCheckedAt: Date.now() }));
    expect(await roundOf('d', 'timeout')).toBe(0);
    // 未体检过的源记为一次 bad（healthCheckedAt 有值才会判 bad——此处 roundOf 会写入）
    expect(await roundOf('demo', 'timeout')).toBe(0);
  });

  it('summarize：按 subscriptionId 聚合源数与存活', async () => {
    await sourceRepo.saveMany([
      makeSource({ id: 's1', key: 's1', subscriptionId: 'https://sub-a', health: 'ok', healthCheckedAt: Date.now() }),
      makeSource({ id: 's2', key: 's2', subscriptionId: 'https://sub-a', health: 'timeout', healthCheckedAt: Date.now() }),
      makeSource({ id: 's3', key: 's3', subscriptionId: null }),
    ]);
    const summaries = await subscriptionLifecycleService.summarize();
    const subA = summaries.find((s) => s.subscriptionId === 'https://sub-a');
    expect(subA).toBeDefined();
    expect(subA!.sourceCount).toBe(2);
    expect(subA!.alive).toBe(1);
    expect(subA!.dead).toBe(1);
  });
});

/**
 * 自动禁用前复检（P0-3 引入，P1-7 放开覆盖面）。
 *
 * 「连续 3 次判坏」是禁用依据，但一次抖动就误禁一批好源是不可逆的用户可见后果，
 * 所以在禁用动作前给源一次自证机会。旧口径只对爬虫源复检——慢内网
 * alist / webdav / jellyfin 的「假死」同样多（P1-7 / D11），故放开到全部联网源；
 * 演示源（无网络请求）与 Web 环境仍然不复检。
 */
describe('自动禁用前复检（P0-3 / P1-7）', () => {
  /** 复检发起次数与涉及的源类型（比读 spy.mock 历史直白，断言只看这两项） */
  let recheckCalls: number;
  let recheckedTypes: SourceType[];

  /** 复检结论可控：ok=true 视为「源还活着」；每次调用都会重置计数 */
  function stubRecheck(ok: boolean): void {
    recheckCalls = 0;
    recheckedTypes = [];
    vi.spyOn(BaseAdapter.prototype, 'testConnection').mockImplementation(
      async (source: Source): Promise<ConnectionResult> => {
        recheckCalls += 1;
        recheckedTypes.push(source.type);
        return ok
          ? { ok: true, latencyMs: 12, health: 'ok', error: null, itemCount: 3 }
          : {
              ok: false,
              latencyMs: 0,
              health: 'unreachable',
              error: {
                code: 'E_SOURCE_UNAVAILABLE',
                message: '源不可用',
                detail: null,
                retryable: true,
                httpStatus: null,
              },
              itemCount: null,
            };
      },
    );
  }

  function asNative(): void {
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => 'android' });
  }

  /** 连续判坏 rounds 轮（复检结论固定），返回退化处置数 */
  async function badRounds(id: string, rounds: number, recheckOk: boolean): Promise<number> {
    stubRecheck(recheckOk);
    let degraded = 0;
    for (let i = 0; i < rounds; i += 1) degraded += await roundOf(id, 'timeout');
    return degraded;
  }

  beforeEach(async () => {
    await resetAll();
    asNative();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('webdav 源第 3 次判坏后复检通过：不禁用、回写 health=ok、清掉禁用计数', async () => {
    await sourceRepo.save(makeSource({ id: 'r1', key: 'r1', type: 'webdav', lastErrorCode: 'E_TIMEOUT' }));
    await roundOf('r1', 'timeout');
    await roundOf('r1', 'timeout');

    expect(await badRounds('r1', 1, true)).toBe(0);

    const after = await sourceRepo.get('r1');
    expect(after!.enabled).toBe(true);
    expect(after!.autoDisabledAt ?? null).toBeNull();
    expect(after!.health).toBe('ok');
    expect(after!.lastErrorCode).toBeNull();
    // 只在「够格禁用」那一轮发一次复检，前两轮不额外打网络请求
    expect(recheckCalls).toBe(1);
    expect(await readKv<Record<string, number>>('source-health-streak')).not.toHaveProperty('r1');
  });

  it('复检仍失败：按原结论禁用并标记 autoDisabledAt', async () => {
    await sourceRepo.save(makeSource({ id: 'r2', key: 'r2', type: 'jellyfin' }));

    expect(await badRounds('r2', 3, false)).toBe(1);

    const after = await sourceRepo.get('r2');
    expect(after!.enabled).toBe(false);
    expect(after!.autoDisabledAt).toBeGreaterThan(0);
    expect(after!.health).toBe('timeout');
    expect(recheckCalls).toBe(1);
  });

  it('复检通过 = 跳过一次禁用：下一轮真死要从头累计 3 次', async () => {
    await sourceRepo.save(makeSource({ id: 'r3', key: 'r3', type: 'alist' }));
    await badRounds('r3', 2, false);
    // 第 3 轮复检通过：这一笔禁用被吞掉，计数同时清零
    expect(await badRounds('r3', 1, true)).toBe(0);

    expect(await badRounds('r3', 1, false)).toBe(0); // 重新累计 1
    expect(await badRounds('r3', 1, false)).toBe(0); // 2
    expect(await badRounds('r3', 1, false)).toBe(1); // 3 → 复检失败 → 禁用
    expect((await sourceRepo.get('r3'))!.enabled).toBe(false);
  });

  it.each<SourceType>(['site', 'alist', 'webdav', 'jellyfin', 'douban', 'spider'])(
    '%s 源禁用前都复检一次（P1-7 放开到全部联网源）',
    async (type) => {
      await sourceRepo.save(makeSource({ id: `t-${type}`, key: `t-${type}`, type }));
      expect(await badRounds(`t-${type}`, 3, true)).toBe(0);
      expect(recheckedTypes).toEqual([type]);
      expect((await sourceRepo.get(`t-${type}`))!.health).toBe('ok');
    },
  );

  it('演示源不发复检请求（无网络请求，禁用照常）', async () => {
    await sourceRepo.save(makeSource({ id: 'r4', key: 'r4', type: 'demo' }));

    expect(await badRounds('r4', 3, true)).toBe(1);
    expect(recheckCalls).toBe(0);
    expect((await sourceRepo.get('r4'))!.enabled).toBe(false);
  });

  it('Web 环境不复检：保持体检耗时与单测确定性，禁用照旧', async () => {
    vi.unstubAllGlobals(); // 回到 web
    stubRecheck(true);
    await sourceRepo.save(makeSource({ id: 'r5', key: 'r5', type: 'webdav' }));
    let degraded = 0;
    for (let i = 0; i < 3; i += 1) degraded += await roundOf('r5', 'timeout');

    expect(degraded).toBe(1);
    expect(recheckCalls).toBe(0);
  });
});
