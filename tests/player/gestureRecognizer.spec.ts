import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GestureRecognizer, type GestureContext, type GestureIntent } from '@/player/GestureRecognizer';

/**
 * 手势识别纯逻辑测试（AC-49 / 技术方案 9.3）
 *
 * 覆盖：
 * - 位移 < 8px 判定为单击（延迟 250ms 派发，避免与双击冲突）
 * - 双击（250ms 内任意侧）判定为 double-tap
 * - 双击不再触发快进/快退 seek
 * - 水平位移 > 1.5×垂直 → 快进/快退；松手才提交 seek
 * - 垂直位移主导 → 左亮度、右音量
 * - 长按 500ms → 长按开始，松手结束
 * - 长按 3000ms 且 ctx 允许 → 先结束倍速再派发帮助，本次长按被消费掉
 * - 拖动音量/亮度以起点值为基准，并在 0~100 钳制
 */
const WIDTH = 360;
const HEIGHT = 640;

function makeCtx(overrides: Partial<GestureContext> = {}): GestureContext {
  return {
    width: WIDTH,
    height: HEIGHT,
    currentTime: 100,
    duration: 1000,
    volume: 50,
    brightness: 50,
    seekMaxSec: 90,
    sensitivity: 'medium',
    ...overrides,
  };
}

function makeRecognizer(): { recognizer: GestureRecognizer; intents: GestureIntent[] } {
  const intents: GestureIntent[] = [];
  const recognizer = new GestureRecognizer({ onIntent: (i) => intents.push(i) });
  return { recognizer, intents };
}

describe('GestureRecognizer', () => {
  let now = 1_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function tap(recognizer: GestureRecognizer, x: number, y: number, ctx = makeCtx()): void {
    recognizer.pointerDown({ pointerId: 1, clientX: x, clientY: y }, ctx);
    recognizer.pointerUp({ pointerId: 1, clientX: x, clientY: y });
  }

  it('位移 < 8px 且时长 < 250ms 判定为单击（延迟 250ms 派发）', () => {
    const { recognizer, intents } = makeRecognizer();
    recognizer.pointerDown({ pointerId: 1, clientX: 100, clientY: 300 }, makeCtx());
    recognizer.pointerMove({ pointerId: 1, clientX: 104, clientY: 303 }, makeCtx());
    now += 120;
    recognizer.pointerUp({ pointerId: 1, clientX: 104, clientY: 303 });

    // 尚未派发，等待双击窗口
    expect(intents).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(intents).toHaveLength(1);
    // B-04：单击要带按下点坐标（弹幕命中用它），不是松手点——手指抖动几 px 不该改变命中
    expect(intents[0]).toEqual({ type: 'single-tap', side: 'left', x: 100, y: 300 });
  });

  it('250ms 内任意侧两次点击判定为双击（不要求同侧）', () => {
    const { recognizer, intents } = makeRecognizer();
    tap(recognizer, 100, 300, makeCtx()); // 左侧
    now += 200;
    tap(recognizer, 300, 300, makeCtx()); // 右侧
    vi.advanceTimersByTime(300);

    expect(intents).toHaveLength(1);
    expect(intents[0]).toEqual({ type: 'double-tap', side: 'right' });
  });

  it('双击不产生 seek intent', () => {
    const { recognizer, intents } = makeRecognizer();
    tap(recognizer, 100, 300, makeCtx());
    now += 200;
    tap(recognizer, 300, 300, makeCtx());
    vi.advanceTimersByTime(300);

    expect(intents.some((i) => i.type === 'seek-preview')).toBe(false);
    expect(intents.some((i) => i.type === 'seek-commit')).toBe(false);
  });

  it('水平拖动 1/3 屏宽 → 快进约 30s，松手才提交 seek（AC-47）', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx();
    recognizer.pointerDown({ pointerId: 1, clientX: 100, clientY: 320 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 100 + WIDTH / 3, clientY: 322 }, ctx);

    const preview = intents.find((i) => i.type === 'seek-preview');
    expect(preview).toBeTruthy();
    if (preview?.type === 'seek-preview') {
      expect(preview.targetSec).toBeCloseTo(130, 1);
      expect(preview.deltaSec).toBeCloseTo(30, 1);
    }

    // 拖动中不应有 commit
    expect(intents.some((i) => i.type === 'seek-commit')).toBe(false);

    recognizer.pointerUp({ pointerId: 1, clientX: 100 + WIDTH / 3, clientY: 322 });
    const commit = intents.find((i) => i.type === 'seek-commit');
    expect(commit).toBeTruthy();
    if (commit?.type === 'seek-commit') expect(commit.targetSec).toBeCloseTo(130, 1);
  });

  it('水平拖动超出片尾时钳制到总时长（AC-48）', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx({ currentTime: 980, duration: 1000 });
    recognizer.pointerDown({ pointerId: 1, clientX: 100, clientY: 320 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 340, clientY: 322 }, ctx);
    recognizer.pointerUp({ pointerId: 1, clientX: 340, clientY: 322 });

    const commit = intents.find((i) => i.type === 'seek-commit');
    expect(commit?.type === 'seek-commit' && commit.targetSec).toBe(1000);
  });

  it('灵敏度 high 时同样的拖动得到 1.5 倍位移', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx({ sensitivity: 'high' });
    recognizer.pointerDown({ pointerId: 1, clientX: 0, clientY: 320 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: WIDTH / 3, clientY: 322 }, ctx);

    const preview = intents.find((i) => i.type === 'seek-preview');
    if (preview?.type === 'seek-preview') expect(preview.deltaSec).toBeCloseTo(45, 1);
  });

  it('右半区垂直上滑 → 音量增大（以起点值为基准）', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx({ volume: 40 });
    recognizer.pointerDown({ pointerId: 1, clientX: 300, clientY: 480 }, ctx);
    // 上滑 64px（10% 高度）→ +10
    recognizer.pointerMove({ pointerId: 1, clientX: 302, clientY: 416 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 302, clientY: 352 }, ctx);

    const volumes = intents.filter((i) => i.type === 'volume');
    expect(volumes.length).toBeGreaterThan(0);
    const last = volumes[volumes.length - 1];
    if (last?.type === 'volume') expect(last.value).toBeCloseTo(60, 1);
  });

  it('左半区垂直下滑 → 亮度降低，并在 0 处钳制（AC-48 可读下限）', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx({ brightness: 10 });
    recognizer.pointerDown({ pointerId: 1, clientX: 60, clientY: 100 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 62, clientY: 500 }, ctx);

    const brightness = intents.filter((i) => i.type === 'brightness');
    const last = brightness[brightness.length - 1];
    expect(last?.type).toBe('brightness');
    if (last?.type === 'brightness') expect(last.value).toBe(0);
  });

  it('垂直拖动不会误触发 seek', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx();
    recognizer.pointerDown({ pointerId: 1, clientX: 300, clientY: 200 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 304, clientY: 400 }, ctx);
    recognizer.pointerUp({ pointerId: 1, clientX: 304, clientY: 400 });
    expect(intents.some((i) => i.type === 'seek-commit')).toBe(false);
    expect(intents.some((i) => i.type === 'volume')).toBe(true);
  });

  it('长按 500ms 触发长按，松手结束（AC-49）', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx();
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, ctx);
    vi.advanceTimersByTime(500);
    expect(intents).toEqual([{ type: 'long-press-start' }]);

    recognizer.pointerUp({ pointerId: 1, clientX: 180, clientY: 320 });
    expect(intents).toEqual([{ type: 'long-press-start' }, { type: 'long-press-end' }]);
    // 长按不应再派发单击
    vi.advanceTimersByTime(400);
    expect(intents.some((i) => i.type === 'single-tap')).toBe(false);
  });

  it('长按期间移动超过 8px 会取消长按', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx();
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, ctx);
    vi.advanceTimersByTime(200);
    recognizer.pointerMove({ pointerId: 1, clientX: 240, clientY: 322 }, ctx);
    vi.advanceTimersByTime(500);
    expect(intents.some((i) => i.type === 'long-press-start')).toBe(false);
  });

  it('未开启帮助资格时，长按多久都只走倍速（AC 长按帮助不抢手势）', () => {
    const { recognizer, intents } = makeRecognizer();
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, makeCtx());
    vi.advanceTimersByTime(10_000);
    expect(intents).toEqual([{ type: 'long-press-start' }]);
  });

  it('开启帮助资格后按住 3 秒：先结束倍速再派发帮助，且本次长按不再产生别的 intent', () => {
    const { recognizer, intents } = makeRecognizer();
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, makeCtx({ longPressHelpEnabled: true }));
    vi.advanceTimersByTime(3_000);
    expect(intents).toEqual([
      { type: 'long-press-start' },
      { type: 'long-press-end' },
      { type: 'long-press-help' },
    ]);

    // 长按已被帮助消费：松手不该再派发单击或 seek-cancel
    recognizer.pointerUp({ pointerId: 1, clientX: 180, clientY: 320 });
    vi.advanceTimersByTime(400);
    expect(intents.filter((i) => i.type === 'single-tap' || i.type === 'seek-cancel')).toHaveLength(0);
  });

  it('帮助阈值前松手只算倍速，不弹帮助', () => {
    const { recognizer, intents } = makeRecognizer();
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, makeCtx({ longPressHelpEnabled: true }));
    vi.advanceTimersByTime(1_200);
    recognizer.pointerUp({ pointerId: 1, clientX: 180, clientY: 320 });
    expect(intents).toEqual([{ type: 'long-press-start' }, { type: 'long-press-end' }]);
    vi.advanceTimersByTime(5_000);
    expect(intents.some((i) => i.type === 'long-press-help')).toBe(false);
  });

  it('按住期间移动超过 8px，帮助计时器一并作废', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx({ longPressHelpEnabled: true });
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, ctx);
    vi.advanceTimersByTime(2_000);
    recognizer.pointerMove({ pointerId: 1, clientX: 260, clientY: 322 }, ctx);
    vi.advanceTimersByTime(5_000);
    expect(intents.some((i) => i.type === 'long-press-help')).toBe(false);
  });

  it('多指：第二根手指按下被忽略', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx();
    recognizer.pointerDown({ pointerId: 1, clientX: 100, clientY: 320 }, ctx);
    recognizer.pointerDown({ pointerId: 2, clientX: 300, clientY: 100 }, ctx);
    recognizer.pointerMove({ pointerId: 2, clientX: 340, clientY: 100 }, ctx);
    expect(intents).toHaveLength(0);
  });

  it('destroy 清理定时器，不再派发任何手势', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx();
    recognizer.pointerDown({ pointerId: 1, clientX: 100, clientY: 300 }, ctx);
    recognizer.pointerUp({ pointerId: 1, clientX: 100, clientY: 300 });
    recognizer.destroy();
    vi.advanceTimersByTime(1000);
    expect(intents).toHaveLength(0);
  });

  it('回归：亮度已为 0 时再次上滑可回升（不再卡在 0%）', () => {
    const { recognizer, intents } = makeRecognizer();
    // store 里的亮度就是 0（不再是遮罩不透明度反算）
    const ctx = makeCtx({ brightness: 0 });
    recognizer.pointerDown({ pointerId: 1, clientX: 60, clientY: 480 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 60, clientY: 400 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 60, clientY: 300 }, ctx);

    const values = intents.filter((i) => i.type === 'brightness');
    const last = values[values.length - 1];
    // 上滑 180px ≈ 28.1%（旧 bug 下基准为 -9900，任何滑动都被钳成 0）
    if (last?.type === 'brightness') expect(last.value).toBeCloseTo(28.1, 1);
  });

  it('基准亮度为 NaN 时回落 100，不会把亮度锁死', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx({ brightness: Number.NaN });
    recognizer.pointerDown({ pointerId: 1, clientX: 60, clientY: 480 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 60, clientY: 560 }, ctx);

    const values = intents.filter((i) => i.type === 'brightness');
    const last = values[values.length - 1];
    if (last?.type === 'brightness') expect(last.value).toBeCloseTo(87.5, 1);
  });

  it('上次 up 丢失后同一指针再次按下会重置样本（手势不会永久失效）', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx({ brightness: 0 });
    recognizer.pointerDown({ pointerId: 1, clientX: 60, clientY: 480 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 60, clientY: 600 }, ctx);
    // 故意不派发 pointerUp，模拟落点被控制条等元素吞掉
    const before = intents.length;

    recognizer.pointerDown({ pointerId: 1, clientX: 60, clientY: 480 }, ctx);
    recognizer.pointerMove({ pointerId: 1, clientX: 60, clientY: 400 }, ctx);

    const after = intents.slice(before).filter((i) => i.type === 'brightness');
    const last = after[after.length - 1];
    if (last?.type === 'brightness') expect(last.value).toBeCloseTo(12.5, 1);
  });

  it('上次 up 丢失后新落下的主指针接管：先收尾在飞的长按，画面不再点不动', () => {
    const { recognizer, intents } = makeRecognizer();
    const ctx = makeCtx();
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, ctx);
    vi.advanceTimersByTime(600);
    expect(intents).toEqual([{ type: 'long-press-start' }]);

    // 真机上"抬手半路被吞"后，下一次点屏拿到的是全新的 pointerId（WebView 单调递增），
    // 但它仍是 primary。旧实现见 id 不符就直接 return：倍速挂着、这根手指也永远不进样本。
    recognizer.pointerDown({ pointerId: 2, clientX: 100, clientY: 300, isPrimary: true }, ctx);
    expect(intents).toEqual([{ type: 'long-press-start' }, { type: 'long-press-end' }]);

    recognizer.pointerUp({ pointerId: 2, clientX: 100, clientY: 300 });
    vi.advanceTimersByTime(300);
    expect(intents[intents.length - 1]).toEqual({ type: 'single-tap', side: 'left', x: 100, y: 300 });
  });

  it('长按进行中整层被拆掉：补一次 long-press-end，倍速不跟着实例挂到天亮', () => {
    const { recognizer, intents } = makeRecognizer();
    recognizer.pointerDown({ pointerId: 1, clientX: 180, clientY: 320 }, makeCtx());
    vi.advanceTimersByTime(600);
    expect(intents).toEqual([{ type: 'long-press-start' }]);

    // 锁屏/错误层把 GestureLayer 整层 v-if 掉时，这一根的抬手永远不会再来
    recognizer.destroy();
    expect(intents).toEqual([{ type: 'long-press-start' }, { type: 'long-press-end' }]);
  });
});
