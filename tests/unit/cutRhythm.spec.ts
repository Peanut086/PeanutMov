/**
 * 镜头节奏算法单测（G-C05）
 *
 * 这一层决定进度条上那 60 根柱子说什么，所以钉三件事：
 * 1. 空帧不参与记账——黑场淡入淡出不是换镜，否则片头会在带上长成一座假山峰；
 * 2. 「没看过」与「很平」必须是两种输出（NaN 与 0），UI 才能分别画斜纹和矮柱；
 * 3. 相对归一一定会把最响那格顶满，所以换镜点还需要一道绝对闸门，
 *    否则整集都很平时每一格都是"峰值"。
 */
import { describe, expect, it } from 'vitest';

import { LUMA_CELLS } from '@/player/danmakuContrast';
import {
  CUT_FULL_DIFF,
  MIN_CUT_RAW,
  PEAK_AT,
  RHYTHM_BINS,
  RHYTHM_MIN_SAMPLES,
  accumulateRhythm,
  createRhythmBins,
  fieldActivity,
  resetRhythmBins,
  rhythmBinCenterSec,
  rhythmBinOf,
  rhythmCoveredBins,
  rhythmPeaks,
  rhythmValues,
  type RhythmBins,
} from '@/player/cutRhythm';

/** 整幅同一亮度的帧（亮度场是 32×18 的均值，均匀场足够表达"平"与"切"） */
function flat(level: number): Uint8Array {
  return new Uint8Array(LUMA_CELLS).fill(level);
}

function binsFilled(perBin: number[], activity: number): RhythmBins {
  const bins = createRhythmBins();
  for (const bin of perBin) {
    for (let i = 0; i < RHYTHM_MIN_SAMPLES; i += 1) accumulateRhythm(bins, bin, activity);
  }
  return bins;
}

describe('fieldActivity · 相邻帧的换镜强度', () => {
  it('首帧只建立基线：记 0，不当成"画面很平"的证据', () => {
    expect(fieldActivity(null, flat(120))).toBe(0);
  });

  it('一模一样的两帧是 0，整幅大跳封顶 1', () => {
    expect(fieldActivity(flat(120), flat(120))).toBe(0);
    // 平均差 = CUT_FULL_DIFF 的两倍 → 归一后本该 2，钳在 1
    expect(fieldActivity(flat(20), flat(20 + CUT_FULL_DIFF * 2))).toBe(1);
  });

  it('平均差折到 0~1：一档跳变就是 CUT_FULL_DIFF 的占比', () => {
    // 亮度场是 Uint8Array，20+12 落到 32（小数被截），平均差 12 → 12/25
    expect(fieldActivity(flat(20), flat(20 + 12))).toBeCloseTo(12 / CUT_FULL_DIFF, 5);
    expect(fieldActivity(flat(20), flat(20 + 12))).toBeCloseTo(0.48, 5);
  });

  it('空帧（近乎全黑）不给出数值：淡入淡出不能被记成一次换镜', () => {
    expect(fieldActivity(flat(120), flat(0))).toBeNaN();
    // 从黑场里出来的那一样也一样不算：两边只要有一边是空帧就作废
    expect(fieldActivity(flat(0), flat(120))).toBeNaN();
  });

  it('网格长度不对（拿错缓冲）也作废，不算 0 也不算大差', () => {
    const short = new Uint8Array(LUMA_CELLS - 8).fill(10);
    expect(fieldActivity(short, flat(10))).toBeNaN();
    expect(fieldActivity(null, short)).toBeNaN();
  });
});

describe('rhythmBinOf · 位置到格号', () => {
  it('时长未知的每一帧都不记账（-1），而不是全挤在第 0 格', () => {
    expect(rhythmBinOf(12, 0)).toBe(-1);
    expect(rhythmBinOf(12, Number.NaN)).toBe(-1);
    expect(rhythmBinOf(-1, 600)).toBe(-1);
  });

  it('首尾都收在带内：0 → 第 0 格，正好播完 → 最后一格', () => {
    expect(rhythmBinOf(0, 600)).toBe(0);
    expect(rhythmBinOf(600, 600)).toBe(RHYTHM_BINS - 1);
    expect(rhythmBinOf(300, 600)).toBe(RHYTHM_BINS / 2);
  });

  it('格宽 = 时长 / 格数', () => {
    // 600s / 60 格 = 10s 一格：9.9s 还在第 0 格，10s 起进第 1 格
    expect(rhythmBinOf(9.9, 600)).toBe(0);
    expect(rhythmBinOf(10, 600)).toBe(1);
    expect(rhythmBinCenterSec(1, 600)).toBe(15);
  });
});

describe('rhythmValues · 有数据与没数据是两回事', () => {
  it('样本不足 MIN_SAMPLES 的格是 NaN（斜纹），不是 0（矮柱）', () => {
    const bins = createRhythmBins();
    for (let i = 0; i < RHYTHM_MIN_SAMPLES - 1; i += 1) accumulateRhythm(bins, 3, 0.5);
    const values = rhythmValues(bins);
    expect(values).toHaveLength(RHYTHM_BINS);
    expect(values[3]).toBeNaN();
    expect(rhythmCoveredBins(values)).toBe(0);
  });

  it('凑够样本的格给出高度，其余仍是 NaN', () => {
    const values = rhythmValues(binsFilled([7], 0.5));
    expect(rhythmCoveredBins(values)).toBe(1);
    // 自己是全片最响的一格 → 相对归一后铺满
    expect(values[7]).toBeCloseTo(1, 5);
    expect(values[0]).toBeNaN();
  });

  it('整集都很平时不会顶满：分母有噪声下限，不然一根针也放大成满格', () => {
    const values = rhythmValues(binsFilled([0, 1, 2], 0.02));
    for (const bin of [0, 1, 2]) {
      expect(values[bin]).toBeLessThan(PEAK_AT);
      expect(values[bin]).toBeGreaterThan(0);
    }
  });

  it('累加只做均值，不做峰值：同格内一次大跳被平稳样本摊薄', () => {
    const bins = createRhythmBins();
    accumulateRhythm(bins, 5, 1);
    for (let i = 0; i < RHYTHM_MIN_SAMPLES - 1; i += 1) accumulateRhythm(bins, 5, 0);
    // 5 号格均值 0.25；6 号格持续 0.5 是全片最响，归一后铺满，5 号格因此只有它一半高
    fill(bins, 6, 0.5);
    const values = rhythmValues(bins);
    expect(values[5] / values[6]).toBeCloseTo(0.5, 5);
    expect(values[6]).toBeCloseTo(1, 5);
  });

  it('NaN 活动量（空帧）根本进不了账本：格子里既不加和也不计数', () => {
    const bins = createRhythmBins();
    accumulateRhythm(bins, 0, Number.NaN);
    accumulateRhythm(bins, -1, 0.5);
    accumulateRhythm(bins, RHYTHM_BINS, 0.5);
    expect(bins.counts[0]).toBe(0);
    expect(rhythmCoveredBins(rhythmValues(bins))).toBe(0);
  });

  it('reset 清空整条带（换集必须从空带开始）', () => {
    const bins = binsFilled([0, 1], 0.5);
    resetRhythmBins(bins);
    expect(rhythmCoveredBins(rhythmValues(bins))).toBe(0);
    expect(bins.sums.every((s) => s === 0)).toBe(true);
  });
});

describe('rhythmPeaks · 只标真值得跳的那几格', () => {
  it('响且相隔足够的格都标出来（升序）', () => {
    const bins = binsFilled([0, 8, 30], 0.5);
    const values = rhythmValues(bins);
    for (const bin of [0, 8, 30]) expect(values[bin]).toBeGreaterThanOrEqual(PEAK_AT);
    expect(rhythmPeaks(values, bins)).toEqual([0, 8, 30]);
  });

  it('相邻不足最小间距只留更响的那个：同一片打戏不该标两遍', () => {
    const bins = createRhythmBins();
    fill(bins, 10, 0.6);
    fill(bins, 11, 0.45);
    const values = rhythmValues(bins);
    // 10 号格是全片最响（归一到 1），11 号格 0.75 也过线，但只差 1 格
    expect(values[11]).toBeGreaterThanOrEqual(PEAK_AT);
    expect(rhythmPeaks(values, bins)).toEqual([10]);
  });

  it('整集都很平时一个都不标：相对归一的满分不算换镜点', () => {
    // 每格 0.10 的噪声（低于 MIN_CUT_RAW），偶发一格 0.14 被归一顶到线上
    const bins = createRhythmBins();
    for (let i = 0; i < RHYTHM_BINS; i += 1) fill(bins, i, 0.1);
    fill(bins, 20, 0.14);
    const values = rhythmValues(bins);
    // 分母取噪声下限 0.18，所以 0.14 那格是 0.78 —— 仍然越过了 PEAK 线
    expect(values[20]).toBeGreaterThan(PEAK_AT);
    // 这一句是这道闸门的唯一理由：0.14 < MIN_CUT_RAW
    expect(0.14).toBeLessThan(MIN_CUT_RAW);
    expect(rhythmPeaks(values, bins)).toEqual([]);
  });

  it('样本不足的格即使高度满格也不算（NaN 高度已被挡掉）', () => {
    const bins = createRhythmBins();
    fill(bins, 12, 0.9, RHYTHM_MIN_SAMPLES - 1);
    const values = rhythmValues(bins);
    expect(values[12]).toBeNaN();
    expect(rhythmPeaks(values, bins)).toEqual([]);
  });
});

function fill(bins: RhythmBins, bin: number, activity: number, count = RHYTHM_MIN_SAMPLES): void {
  for (let i = 0; i < count; i += 1) accumulateRhythm(bins, bin, activity);
}
