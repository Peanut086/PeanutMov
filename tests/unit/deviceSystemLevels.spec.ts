import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceService } from '@/services/deviceService';
import { WINDOW_BRIGHTNESS_MIN_RATIO } from '@/player/brightness';

const native = vi.hoisted(() => ({ isNative: false }));
const ui = vi.hoisted(() => ({
  readRawSystemLevels: vi.fn(),
  readRawSystemVolume: vi.fn(),
  writeWindowBrightness: vi.fn(),
  clearWindowBrightness: vi.fn(),
  writeSystemVolume: vi.fn(),
}));

vi.mock('@/shared/platform', () => ({ isNative: () => native.isNative }));
vi.mock('@/native/playerUi', () => ui);

describe('设备服务系统亮度/音量（API-12）', () => {
  beforeEach(() => {
    native.isNative = false;
    ui.readRawSystemLevels.mockReset();
    ui.readRawSystemVolume.mockReset();
    ui.writeWindowBrightness.mockReset();
    ui.clearWindowBrightness.mockReset();
    ui.writeSystemVolume.mockReset();
  });

  it('原生返回 null（插件缺失/异常）时不可用', async () => {
    native.isNative = true;
    ui.readRawSystemLevels.mockResolvedValue(null);
    expect(await deviceService.readSystemLevels()).toBeNull();
  });

  describe('读取语义', () => {
    it('背光 + 音量换算为用户 0~100', async () => {
      native.isNative = true;
      ui.readRawSystemLevels.mockResolvedValue({ brightnessRatio: 1, volumePercent: 60 });
      expect(await deviceService.readSystemLevels()).toEqual({ brightness: 100, volume: 60 });
    });

    it('任一项读不到就整体返回 null，不给"半套真值"', async () => {
      native.isNative = true;
      ui.readRawSystemLevels.mockResolvedValue({ brightnessRatio: -1, volumePercent: 60 });
      expect(await deviceService.readSystemLevels()).toBeNull();
      ui.readRawSystemLevels.mockResolvedValue({ brightnessRatio: 0.5, volumePercent: -1 });
      expect(await deviceService.readSystemLevels()).toBeNull();
    });
  });

  describe('写入语义', () => {
    it('亮度经遮罩下限映射后写入窗口背光', async () => {
      native.isNative = true;
      ui.writeWindowBrightness.mockResolvedValue(true);
      await deviceService.setBrightness(100);
      expect(ui.writeWindowBrightness).toHaveBeenCalledWith(1);
      await deviceService.setBrightness(0);
      expect(ui.writeWindowBrightness).toHaveBeenCalledWith(WINDOW_BRIGHTNESS_MIN_RATIO);
    });

    it('非法亮度不落到原生', async () => {
      native.isNative = true;
      expect(await deviceService.setBrightness(Number.NaN)).toBe(false);
      expect(ui.writeWindowBrightness).not.toHaveBeenCalled();
    });

    it('非法音量不落到原生（防止把全局音量写坏）', async () => {
      native.isNative = true;
      expect(await deviceService.setVolume(Number.NaN)).toBeNull();
      expect(ui.writeSystemVolume).not.toHaveBeenCalled();
    });

    it('音量以原生回读值为准（离散档位量化）', async () => {
      native.isNative = true;
      ui.writeSystemVolume.mockResolvedValue(64);
      expect(await deviceService.setVolume(62)).toBe(64);
      expect(ui.writeSystemVolume).toHaveBeenCalledWith(62);
    });
  });
});
