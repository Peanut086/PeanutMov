import { describe, expect, it, vi } from 'vitest';

import { deviceService } from '@/services/deviceService';
import {
  clearWindowBrightness,
  readRawSystemLevels,
  readRawSystemVolume,
  writeSystemVolume,
  writeWindowBrightness,
} from '@/native/playerUi';

// 只 mock 平台判定，playerUi 用真实实现：Web 分支必须在触达 Capacitor 插件前短路
vi.mock('@/shared/platform', () => ({ isNative: () => false }));

describe('Web 下的系统亮度/音量降级（API-12）', () => {
  it('playerUi 五项全部返回不可用哨兵，不抛异常', async () => {
    await expect(readRawSystemLevels()).resolves.toBeNull();
    await expect(readRawSystemVolume()).resolves.toBeNull();
    await expect(writeWindowBrightness(0.5)).resolves.toBe(false);
    await expect(writeSystemVolume(50)).resolves.toBeNull();
    await expect(clearWindowBrightness()).resolves.toBeUndefined();
  });

  it('deviceService 据此让播放页退回遮罩 + 播放器倍率', async () => {
    expect(await deviceService.readSystemLevels()).toBeNull();
    expect(await deviceService.setBrightness(50)).toBe(false);
    expect(await deviceService.setVolume(50)).toBeNull();
    expect(await deviceService.readVolume()).toBeNull();
    await expect(deviceService.releaseBrightness()).resolves.toBeUndefined();
  });
});
