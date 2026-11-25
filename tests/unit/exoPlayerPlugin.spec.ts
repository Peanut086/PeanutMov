import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ isSupported: vi.fn() }));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ isSupported: h.isSupported }),
}));

import { getExoPlayerStatus, isExoPlayerAvailable } from '@/native/exoPlayerPlugin';

describe('ExoPlayer 能力状态', () => {
  beforeEach(() => {
    h.isSupported.mockReset();
  });

  it('支持且不在安全模式：可用', async () => {
    h.isSupported.mockResolvedValue({ supported: true, safeMode: false });
    await expect(getExoPlayerStatus()).resolves.toEqual({
      available: true,
      supported: true,
      safeMode: false,
      reason: null,
    });
    await expect(isExoPlayerAvailable()).resolves.toBe(true);
  });

  it('安全模式：保留支持能力但不可用', async () => {
    h.isSupported.mockResolvedValue({ supported: true, safeMode: true });
    await expect(getExoPlayerStatus()).resolves.toEqual({
      available: false,
      supported: true,
      safeMode: true,
      reason: 'safe_mode',
    });
    await expect(isExoPlayerAvailable()).resolves.toBe(false);
  });

  it('环境不支持：与安全模式分开', async () => {
    h.isSupported.mockResolvedValue({ supported: false });
    await expect(getExoPlayerStatus()).resolves.toEqual({
      available: false,
      supported: false,
      safeMode: false,
      reason: 'unsupported',
    });
  });

  it('旧插件没有 safeMode 字段：按非安全模式兼容', async () => {
    h.isSupported.mockResolvedValue({ supported: true });
    await expect(getExoPlayerStatus()).resolves.toMatchObject({ available: true, safeMode: false });
  });

  it('插件方法缺失或调用失败：归为插件不可用', async () => {
    h.isSupported.mockRejectedValue(new Error('not implemented'));
    await expect(getExoPlayerStatus()).resolves.toEqual({
      available: false,
      supported: false,
      safeMode: false,
      reason: 'plugin_missing',
    });
  });
});
