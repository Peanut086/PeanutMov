import { describe, expect, it } from 'vitest';

import { isPlaybackStalled } from '@/player/PlayerController';
import { NET_STALL_STUCK_MS, STALL_MIN_ADVANCE_SEC, STALL_STUCK_MS } from '@/player/constants';

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

  /**
   * OPT-26（P2-⑫）：同一份判定两档预算。
   *
   * 在线流的停滞窗口比本地宽两倍多——弱网缓冲得有容忍；但对本地那一档，
   * 同样的时长早就该走复位重备了。差别就是这一条断言。
   */
  it('两档窗口各算各的：同一时刻本地档已经判停滞，在线档还没到点', () => {
    // 24.9 秒不动，在在线档里仍只是"网慢"——真要按在线档裁，得显式传 NET_STALL_STUCK_MS
    const elapsed = NET_STALL_STUCK_MS - 100;
    expect(isPlaybackStalled(0, 0, elapsed, STALL_STUCK_MS)).toBe(true);
    expect(isPlaybackStalled(0, 0, elapsed, NET_STALL_STUCK_MS)).toBe(false);
  });

  it('在线档到点判停滞：签名地址过期不留错误，只能靠这个窗口发现', () => {
    expect(isPlaybackStalled(120, 120.2, NET_STALL_STUCK_MS)).toBe(true);
  });
});
