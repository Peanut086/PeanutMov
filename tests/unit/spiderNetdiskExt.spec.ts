/**
 * 网盘源 ext 下发回归（第二轮 / 项 3）
 *
 * 缺陷：`appendNetdiskConfig` 对非 JSON 的 ext 用 `ext|||{json}` 追加。
 * 但爬虫侧是 `JSON.parse(ext)` 取源配置（drpy_host.js `__catvodEnsureInit`），
 * 追加之后整次解析抛错并退回 `{}` —— 画质/线程没下发，源自带的 api/token
 * 配置也一起丢掉，等于把本来能用的网盘源改坏。
 *
 * 现口径：只合并 JSON 对象形态的 ext，其余（URL 形态、加密 ext）原样透传。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Source } from '@/types';

const NETDISK_CONFIG = { quality: '1080P', threadCount: 4 };

function makeNetdiskSource(initExt: string): Source {
  return {
    id: 'src-pan',
    key: 'csp_Quark',
    name: '网盘源',
    type: 'spider',
    enabled: true,
    builtin: false,
    sort: 1,
    // `isNetdiskSource` 只看 initExt 与 baseUrl 的关键词，这里靠 baseUrl 恒定命中，
    // 免得每个用例的 ext 形态不同导致根本没走合并分支
    baseUrl: 'https://mirrors.example.com/quark.pan/live.jar',
    pathPrefix: null,
    auth: { mode: 'none', username: null, password: null, token: null },
    headers: {},
    ext: {
      kind: 'jar',
      api: 'csp_Quark',
      jarUrl: 'https://mirrors.example.com/live.jar;md5;aabbcc',
      initExt,
      searchable: true,
    },
    subscriptionId: null,
    warning: null,
    health: 'unknown',
    healthCheckedAt: null,
    lastErrorCode: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

async function loadExtOf(initExt: string): Promise<string | undefined> {
  vi.resetModules();
  vi.doMock('@/shared/platform', () => ({ isNative: () => true }));
  vi.doMock('@/services/netdiskConfig', () => ({
    getNetdiskConfig: () => NETDISK_CONFIG,
    formatConfigForSpider: (c: typeof NETDISK_CONFIG) =>
      JSON.stringify({ quality: c.quality, thread: c.threadCount }),
  }));
  const load = vi.fn().mockResolvedValue({ handle: 'pan-1' });
  vi.doMock('@/native/spiderPlugin', () => ({
    Spider: { load, invoke: vi.fn(), proxy: vi.fn(), unload: vi.fn(), isSupported: vi.fn() },
    isSpiderAvailable: vi.fn().mockResolvedValue(true),
    spiderInvoke: vi.fn(),
  }));

  const { SpiderAdapter: Adapter } = await import('@/sources/spider/SpiderAdapter');
  const adapter = new Adapter();
  // 走 warmup：testConnection 的探活会先 HEAD jar，网络层不在本用例范围内；
  // warmup 直达加载分支，且网盘配置合并正是发生在发起加载的那一刻
  await adapter.warmup(makeNetdiskSource(initExt));
  expect(load).toHaveBeenCalledTimes(1);
  return load.mock.calls[0]?.[0]?.initExt;
}

describe('网盘源 ext 下发', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('JSON 对象 ext：合并画质/线程，且结果仍可被爬虫 JSON.parse', async () => {
    const out = await loadExtOf('{"token":"secret-token","api":"https://pan.example.com"}');

    expect(out).toBeDefined();
    expect(out).not.toContain('|||');
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    // 源自带配置必须保住：丢掉它就是把能用的源改坏
    expect(parsed.token).toBe('secret-token');
    expect(parsed.api).toBe('https://pan.example.com');
    expect(parsed.quality).toBe('1080P');
    expect(parsed.thread).toBe(4);
  });

  it('URL 形态 ext 原样透传，不再拼 |||', async () => {
    const raw = 'https://rule.example.com/netdisk.js';
    expect(await loadExtOf(raw)).toBe(raw);
  });

  it('空 ext 不凭空造出配置串', async () => {
    expect(await loadExtOf('')).toBe('');
  });

  it('加密 ext（超长且非 JSON）原样透传', async () => {
    const raw = `Encrypted(${Buffer.from('a'.repeat(160)).toString('base64')})`;
    expect(await loadExtOf(raw)).toBe(raw);
  });

  it('JSON 数组形态 ext 不合并（合并会破坏下标结构）', async () => {
    const raw = '["https://a.test/1.js","https://b.test/2.js"]';
    expect(await loadExtOf(raw)).toBe(raw);
  });
});
