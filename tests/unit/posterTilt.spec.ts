import { describe, expect, it } from 'vitest';

import {
  LIFT_SCALE,
  LIFT_Z,
  TILT_MAX_DEG,
  TILT_PERSPECTIVE,
  TILT_SCALE,
  liftPose,
  restPose,
  tiltPose,
} from '@/shared/posterTilt';

/**
 * 海报卡 3D 倾斜几何（C-08）
 *
 * 验收里那几条"看起来对不对"的红线，能落成数字的都在这里锁死：
 * 角度上限 12°、指针在哪个角高光就在哪个角、影子往反方向偏、越界坐标钳回卡片内。
 */
function deg(transform: string, axis: 'X' | 'Y'): number {
  const m = transform.match(new RegExp(`rotate${axis}\\((-?[\\d.]+)deg\\)`));
  return m ? Number(m[1]) : NaN;
}

function shadowX(boxShadow: string): number {
  return Number(boxShadow.split(' ')[0].replace('px', ''));
}

describe('tiltPose', () => {
  it('角度上限就是验收值 12°', () => {
    expect(TILT_MAX_DEG).toBe(12);
  });

  it('指针在正中央时不倾斜，只有轻微放大', () => {
    const pose = tiltPose(0.5, 0.5);
    expect(deg(pose.transform, 'X')).toBeCloseTo(0, 3);
    expect(deg(pose.transform, 'Y')).toBeCloseTo(0, 3);
    expect(pose.transform).toContain(`scale(${TILT_SCALE})`);
  });

  it('左上角：上沿后仰、左沿外翻；右下角正好相反', () => {
    const tl = tiltPose(0, 0);
    expect(deg(tl.transform, 'X')).toBeCloseTo(TILT_MAX_DEG, 3);
    expect(deg(tl.transform, 'Y')).toBeCloseTo(-TILT_MAX_DEG, 3);

    const br = tiltPose(1, 1);
    expect(deg(br.transform, 'X')).toBeCloseTo(-TILT_MAX_DEG, 3);
    expect(deg(br.transform, 'Y')).toBeCloseTo(TILT_MAX_DEG, 3);
  });

  it('卡片外的坐标钳回 [0,1]，不许算出超过上限的角度', () => {
    const wild = tiltPose(-2, 3);
    const edge = tiltPose(0, 1);
    expect(wild.transform).toBe(edge.transform);
    expect(Math.abs(deg(wild.transform, 'X'))).toBeLessThanOrEqual(TILT_MAX_DEG);
    expect(Math.abs(deg(wild.transform, 'Y'))).toBeLessThanOrEqual(TILT_MAX_DEG);
  });

  it('幅度上限可按降级参数收缩', () => {
    const half = tiltPose(0, 0, 6);
    expect(deg(half.transform, 'X')).toBeCloseTo(6, 3);
    expect(deg(half.transform, 'Y')).toBeCloseTo(-6, 3);
  });

  it('透视写在 transform 里：每张卡有自己的灭点，不必给父容器加 perspective', () => {
    expect(tiltPose(0.5, 0.5).transform).toContain(`perspective(${TILT_PERSPECTIVE}px)`);
  });

  it('影子偏在指针的对侧', () => {
    expect(shadowX(tiltPose(0, 0.5).boxShadow)).toBeGreaterThan(0);
    expect(shadowX(tiltPose(1, 0.5).boxShadow)).toBeLessThan(0);
  });

  it('高光中心换成百分比（渐变本体留在 CSS，JS 只写两个自定义属性）', () => {
    const pose = tiltPose(0.25, 0.75);
    expect(pose.sheenX).toBe('25.0%');
    expect(pose.sheenY).toBe('75.0%');
  });
});

describe('liftPose / restPose', () => {
  it('抬升位姿沿 Z 轴抬起并放大', () => {
    const pose = liftPose();
    expect(pose.transform).toContain(`perspective(${TILT_PERSPECTIVE}px)`);
    expect(pose.transform).toContain(`translateZ(${LIFT_Z}px)`);
    expect(pose.transform).toContain(`scale(${LIFT_SCALE})`);
  });

  it('归位是彻底清空内联样式（把 transform 交回 CSS，:active 才能继续生效）', () => {
    const pose = restPose();
    expect(pose.transform).toBe('');
    expect(pose.boxShadow).toBe('');
  });
});
