import { describe, expect, it } from 'vitest';

import { BaseAdapter, type ProbeResult } from '@/sources/base/BaseAdapter';
import type { PlaybackSource, ResolvePlayParams } from '@/types';

/**
 * BaseAdapter 探活超时窗口（REV 补充：晚成功按超时处理）
 *
 * 不响应 AbortSignal 的 probe（如 spider 的原生调用）可能在超时后才 resolve，
 * testConnection 必须把它判成 E_TIMEOUT 而不是 ok:true；
 * `probeWindowMs` 允许子类（或 P1-7 的类型分级）放宽窗口（spider 的 jar 下载最长 30s）。
 */

class SlowAdapter extends BaseAdapter {
  readonly type = 'site' as const;
  protected override probeWindowMs(): number {
    return 50;
  }
  protected async probe(): Promise<ProbeResult> {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { itemCount: 1 };
  }
  // 抽象方法的最小实现（本测试不触达）
  listCategories = async () => [];
  browse = async () => ({ items: [], page: 1, pageSize: 20, total: 0, hasMore: false });
  search = async () => [];
  getDetail = async () => {
    throw new Error('not used');
  };
  resolvePlayUrl = async (_params: ResolvePlayParams): Promise<PlaybackSource> => {
    throw new Error('not used');
  };
}

class FastAdapter extends SlowAdapter {
  protected override probeWindowMs(): number {
    return 3_000;
  }
  protected override async probe(): Promise<ProbeResult> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { itemCount: 7 };
  }
}

const SOURCE = {
  id: 'src-a',
  key: 'k',
  name: '测试源',
  type: 'site',
  enabled: true,
  builtin: false,
  sort: 1,
  baseUrl: 'https://example.com',
  pathPrefix: null,
  auth: { mode: 'none', username: null, password: null, token: null },
  headers: {},
  ext: null,
  subscriptionId: null,
  warning: null,
  health: 'unknown',
  healthCheckedAt: null,
  lastErrorCode: null,
  createdAt: 1,
  updatedAt: 1,
} as never;

describe('BaseAdapter testConnection 超时', () => {
  it('probe 晚于窗口成功 → E_TIMEOUT（不返回 ok:true）', async () => {
    const adapter = new SlowAdapter();
    const result = await adapter.testConnection(SOURCE);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('E_TIMEOUT');
    expect(result.health).toBe('timeout');
  });

  it('子类放宽窗口后正常成功', async () => {
    const adapter = new FastAdapter();
    const result = await adapter.testConnection(SOURCE);
    expect(result.ok).toBe(true);
    expect(result.itemCount).toBe(7);
  });
});
