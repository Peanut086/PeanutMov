/**
 * 画面比例档位的单一口径（P1 配置 + G-A09 捏合尺共用）。
 *
 * 标签与说明只在这里写一次：设置弹层、播放页画面弹层、捏合 HUD 必须说同一套话，
 * 否则同一件事在三个地方有三个名字。
 */
import type { ResizeMode } from '@/types';

export interface DisplayModeOption {
  value: ResizeMode;
  label: string;
  hint: string;
}

export const DISPLAY_MODE_OPTIONS: DisplayModeOption[] = [
  { value: 'contain', label: '适应', hint: '完整显示，留黑边' },
  { value: 'cover', label: '铺满', hint: '裁剪边缘，不变形' },
  { value: 'fill', label: '拉伸', hint: '填满屏幕，会变形' },
];

export function displayModeLabel(mode: ResizeMode): string {
  return DISPLAY_MODE_OPTIONS.find((item) => item.value === mode)?.label ?? mode;
}
