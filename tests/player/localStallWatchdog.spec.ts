import { describe, expect, it } from 'vitest';

import { isPlaybackStalled } from '@/player/PlayerController';
import { STALL_MIN_ADVANCE_SEC, STALL_STUCK_MS } from '@/player/constants';

/**
 * P0-2 本地播放停滞判定（真机实测依据）
 *
 * 转封装时间轴被写坏的 MP4：ExoPlayer 到 READY、渲染首帧，之后位置永远不动
 * （解码器只剩预滚帧，`in=0`），引擎自身不报错——只能靠"位置是否推进"判定。
 */
describe('isPlaybackStalled', () => {
  it('位置按步长推进 → 不判停滞', () => {
    expect(isPlaybackStalled(10, 10 + STALL_MIN_ADVANCE_SEC, STALL_STUCK_MS + 1000)).toBe(false);
  });

  it('位置不动但仍在起播窗口内 → 先别报（慢起播不是坏文件）', () => {
    expect(isPlaybackStalled(0, 0, STALL_STUCK_MS - 100)).toBe(false);
  });

  it('位置不动且已超窗口 → 判停滞', () => {
    expect(isPlaybackStalled(0, 0, STALL_STUCK_MS)).toBe(true);
  });

  it('推进量小于步长（坏件表现为几乎不动）→ 到点仍判停滞', () => {
    expect(isPlaybackStalled(100, 100 + 0.3, STALL_STUCK_MS)).toBe(true);
  });

  it('位置倒退（seek 落关键帧）→ 到点判停滞，交给复位重试收口', () => {
    expect(isPlaybackStalled(30, 28, STALL_STUCK_MS)).toBe(true);
  });
});
