/**
 * 边缘右滑返回的手势判定（B-07 · 纯状态机，不碰 DOM）
 *
 * 输入只有坐标和时间戳，于是四条规则都能用假时钟穷举边界：
 * 起点必须落在左侧 `bandPx` 内（否则是正常横滑，不抢）、位移超过 `commitRatio`
 * 屏宽或松手速度超过阈值即返回、纵向占优立刻整段放弃（列表还在滚就别掺和）。
 *
 * 「起点在横滚容器里就一票否决」需要读 computed style，放在调用方（composable），
 * 这里只保留几何与阈值。
 */

export interface EdgeSwipeConfig {
  /** 起点落在屏幕左侧这个带宽内才算边缘手势 */
  bandPx: number;
  /** 起步死区：位移没超过它不做方向判定，手抖不算手势 */
  deadZonePx: number;
  /** 拖动距离 / 屏宽 达到即返回 */
  commitRatio: number;
  /** 松手瞬间（测速窗口内）平均速度超过它即返回，单位 px/s */
  commitVelocityPx: number;
  /** 横向需领先纵向这么多倍才认定横滑 */
  directionRatio: number;
  /** 测速窗口：只取最近这段时间的采样算速度 */
  velocityWindowMs: number;
}

export const EDGE_SWIPE_DEFAULT: EdgeSwipeConfig = {
  bandPx: 24,
  deadZonePx: 8,
  commitRatio: 0.4,
  commitVelocityPx: 800,
  directionRatio: 1.5,
  velocityWindowMs: 100,
};

/**
 * - `none`：当前没有可跟的手势（起点不在边缘带 / 已经结束）
 * - `pending`：还在死区里，方向未定
 * - `drag`：已认定边缘右滑，调用方按 `offset` 跟手
 * - `abandon`：本次手势作废（纵向滚动 / 反向拖动 / 起点在横滚容器）
 */
export type EdgeSwipeVerdict = 'none' | 'pending' | 'drag' | 'abandon';

export interface EdgeSwipeRelease {
  /** 松手前是否处于跟手状态（不是的话调用方什么都不用做） */
  dragging: boolean;
  commit: boolean;
  offset: number;
  /** 带符号：向左甩为负，永远不该触发返回 */
  velocity: number;
}

interface Sample {
  x: number;
  t: number;
}

/** 速度可信的最小采样跨度：低于一帧半就不当作快甩证据 */
const MIN_VELOCITY_SPAN_MS = 24;

export class EdgeSwipeRecognizer {
  private readonly cfg: EdgeSwipeConfig;
  private width = 1;
  private startX = 0;
  private startY = 0;
  private state: 'idle' | 'pending' | 'drag' = 'idle';
  private dx = 0;
  private samples: Sample[] = [];

  constructor(config: Partial<EdgeSwipeConfig> = {}) {
    this.cfg = { ...EDGE_SWIPE_DEFAULT, ...config };
  }

  /** 当前跟手位移，已钳在 `[0, 屏宽]`：往回拖只会停在原位，不会拖出左边界 */
  get offset(): number {
    return this.dx;
  }

  /** 起点。不在左侧带内直接返回 `none`，调用方不必再关心后续 move。 */
  begin(x: number, y: number, t: number, viewportWidth: number): EdgeSwipeVerdict {
    this.width = viewportWidth > 0 ? viewportWidth : 1;
    this.startX = x;
    this.startY = y;
    this.dx = 0;
    this.samples = [{ x, t }];
    if (x > this.cfg.bandPx) {
      this.state = 'idle';
      return 'none';
    }
    this.state = 'pending';
    return 'pending';
  }

  move(x: number, y: number, t: number): EdgeSwipeVerdict {
    if (this.state === 'idle') return 'none';
    this.track(x, t);

    const dx = x - this.startX;
    const dy = y - this.startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);

    if (this.state === 'pending') {
      // 纵向占优：这是列表滚动，整段手势交还给页面
      if (ady > this.cfg.deadZonePx && ady > adx * this.cfg.directionRatio) {
        this.state = 'idle';
        return 'abandon';
      }
      // 反向（向左）拖同样作废：返回只在右滑方向上存在
      if (dx < -this.cfg.deadZonePx) {
        this.state = 'idle';
        return 'abandon';
      }
      if (dx > this.cfg.deadZonePx && dx > ady * this.cfg.directionRatio) this.state = 'drag';
      else return 'pending';
    }

    this.dx = Math.min(Math.max(dx, 0), this.width);
    return 'drag';
  }

  /**
   * 松手。位移与速度取"或"：慢慢拖过 40% 屏宽算数，短距离快甩同样算数——
   * 后者靠最近 `velocityWindowMs` 的平均速度。
   *
   * `t` 用松手事件的时间戳：静止后再松手不该算快甩，而指针静止时浏览器不再派发
   * move，采样点会停在很久以前，只能拿最后一次采样与松手时刻的间隔来判断。
   */
  end(t: number): EdgeSwipeRelease {
    const dragging = this.state === 'drag';
    const offset = this.dx;
    const velocity = dragging ? this.velocity(t) : 0;
    this.state = 'idle';
    this.samples = [];
    if (!dragging) return { dragging: false, commit: false, offset, velocity: 0 };
    return { dragging: true, commit: offset >= this.width * this.cfg.commitRatio || velocity >= this.cfg.commitVelocityPx, offset, velocity };
  }

  private velocity(now: number): number {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return 0;
    // 松手前已静止超过一个窗口：这次释放没有"甩"的成分
    if (now - last.t > this.cfg.velocityWindowMs) return 0;
    const span = last.t - first.t;
    // 采样间隔不足一帧时速度全是噪声（脚本合成的事件就是 0ms 间隔），
    // 宁可不认这次快甩，交给位移阈值判定
    if (span < MIN_VELOCITY_SPAN_MS) return 0;
    return ((last.x - first.x) / span) * 1000;
  }

  private track(x: number, t: number): void {
    this.samples.push({ x, t });
    const cut = t - this.cfg.velocityWindowMs;
    // 至少留两个采样点，否则窗口里只剩最后一个点，速度恒为 0
    while (this.samples.length > 2 && this.samples[1].t < cut) this.samples.shift();
  }
}
