import { LUMA_CELLS, type LumaField } from '@/player/danmakuContrast';

const BLACK_FRAME_MAX_LUMA = 2;

export interface BlackFrameSample {
  black: boolean;
  maxLuma: number;
  meanLuma: number;
}

export function isBlackFrame(field: LumaField | null): BlackFrameSample | null {
  if (!field || field.cells.length !== LUMA_CELLS) return null;
  let maxLuma = 0;
  let sum = 0;
  for (const value of field.cells) {
    maxLuma = Math.max(maxLuma, value);
    sum += value;
  }
  return {
    black: maxLuma <= BLACK_FRAME_MAX_LUMA,
    maxLuma,
    meanLuma: sum / field.cells.length,
  };
}
