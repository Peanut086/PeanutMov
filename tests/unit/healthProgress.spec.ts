import { describe, expect, it, beforeEach } from 'vitest';

import { appEvents } from '@/services/events';
import { sourceService } from '@/services/sourceService';
import { sourceRegistry } from '@/sources/registry';
import type { Source, SourceAdapter } from '@/types';

import { resetAll } from './helpers';

/**
 * CHG-05 / AC-107：批量测速的并发与进度事件
 *
 * 只断言"事件序列不重不漏 + 并发不超过上限"，不依赖真实网络与真实耗时。
 */
function makeAdapter(opts: {
  delayMs?: number;
  failIds?: Set<string>;
  track?: { inFlight: number; peak: number };
}): SourceAdapter {
  const delay = opts.delayMs ?? 0;
  return {
    type: 'alist',
    async testConnection(source: Source) {
      if (opts.track) {
        opts.track.inFlight += 1;
        opts.track.peak = Math.max(opts.track.peak, opts.track.inFlight);
      }
      try {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (opts.failIds?.has(source.id)) {
          return {
            ok: false,
            latencyMs: delay,
            health: 'timeout' as const,
            error: { code: 'E_TIMEOUT' as const, message: '超时', detail: null, retryable: true, httpStatus: null },
            itemCount: null,
          };
        }
        return { ok: true, latencyMs: delay, health: 'ok' as const, error: null, itemCount: 1 };
      } finally {
        if (opts.track) opts.track.inFlight -= 1;
      }
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

async function createSources(count: number): Promise<Source[]> {
  const created: Source[] = [];
  for (let i = 0; i < count; i += 1) {
    created.push(
      await sourceService.create({
        name: `线路 ${i + 1}`,
        type: 'alist',
        baseUrl: `https://s${i}.example.com`,
      }),
    );
  }
  return created;
}

describe('checkHealth 进度事件（AC-107）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('进度序列从 0 严格递增到 total，不重不漏', async () => {
    const sources = await createSources(5);
    sourceRegistry.register(makeAdapter({}));

    const seen: Array<{ done: number; total: number }> = [];
    const off = appEvents.on('sources:healthProgress', (payload) => seen.push({ ...payload }));

    await sourceService.checkHealth(sources.map((s) => s.id));
    off();

    expect(seen[0]).toEqual({ done: 0, total: 5 });
    const dones = seen.map((item) => item.done);
    // 严格递增（除起点外每个源 +1）
    for (let i = 1; i < dones.length; i += 1) {
      expect(dones[i]).toBe(dones[i - 1]! + 1);
    }
    expect(dones[dones.length - 1]).toBe(5);
    expect(seen.every((item) => item.total === 5)).toBe(true);
  });

  it('单源失败也计入进度（节奏不变）', async () => {
    const sources = await createSources(4);
    sourceRegistry.register(makeAdapter({ failIds: new Set([sources[1]!.id, sources[3]!.id]) }));

    const seen: number[] = [];
    const off = appEvents.on('sources:healthProgress', (payload) => seen.push(payload.done));
    const results = await sourceService.checkHealth(sources.map((s) => s.id));
    off();

    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(results[sources[1]!.id]?.health).toBe('timeout');
    expect(results[sources[0]!.id]?.health).toBe('ok');
  });

  it('空集合只发一次 {0,0}', async () => {
    sourceRegistry.register(makeAdapter({}));
    const seen: Array<{ done: number; total: number }> = [];
    const off = appEvents.on('sources:healthProgress', (payload) => seen.push({ ...payload }));

    // 没有任何启用源（新建库只有演示源，这里按不存在的 id 过滤）
    await sourceService.checkHealth(['not-exist']);
    off();

    expect(seen).toEqual([{ done: 0, total: 0 }]);
  });

  it('并发不超过 HEALTH_CHECK_CONCURRENCY（6）', async () => {
    const sources = await createSources(9);
    const track = { inFlight: 0, peak: 0 };
    sourceRegistry.register(makeAdapter({ delayMs: 40, track }));

    await sourceService.checkHealth(sources.map((s) => s.id));

    expect(track.peak).toBeLessThanOrEqual(6);
    expect(track.peak).toBeGreaterThan(1);
  });

  it('50 个源、每个 20ms 时总耗时远小于 25s（AC-107 口径）', async () => {
    const sources = await createSources(50);
    sourceRegistry.register(makeAdapter({ delayMs: 20 }));

    const started = Date.now();
    await sourceService.checkHealth(sources.map((s) => s.id));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(25_000);
  });
});
