import { describe, expect, it } from 'vitest';

import { DIM_MAX_OPACITY } from '@/player/constants';
import { brightnessToDimOpacity, clampBrightness, dimOpacityToBrightness } from '@/player/brightness';

describe('亮度 ↔ 遮罩不透明度换算', () => {
  it('端点映射：100 → 0，0 → DIM_MAX_OPACITY', () => {
    expect(brightnessToDimOpacity(100)).toBe(0);
    expect(brightnessToDimOpacity(0)).toBe(DIM_MAX_OPACITY);
    expect(dimOpacityToBrightness(0)).toBe(100);
    expect(dimOpacityToBrightness(DIM_MAX_OPACITY)).toBe(0);
  });

  it('往返换算保持原值（0~100）', () => {
    for (let v = 0; v <= 100; v += 1) {
      expect(dimOpacityToBrightness(brightnessToDimOpacity(v))).toBeCloseTo(v, 6);
    }
  });

  it('越界/NaN 输入回落安全值', () => {
    expect(clampBrightness(Number.NaN)).toBe(100);
    expect(clampBrightness(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampBrightness(-50)).toBe(0);
    expect(clampBrightness(200)).toBe(100);

    expect(brightnessToDimOpacity(-50)).toBe(DIM_MAX_OPACITY);
    expect(brightnessToDimOpacity(Number.NaN)).toBe(0);
    expect(dimOpacityToBrightness(Number.NaN)).toBe(100);
    expect(dimOpacityToBrightness(DIM_MAX_OPACITY * 100)).toBe(0);
    expect(dimOpacityToBrightness(-1)).toBe(100);
  });

  it('回归：最低亮度可回升（旧逻辑把 dim 写成 0~80，导致永久 0%）', () => {
    // 滑到最低：store 里应是遮罩不透明度 0.8，而不是 80
    const dim = brightnessToDimOpacity(0);
    expect(dim).toBe(DIM_MAX_OPACITY);

    // 下一次手势的基准值能从遮罩反算出 0，从而允许上滑回升
    expect(dimOpacityToBrightness(dim)).toBe(0);
    expect(dimOpacityToBrightness(brightnessToDimOpacity(50))).toBe(50);
  });
});
