import { describe, expect, it } from 'vitest';

import { LUMA_CELLS } from '@/player/danmakuContrast';
import { isBlackFrame } from '@/player/blackFrame';

function field(...brightCells: Array<[number, number]>): Uint8Array {
  const cells = new Uint8Array(LUMA_CELLS);
  for (const [index, value] of brightCells) cells[index] = value;
  return cells;
}

describe('黑帧判定', () => {
  it('整场近黑且没有任何可见细节 → 判黑帧', () => {
    expect(isBlackFrame({ cells: field(), at: 0 })).toEqual({
      black: true,
      maxLuma: 0,
      meanLuma: 0,
    });
    expect(isBlackFrame({ cells: field([0, 2], [575, 2]), at: 0 })?.black).toBe(true);
  });

  it('暗场里存在可见细节 → 不判黑帧', () => {
    expect(isBlackFrame({ cells: field([288, 3]), at: 0 })).toEqual({
      black: false,
      maxLuma: 3,
      meanLuma: expect.any(Number),
    });
  });

  it('取样缺失或格子数不合法 → 无法判定', () => {
    expect(isBlackFrame(null)).toBeNull();
    expect(isBlackFrame({ cells: new Uint8Array(3), at: 0 })).toBeNull();
  });
});
