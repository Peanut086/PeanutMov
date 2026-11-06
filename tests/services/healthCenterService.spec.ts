/**
 * 健康中心数据服务单测（EXT-01）
 *
 * 覆盖：汇总口径、失败分布、7 日趋势（补零 / 健康率 / 日期键）、
 * kv 持久化的归一化与异常降级。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { kvRepo } from '@/db/repositories/kvRepo';
import {
  buildTrendSeries,
  clearHealthTrend,
  dateKeyOf,
  FAILURE_REASON_META,
  failureDistributionOf,
  HEALTH_TREND_KV_KEY,
  HEALTH_TREND_MAX_SNAPSHOTS,
  isFailureHealth,
  loadHealthTrend,
  normalizeSnapshots,
  recordHealthTrend,
  saveHealthTrend,
  snapshotOf,
  summarizeSources,
  trendLabelOf,
  upsertSnapshot,
  type HealthCenterSummary,
  type HealthTrendSnapshot,
} from '@/services/healthCenterService';
import type { Source } from '@/types';

import { readKv, resetAll } from '../unit/helpers';

function makeSource(overrides: Partial<Source> = {}): Source {
  const now = Date.now();
  return {
    id: overrides.id ?? 'source-1',
    key: overrides.key ?? overrides.id ?? 'source-1',
    name: overrides.name ?? '测试源',
    type: overrides.type ?? 'site',
    enabled: overrides.enabled ?? true,
    builtin: false,
    sort: overrides.sort ?? 0,
    baseUrl: overrides.baseUrl ?? 'https://example.com',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: overrides.health ?? 'unknown',
    healthCheckedAt: overrides.healthCheckedAt ?? null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function summaryOf(overrides: Partial<HealthCenterSummary> = {}): HealthCenterSummary {
  return { total: 0, healthy: 0, failed: 0, unknown: 0, disabled: 0, ...overrides };
}

describe('isFailureHealth', () => {
  it('四种失败态为 true，ok / unknown 为 false', () => {
    expect(isFailureHealth('timeout')).toBe(true);
    expect(isFailureHealth('unreachable')).toBe(true);
    expect(isFailureHealth('bad_config')).toBe(true);
    expect(isFailureHealth('auth_failed')).toBe(true);
    expect(isFailureHealth('ok')).toBe(false);
    expect(isFailureHealth('unknown')).toBe(false);
  });
});

describe('summarizeSources', () => {
  it('四类计数互斥，healthy + failed + unknown === total', () => {
    const list = [
      makeSource({ id: 'a', health: 'ok' }),
      makeSource({ id: 'b', health: 'timeout' }),
      makeSource({ id: 'c', health: 'unreachable', enabled: false }),
      makeSource({ id: 'd', health: 'unknown' }),
    ];
    const summary = summarizeSources(list);
    expect(summary).toEqual({ total: 4, healthy: 1, failed: 2, unknown: 1, disabled: 1 });
    expect(summary.healthy + summary.failed + summary.unknown).toBe(summary.total);
  });

  it('空列表全 0', () => {
    expect(summarizeSources([])).toEqual({
      total: 0,
      healthy: 0,
      failed: 0,
      unknown: 0,
      disabled: 0,
    });
  });
});

describe('failureDistributionOf', () => {
  it('按数量降序，占比按失败源总数计算', () => {
    const buckets = failureDistributionOf([
      makeSource({ id: 'a', health: 'unreachable' }),
      makeSource({ id: 'b', health: 'unreachable' }),
      makeSource({ id: 'c', health: 'timeout' }),
      makeSource({ id: 'd', health: 'bad_config' }),
      makeSource({ id: 'e', health: 'ok' }),
      makeSource({ id: 'f', health: 'unknown' }),
    ]);

    expect(buckets.map((bucket) => bucket.reason)).toEqual([
      'unreachable',
      'timeout',
      'bad_config',
    ]);
    expect(buckets[0]).toEqual({
      reason: 'unreachable',
      ...FAILURE_REASON_META.unreachable,
      count: 2,
      ratio: 0.5,
      percent: 50,
    });
    expect(buckets[1].percent).toBe(25);
    expect(buckets[2].percent).toBe(25);
  });

  it('并列时按固定顺序（timeout → unreachable → bad_config → auth_failed）', () => {
    const buckets = failureDistributionOf([
      makeSource({ id: 'a', health: 'auth_failed' }),
      makeSource({ id: 'b', health: 'bad_config' }),
      makeSource({ id: 'c', health: 'timeout' }),
      makeSource({ id: 'd', health: 'unreachable' }),
    ]);
    expect(buckets.map((bucket) => bucket.reason)).toEqual([
      'timeout',
      'unreachable',
      'bad_config',
      'auth_failed',
    ]);
    expect(buckets.every((bucket) => bucket.percent === 25)).toBe(true);
  });

  it('没有失败源时返回空数组', () => {
    expect(
      failureDistributionOf([makeSource({ health: 'ok' }), makeSource({ id: 'x', health: 'unknown' })]),
    ).toEqual([]);
  });
});

describe('日期键与趋势点', () => {
  it('dateKeyOf 用本地日期并补零', () => {
    expect(dateKeyOf(new Date(2026, 10, 6, 23, 30).getTime())).toBe('2026-11-06');
    expect(dateKeyOf(new Date(2026, 0, 9))).toBe('2026-01-09');
    expect(dateKeyOf(new Date(Number.NaN))).toBe('');
  });

  it('trendLabelOf 取 MM-DD，非法输入原样返回', () => {
    expect(trendLabelOf('2026-11-06')).toBe('11-06');
    expect(trendLabelOf('bad')).toBe('bad');
  });

  it('buildTrendSeries 恒定 7 天，缺失日补 0 并标记未采集', () => {
    const now = new Date(2026, 10, 6, 12, 0).getTime();
    const series = buildTrendSeries(
      [
        { date: '2026-10-31', total: 10, healthy: 5, failed: 3, unknown: 2 },
        { date: '2026-11-06', total: 4, healthy: 3, failed: 1, unknown: 0 },
      ],
      now,
    );

    expect(series).toHaveLength(7);
    expect(series[0]).toMatchObject({ date: '2026-10-31', label: '10-31', recorded: true });
    expect(series[6]).toMatchObject({
      date: '2026-11-06',
      label: '11-06',
      recorded: true,
      healthRate: 75,
    });
    expect(series[3]).toMatchObject({ recorded: false, total: 0, healthy: 0, healthRate: 0 });
  });

  it('buildTrendSeries 对天数做上下限收敛', () => {
    const now = new Date(2026, 10, 6, 12, 0).getTime();
    expect(buildTrendSeries([], now, 0)).toHaveLength(1);
    expect(buildTrendSeries([], now, 999)).toHaveLength(HEALTH_TREND_MAX_SNAPSHOTS);
    expect(buildTrendSeries([], new Date(Number.NaN).getTime())).toEqual([]);
  });

  it('snapshotOf 只保留四项计数', () => {
    expect(snapshotOf(summaryOf({ total: 3, healthy: 1, failed: 1, unknown: 1, disabled: 2 }), '2026-11-06')).toEqual({
      date: '2026-11-06',
      total: 3,
      healthy: 1,
      failed: 1,
      unknown: 1,
    });
  });
});

describe('normalizeSnapshots / upsertSnapshot', () => {
  it('非数组返回空数组', () => {
    expect(normalizeSnapshots(null)).toEqual([]);
    expect(normalizeSnapshots('oops')).toEqual([]);
    expect(normalizeSnapshots({ date: '2026-11-06' })).toEqual([]);
  });

  it('丢弃非法日期与空条目，负数/非数字收敛为 0，同日后者覆盖', () => {
    const normalized = normalizeSnapshots([
      null,
      { date: 'bad' },
      { date: '2026-11-06', total: -1, healthy: 'x', failed: 2, unknown: 1 },
      { date: '2026-11-05', total: 3, healthy: 2, failed: 1, unknown: 0 },
      { date: '2026-11-06', total: 4, healthy: 3, failed: 1, unknown: 0 },
    ]);

    expect(normalized.map((item) => item.date)).toEqual(['2026-11-05', '2026-11-06']);
    expect(normalized[1]).toEqual({
      date: '2026-11-06',
      total: 4,
      healthy: 3,
      failed: 1,
      unknown: 0,
    });
  });

  it('最多保留最近 30 条', () => {
    const list: HealthTrendSnapshot[] = [];
    for (let offset = 0; offset < 35; offset += 1) {
      const date = dateKeyOf(new Date(2026, 0, 1 + offset));
      list.push({ date, total: offset + 1, healthy: offset + 1, failed: 0, unknown: 0 });
    }
    const normalized = normalizeSnapshots(list);
    expect(normalized).toHaveLength(HEALTH_TREND_MAX_SNAPSHOTS);
    expect(normalized[normalized.length - 1].date).toBe(dateKeyOf(new Date(2026, 0, 35)));
    expect(normalized[0].date).toBe(dateKeyOf(new Date(2026, 0, 6)));
  });

  it('upsertSnapshot 覆盖同日并保持升序', () => {
    const base: HealthTrendSnapshot[] = [
      { date: '2026-11-05', total: 2, healthy: 1, failed: 1, unknown: 0 },
      { date: '2026-11-06', total: 2, healthy: 1, failed: 1, unknown: 0 },
    ];
    const next = upsertSnapshot(base, {
      date: '2026-11-06',
      total: 5,
      healthy: 4,
      failed: 1,
      unknown: 0,
    });
    expect(next).toHaveLength(2);
    expect(next[1].total).toBe(5);
    expect(next[0].date).toBe('2026-11-05');
  });
});

describe('趋势快照持久化（kv）', () => {
  beforeEach(async () => {
    await resetAll();
  });

  it('recordHealthTrend 落库并在同日覆盖', async () => {
    const now = new Date(2026, 10, 6, 9, 0).getTime();
    const first = await recordHealthTrend(
      summaryOf({ total: 5, healthy: 2, failed: 2, unknown: 1, disabled: 1 }),
      now,
    );
    expect(first).toHaveLength(1);
    expect(first[0]).toEqual({
      date: '2026-11-06',
      total: 5,
      healthy: 2,
      failed: 2,
      unknown: 1,
    });
    expect(await readKv(HEALTH_TREND_KV_KEY)).toEqual(first);

    const second = await recordHealthTrend(
      summaryOf({ total: 6, healthy: 3, failed: 2, unknown: 1 }),
      now + 60 * 60 * 1000,
    );
    expect(second).toHaveLength(1);
    expect(second[0].total).toBe(6);
  });

  it('损坏数据降级：非数组读出空数组，脏条目被清洗', async () => {
    await kvRepo.set(HEALTH_TREND_KV_KEY, 'not-an-array');
    expect(await loadHealthTrend()).toEqual([]);

    await kvRepo.set(HEALTH_TREND_KV_KEY, [
      { date: '2026-11-05', total: 3, healthy: 2, failed: 1, unknown: 0 },
      { date: 'bad-date', total: 1, healthy: 1, failed: 0, unknown: 0 },
      null,
    ]);
    const loaded = await loadHealthTrend();
    expect(loaded.map((item) => item.date)).toEqual(['2026-11-05']);
  });

  it('saveHealthTrend 写入前归一化，clearHealthTrend 清空', async () => {
    await saveHealthTrend([
      { date: '2026-11-06', total: 2, healthy: 1, failed: 1, unknown: 0 },
      { date: '2026-11-06', total: 4, healthy: 3, failed: 1, unknown: 0 },
    ]);
    const stored = await readKv<HealthTrendSnapshot[]>(HEALTH_TREND_KV_KEY);
    expect(stored).toHaveLength(1);
    expect(stored?.[0].total).toBe(4);

    await clearHealthTrend();
    expect(await readKv(HEALTH_TREND_KV_KEY)).toBeNull();
  });
});
