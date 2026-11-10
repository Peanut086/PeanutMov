import { describe, expect, it } from 'vitest';

import { DIM_MAX_OPACITY } from '@/player/constants';
import {
  WINDOW_BRIGHTNESS_MIN_RATIO,
  brightnessToDimOpacity,
  brightnessToWindowRatio,
  clampBrightness,
  windowRatioToBrightness,
} from '@/player/brightness';

describe('亮度 → 遮罩不透明度换算（Web / 原生能力缺失的回退路径）', () => {
  it('端点映射：100 → 0，0 → DIM_MAX_OPACITY', () => {
    expect(brightnessToDimOpacity(100)).toBe(0);
    expect(brightnessToDimOpacity(0)).toBe(DIM_MAX_OPACITY);
  });

  it('越界/NaN 输入回落安全值', () => {
    expect(clampBrightness(Number.NaN)).toBe(100);
    expect(clampBrightness(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampBrightness(-50)).toBe(0);
    expect(clampBrightness(200)).toBe(100);

    expect(brightnessToDimOpacity(-50)).toBe(DIM_MAX_OPACITY);
    expect(brightnessToDimOpacity(Number.NaN)).toBe(0);
  });

  it('回归：store 存的是亮度而不是遮罩不透明度，滑到最低后仍能回升', () => {
    // 旧实现把 0~0.8 的不透明度当亮度存（写过 80），反算时永远得到 0
    expect(clampBrightness(0)).toBe(0);
    expect(brightnessToDimOpacity(clampBrightness(0))).toBe(DIM_MAX_OPACITY);
    expect(clampBrightness(50)).toBe(50);
  });
});

describe('亮度 ↔ 窗口背光换算（原生路径）', () => {
  it('端点：100 → 最亮，0 → 背光下限（Android 的 0 是纯黑，不能用）', () => {
    expect(brightnessToWindowRatio(100)).toBe(1);
    expect(brightnessToWindowRatio(0)).toBe(WINDOW_BRIGHTNESS_MIN_RATIO);
  });

  it('往返换算保持原值（0~100）：读回来再写出去不会跳变', () => {
    for (let v = 0; v <= 100; v += 1) {
      expect(windowRatioToBrightness(brightnessToWindowRatio(v))).toBeCloseTo(v, 6);
    }
  });

  it('系统背光落到 0~100 用户值', () => {
    expect(windowRatioToBrightness(1)).toBe(100);
    expect(windowRatioToBrightness(0)).toBe(0);
    expect(windowRatioToBrightness(0.5)).toBeCloseTo(47.4, 1);
    // -1 = 原生「读不到」哨兵；真正禁用系统模式由 deviceService 判 null，这里只兜底
    expect(windowRatioToBrightness(-1)).toBe(100);
    expect(windowRatioToBrightness(Number.NaN)).toBe(100);
  });

  it('越界亮度按钳制结果换算背光', () => {
    expect(brightnessToWindowRatio(-50)).toBe(WINDOW_BRIGHTNESS_MIN_RATIO);
    expect(brightnessToWindowRatio(200)).toBe(1);
    expect(brightnessToWindowRatio(Number.NaN)).toBe(1);
  });
});
