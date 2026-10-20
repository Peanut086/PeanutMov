/**
 * 播放器常量（UI 包内部）
 *
 * 只放播放器局部数值；跨模块常量见 `shared/constants.ts`。
 */
import type { PlaybackRate } from '@/types';

export const PLAYER_ENGINE_KIND = {
  VIDEO: 'video',
  HLS: 'hls',
} as const;

/** 加载元数据超时（与 shared 的 TIMEOUT_LOAD_METADATA_MS 一致，本地引用便于阅读） */
export const LOAD_METADATA_TIMEOUT_MS = 15000;

/** 网络错误自动重试次数（技术方案 9.7：1 次） */
export const NETWORK_RETRY_TIMES = 1;
export const NETWORK_RETRY_DELAY_MS = 1000;

/** 控制条自动隐藏 */
export const CONTROLS_HIDE_DELAY_MS = 3000;

/** 双击判定间隔（与 shared 常量一致） */
export const DOUBLE_TAP_INTERVAL_MS = 300;

/** 长按倍速默认值 */
export const LONG_PRESS_RATE = 2;

/** 快进快退步长（秒） */
export const SEEK_STEP_SEC = 10;

/** 音量/亮度步长（键盘） */
export const VOLUME_STEP = 5;

/** 播放器速率档位 */
export const RATE_OPTIONS: readonly PlaybackRate[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 自动连播倒计时（秒） */
export const AUTO_NEXT_COUNTDOWN_SEC = 3;

/** 字幕字号 → CSS 类 */
export const SUBTITLE_SIZE_CLASS = {
  small: 'subtitle-overlay--small',
  medium: '',
  large: 'subtitle-overlay--large',
} as const;

/** 亮度遮罩最大不透明度（AC-48：底层保留 20%） */
export const DIM_MAX_OPACITY = 0.8;

/** 起播位置有效区间（技术方案 9.4） */
export const RESUME_MIN_RATIO = 0.05;
export const RESUME_MAX_RATIO = 0.95;

/** 清晰度自动档标签 */
export const QUALITY_AUTO = 'auto';
