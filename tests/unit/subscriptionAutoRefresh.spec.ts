/**
 * FIX-06 / FR-51 / AC-119：订阅自动刷新「启动 + App 回前台」触发与 24h TTL 去重
 *
 * 缺陷：`initSubscriptionAutoRefresh()` 只在启动时 fire-and-forget 调一次，
 * 之后无论 App 回到前台多少次都不会再补触发（SRS FR-51「启动时 + 每 24h 自动刷新」只落了一半）。
 *
 * 修复口径（Q-05=A）：启动 + 回前台触发，TTL 判定不常驻定时器；
 * 回前台与启动共用同一闸门（24h 去重 + 在途合并），避免 24h 内重复拉取或并发拉取。
 *
 * 本用例只验证「触发层」：`maybeAutoRefresh` 被 spy 掉，不碰 IndexedDB / 网络；
 * 逐订阅 TTL 语义由 `subscriptionLifecycle.spec.ts` 与 `importService.spec.ts` 覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetLifecycleState } from '@/native/appLifecycle';
import {
  subscriptionLifecycleService,
  type SubscriptionRefreshResult,
} from '@/services/subscriptionLifecycleService';
import { initSubscriptionAutoRefresh } from '@/stores/bootstrap';

const DAY = 24 * 60 * 60 * 1000;
/** 真实时钟引用（用于在 Date.now 上叠加可控偏移） */
const realNow = Date.now.bind(Date);

let clockOffset = 0;
let restores: Array<() => void> = [];

/** 触发 Web 端前后台切换（appLifecycle 的 visibilitychange 兜底） */
function emitVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

/**
 * 一次「切后台 → 回前台」。
 *
 * 注意：`dispatchEvent` 是同步的，回前台回调会同步进入 `autoRefreshIfDue` 并在第一个
 * await 前落闸门/在途 Promise，所以断言前必须先 `flush()` 让在途刷新落地，
 * 否则下一次回前台会被正确地「合并到在途任务」而看不到新调用。
 */
function emitResume(): void {
  emitVisibility('hidden');
  emitVisibility('visible');
}

/** 让 fire-and-forget 的异步链路（含微任务）落地 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** spy 掉真实刷新链路，返回调用计数与可控的 resolve 句柄 */
function stubRefresh(): {
  calls: () => number;
  resolve: (result: SubscriptionRefreshResult) => void;
  usePending: () => void;
} {
  let resolveRun: ((result: SubscriptionRefreshResult) => void) | null = null;
  let pending: Promise<SubscriptionRefreshResult> | null = null;
  const spy = vi
    .spyOn(subscriptionLifecycleService, 'maybeAutoRefresh')
    .mockImplementation(() => {
      if (pending) return pending;
      return Promise.resolve({ refreshed: 0, failed: 0, deferred: 0 });
    });
  restores.push(() => spy.mockRestore());
  return {
    calls: () => spy.mock.calls.length,
    /** 切换到「在途」模式：首次调用挂起，直到手动 resolve */
    usePending: () => {
      pending = new Promise((resolve) => {
        resolveRun = resolve;
      });
    },
    resolve: (result) => {
      pending = null;
      resolveRun?.(result);
    },
  };
}

describe('订阅自动刷新：回前台触发 + 24h TTL 去重（FIX-06 / AC-119）', () => {
  beforeEach(() => {
    subscriptionLifecycleService.__resetAutoRefreshState();
    resetLifecycleState();
    clockOffset = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
    restores.push(() => dateSpy.mockRestore());
  });

  afterEach(() => {
    subscriptionLifecycleService.__resetAutoRefreshState();
    resetLifecycleState();
    for (const restore of restores) restore();
    restores = [];
  });

  it('TTL 过期（无历史 / 超过 24h）：回前台触发刷新', async () => {
    const stub = stubRefresh();
    subscriptionLifecycleService.bindAutoRefresh();

    // 首次回前台（无历史 = 视为到期）
    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);

    // 超过 24h 后再回前台：再次刷新
    clockOffset = DAY + 1;
    emitResume();
    await flush();
    expect(stub.calls()).toBe(2);
  });

  it('TTL 未过期（24h 内）：回前台不重复触发', async () => {
    const stub = stubRefresh();
    subscriptionLifecycleService.bindAutoRefresh();

    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);

    // 23h59m：仍应被闸门拦下
    clockOffset = DAY - 60_000;
    emitResume();
    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);

    // 恰好跨过 24h：恢复触发
    clockOffset = DAY + 60_000;
    emitResume();
    await flush();
    expect(stub.calls()).toBe(2);
  });

  it('并发去重：快速连续回前台只执行一次（复用同一在途刷新）', async () => {
    const stub = stubRefresh();
    stub.usePending();
    subscriptionLifecycleService.bindAutoRefresh();

    // 第一轮：回前台 → 刷新挂起（在途）
    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);

    // 在途期间反复切前后台：不得再发起新的刷新
    emitResume();
    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);

    // 在途结束后（TTL 闸门已落），再回前台依然只有一次真实刷新
    stub.resolve({ refreshed: 2, failed: 0, deferred: 0 });
    await flush();
    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);
  });

  it('进后台不触发刷新（仅回前台触发）', async () => {
    const stub = stubRefresh();
    subscriptionLifecycleService.bindAutoRefresh();

    emitVisibility('hidden');
    emitVisibility('hidden');
    await flush();
    expect(stub.calls()).toBe(0);
  });

  it('离线时不发起刷新，也不占用 TTL 闸门（联网后回前台可补触发）', async () => {
    const stub = stubRefresh();
    const onlineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    restores.push(() => onlineSpy.mockRestore());
    subscriptionLifecycleService.bindAutoRefresh();

    emitResume();
    await flush();
    expect(stub.calls()).toBe(0);

    onlineSpy.mockReturnValue(true);
    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);
  });

  it('bindAutoRefresh 幂等：重复绑定只保留一个生命周期订阅', async () => {
    const stub = stubRefresh();
    subscriptionLifecycleService.bindAutoRefresh();
    subscriptionLifecycleService.bindAutoRefresh();
    subscriptionLifecycleService.bindAutoRefresh();

    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);
    await flush();
    expect(stub.calls()).toBe(1);
  });

  it('启动触发：initSubscriptionAutoRefresh 立即发起一次并接线回前台', async () => {
    const stub = stubRefresh();

    initSubscriptionAutoRefresh();
    await flush();
    expect(stub.calls()).toBe(1);

    // 启动后 24h 内回前台不再重复触发（启动与回前台共用闸门）
    emitResume();
    await flush();
    expect(stub.calls()).toBe(1);

    // 超过 24h 后回前台补触发
    clockOffset = DAY + 1;
    emitResume();
    await flush();
    expect(stub.calls()).toBe(2);
  });
});
