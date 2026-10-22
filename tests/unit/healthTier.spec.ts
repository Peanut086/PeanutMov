import { describe, expect, it, beforeEach } from 'vitest';

import {
  HEALTH_TIER_LABELS,
  HEALTH_TIER_ORDER,
  HEALTH_TIER_THRESHOLDS,
  SOURCE_SORT_MODE_STORAGE_KEY,
  healthTierOf,
  readSourceSortMode,
  sortSources,
  writeSourceSortMode,
} from '@/shared/healthTier';
import type { Source, SourceHealth } from '@/types';

/**
 * CHG-05 / AC-106、AC-108
 *
 * 断言一律引用 `HEALTH_TIER_THRESHOLDS`，测试内不出现 300/800/2000 字面量，
 * 避免"改阈值不改测试"的假绿。
 */
const { fastMaxMs, goodMaxMs, fairMaxMs } = HEALTH_TIER_THRESHOLDS;

function source(overrides: Partial<Source> & { id: string }): Source {
  return {
    id: overrides.id,
    key: overrides.key ?? overrides.id,
    name: overrides.name ?? overrides.id,
    type: 'site',
    enabled: overrides.enabled ?? true,
    builtin: overrides.builtin ?? false,
    sort: overrides.sort ?? 0,
    baseUrl: 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: overrides.health ?? 'ok',
    healthCheckedAt: overrides.healthCheckedAt ?? 1,
    lastErrorCode: overrides.lastErrorCode ?? null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('healthTierOf（AC-106）', () => {
  it('阈值边界：fastMax / fastMax+1', () => {
    expect(healthTierOf('ok', fastMaxMs - 1)).toBe('fast');
    expect(healthTierOf('ok', fastMaxMs)).toBe('fast');
    expect(healthTierOf('ok', fastMaxMs + 1)).toBe('good');
  });

  it('阈值边界：goodMax / goodMax+1', () => {
    expect(healthTierOf('ok', goodMaxMs)).toBe('good');
    expect(healthTierOf('ok', goodMaxMs + 1)).toBe('fair');
  });

  it('阈值边界：fairMax / fairMax+1', () => {
    expect(healthTierOf('ok', fairMaxMs)).toBe('fair');
    expect(healthTierOf('ok', fairMaxMs + 1)).toBe('slow');
  });

  it('0ms 视为极速（可用延迟下界）', () => {
    expect(healthTierOf('ok', 0)).toBe('fast');
  });

  it('非 ok 一律 bad，不看延迟', () => {
    const unhealthy: SourceHealth[] = ['auth_failed', 'timeout', 'unreachable', 'bad_config'];
    for (const health of unhealthy) {
      expect(healthTierOf(health, 10), health).toBe('bad');
      expect(healthTierOf(health, null), health).toBe('bad');
    }
  });

  it('ok 但延迟不可用 → bad（null / NaN / Infinity / 负数）', () => {
    expect(healthTierOf('ok', null)).toBe('bad');
    expect(healthTierOf('ok', Number.NaN)).toBe('bad');
    expect(healthTierOf('ok', Number.POSITIVE_INFINITY)).toBe('bad');
    expect(healthTierOf('ok', -1)).toBe('bad');
  });

  it('unknown 优先于一切（即使带了延迟）', () => {
    expect(healthTierOf('unknown', null)).toBe('unknown');
    expect(healthTierOf('unknown', 50)).toBe('unknown');
  });

  it('六档文案与顺序表完整', () => {
    const tiers = Object.keys(HEALTH_TIER_LABELS);
    expect(tiers).toHaveLength(6);
    expect(Object.keys(HEALTH_TIER_ORDER)).toEqual(tiers);
    expect(HEALTH_TIER_ORDER.fast).toBeLessThan(HEALTH_TIER_ORDER.bad);
    expect(HEALTH_TIER_LABELS).toMatchObject({
      fast: '极速',
      good: '快速',
      fair: '一般',
      slow: '较慢',
      bad: '异常',
      unknown: '未检测',
    });
  });
});

describe('sortSources（AC-108）', () => {
  const latencyMap: Record<string, number | null> = {
    a: 900,
    b: 100,
    c: null,
    d: 500,
    e: 5000,
  };
  const latencyOf = (id: string): number | null => latencyMap[id] ?? null;

  it('tier 模式：按档位 → 延迟升序', () => {
    const list = [
      source({ id: 'e', health: 'ok' }), // slow 5000
      source({ id: 'a', health: 'ok' }), // fair 900
      source({ id: 'b', health: 'ok' }), // fast 100
      source({ id: 'd', health: 'ok' }), // good 500
    ];
    expect(sortSources(list, 'tier', latencyOf).map((s) => s.id)).toEqual(['b', 'd', 'a', 'e']);
  });

  it('tier 模式：bad 与 unknown 排在 ok 之后，null 延迟在同档排最后', () => {
    const list = [
      source({ id: 'u', health: 'unknown' }),
      source({ id: 'x', health: 'timeout' }), // bad
      source({ id: 'c', health: 'ok' }), // ok 但延迟 null → bad
      source({ id: 'b', health: 'ok' }),
    ];
    const ids = sortSources(list, 'tier', latencyOf).map((s) => s.id);
    expect(ids[0]).toBe('b');
    expect(ids.slice(1)).toEqual(expect.arrayContaining(['c', 'x', 'u']));
    // unknown 恒最后
    expect(ids[ids.length - 1]).toBe('u');
  });

  it('tier 模式：同档同延迟按 sort → name → id 稳定', () => {
    const list = [
      source({ id: 'z2', name: '乙', sort: 2, health: 'ok' }),
      source({ id: 'z1', name: '甲', sort: 2, health: 'ok' }),
      source({ id: 'z0', name: '丙', sort: 1, health: 'ok' }),
    ];
    const same = () => 100;
    expect(sortSources(list, 'tier', same).map((s) => s.id)).toEqual(['z0', 'z1', 'z2']);
  });

  it('tier 模式不特判 builtin（演示源按实际质量自然靠前）', () => {
    const list = [
      source({ id: 'demo', builtin: true, sort: 9999, health: 'ok' }),
      source({ id: 'slow-one', health: 'ok' }),
    ];
    expect(sortSources(list, 'tier', (id) => (id === 'demo' ? 5 : 1800)).map((s) => s.id)).toEqual([
      'demo',
      'slow-one',
    ]);
  });

  it('manual 模式：builtin 升序 → sort 升序，与既有列表行为一致', () => {
    const list = [
      source({ id: 'demo', builtin: true, sort: 9999 }),
      source({ id: 'third', sort: 3 }),
      source({ id: 'first', sort: 1 }),
    ];
    expect(sortSources(list, 'manual', latencyOf).map((s) => s.id)).toEqual(['first', 'third', 'demo']);
  });

  it('不修改入参且多次排序结果一致', () => {
    const list = [source({ id: 'a', health: 'ok' }), source({ id: 'b', health: 'ok' })];
    const snapshot = list.map((s) => s.id);
    const once = sortSources(list, 'tier', latencyOf).map((s) => s.id);
    const twice = sortSources(list, 'tier', latencyOf).map((s) => s.id);
    expect(list.map((s) => s.id)).toEqual(snapshot);
    expect(once).toEqual(twice);
  });
});

describe('排序偏好持久化（AC-108）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('缺省为 manual', () => {
    expect(readSourceSortMode()).toBe('manual');
  });

  it('写入后可读回', () => {
    writeSourceSortMode('tier');
    expect(readSourceSortMode()).toBe('tier');
    expect(localStorage.getItem(SOURCE_SORT_MODE_STORAGE_KEY)).toBe('tier');
  });

  it('非法值回退 manual', () => {
    localStorage.setItem(SOURCE_SORT_MODE_STORAGE_KEY, 'whatever');
    expect(readSourceSortMode()).toBe('manual');
  });

  it('读写异常不影响调用方（隐私模式模拟）', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('denied');
      },
    });
    try {
      expect(readSourceSortMode()).toBe('manual');
      expect(() => writeSourceSortMode('tier')).not.toThrow();
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    }
  });
});
