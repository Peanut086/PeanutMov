/**
 * P1-1：`sourceStore.checkSources(ids)`（导入后只体检本批源）
 *
 * 钉住四件事：
 * 1. 统计口径按传入 ids 取——`healthService.check(ids)` 返回的是与旧快照合并后的全量结果，
 *    直接把 `failedCount` 报给用户会把"别的源早就坏了"算成本次导入的成绩；
 * 2. 收尾与 `refreshHealth` 一致：退化处置 → 重载列表 → 刷新订阅摘要；
 * 3. 取消不是错误：返回 `aborted`，不写 `error`，`healthChecking` 归位；
 * 4. 空列表 / 已在检测时不并发探测。
 */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { healthService, type HealthSnapshot } from '@/services/healthService';
import { sourceService } from '@/services/sourceService';
import { subscriptionLifecycleService } from '@/services/subscriptionLifecycleService';
import { useSourceStore } from '@/stores/sourceStore';
import { AppError } from '@/shared/errors';
import type { HealthCheckResult, Source, SourceHealth } from '@/types';

import { resetAll } from './helpers';

function makeSource(id: string): Source {
  const now = Date.now();
  return {
    id,
    key: id,
    name: `源 ${id}`,
    type: 'site',
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl: `https://${id}.example.com`,
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    autoDisabledAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function resultOf(health: SourceHealth): HealthCheckResult {
  return { sourceId: 'probe', health, checkedAt: Date.now(), latencyMs: 100, error: null };
}

/** 合并后的全量快照：s3 是"上次别的源"留下的失效记录，不该计入本次成绩 */
function snapshotOf(results: Record<string, HealthCheckResult>): HealthSnapshot {
  return {
    checkedAt: Date.now(),
    results: { ...results, s3: resultOf('unreachable') },
    failedCount: Object.values({ ...results, s3: resultOf('unreachable') }).filter(
      (r) => r.health !== 'ok',
    ).length,
  };
}

let store: ReturnType<typeof useSourceStore>;

beforeEach(async () => {
  vi.clearAllMocks();
  await resetAll();
  setActivePinia(createPinia());
  store = useSourceStore();
  vi.spyOn(sourceService, 'list').mockResolvedValue([makeSource('s1'), makeSource('s2'), makeSource('s3')]);
  vi.spyOn(subscriptionLifecycleService, 'applyHealthDegradation').mockResolvedValue(0);
  vi.spyOn(subscriptionLifecycleService, 'summarize').mockResolvedValue([]);
  await store.load();
});

describe('checkSources（P1-1）', () => {
  it('按传入 ids 统计可用/失效，合并快照里其它源的旧记录不算进来', async () => {
    const check = vi
      .spyOn(healthService, 'check')
      .mockResolvedValue(
        snapshotOf({ s1: resultOf('ok'), s2: resultOf('timeout') }),
      );

    const report = await store.checkSources(['s1', 's2']);

    expect(check.mock.calls[0]?.[0]).toEqual(['s1', 's2']);
    expect(report).toEqual({ aborted: false, checked: 2, ok: 1, bad: 1 });
  });

  it('收尾与全量体检一致：退化处置 → 重载列表', async () => {
    vi.spyOn(healthService, 'check').mockResolvedValue(snapshotOf({ s1: resultOf('ok') }));
    vi.mocked(sourceService.list).mockClear();

    await store.checkSources(['s1']);

    expect(subscriptionLifecycleService.applyHealthDegradation).toHaveBeenCalledTimes(1);
    expect(sourceService.list).toHaveBeenCalledTimes(1);
    expect(store.healthChecking).toBe(false);
    expect(store.healthProgress).toBeNull();
  });

  it('取消：aborted 返回、不写错误、状态归位', async () => {
    vi.spyOn(healthService, 'check').mockRejectedValue(new AppError('E_ABORTED'));

    const report = await store.checkSources(['s1', 's2']);

    expect(report.aborted).toBe(true);
    expect(store.error).toBeNull();
    expect(store.healthChecking).toBe(false);
    // 取消的那轮不做退化处置，避免半截结果触发误禁
    expect(subscriptionLifecycleService.applyHealthDegradation).not.toHaveBeenCalled();
  });

  it('探测中途取消但底层正常返回：仍标 aborted，并把已完成部分刷回界面', async () => {
    vi.spyOn(healthService, 'check').mockImplementation(async () => {
      // 模拟"用户在探测途中点了取消"，而服务层把已完成的部分正常返回
      store.cancelHealthCheck();
      return snapshotOf({ s1: resultOf('ok') });
    });

    const report = await store.checkSources(['s1', 's2']);

    expect(report.aborted).toBe(true);
    expect(report.checked).toBe(1);
    expect(store.error).toBeNull();
  });

  it('真错误照常上抛并写入 error（不是取消）', async () => {
    vi.spyOn(healthService, 'check').mockRejectedValue(new Error('db down'));

    await expect(store.checkSources(['s1'])).rejects.toThrow('db down');
    expect(store.error?.code).toBe('E_NETWORK');
    expect(store.healthChecking).toBe(false);
  });

  it('空列表与检测中都不发起探测', async () => {
    const check = vi.spyOn(healthService, 'check').mockResolvedValue(snapshotOf({}));

    await expect(store.checkSources([])).resolves.toEqual({
      aborted: false,
      checked: 0,
      ok: 0,
      bad: 0,
    });
    expect(check).not.toHaveBeenCalled();

    const pending = store.checkSources(['s1']);
    await expect(store.checkSources(['s2'])).resolves.toEqual({
      aborted: false,
      checked: 0,
      ok: 0,
      bad: 0,
    });
    expect(check).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('未探测到的源既不计 ok 也不计 bad（取消/跳过时不虚报成绩）', async () => {
    vi.spyOn(healthService, 'check').mockResolvedValue(snapshotOf({ s1: resultOf('ok') }));

    const report = await store.checkSources(['s1', 's2']);

    expect(report).toMatchObject({ checked: 1, ok: 1, bad: 0 });
  });
});
