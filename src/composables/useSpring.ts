/**
 * 弹簧物理原语（A 批次·A-02）
 *
 * 半隐式欧拉积分，逐帧推进：`a = -k·(x - target) - c·v`。相比固定时长的 CSS 缓动，
 * 它能把**释放瞬间的手指速度**接过去——慢放慢慢贴、快甩先顺着走一点再收回，
 * 跟手和回弹之间不再出现"断开"。
 *
 * 只负责物理，不负责语义：阈值判定、档位选择、reduced-motion 由调用方决定。
 *
 * 曲线没有做成 CSS token：过冲要越过终点，而 Sheet / 下拉回弹的终点都贴着屏幕边缘，
 * 越过去就是撕开一条缝；纯过渡拿不到释放速度，也就失去了用弹簧的主要理由。
 */

export interface SpringConfig {
  /** 刚度 k：越大越"硬"，收敛越快，过冲越小 */
  stiffness: number;
  /** 阻尼 c：越大过冲越小；ζ = c / (2√k) */
  damping: number;
}

/**
 * 默认档：ζ ≈ 0.67 → 过冲约 6%（低于 8% 的手感红线），约 350ms 内收敛。
 * 阻尼比再低就会明显果冻，再高就退化成普通减速。
 */
export const SPRING_DEFAULT: SpringConfig = { stiffness: 380, damping: 26 };

/** 掉帧时钳制单帧步长：低端机一帧 100ms 也不至于把积分推爆 */
const MAX_FRAME_MS = 32;
/** 每帧子步长数：一次算完 32ms 会产生肉眼可见的相位误差 */
const SUBSTEPS = 4;
/** 兜底停机时间：参数被配到不发散但也不收敛的角落时，到点直接吸附 */
const MAX_SPRING_MS = 1200;

export interface SpringAnimation {
  /** 起始值（单位由调用方决定，通常是 px） */
  from: number;
  target: number;
  /** 继承的初速度，单位/秒，符号与 from→target 同轴 */
  velocity?: number;
  config?: SpringConfig;
  /** 值域约束；弹簧撞到停靠位时按硬停处理（不反向弹过去） */
  clamp?: (value: number) => number;
  onFrame: (value: number) => void;
  onSettle: () => void;
}

/**
 * 系统「减少动态效果」。在释放那一刻现读，不做常驻监听：
 * 弹簧遇到它必须退化成瞬时吸附，而不是"更慢一点的弹簧"。
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** 启动一次弹簧动画，返回停止函数（中途被打断时调用，不会触发 onSettle） */
export function animateSpring(anim: SpringAnimation): () => void {
  const { from, target, onFrame, onSettle } = anim;
  const clamp = anim.clamp ?? ((v) => v);
  const stiffness = anim.config?.stiffness ?? SPRING_DEFAULT.stiffness;
  const damping = anim.config?.damping ?? SPRING_DEFAULT.damping;
  // 收敛判据按行程缩放：拖 3px 和拖 300px 不该用同一把尺子
  const span = Math.abs(target - from);
  const eps = Math.max(0.4, span * 0.004);
  const velocityEps = eps * 10;

  if (typeof requestAnimationFrame !== 'function') {
    onFrame(target);
    onSettle();
    return () => undefined;
  }

  let x = clamp(from);
  let v = anim.velocity ?? 0;
  let elapsed = 0;
  let last = 0;
  let raf = 0;
  let done = false;
  onFrame(x);

  const step = (now: number): void => {
    const dt = last === 0 ? MAX_FRAME_MS : Math.min(now - last, MAX_FRAME_MS);
    last = now;
    elapsed += dt;

    const h = dt / 1000 / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      v += (-stiffness * (x - target) - damping * v) * h;
      x += v * h;
    }
    const next = clamp(x);
    onFrame(next);

    // 撞上停靠位（值域约束生效且仍在往里推）= 硬停，不假装弹回来
    const hittingStop = next === target && (from > target ? v < 0 : v > 0);
    if (hittingStop || (Math.abs(next - target) < eps && Math.abs(v) < velocityEps) || elapsed > MAX_SPRING_MS) {
      done = true;
      onFrame(target);
      onSettle();
      return;
    }
    raf = requestAnimationFrame(step);
  };

  raf = requestAnimationFrame(step);
  return () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
  };
}
