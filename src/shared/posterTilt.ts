/**
 * 海报卡 3D 倾斜的纯几何（C-08）
 *
 * 只管算位姿，不碰 DOM：指针在卡片内的归一化坐标 → transform / 投影 / 高光三件套。
 * 角度上限 12°——再大就脱离"卡片有厚度"的观感，变成一张被捏弯的纸。
 */

/** 倾斜角度上限（度） */
export const TILT_MAX_DEG = 12;
/** 透视距离（px）：写在 transform 里而不是父容器，卡片各自有自己的灭点 */
export const TILT_PERSPECTIVE = 760;
/** 倾斜时的轻微放大，让卡片"顶"出纸面 */
export const TILT_SCALE = 1.02;
/** 长按抬升：沿 Z 轴抬起与放大量 */
export const LIFT_Z = 34;
export const LIFT_SCALE = 1.045;

export interface TiltPose {
  transform: string;
  boxShadow: string;
  /**
   * 高光中心（百分比）。只写两个自定义属性，渐变本体留在 CSS 里——
   * 逐帧重新拼一条 radial-gradient 字符串既浪费，也躲不开个别 WebView
   * 对内联渐变的解析差异。
   */
  sheenX: string;
  sheenY: string;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * @param nx 指针横向位置 0~1（左→右）
 * @param ny 指针纵向位置 0~1（上→下）
 * @param maxDeg 幅度上限，控制台/降级时传小值
 */
export function tiltPose(nx: number, ny: number, maxDeg = TILT_MAX_DEG): TiltPose {
  const x = clamp01(nx);
  const y = clamp01(ny);
  const rotateY = (x - 0.5) * maxDeg * 2;
  const rotateX = (0.5 - y) * maxDeg * 2;
  return {
    transform: `perspective(${TILT_PERSPECTIVE}px) rotateX(${rotateX.toFixed(3)}deg) rotateY(${rotateY.toFixed(3)}deg) scale(${TILT_SCALE})`,
    // 光从指针那一侧打来，影子就往反方向偏
    boxShadow: `${((0.5 - x) * 26).toFixed(2)}px ${((0.5 - y) * 26 + 12).toFixed(2)}px 34px rgba(0, 0, 0, 0.6)`,
    sheenX: `${(x * 100).toFixed(1)}%`,
    sheenY: `${(y * 100).toFixed(1)}%`,
  };
}

/**
 * 长按 500ms 后的抬升位姿（不再跟随指针）。
 * 阴影与描边交给 CSS 的 `.is-lifted`，那里才能用设计令牌。
 */
export function liftPose(): TiltPose {
  return {
    transform: `perspective(${TILT_PERSPECTIVE}px) translateZ(${LIFT_Z}px) scale(${LIFT_SCALE})`,
    boxShadow: '',
    sheenX: '',
    sheenY: '',
  };
}

/** 归位：交回 CSS，`:active` 的 scale(.985) 重新接管 */
export function restPose(): TiltPose {
  return { transform: '', boxShadow: '', sheenX: '', sheenY: '' };
}
