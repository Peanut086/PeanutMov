import { describe, expect, it, beforeEach } from 'vitest';

import { sourceService } from '@/services/sourceService';
import { sourceRegistry } from '@/sources/registry';
import { healthService } from '@/services/healthService';
import type { Source, SourceAdapter } from '@/types';

import { resetAll } from './helpers';

/**
 * REV-41 回归：check(ids) 子集检测不应覆盖 cachedSnapshot 中未检测源的数据。
 *
 * 场景：3 个源 → checkAll → check([b]) → latencyOf(a) 仍为 120，tierOf(a) 不变 bad。
 */

const LATENCY_MAP: Record<string, number> = {
  a: 120,
  b: 350,
  c: 80,
};

function makeAdapter(): SourceAdapter {
  return {
    type: 'alist',
    async testConnection(source: Source) {
      const latency = LATENCY_MAP[source.id] ?? 100;
      return {
        ok: true,
        latencyMs: latency,
        health: 'ok' as const,
        error: null,
        itemCount: 1,
      };
    },
    async listCategories() {
      return [];
    },
    async browse() {
      return { items: [], page: 1, pageSize: 30, total: 0, hasMore: false };
    },
    async search() {
      return [];
    },
    async getDetail() {
      throw new Error('not used');
    },
    async resolvePlayUrl() {
      throw new Error('not used');
    },
  } as unknown as SourceAdapter;
}

describe('REV-41 回归：子集检测快照合并', () => {
  beforeEach(async () => {
    await resetAll();
    healthService.__reset();
    sourceRegistry.register(makeAdapter());
  });

  it('check(ids) 后，未检测源的 latencyOf / tierOf 保持不变', async () => {
    // 创建 3 个源，ID 分别含 a/b/c 以匹配 LATENCY_MAP
    const sourceA = await sourceService.create({ name: '源A', type: 'alist', baseUrl: 'https://a.example.com' });
    const sourceB = await sourceService.create({ name: '源B', type: 'alist', baseUrl: 'https://b.example.com' });
    const sourceC = await sourceService.create({ name: '源C', type: 'alist', baseUrl: 'https://c.example.com' });

    // 重新注册 adapter，使用真实 ID 映射
    sourceRegistry.register({
      type: 'alist',
      async testConnection(source: Source) {
        const id = source.id;
        const latency =
          id === sourceA.id ? 120 : id === sourceB.id ? 350 : id === sourceC.id ? 80 : 100;
        return {
          ok: true,
          latencyMs: latency,
          health: 'ok' as const,
          error: null,
          itemCount: 1,
        };
      },
      async listCategories() { return []; },
      async browse() { return { items: [], page: 1, pageSize: 30, total: 0, hasMore: false }; },
      async search() { return []; },
      async getDetail() { throw new Error('not used'); },
      async resolvePlayUrl() { throw new Error('not used'); },
    } as unknown as SourceAdapter);

    // Step 1: checkAll → 填充全部 3 个源
    const allSnapshot = await healthService.checkAll({ force: true });
    expect(Object.keys(allSnapshot.results)).toHaveLength(3);
    expect(healthService.latencyOf(sourceA.id)).toBe(120);
    expect(healthService.latencyOf(sourceB.id)).toBe(350);
    expect(healthService.latencyOf(sourceC.id)).toBe(80);

    const tierABefore = healthService.tierOf(sourceA.id);
    const tierCBefore = healthService.tierOf(sourceC.id);

    // Step 2: check([sourceB]) → 只检测 B
    const subSnapshot = await healthService.check([sourceB.id]);

    // 返回的是合并后的快照（含全部 3 个源）
    expect(Object.keys(subSnapshot.results)).toHaveLength(3);
    expect(subSnapshot.results[sourceB.id]).toBeDefined();

    // Step 3: 关键断言 — A 和 C 的缓存数据不应丢失
    expect(healthService.latencyOf(sourceA.id)).toBe(120);
    expect(healthService.latencyOf(sourceC.id)).toBe(80);
    expect(healthService.healthOf(sourceA.id)).toBe('ok');
    expect(healthService.healthOf(sourceC.id)).toBe('ok');

    // Tier 不应退化为 bad
    expect(healthService.tierOf(sourceA.id)).toBe(tierABefore);
    expect(healthService.tierOf(sourceC.id)).toBe(tierCBefore);
  });

  it('无缓存时 check(ids) 仍正常创建新快照', async () => {
    const source = await sourceService.create({
      name: '孤立源',
      type: 'alist',
      baseUrl: 'https://lonely.example.com',
    });

    // healthService.__reset() 已清空缓存，直接 check
    const snapshot = await healthService.check([source.id]);
    expect(Object.keys(snapshot.results)).toHaveLength(1);
    expect(snapshot.results[source.id]?.health).toBe('ok');
    expect(healthService.latencyOf(source.id)).toBe(100);
  });

  it('checkAll 仍正常替换整个快照', async () => {
    const sourceA = await sourceService.create({ name: 'A', type: 'alist', baseUrl: 'https://a2.example.com' });
    const sourceB = await sourceService.create({ name: 'B', type: 'alist', baseUrl: 'https://b2.example.com' });

    sourceRegistry.register({
      type: 'alist',
      async testConnection(source: Source) {
        return {
          ok: true,
          latencyMs: source.id === sourceA.id ? 200 : 400,
          health: 'ok' as const,
          error: null,
          itemCount: 1,
        };
      },
      async listCategories() { return []; },
      async browse() { return { items: [], page: 1, pageSize: 30, total: 0, hasMore: false }; },
      async search() { return []; },
      async getDetail() { throw new Error('not used'); },
      async resolvePlayUrl() { throw new Error('not used'); },
    } as unknown as SourceAdapter);

    await healthService.checkAll({ force: true });
    expect(healthService.latencyOf(sourceA.id)).toBe(200);
    expect(healthService.latencyOf(sourceB.id)).toBe(400);

    // 再次 checkAll 应替换（非合并）
    sourceRegistry.register({
      type: 'alist',
      async testConnection(_source: Source) {
        return {
          ok: true,
          latencyMs: 999,
          health: 'ok' as const,
          error: null,
          itemCount: 1,
        };
      },
      async listCategories() { return []; },
      async browse() { return { items: [], page: 1, pageSize: 30, total: 0, hasMore: false }; },
      async search() { return []; },
      async getDetail() { throw new Error('not used'); },
      async resolvePlayUrl() { throw new Error('not used'); },
    } as unknown as SourceAdapter);

    await healthService.checkAll({ force: true });
    expect(healthService.latencyOf(sourceA.id)).toBe(999);
    expect(healthService.latencyOf(sourceB.id)).toBe(999);
  });
});
