/**
 * P1-7（D11）：探活窗口分级口径。
 *
 * 两层窗口必须同步分级，否则短的那一层先误判：
 * - `sourceService.probeTimeoutOf` → `httpClient.withProbeTimeout` 的收窄层；
 * - `BaseAdapter.probeWindowMs` → 适配器自己的探测闸门层（`recheckAlive` 直接走这层）。
 * 本文件守住分级表与闸门层；收窄层的实际生效见 `tests/unit/sourceService.spec.ts`「检查超时口径」。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  TIMEOUT_PROBE_NETSTORE_MS,
  TIMEOUT_PROBE_SPIDER_MS,
  TIMEOUT_PROBE_SPIDER_WARM_MS,
  TIMEOUT_TEST_CONNECTION_MS,
} from '@/shared/constants';
import { AppError } from '@/shared/errors';
import { AlistAdapter } from '@/sources/alist/AlistAdapter';
import { SiteAdapter } from '@/sources/site/SiteAdapter';
import { SpiderAdapter } from '@/sources/spider/SpiderAdapter';
import { probeWindowMsFor } from '@/sources/probeWindow';
import { probeTimeoutOf } from '@/services/sourceService';
import type { ConnectionResult, Source, SourceType } from '@/types';

const ALL_TYPES: readonly SourceType[] = ['demo', 'alist', 'webdav', 'jellyfin', 'site', 'spider', 'douban'];

function makeSource(type: SourceType, baseUrl: string): Source {
  const now = Date.now();
  return {
    id: `src-${type}`,
    key: `src-${type}`,
    name: `${type} 源`,
    type,
    enabled: true,
    builtin: false,
    sort: 0,
    baseUrl,
    pathPrefix: null,
    auth: { mode: 'token', username: null, password: null, token: 'tok' },
    headers: {},
    ext: null,
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** 适配器 `testConnection` 内部实际使用的闸门值（protected，测试侧按口径取） */
function adapterGateWindow(adapter: object, source: Source): number {
  return (adapter as { probeWindowMs: (s: Source) => number }).probeWindowMs(source);
}

/**
 * 把适配器的 `probe` 换成「只在 abort 信号上失败、永不自行返回」的挂起实现。
 * 直接 stub 而不是伪造 fetch：`AlistAdapter.probe` / `SiteAdapter.probe` 不透传 signal，
 * 真实 fetch 场景要经 `withProbeTimeout` 才收得住（那部分在 sourceService 的用例里覆盖），
 * 本用例只看适配器闸门层何时判定。
 */
function stubHangingProbe(prototype: object, key: string): void {
  type ProbeFn = (source: Source, signal?: AbortSignal) => Promise<{ itemCount: number | null }>;
  vi.spyOn(prototype as unknown as Record<string, ProbeFn>, key).mockImplementation(
    (_source: Source, signal?: AbortSignal) =>
      new Promise<{ itemCount: number | null }>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new AppError('E_ABORTED'));
          return;
        }
        signal?.addEventListener('abort', () => reject(new AppError('E_ABORTED')), { once: true });
      }),
  );
}

describe('探活窗口分级（P1-7）', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('分级表：spider 35s、alist/webdav/jellyfin 8s、site/douban/demo 3s', () => {
    expect(TIMEOUT_PROBE_NETSTORE_MS).toBe(8000);
    expect(probeWindowMsFor(makeSource('spider', 'https://example.com'))).toBe(TIMEOUT_PROBE_SPIDER_MS);
    for (const type of ['alist', 'webdav', 'jellyfin'] as const) {
      expect(probeWindowMsFor(makeSource(type, 'https://example.com'))).toBe(TIMEOUT_PROBE_NETSTORE_MS);
    }
    for (const type of ['site', 'douban', 'demo'] as const) {
      expect(probeWindowMsFor(makeSource(type, 'https://example.com'))).toBe(TIMEOUT_TEST_CONNECTION_MS);
    }
  });

  it('两层共用一处口径：`probeTimeoutOf` 只做转发，不再自带类型分支', () => {
    for (const type of ALL_TYPES) {
      const source = makeSource(type, 'https://example.com');
      expect(probeTimeoutOf(source)).toBe(probeWindowMsFor(source));
    }
  });

  it('爬虫源仍按冷/热分级（35s / 15s），不被类型分级压平', () => {
    const adapter = new SpiderAdapter();
    const source = makeSource('spider', 'https://example.com');
    expect(adapterGateWindow(adapter, source)).toBe(TIMEOUT_PROBE_SPIDER_MS);

    (adapter as unknown as { handles: Map<string, unknown> }).handles.set(source.id, {});
    expect(adapterGateWindow(adapter, source)).toBe(TIMEOUT_PROBE_SPIDER_WARM_MS);
  });

  it('闸门层同步分级：alist 在 3s 时仍未判死，8s 才判 timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubHangingProbe(AlistAdapter.prototype, 'probe');
    const adapter = new AlistAdapter();
    let settled: ConnectionResult | null = null;

    const pending = adapter.testConnection(makeSource('alist', 'https://nas.example.com')).then((r) => {
      settled = r;
      return r;
    });

    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBeNull(); // 旧口径（3s）此刻已判「连接超时」

    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.health).toBe('timeout');
    expect(result.error?.code).toBe('E_TIMEOUT');
    expect(result.error?.detail).toContain('8000');
  });

  it('site 仍按 3s 判死（AC-15 口径不放宽）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stubHangingProbe(SiteAdapter.prototype, 'probe');
    const adapter = new SiteAdapter();
    let settled: ConnectionResult | null = null;

    const pending = adapter.testConnection(makeSource('site', 'https://slow.example.com')).then((r) => {
      settled = r;
      return r;
    });

    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).error?.code).toBe('E_TIMEOUT');
  });
});
