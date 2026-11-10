/**
 * 亮度（0~100，用户语义）的换算入口：遮罩不透明度（Web 回退）与窗口背光比（原生）。
 *
 * store 里只存 0~100 这一个真相，落点由换算决定。历史上曾把遮罩不透明度当亮度存
 * （`playerStore.dim`），两套单位混用导致亮度「滑到最低后永远 0%」。
 */
import { DIM_MAX_OPACITY } from '@/player/constants';

export const BRIGHTNESS_MAX = 100;
/** 用户亮度下限：遮罩路径下为 DIM_MAX_OPACITY（画面保留 20% 亮度，AC-48） */
export const BRIGHTNESS_MIN = 0;

/**
 * 窗口背光下限。Android 的 `screenBrightness = 0` 语义是纯黑（画面全看不见），
 * 所以 0% 只压到 5% 背光——与遮罩路径同样不允许把画面滑成黑屏。
 */
export const WINDOW_BRIGHTNESS_MIN_RATIO = 0.05;

export function clampBrightness(value: number): number {
  if (!Number.isFinite(value)) return BRIGHTNESS_MAX;
  return Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, value));
}

/** 亮度 0~100 → 遮罩不透明度 0~DIM_MAX_OPACITY（仅 Web / 原生能力缺失时使用） */
export function brightnessToDimOpacity(brightness: number): number {
  return ((BRIGHTNESS_MAX - clampBrightness(brightness)) / BRIGHTNESS_MAX) * DIM_MAX_OPACITY;
}

/** 亮度 0~100 → 窗口背光 0~1（与 `windowRatioToBrightness` 互逆，读回再写不跳变） */
export function brightnessToWindowRatio(brightness: number): number {
  const span = 1 - WINDOW_BRIGHTNESS_MIN_RATIO;
  const ratio = WINDOW_BRIGHTNESS_MIN_RATIO + (clampBrightness(brightness) / BRIGHTNESS_MAX) * span;
  return Math.min(1, ratio);
}

/** 窗口背光 0~1 → 亮度 0~100（越界/NaN 回落安全值） */
export function windowRatioToBrightness(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio < 0) return BRIGHTNESS_MAX;
  const span = 1 - WINDOW_BRIGHTNESS_MIN_RATIO;
  const scaled = ((Math.min(1, ratio) - WINDOW_BRIGHTNESS_MIN_RATIO) / span) * BRIGHTNESS_MAX;
  return clampBrightness(scaled);
}
