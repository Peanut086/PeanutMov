/**
 * 播放器常量（UI 包内部）
 *
 * 只放播放器局部数值；跨模块常量见 `shared/constants.ts`。
 */
import { DIM_MAX_PERCENT } from '@/shared/constants';
import type { PlaybackRate } from '@/types';

export const PLAYER_ENGINE_KIND = {
  VIDEO: 'video',
  HLS: 'hls',
} as const;

/** 加载元数据超时（WebView video 引擎；慢源给足余量，本地引用便于阅读） */
export const LOAD_METADATA_TIMEOUT_MS = 20000;

/** 原生引擎元数据超时：ExoPlayer 对坏地址失败很快，10s 足够，避免回退前白等 */
export const NATIVE_METADATA_TIMEOUT_MS = 10000;

/** HLS 引擎元数据超时：hls.js 自身重试可能挂死，外层兜底 */
export const HLS_METADATA_TIMEOUT_MS = 25000;

/**
 * HLS 清单预检超时（AC-40）
 *
 * 仅用于 m3u8 的 DRM 探测（`#EXT-X-KEY:METHOD=SAMPLE-AES`）：
 * 超时/网络失败一律放行给 hls.js 正常加载，避免把网络抖动误判为"受保护内容"。
 */
export const MANIFEST_PREFLIGHT_TIMEOUT_MS = 4000;

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

/** 跳过片头/片尾胶囊的倒计时（秒） */
export const SKIP_INTRO_COUNTDOWN_SEC = 3;

/** B-04：点中弹幕后它最多停这么久就自动放行，不能让一条弹幕长期挂在画面上 */
export const DANMAKU_PICK_MAX_MS = 4000;

/** 字幕字号 → CSS 类 */
export const SUBTITLE_SIZE_CLASS = {
  small: 'subtitle-overlay--small',
  medium: '',
  large: 'subtitle-overlay--large',
} as const;

/** 亮度遮罩最大不透明度（AC-48：底层保留 20%；与 DIM_MAX_PERCENT 同一真相） */
export const DIM_MAX_OPACITY = DIM_MAX_PERCENT / 100;

/** 起播位置有效区间（技术方案 9.4） */
export const RESUME_MIN_RATIO = 0.05;
export const RESUME_MAX_RATIO = 0.95;

/**
 * 黑屏检测延迟（秒级）：起播后观察这么久仍一帧未解 → 判定「只有声音没有画面」。
 *
 * 实测 Android WebView 播放 HEVC 的 HLS 时：`videoWidth=1920`、`currentTime` 正常推进、
 * `error=null`，但 `getVideoPlaybackQuality().totalVideoFrames === 0`——用户看到的是
 * 黑屏 + 声音，App 却以为在正常播放。5s 足够区分「慢起播」与「解不出帧」。
 */
export const NO_VIDEO_CHECK_DELAY_MS = 5000;

/** 清晰度自动档标签 */
export const QUALITY_AUTO = 'auto';

/**
 * seek 落位判定（P1-a）。
 *
 * 原生引擎在 `.ts` 上定位要秒级（无样本索引 → 按 PCR 二分 + 回退关键帧 + 重启硬解），
 * 此时引擎上报的时间仍是旧位置。历史写库因此要等引擎报回接近目标的时间再触发，
 * 超时兜底保证"定位失败也不会丢掉进度"。
 */
export const SEEK_SETTLE_TIMEOUT_MS = 8000;
/**
 * 落位容差取 3s：大于原生 1s 轮询粒度 + seek 落关键帧的误差，
 * 又小于双击 ±10s 的步长——容差再大就会在引擎仍停在起点时误判落位，
 * 把旧位置写回历史（进度倒退）并让"正在定位"提示一闪而过。
 */
export const SEEK_SETTLE_TOLERANCE_SEC = 3;

/**
 * P0-2：本地播放停滞自愈窗口。
 *
 * 转封装产物时间轴被写坏时，ExoPlayer 会 READY + 出首帧、但位置永远不动
 * （真机实证：解码器只剩预滚帧，`in=0`）。8s 无任何推进即认定停滞，
 * 复位重备一次；再停滞就报错收口，不再让用户对着转圈干等。
 */
export const STALL_CHECK_INTERVAL_MS = 1000;
export const STALL_STUCK_MS = 8000;
/** 推进下限：小于引擎轮询粒度（1s）与 seek 落关键帧误差的合理解释范围 */
export const STALL_MIN_ADVANCE_SEC = 0.5;
/**
 * OPT-26（P2-⑫）：网络流停滞判定窗口，比本地那一档宽两倍多。
 *
 * 本地文件的停滞只有"时间轴坏了"一种解释，8 秒足够；网络流还要容纳弱网缓冲——
 * 判得太急，1Mbps 的正常观看会被当成断流去重新取址。25 秒的口径是：
 * 位置和缓冲**同时**不动 25 秒，已经不是"网慢"（喂不饱时缓冲仍在涨），
 * 而是这条地址不再供数据了——签名过期、源侧断流都是这个形态。
 */
export const NET_STALL_STUCK_MS = 25_000;
/** FIX-PLAY-C2：本地播放解码错误时，容错重播向前跳开的秒数（坏件通常局部，跳过可续看） */
export const LOCAL_DECODE_SKIP_SEC = 10;
