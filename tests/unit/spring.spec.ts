import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { animateSpring } from '@/composables/useSpring';

/**
 * 弹簧积分器（A 批次·A-02）
 *
 * 验收红线来自方案：快甩要下沉再收回、低端机掉帧不许弹飞、任何参数都不许卡在中间态、
 * 位移永远不许越过停靠位（Sheet 贴屏幕底边，越过去就是撕缝）。
 */

let queue: Array<(now: number) => void> = [];
let now = 0;

/** 手动推进 frames 帧；弹簧停机后回调队列为空，继续推是空转 */
function pump(frameMs: number, frames: number): void {
  for (let i = 0; i < frames; i++) {
    now += frameMs;
    const pending = queue;
    queue = [];
    pending.forEach((cb) => cb(now));
    if (queue.length === 0) return;
  }
}

beforeEach(() => {
  queue = [];
  now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    queue.push(cb);
    return queue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    queue = [];
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('animateSpring', () => {
  it('无初速度时收敛到目标并停机', () => {
    const seen: number[] = [];
    let settled = false;
    animateSpring({
      from: 120,
      target: 0,
      onFrame: (v) => seen.push(v),
      onSettle: () => {
        settled = true;
      },
    });
    pump(16, 120);
    expect(settled).toBe(true);
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('向下甩时先继续下沉再收回（释放速度被接住）', () => {
    const seen: number[] = [];
    animateSpring({
      from: 40,
      target: 0,
      velocity: 900,
      onFrame: (v) => seen.push(v),
      onSettle: () => undefined,
    });
    pump(16, 120);
    const peak = Math.max(...seen);
    expect(peak).toBeGreaterThan(40);
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('停靠位是硬边界：带 clamp 时任何一帧都不越过终点', () => {
    const seen: number[] = [];
    animateSpring({
      from: 160,
      target: 0,
      velocity: 2400,
      clamp: (v) => Math.max(0, v),
      onFrame: (v) => seen.push(v),
      onSettle: () => undefined,
    });
    pump(16, 200);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    // 撞上停靠位即停机，不假装弹回来
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('掉帧到 500ms 一帧也不发散，且会到点吸附', () => {
    const seen: number[] = [];
    let settled = false;
    animateSpring({
      from: 200,
      target: 0,
      velocity: 1500,
      onFrame: (v) => seen.push(v),
      onSettle: () => {
        settled = true;
      },
    });
    // 单帧被钳到 32ms，所以要按钳制后的时间推够收敛所需的帧数
    pump(500, 80);
    expect(Math.max(...seen.map(Math.abs))).toBeLessThan(1000);
    expect(seen.every(Number.isFinite)).toBe(true);
    expect(settled).toBe(true);
  });

  it('刚度/阻尼配到极端也不卡死（兜底停机时间生效）', () => {
    let settled = false;
    animateSpring({
      from: 300,
      target: 0,
      config: { stiffness: 1, damping: 0.01 },
      onFrame: () => undefined,
      onSettle: () => {
        settled = true;
      },
    });
    pump(16, 200);
    expect(settled).toBe(true);
  });

  it('停止函数掐掉后续帧，且不触发 onSettle', () => {
    let settled = false;
    const seen: number[] = [];
    const stop = animateSpring({
      from: 100,
      target: 0,
      onFrame: (v) => seen.push(v),
      onSettle: () => {
        settled = true;
      },
    });
    pump(16, 4);
    const before = seen.length;
    stop();
    pump(16, 20);
    expect(seen.length).toBe(before);
    expect(settled).toBe(false);
  });

  it('没有 requestAnimationFrame 时直接吸附，不静默卡在半路', () => {
    vi.stubGlobal('requestAnimationFrame', undefined);
    let settled = false;
    animateSpring({
      from: 88,
      target: 0,
      onFrame: () => undefined,
      onSettle: () => {
        settled = true;
      },
    });
    expect(settled).toBe(true);
  });
});
