/**
 * 亮度（0~100，用户语义）与画面遮罩不透明度（0~DIM_MAX_OPACITY）的唯一换算入口。
 *
 * 任何读写 `playerStore.dim` 的地方都必须经过这里：
 * 该字段是遮罩不透明度、不是亮度，历史上两套单位混用曾导致亮度「滑到最低后永远 0%」。
 */
import { DIM_MAX_OPACITY } from '@/player/constants';

export const BRIGHTNESS_MAX = 100;
/** 用户亮度下限：0 时遮罩为 DIM_MAX_OPACITY（画面保留 20% 亮度，AC-48） */
export const BRIGHTNESS_MIN = 0;

export function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) return BRIGHTNESS_MAX;
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, value));
}

/** 亮度 0~100 → 遮罩不透明度 0~DIM_MAX_OPACITY */
export function brightnessToDimOpacity(brightness: number): number {
  return ((BRIGHTNESS_MAX - clampBrightness(brightness)) / BRIGHTNESS_MAX) * DIM_MAX_OPACITY;
}

/** 遮罩不透明度 → 亮度 0~100（越界/NaN 均回落安全值） */
export function dimOpacityToBrightness(dimOpacity: number): number {
  if (!Number.isFinite(dimOpacity)) return BRIGHTNESS_MAX;
  const ratio = Math.min(1, Math.max(0, dimOpacity / DIM_MAX_OPACITY));
  return clampBrightness((1 - ratio) * BRIGHTNESS_MAX);
}
