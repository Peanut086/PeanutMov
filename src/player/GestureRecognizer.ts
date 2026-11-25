/**
 * 手势识别（纯逻辑，可单测）
 *
 * 输入：Pointer 序列（down/move/up）+ 视口尺寸 + 当前音量/亮度/进度
 * 输出：intent（单击/双击/拖动预览/提交 seek/音量/亮度/长按倍速）
 *
 * 判定规则见技术方案 9.3：
 * - 单击：位移 < 8px 且时长 < 300ms
 * - 双击：两次 tap 间隔 < 300ms
 * - 水平拖动：|dx| > 8 且 |dx| > 1.5|dy|
 * - 垂直拖动：|dy| > 8 且 |dy| > 1.5|dx|；右半区音量、左半区亮度
 * - 长按：500ms 无位移 → 临时倍速
 * - 长按帮助：3000ms 无位移 → `long-press-help`（仅 ctx 允许时启用，触发前先结束倍速）
 *
 * 所有长按时序都由本类的两个计时器裁决：调用方不要再自己起一份长按计时器，
 * 否则同一根手指会既进倍速又弹帮助。
 *
 * 本类**不接触 DOM**（只接收数字与回调），因此可在 Node 中直接单测。
 */
import {
  GESTURE_DIRECTION_RATIO,
  GESTURE_DOUBLE_TAP_INTERVAL_MS,
  GESTURE_HELP_LONG_PRESS_MS,
  GESTURE_LONG_PRESS_MS,
  GESTURE_SENSITIVITY_FACTOR,
  GESTURE_TAP_MAX_DURATION_MS,
  GESTURE_TAP_MAX_MOVE_PX,
} from '@/shared/constants';
import type { Sensitivity } from '@/types';

export type GestureIntent =
  | { type: 'tap' }
  | { type: 'double-tap'; side: 'left' | 'right' }
  | { type: 'seek-preview'; targetSec: number; deltaSec: number }
  | { type: 'seek-commit'; targetSec: number }
  | { type: 'seek-cancel' }
  | { type: 'volume'; value: number; delta: number }
  | { type: 'brightness'; value: number; delta: number }
  | { type: 'long-press-start' }
  | { type: 'long-press-end' }
  /** 按住超过帮助阈值且未移动（仅 `ctx.longPressHelpEnabled` 时派发），消费掉本次手势 */
  | { type: 'long-press-help' }
  /** x/y 为按下点视口坐标（CSS px）：B-04 用它做弹幕命中测试，其余消费方只关心 side */
  | { type: 'single-tap'; side: 'left' | 'right'; x: number; y: number };

export interface GestureContext {
  /** 视口宽高（px） */
  width: number;
  height: number;
  /** 当前播放进度与总时长（秒） */
  currentTime: number;
  duration: number;
  /** 当前音量/亮度（0~100） */
  volume: number;
  brightness: number;
  /** 水平满屏拖动的最大秒数 */
  seekMaxSec: number;
  /** 相对定位是否可靠；false 时水平拖动取消，音量/亮度仍可用 */
  seekEnabled?: boolean;
  sensitivity: Sensitivity;
  /** 本次长按是否允许在超过帮助阈值后呼出帮助浮层（缺省不允许） */
  longPressHelpEnabled?: boolean;
}

export interface GestureCallbacks {
  onIntent: (intent: GestureIntent) => void;
}

export type DragMode = 'none' | 'undetermined' | 'seek' | 'volume' | 'brightness';

interface PointerSample {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startTime: number;
  side: 'left' | 'right';
}

export class GestureRecognizer {
  private sample: PointerSample | null = null;
  private mode: DragMode = 'none';
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressHelpTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTapAt = 0;
  private pendingTapTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressActive = false;

  /** 拖动期间累计的目标位置，松手时提交 */
  private pendingTarget: number | null = null;
  private pendingVolume: number | null = null;
  private pendingBrightness: number | null = null;
  private baseVolume = 100;
  private baseBrightness = 100;

  constructor(private readonly callbacks: GestureCallbacks) {}

  /* ---------- 事件入口 ---------- */

  pointerDown(
    ev: { pointerId: number; clientX: number; clientY: number; isPrimary?: boolean },
    ctx: GestureContext,
  ): void {
    // 多指：忽略新增手指——本类始终只跟踪一根手指，双指捏合由上层的
    // PinchResizeRecognizer 接管（G-A09）；
    // 同一指针重复 down（上一次 up/cancel 丢失）则丢弃陈旧样本，避免手势永久卡死
    if (this.sample !== null) {
      if (this.sample.id !== ev.pointerId) {
        // 新落下的若是 primary 指针，说明上一根只是"抬手没送到"（系统收走触摸、捏合抢先认领），
        // 而不是它还真按着。此时只 return 会让本类永久认为有一根手指在按：之后每次按下都被
        // 当成多指丢弃，单击/拖动再也进不来，画面等于点什么都没人应答。
        // 必须走 pointerCancel——它顺带把在飞的长按倍速收尾，否则提示与 2x 一起挂着。
        if (ev.isPrimary !== true) return;
        this.pointerCancel({ pointerId: this.sample.id });
      } else {
        this.sample = null;
        this.mode = 'none';
      }
    }
    this.cancelLongPress();
    const side = ev.clientX < ctx.width / 2 ? 'left' : 'right';
    this.sample = {
      id: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      lastX: ev.clientX,
      lastY: ev.clientY,
      startTime: Date.now(),
      side,
    };
    this.mode = 'undetermined';
    this.pendingTarget = null;
    this.pendingVolume = null;
    this.pendingBrightness = null;
    this.longPressActive = false;

    this.longPressTimer = setTimeout(() => {
      this.longPressTimer = null;
      if (this.sample === null || this.mode !== 'undetermined') return;
      const moved = distance(this.sample);
      if (moved > GESTURE_TAP_MAX_MOVE_PX) return;
      this.longPressActive = true;
      this.callbacks.onIntent({ type: 'long-press-start' });
    }, GESTURE_LONG_PRESS_MS);

    if (ctx.longPressHelpEnabled === true) {
      this.longPressHelpTimer = setTimeout(() => {
        this.longPressHelpTimer = null;
        if (this.sample === null || this.mode !== 'undetermined') return;
        if (distance(this.sample) > GESTURE_TAP_MAX_MOVE_PX) return;
        if (this.longPressActive) {
          // 帮助浮层不该压在倍速手势上：按松手处理，先把倍速恢复掉
          this.longPressActive = false;
          this.callbacks.onIntent({ type: 'long-press-end' });
        }
        // 本次长按已被帮助消费：丢弃样本，松手不再派发 tap / seek-cancel
        this.sample = null;
        this.mode = 'none';
        this.callbacks.onIntent({ type: 'long-press-help' });
      }, GESTURE_HELP_LONG_PRESS_MS);
    }
  }

  pointerMove(ev: { pointerId: number; clientX: number; clientY: number }, ctx: GestureContext): void {
    const sample = this.sample;
    if (!sample || sample.id !== ev.pointerId) return;

    sample.lastX = ev.clientX;
    sample.lastY = ev.clientY;

    const dx = ev.clientX - sample.startX;
    const dy = ev.clientY - sample.startY;

    if (this.mode === 'undetermined') {
      if (Math.abs(dx) < GESTURE_TAP_MAX_MOVE_PX && Math.abs(dy) < GESTURE_TAP_MAX_MOVE_PX) return;
      this.cancelLongPress();
      if (Math.abs(dx) > Math.abs(dy) * GESTURE_DIRECTION_RATIO) {
        if (ctx.seekEnabled === false) {
          this.mode = 'none';
          this.callbacks.onIntent({ type: 'seek-cancel' });
          return;
        }
        this.mode = 'seek';
      } else if (Math.abs(dy) > Math.abs(dx) * GESTURE_DIRECTION_RATIO) {
        this.mode = sample.side === 'left' ? 'brightness' : 'volume';
        // 记录拖动起点的音量/亮度作为基准，避免逐帧累加漂移；越界/NaN 由 clamp 兜底
        this.baseVolume = clamp(Number.isFinite(ctx.volume) ? ctx.volume : 0, 0, 100);
        this.baseBrightness = clamp(Number.isFinite(ctx.brightness) ? ctx.brightness : 100, 0, 100);
      } else return;
    }

    if (this.mode === 'seek') {
      const factor = GESTURE_SENSITIVITY_FACTOR[ctx.sensitivity] ?? 1;
      const deltaSec = (dx / Math.max(1, ctx.width)) * ctx.seekMaxSec * factor;
      const target = clamp(
        ctx.currentTime + deltaSec,
        0,
        ctx.duration > 0 ? ctx.duration : ctx.currentTime + deltaSec,
      );
      this.pendingTarget = target;
      this.callbacks.onIntent({
        type: 'seek-preview',
        targetSec: target,
        deltaSec: target - ctx.currentTime,
      });
      return;
    }

    if (this.mode === 'volume') {
      const value = clamp(this.baseVolume - (dy / Math.max(1, ctx.height)) * 100, 0, 100);
      if (this.pendingVolume === value) return;
      this.pendingVolume = value;
      this.callbacks.onIntent({ type: 'volume', value, delta: value - ctx.volume });
      return;
    }

    if (this.mode === 'brightness') {
      const value = clamp(this.baseBrightness - (dy / Math.max(1, ctx.height)) * 100, 0, 100);
      if (this.pendingBrightness === value) return;
      this.pendingBrightness = value;
      this.callbacks.onIntent({ type: 'brightness', value, delta: value - ctx.brightness });
    }
  }

  pointerUp(ev: { pointerId: number; clientX: number; clientY: number }): void {
    const sample = this.sample;
    this.cancelLongPress();
    if (!sample || sample.id !== ev.pointerId) return;

    sample.lastX = ev.clientX;
    sample.lastY = ev.clientY;
    const elapsed = Date.now() - sample.startTime;
    const moved = distance(sample);
    const mode = this.mode;
    const side = sample.side;
    const tapX = sample.startX;
    const tapY = sample.startY;

    this.sample = null;
    this.mode = 'none';

    if (this.longPressActive) {
      this.longPressActive = false;
      this.callbacks.onIntent({ type: 'long-press-end' });
      return;
    }

    if (mode === 'seek') {
      if (this.pendingTarget !== null) {
        this.callbacks.onIntent({ type: 'seek-commit', targetSec: this.pendingTarget });
      }
      this.pendingTarget = null;
      return;
    }

    if (mode === 'volume' || mode === 'brightness') {
      // 音量/亮度在 move 中已实时生效，松手不再派发
      this.pendingVolume = null;
      this.pendingBrightness = null;
      return;
    }

    // 未发生有效拖动：按 tap 处理
    if (moved <= GESTURE_TAP_MAX_MOVE_PX && elapsed <= GESTURE_TAP_MAX_DURATION_MS) {
      this.handleTap(side, tapX, tapY);
      return;
    }

    // 拖动方向不明确但位移很大：视为取消
    if (mode === 'undetermined') this.callbacks.onIntent({ type: 'seek-cancel' });
  }

  pointerCancel(ev: { pointerId: number }): void {
    this.cancelLongPress();
    if (!this.sample || this.sample.id !== ev.pointerId) return;
    const mode = this.mode;
    this.sample = null;
    this.mode = 'none';
    this.pendingTarget = null;
    this.pendingVolume = null;
    this.pendingBrightness = null;
    if (mode === 'seek') this.callbacks.onIntent({ type: 'seek-cancel' });
    if (this.longPressActive) {
      this.longPressActive = false;
      this.callbacks.onIntent({ type: 'long-press-end' });
    }
  }

  /**
   * G-A09：不做 id 校验地抹掉当前样本，供上层把整只手势移交给别的识别器（双指捏合）。
   *
   * 走 `pointerCancel` 而不是只清字段：在飞的倍速要收尾、在飞的 seek 要派发 cancel，
   * 否则第二指落下后倍速会一直挂着，或抬手时补一次莫名其妙的跳转。
   */
  cancelAll(): void {
    const sample = this.sample;
    if (sample === null) return;
    this.pointerCancel({ pointerId: sample.id });
  }

  /** 组件卸载时清理定时器，防止回调打到已卸载实例 */
  destroy(): void {
    this.cancelLongPress();
    // 按住不动时本层被拆掉（锁屏/错误层把 GestureLayer 整层 v-if 掉）：抬手永不再来，
    // 先交一次 long-press-end，否则临时倍速与"快进中"提示会跟着这个实例一起挂到天亮。
    if (this.longPressActive) {
      this.longPressActive = false;
      this.callbacks.onIntent({ type: 'long-press-end' });
    }
    if (this.pendingTapTimer !== null) {
      clearTimeout(this.pendingTapTimer);
      this.pendingTapTimer = null;
    }
    this.sample = null;
    this.mode = 'none';
  }

  /* ---------- 内部 ---------- */

  private handleTap(side: 'left' | 'right', x: number, y: number): void {
    const now = Date.now();
    // 双击不再限定左右半屏：暂停/播放是全局动作，左右先后点也算双击
    const isDouble = now - this.lastTapAt <= GESTURE_DOUBLE_TAP_INTERVAL_MS;

    if (isDouble) {
      this.lastTapAt = 0;
      if (this.pendingTapTimer !== null) {
        clearTimeout(this.pendingTapTimer);
        this.pendingTapTimer = null;
      }
      this.callbacks.onIntent({ type: 'double-tap', side });
      return;
    }

    this.lastTapAt = now;

    // 延迟一个双击窗口再派发单击，避免与双击冲突
    if (this.pendingTapTimer !== null) clearTimeout(this.pendingTapTimer);
    this.pendingTapTimer = setTimeout(() => {
      this.pendingTapTimer = null;
      if (this.lastTapAt === now) this.lastTapAt = 0;
      this.callbacks.onIntent({ type: 'single-tap', side, x, y });
    }, GESTURE_DOUBLE_TAP_INTERVAL_MS);
  }

  private cancelLongPress(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
    if (this.longPressHelpTimer !== null) {
      clearTimeout(this.longPressHelpTimer);
      this.longPressHelpTimer = null;
    }
  }
}

function distance(sample: PointerSample): number {
  const dx = sample.lastX - sample.startX;
  const dy = sample.lastY - sample.startY;
  return Math.hypot(dx, dy);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
