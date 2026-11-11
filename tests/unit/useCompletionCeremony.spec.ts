import { effectScope, nextTick } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DownloadTask } from '@/types';
import { CEREMONY_MS, useCompletionCeremony } from '@/composables/useCompletionCeremony';

/**
 * C-11 编排层：谁配庆祝
 *
 * 关键红线是「批量完成只庆祝一次」与「已有完成态不该在进场时重播」，
 * 所以这里重点验 diff 的基线与时限，而不是动画本身。
 */
function task(id: string, status: DownloadTask['status']): DownloadTask {
  return { id, status } as DownloadTask;
}

function ceremonyInScope() {
  let api!: ReturnType<typeof useCompletionCeremony>;
  const scope = effectScope();
  scope.run(() => {
    api = useCompletionCeremony();
  });
  return { api, scope };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCompletionCeremony', () => {
  it('首次 observe 只登记基线：进页面时已完成的任务不放动画', () => {
    const { api } = ceremonyInScope();
    const result = api.observe([task('a', 'completed'), task('b', 'downloading')]);

    expect(result).toEqual({ fresh: [], bulk: false });
    expect(api.celebrateId.value).toBeNull();
    expect(api.celebrateSummary.value).toBe(false);
  });

  it('单项新增完成：只有那一行庆祝', () => {
    const { api } = ceremonyInScope();
    api.observe([task('a', 'downloading')]);

    const result = api.observe([task('a', 'completed')]);
    expect(result.fresh.map((t) => t.id)).toEqual(['a']);
    expect(result.bulk).toBe(false);
    expect(api.celebrateId.value).toBe('a');
    expect(api.celebrateSummary.value).toBe(false);
  });

  it('批量新增完成：汇总卡庆祝一次，单项静默', () => {
    const { api } = ceremonyInScope();
    api.observe([task('a', 'downloading'), task('b', 'downloading'), task('c', 'downloading')]);

    const result = api.observe([task('a', 'completed'), task('b', 'completed'), task('c', 'completed')]);
    expect(result.fresh).toHaveLength(3);
    expect(result.bulk).toBe(true);
    expect(api.celebrateId.value).toBeNull();
    expect(api.celebrateSummary.value).toBe(true);
  });

  it('庆祝状态到点自动摘 class，不常驻', () => {
    const { api } = ceremonyInScope();
    api.observe([task('a', 'downloading')]);
    api.observe([task('a', 'completed')]);

    vi.advanceTimersByTime(CEREMONY_MS - 1);
    expect(api.celebrateId.value).toBe('a');
    vi.advanceTimersByTime(2);
    expect(api.celebrateId.value).toBeNull();
  });

  it('非完成态变化不庆祝，也不清空正在放的动画', () => {
    const { api } = ceremonyInScope();
    api.observe([task('a', 'downloading')]);
    api.observe([task('a', 'completed')]);

    api.observe([task('a', 'completed'), task('b', 'downloading')]);
    expect(api.celebrateId.value).toBe('a');
    expect(vi.getTimerCount()).toBe(1);
  });

  it('任务被删除后同一条再次完成，会重新庆祝（清理 seen 的回归）', () => {
    const { api } = ceremonyInScope();
    api.observe([task('a', 'completed')]);
    vi.advanceTimersByTime(CEREMONY_MS + 10);

    api.observe([]);
    const result = api.observe([task('a', 'completed')]);
    expect(result.fresh.map((t) => t.id)).toEqual(['a']);
    expect(api.celebrateId.value).toBe('a');
  });

  it('作用域销毁（切走页面）不留定时器', async () => {
    const { api, scope } = ceremonyInScope();
    api.observe([task('a', 'downloading')]);
    api.observe([task('a', 'completed')]);
    expect(vi.getTimerCount()).toBe(1);

    scope.stop();
    await nextTick();
    expect(vi.getTimerCount()).toBe(0);
    expect(api.celebrateId.value).toBeNull();
    expect(api.celebrateSummary.value).toBe(false);
  });
});
