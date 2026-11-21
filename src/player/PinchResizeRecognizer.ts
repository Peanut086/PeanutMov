/**
 * 双指捏合切画幅（G-A09，纯逻辑，不接触 DOM，可在 Node 中单测）。
 *
 * 两指间距相对「第二指落下那一刻」做比例缩放，映射到一条 0~1 的画幅尺：
 * 0 = 适应（contain）、0.5 = 铺满（cover）、1 = 拉伸（fill）。张开往右走、捏合往左走。
 *
 * 尺上的起点是**当前档位**（`startMode`），不是 0。若把每次会话都归零，从「铺满」
 * 起手捏一下就会先跳到「适应」再回来——一个没人要求的换档。以当前档为锚点后：
 * 每走 0.35 的比例变化换一档，两个方向对称，端点档位只剩一个方向可走。
 *
 * 用相对比例而不是绝对像素：两指自然张开的距离随手型和屏幕尺寸变化，
 * 按绝对值定档会让一部分人刚落下手指就压在错误的档位上。
 *
 * 判定阈值刻意不对称（0.25 / 0.75 而非围绕 0.5 等分）：contain 与 cover 之间
 * 是「有没有黑边」的直觉分界，用户从默认档往右捏时应该更早看到变化。
 */
import type { ResizeMode } from '@/types';

/** 相对间距变化超过这个比例才算真的在捏合（两指单纯落住不算） */
export const PINCH_ENGAGE_RATIO = 0.05;
/** 走完整个尺度所需的比例变化；换一档是它的一半 */
export const PINCH_SPAN_RATIO = 0.7;
/** 三档在画幅尺上的停靠位 */
export const MODE_ANCHORS: Record<ResizeMode, number> = {
  contain: 0,
  cover: 0.5,
  fill: 1,
};

export function modeForPosition(pos: number): ResizeMode {
  if (pos < 0.25) return 'contain';
  if (pos < 0.75) return 'cover';
  return 'fill';
}

export interface PinchCallbacks {
  /** 越过触发阈值后的逐次采样：`pos` 为画幅尺位置，`mode` 为当前吸附到的档位 */
  onSample: (pos: number, mode: ResizeMode) => void;
  /**
   * 会话结束。
   * `mode` 为 null 表示从未越过阈值或手势被系统打断 —— 调用方要把画面还原到手势开始前的档位。
   * `reason`：`up` = 正常抬手（可吸附并落盘），`cancel` = 中断（只还原，不落盘）。
   */
  onEnd: (mode: ResizeMode | null, pos: number, reason: 'up' | 'cancel') => void;
}

interface Finger {
  x: number;
  y: number;
}

export class PinchResizeRecognizer {
  private readonly fingers = new Map<number, Finger>();
  private session = false;
  private engaged = false;
  /** 判定为捏合时的两指间距；用它做基准，之后的间距都折算成比例 */
  private base = 0;
  /** 会话起手时所在档位对应的尺位 */
  private anchor = 0;
  private pos = 0;

  /**
   * @param startMode 会话起手时的画幅档位，由调用方在每次落指时现取
   *                  （手势进行中它会变，但锚点不变，否则尺会跟着档位抖动）
   */
  constructor(
    private readonly callbacks: PinchCallbacks,
    private readonly startMode: () => ResizeMode = () => 'contain',
  ) {}

  /** 双指会话是否进行中（会话期间单指手势必须静默） */
  get inSession(): boolean {
    return this.session;
  }

  /** @returns true = 本事件属于捏合会话，调用方不要再把它交给单指识别器 */
  pointerDown(id: number, x: number, y: number): boolean {
    this.fingers.set(id, { x, y });
    if (this.fingers.size === 2) {
      this.session = true;
      this.engaged = false;
      this.base = this.distance();
      this.pos = this.anchor = MODE_ANCHORS[this.startMode()];
    }
    return this.session;
  }

  pointerMove(id: number, x: number, y: number): boolean {
    if (!this.session) return false;
    const finger = this.fingers.get(id);
    if (finger) {
      finger.x = x;
      finger.y = y;
    }
    if (this.fingers.size < 2) return true;
    const dist = this.distance();
    if (dist <= 0 || this.base <= 0) return true;
    const ratio = dist / this.base;
    if (!this.engaged) {
      if (Math.abs(ratio - 1) < PINCH_ENGAGE_RATIO) return true;
      this.engaged = true;
    }
    this.pos = clamp(this.anchor + (ratio - 1) / PINCH_SPAN_RATIO, 0, 1);
    this.callbacks.onSample(this.pos, modeForPosition(this.pos));
    return true;
  }

  pointerUp(id: number): boolean {
    return this.release(id, 'up');
  }

  pointerCancel(id: number): boolean {
    return this.release(id, 'cancel');
  }

  /** 组件卸载/页面切走：静默清场，不派发任何回调 */
  reset(): void {
    this.fingers.clear();
    this.session = false;
    this.engaged = false;
    this.base = 0;
    this.pos = 0;
    this.anchor = 0;
  }

  private release(id: number, reason: 'up' | 'cancel'): boolean {
    if (!this.session) return false;
    this.fingers.delete(id);
    if (this.fingers.size >= 2) {
      // 还有两指在场：以当前间距重新定基准，并保持画幅尺位置不变，避免抬手瞬间跳档
      this.reanchor();
      return true;
    }
    const mode = this.engaged && reason === 'up' ? modeForPosition(this.pos) : null;
    this.callbacks.onEnd(mode, this.pos, reason);
    this.reset();
    return true;
  }

  private reanchor(): void {
    const dist = this.distance();
    if (dist <= 0) return;
    this.base = dist / (1 + (this.pos - this.anchor) * PINCH_SPAN_RATIO);
  }

  /** 取会话中最早落下的两指 —— 第三指只用于扩大会话，不参与几何计算 */
  private distance(): number {
    const it = this.fingers.values();
    const a = it.next().value as Finger | undefined;
    const b = it.next().value as Finger | undefined;
    if (!a || !b) return 0;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
