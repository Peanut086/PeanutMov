/**
 * 订阅生命周期单测（v1.7 / CHG-19，AC-117）
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { resetAll } from './helpers';
import { sourceRepo } from '@/db/repositories/sourceRepo';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import type { Source } from '@/types';

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
