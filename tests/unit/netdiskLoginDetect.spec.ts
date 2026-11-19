/**
 * 网盘登录错误识别回归（FIX-2）
 *
 * 旧口径把任意含 `cookie` / `账号` 的 msg 判为未登录，导致夸克分享类错误
 * （41031「分享者账号已被封禁」、失效分享提示）被误映射成 E_NETDISK_LOGIN_REQUIRED，
 * 把已登录用户反复弹去登录页。本用例锁死新口径：明确登录文案仍命中，分享文案不再误判。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadDetector(): Promise<(msg: string) => 'E_NETDISK_LOGIN_REQUIRED' | undefined> {
  vi.resetModules();
  vi.doMock('@/shared/platform', () => ({ isNative: () => false }));
  vi.doMock('@/services/netdiskConfig', () => ({
    getNetdiskConfig: () => ({ quality: 'auto', threadCount: 4 }),
    formatConfigForSpider: () => '{}',
    hasEnabledNetdiskSource: vi.fn().mockResolvedValue(false),
  }));
  vi.doMock('@/native/spiderPlugin', () => ({
    Spider: { load: vi.fn(), invoke: vi.fn(), proxy: vi.fn(), unload: vi.fn(), isSupported: vi.fn() },
    isSpiderAvailable: vi.fn().mockResolvedValue(false),
    spiderInvoke: vi.fn(),
  }));
  const mod = await import('@/sources/spider/SpiderAdapter');
  return mod.detectNetdiskError;
}

describe('detectNetdiskError（FIX-2）', () => {
  let detect: Awaited<ReturnType<typeof loadDetector>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    detect = await loadDetector();
  });

  it('jar 真实未登录文案命中', () => {
    expect(detect('还未登录夸克账号,请前往【配置中心】登录')).toBe('E_NETDISK_LOGIN_REQUIRED');
    expect(detect('请先登录网盘账号')).toBe('E_NETDISK_LOGIN_REQUIRED');
    expect(detect('cookie 已失效，请重新获取')).toBe('E_NETDISK_LOGIN_REQUIRED');
  });

  it('分享类错误不再误判为登录问题', () => {
    // 41031 文案含「账号」但不是登录问题
    expect(detect('分享者账号已被封禁')).toBeUndefined();
    expect(detect('分享地址已失效')).toBeUndefined();
    expect(detect('该链接已失效或不存在')).toBeUndefined();
    expect(detect('获取播放地址失败：cookie 为空')).toBe('E_NETDISK_LOGIN_REQUIRED');
  });

  it('空串与正常失败不误判', () => {
    expect(detect('')).toBeUndefined();
    expect(detect('解析超时')).toBeUndefined();
  });
});
