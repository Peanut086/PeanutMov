import { describe, expect, it } from 'vitest';

import { isNoVideo } from '@/player/PlayerController';

/**
 * 黑屏判定（真机实测：HEVC/部分 HLS 在 Android WebView 上「有声无画」）
 *
 * 判据来自 `video.getVideoPlaybackQuality()`：
 * 爱看源 m3u8 实测 videoWidth=1920、currentTime 推进、totalVideoFrames=0 → 黑屏；
 * 贝乐虎 mp4 实测 8s 后 totalVideoFrames=206 → 正常。
 */
describe('isNoVideo', () => {
  it('元数据在、时间在走、一帧未解 → 判黑屏', () => {
    expect(isNoVideo({ videoWidth: 1920, videoHeight: 800, totalFrames: 0 }, 5)).toBe(true);
  });

  it('有帧输出 → 正常', () => {
    expect(isNoVideo({ videoWidth: 960, videoHeight: 540, totalFrames: 206 }, 8)).toBe(false);
  });

  it('环境不支持统计（-1）或原生引擎（null）→ 不判黑屏', () => {
    expect(isNoVideo({ videoWidth: 1920, videoHeight: 800, totalFrames: -1 }, 10)).toBe(false);
    expect(isNoVideo(null, 10)).toBe(false);
  });

  it('元数据未就绪（videoWidth=0）→ 再等等，别误报', () => {
    expect(isNoVideo({ videoWidth: 0, videoHeight: 0, totalFrames: 0 }, 6)).toBe(false);
  });

  it('起播不足 1s → 不判（避免慢起播误报）', () => {
    expect(isNoVideo({ videoWidth: 1920, videoHeight: 800, totalFrames: 0 }, 0.4)).toBe(false);
  });
});
