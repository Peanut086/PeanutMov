/**
 * 边缘右滑返回的判定阈值（B-07 · 验收数字都在这里）
 *
 * 验收写的是「左边缘 24px 内起步、超过 40% 屏宽或速度 > 800px/s 即返回，否则回弹」，
 * 每一条都是边界，用假时间戳逐条压：慢拖够距离要成、快甩不够距离也要成、
 * 拖到一半停住再松手不能成、竖着划不能抢列表滚动。
 */
import { describe, expect, it } from 'vitest';

import { EDGE_SWIPE_DEFAULT, EdgeSwipeRecognizer } from '@/shared/EdgeSwipeRecognizer';

/** 屏宽取整数：40% 正好是 160，边界值一眼能看出来 */
const W = 400;
const EDGE_X = 6;

function atEdge(): EdgeSwipeRecognizer {
  const rec = new EdgeSwipeRecognizer();
  expect(rec.begin(EDGE_X, 400, 0, W)).toBe('pending');
  return rec;
}

describe('EdgeSwipeRecognizer', () => {
  it('默认阈值就是验收数字', () => {
    expect(EDGE_SWIPE_DEFAULT).toMatchObject({
      bandPx: 24,
      deadZonePx: 8,
      commitRatio: 0.4,
      commitVelocityPx: 800,
    });
  });

  it('只有起点落在左侧 24px 带内才认边缘手势', () => {
    expect(new EdgeSwipeRecognizer().begin(24, 400, 0, W)).toBe('pending');
    expect(new EdgeSwipeRecognizer().begin(25, 400, 0, W)).toBe('none');
    // 带外起点之后怎么拖都不接管（正常列表横滑不受影响）
    const rec = new EdgeSwipeRecognizer();
    rec.begin(200, 400, 0, W);
    expect(rec.move(400, 402, 50)).toBe('none');
    expect(rec.end(50).dragging).toBe(false);
  });

  it('死区内方向未定，超过 8px 才进入跟手', () => {
    const rec = atEdge();
    expect(rec.move(EDGE_X + 8, 400, 16)).toBe('pending');
    expect(rec.offset).toBe(0);
    expect(rec.move(EDGE_X + 9, 400, 32)).toBe('drag');
    expect(rec.offset).toBe(9);
  });

  it('纵向占优就整段放弃，之后不再接管', () => {
    const rec = atEdge();
    expect(rec.move(EDGE_X + 4, 400 - 30, 16)).toBe('abandon');
    expect(rec.move(EDGE_X + 200, 400 - 60, 32)).toBe('none');
    expect(rec.end(32)).toMatchObject({ dragging: false, commit: false });
  });

  it('向左拖不是返回手势，同样整段作废', () => {
    const rec = atEdge();
    expect(rec.move(EDGE_X - 9, 400, 16)).toBe('abandon');
    expect(rec.end(20)).toMatchObject({ dragging: false, commit: false });
  });

  it('跟手位移钳在 [0, 屏宽]：往回拖不越过原位，超屏宽不放大', () => {
    const rec = atEdge();
    rec.move(EDGE_X + 300, 400, 16);
    expect(rec.offset).toBe(300);
    rec.move(EDGE_X - 50, 401, 32);
    expect(rec.offset).toBe(0);
    rec.move(EDGE_X + 900, 402, 48);
    expect(rec.offset).toBe(W);
  });

  it('慢慢拖过 40% 屏宽即返回（速度不够也算）', () => {
    const rec = atEdge();
    rec.move(EDGE_X + 80, 400, 0);
    rec.move(EDGE_X + 160, 400, 800);
    expect(rec.end(800)).toMatchObject({ dragging: true, commit: true });
  });

  it('差一点不到 40%，但快甩速度过 800px/s 仍返回', () => {
    const rec = atEdge();
    rec.move(EDGE_X + 60, 400, 16);
    rec.move(EDGE_X + 140, 400, 32);
    const result = rec.end(32);
    // 位移 134 < 160，速度 (140-60)/32ms ≈ 2500px/s
    expect(result.offset).toBeLessThan(W * EDGE_SWIPE_DEFAULT.commitRatio);
    expect(result.velocity).toBeGreaterThan(EDGE_SWIPE_DEFAULT.commitVelocityPx);
    expect(result.commit).toBe(true);
  });

  it('拖到一半停住再松手：速度证据过期，不返回', () => {
    const rec = atEdge();
    rec.move(EDGE_X + 60, 400, 16);
    rec.move(EDGE_X + 120, 400, 32);
    const result = rec.end(32 + 400);
    expect(result.velocity).toBe(0);
    expect(result.commit).toBe(false);
  });

  it('采样全挤在同一毫秒（脚本合成事件）时不采信速度', () => {
    const rec = atEdge();
    rec.move(EDGE_X + 100, 400, 0);
    rec.move(EDGE_X + 140, 400, 0);
    const result = rec.end(0);
    expect(result.velocity).toBe(0);
    expect(result.commit).toBe(false);
  });

  it('慢速短拖既不满足位移也不满足速度，交给调用方回弹', () => {
    const rec = atEdge();
    rec.move(EDGE_X + 30, 400, 100);
    rec.move(EDGE_X + 60, 400, 500);
    expect(rec.end(500)).toMatchObject({ dragging: true, commit: false });
  });

  it('松手后状态复位，下一次手势重新判定', () => {
    const rec = atEdge();
    rec.move(EDGE_X + 100, 400, 16);
    rec.end(16);
    expect(rec.move(EDGE_X + 300, 400, 32)).toBe('none');
    expect(rec.begin(EDGE_X, 400, 48, W)).toBe('pending');
    expect(rec.move(EDGE_X + 20, 400, 64)).toBe('drag');
  });

  it('屏宽非法时不炸，位移上限退化为 1px', () => {
    const rec = new EdgeSwipeRecognizer();
    rec.begin(EDGE_X, 400, 0, 0);
    expect(rec.move(EDGE_X + 100, 400, 16)).toBe('drag');
    expect(rec.offset).toBe(1);
  });
});
