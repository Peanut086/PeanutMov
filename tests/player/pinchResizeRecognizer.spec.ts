/**
 * G-A09 双指捏合切画幅 · 几何与状态机
 *
 * 重点覆盖四类容易出事的地方：
 * 1. 单指绝不能被捏合逻辑消费掉（否则现有的拖动快进/音量全废）；
 * 2. 未越过触发阈值的两指落按不算捏合，抬手要交回"什么都没发生"；
 * 3. 手指数量变化时基准要重算，否则一抬手指画面就跳档；
 * 4. 尺的起点是起手档位 —— 起手那一下不许把画面甩到「适应」。
 *
 * 尺中间的取值只断言区间与档位：`pos` 是浮点折算出来的连续量，卡死某一个小数位
 * 等于把实现细节写进契约；端点 0 / 1 是钳位结果，可以精确断言。
 */
import { describe, expect, it, vi } from 'vitest';

import type { ResizeMode } from '@/types';
import {
  PINCH_ENGAGE_RATIO,
  PINCH_SPAN_RATIO,
  PinchResizeRecognizer,
  modeForPosition,
} from '@/player/PinchResizeRecognizer';

function makeRecognizer(startMode: ResizeMode = 'contain') {
  const onSample = vi.fn();
  const onEnd = vi.fn();
  const rec = new PinchResizeRecognizer({ onSample, onEnd }, () => startMode);
  return { rec, onSample, onEnd };
}

/** 从 (0,0) 与 (base,0) 起手的双指会话 */
function startTwoFingers(rec: PinchResizeRecognizer, base = 100): void {
  expect(rec.pointerDown(1, 0, 0)).toBe(false);
  expect(rec.pointerDown(2, base, 0)).toBe(true);
}

/** 把第二指移到距第一指 `dist` 处 */
function spread(rec: PinchResizeRecognizer, dist: number): void {
  rec.pointerMove(2, dist, 0);
}

/** 最近一次采样的画幅尺位置 */
function lastPos(onSample: ReturnType<typeof vi.fn>): number {
  const args = onSample.mock.lastCall as [number, string];
  return args[0];
}

/** 恰好落在档位中段的间距：100 → 1 + 0.5·SPAN */
const MID_DIST = 100 * (1 + 0.5 * PINCH_SPAN_RATIO);

describe('modeForPosition 档位判定', () => {
  it('按 0.25 / 0.75 切三档', () => {
    expect(modeForPosition(0)).toBe('contain');
    expect(modeForPosition(0.24)).toBe('contain');
    expect(modeForPosition(0.25)).toBe('cover');
    expect(modeForPosition(0.5)).toBe('cover');
    expect(modeForPosition(0.74)).toBe('cover');
    expect(modeForPosition(0.75)).toBe('fill');
    expect(modeForPosition(1)).toBe('fill');
  });
});

describe('单指与未成形的会话', () => {
  it('单指的 down/move/up 一律不消费，也不派发任何捏合回调', () => {
    const { rec, onSample, onEnd } = makeRecognizer();
    expect(rec.pointerDown(1, 10, 10)).toBe(false);
    expect(rec.pointerMove(1, 80, 10)).toBe(false);
    expect(rec.pointerUp(1)).toBe(false);
    expect(rec.inSession).toBe(false);
    expect(onSample).not.toHaveBeenCalled();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('两指落住但张合幅度没过阈值：不算捏合，抬手交出 null', () => {
    const { rec, onSample, onEnd } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, 100 * (1 + PINCH_ENGAGE_RATIO - 0.02));
    expect(onSample).not.toHaveBeenCalled();
    expect(rec.pointerUp(2)).toBe(true);
    expect(onEnd).toHaveBeenCalledWith(null, 0, 'up');
    expect(rec.inSession).toBe(false);
  });

  it('两指落住后直接抬手（完全没动）同样不算捏合', () => {
    const { rec, onEnd } = makeRecognizer();
    startTwoFingers(rec);
    rec.pointerUp(1);
    expect(onEnd).toHaveBeenCalledWith(null, 0, 'up');
  });
});

describe('捏合采样与档位映射', () => {
  it('张到中段是铺满，张过头钳在尺的右端（拉伸档）', () => {
    const { rec, onSample } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, MID_DIST);
    expect(onSample).toHaveBeenLastCalledWith(expect.closeTo(0.5, 6), 'cover');
    spread(rec, 180);
    // (1.8-1)/0.7 > 1，必须钳在右端而不是冲出 100%
    expect(lastPos(onSample)).toBe(1);
    expect(onSample).toHaveBeenLastCalledWith(1, 'fill');
  });

  it('捏过头钳在尺的左端（适应档）', () => {
    const { rec, onSample } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, MID_DIST);
    spread(rec, 50);
    expect(onSample).toHaveBeenLastCalledWith(0, 'contain');
  });

  it('抬手吸附到画幅尺当前所在的档位', () => {
    const { rec, onEnd } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, 180);
    expect(rec.pointerUp(2)).toBe(true);
    expect(onEnd).toHaveBeenCalledWith('fill', 1, 'up');
  });

  it('抬手时档位与开始一致也要如实回报（宿主据此决定落不落盘）', () => {
    const { rec, onEnd } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, 100 * (1 + PINCH_ENGAGE_RATIO + 0.01));
    expect(rec.pointerUp(2)).toBe(true);
    expect(onEnd).toHaveBeenCalledWith('contain', expect.closeTo(0.0857, 4), 'up');
  });

  it('中途被打断（pointercancel）不吸附、不落盘，只报告取消', () => {
    const { rec, onEnd } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, MID_DIST);
    expect(rec.pointerCancel(1)).toBe(true);
    expect(onEnd).toHaveBeenCalledWith(null, expect.closeTo(0.5, 6), 'cancel');
    expect(rec.inSession).toBe(false);
  });
});

describe('多指进出会话', () => {
  it('第三指不改变几何；抬起第三指后以原基准继续，不跳档', () => {
    const { rec, onSample } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, MID_DIST);
    expect(rec.pointerDown(3, 50, 50)).toBe(true);
    rec.pointerMove(3, 60, 60);
    expect(rec.pointerUp(3)).toBe(true);
    expect(rec.inSession).toBe(true);
    // 基准重定回原始间距：回到原始间距就该回到尺的左端
    spread(rec, 100);
    expect(onSample).toHaveBeenLastCalledWith(0, 'contain');
  });

  it('会话中追加的手指仍然被消费掉，不会漏给单指识别器', () => {
    const { rec } = makeRecognizer();
    startTwoFingers(rec);
    expect(rec.pointerDown(3, 10, 10)).toBe(true);
    expect(rec.pointerMove(3, 20, 20)).toBe(true);
    expect(rec.pointerUp(3)).toBe(true);
  });

  it('只剩一指时会话收尾，那一指之后的事件交还给单指链路', () => {
    const { rec, onEnd } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, MID_DIST);
    rec.pointerUp(2);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(rec.inSession).toBe(false);
    expect(rec.pointerMove(1, 300, 300)).toBe(false);
    expect(rec.pointerUp(1)).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('会话结束后完全复位：下一轮单指/双指都从头开始', () => {
    const { rec, onEnd } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, MID_DIST);
    rec.pointerUp(1);
    rec.pointerUp(2);
    expect(onEnd).toHaveBeenCalledTimes(1);

    expect(rec.pointerDown(5, 0, 0)).toBe(false);
    expect(rec.pointerDown(6, 100, 0)).toBe(true);
    expect(rec.pointerUp(6)).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenLastCalledWith(null, 0, 'up');
  });

  it('reset 静默清场：不派发抬手，采样也随之停止', () => {
    const { rec, onEnd, onSample } = makeRecognizer();
    startTwoFingers(rec);
    spread(rec, MID_DIST);
    rec.reset();
    expect(onEnd).not.toHaveBeenCalled();
    expect(onSample).toHaveBeenCalledTimes(1);
    expect(rec.inSession).toBe(false);
    expect(rec.pointerUp(1)).toBe(false);
  });
});

describe('尺的起点是当前档位', () => {
  it('从铺满起手：刚越过阈值仍停在铺满，不会先跳适应', () => {
    const { rec, onSample } = makeRecognizer('cover');
    startTwoFingers(rec);
    spread(rec, 100 * (1 + PINCH_ENGAGE_RATIO));
    expect(onSample).toHaveBeenLastCalledWith(expect.closeTo(0.5714, 4), 'cover');
  });

  it('从铺满起手：张到 1.35 倍正好走到右端（拉伸档）', () => {
    const { rec, onSample } = makeRecognizer('cover');
    startTwoFingers(rec);
    spread(rec, 135);
    expect(onSample).toHaveBeenLastCalledWith(1, 'fill');
  });

  it('从铺满往回捏同样一档一换', () => {
    const { rec, onSample } = makeRecognizer('cover');
    startTwoFingers(rec);
    spread(rec, 65);
    expect(onSample).toHaveBeenLastCalledWith(0, 'contain');
  });

  it('从拉伸起手：只能往回走，张开钳在右端', () => {
    const { rec, onSample } = makeRecognizer('fill');
    startTwoFingers(rec);
    spread(rec, 150);
    expect(onSample).toHaveBeenLastCalledWith(1, 'fill');
    spread(rec, 65);
    expect(onSample).toHaveBeenLastCalledWith(0.5, 'cover');
  });

  it('端点档位向外的行程不产生换档', () => {
    const { rec, onSample } = makeRecognizer('contain');
    startTwoFingers(rec);
    spread(rec, 60);
    expect(onSample).toHaveBeenLastCalledWith(0, 'contain');
  });

  it('抬手报的是相对起手走到的档位，而不是起手档位本身', () => {
    const { rec, onEnd } = makeRecognizer('cover');
    startTwoFingers(rec);
    spread(rec, 135);
    expect(rec.pointerUp(2)).toBe(true);
    expect(onEnd).toHaveBeenCalledWith('fill', 1, 'up');
  });
});
