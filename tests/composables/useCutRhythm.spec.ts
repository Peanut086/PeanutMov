/**
 * 镜头节奏带的记账层单测（G-C05）
 *
 * 这里钉的是两条"看不见但会静默说谎"的口径：
 * 1. 上一帧必须存**副本**——`frameLuma` 两条取样路都复用同一块 `Uint8Array`，
 *    留住引用就是拿这张图跟自己比，差值恒为 0，整条带安静地变成一条平地；
 * 2. 渲染层只允许在跨格时收到新对象——3Hz 在同一格里连记 30 次，
 *    每次都惊动 computed 就是给播放器挂一个无意义的重渲染循环。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { useCutRhythm } from '@/composables/useCutRhythm';
import { LUMA_CELLS } from '@/player/danmakuContrast';
import { RHYTHM_BINS, RHYTHM_MIN_COVERED_BINS, RHYTHM_MIN_SAMPLES } from '@/player/cutRhythm';

const DURATION = 600;
const BIN_SEC = DURATION / RHYTHM_BINS;

/** 与 `frameLuma` 同一条复用缓冲：整个测试期间只有这一个数组在被就地改写 */
function reuseBuffer() {
  const cells = new Uint8Array(LUMA_CELLS);
  const field = { cells, at: 0 };
  return {
    field,
    /** level 与 level+20 交替喂进去，差值就是可预期的非 0 */
    fill(level: number): void {
      cells.fill(level);
    },
  };
}

function binCenter(bin: number): number {
  return bin * BIN_SEC + BIN_SEC / 2;
}

/** 把 `bins` 这几格各记满最小样本数 */
function fillBins(rhythm: ReturnType<typeof useCutRhythm>, buf: ReturnType<typeof reuseBuffer>, bins: number[]): void {
  for (const bin of bins) {
    for (let i = 0; i < RHYTHM_MIN_SAMPLES; i += 1) {
      buf.fill(i % 2 === 0 ? 120 : 140);
      rhythm.sample(buf.field, binCenter(bin), DURATION);
    }
  }
}

let buf: ReturnType<typeof reuseBuffer>;

beforeEach(() => {
  buf = reuseBuffer();
});

describe('useCutRhythm · 什么时候才值得铺一条带', () => {
  it('样本还不够铺满 10 格之前不给任何图形（半空的状态像画坏了）', () => {
    const rhythm = useCutRhythm();
    fillBins(rhythm, buf, Array.from({ length: RHYTHM_MIN_COVERED_BINS - 1 }, (_, i) => i));
    expect(rhythm.band.value).toBeNull();

    fillBins(rhythm, buf, [RHYTHM_MIN_COVERED_BINS - 1]);
    expect(rhythm.band.value).not.toBeNull();
    expect(rhythm.band.value?.values).toHaveLength(RHYTHM_BINS);
  });

  it('时长还没报出来时一概不记账（直播/加载中不能全挤在第 0 格）', () => {
    const rhythm = useCutRhythm();
    for (let i = 0; i < 40; i += 1) {
      buf.fill(i % 2 === 0 ? 120 : 140);
      rhythm.sample(buf.field, i * 3, 0);
    }
    expect(rhythm.band.value).toBeNull();
  });

  it('黑场一路到底也不铺带：淡入淡出不算换镜', () => {
    const rhythm = useCutRhythm();
    for (let bin = 0; bin < RHYTHM_BINS; bin += 1) {
      for (let i = 0; i < RHYTHM_MIN_SAMPLES; i += 1) {
        buf.fill(0);
        rhythm.sample(buf.field, binCenter(bin), DURATION);
      }
    }
    expect(rhythm.band.value).toBeNull();
  });
});

describe('useCutRhythm · 数据口径', () => {
  it('留副本而不是留引用：复用缓冲照样量得出画面在跳', () => {
    const rhythm = useCutRhythm();
    const bins = Array.from({ length: RHYTHM_MIN_COVERED_BINS }, (_, i) => i);
    fillBins(rhythm, buf, bins);
    const values = rhythm.band.value?.values ?? [];
    // 若把 field.cells 直接存下来，prev === next，每一格都会是 0，这条带就是一张平地
    for (const bin of bins) expect(values[bin]).toBeGreaterThan(0);
    // 全片第一样只是建立基线（记 0），所以第 0 格比其他格少 1/4 的响度——
    // 这个差额本身就是"首帧不算换镜"的口径证据
    expect(values[0]).toBeCloseTo(0.75, 5);
    expect(values[1]).toBeCloseTo(1, 5);
  });

  it('换集清空：留着上一集的格子给这一集画曲线就是假图', () => {
    const rhythm = useCutRhythm();
    fillBins(rhythm, buf, Array.from({ length: RHYTHM_MIN_COVERED_BINS }, (_, i) => i));
    expect(rhythm.band.value).not.toBeNull();
    rhythm.reset();
    expect(rhythm.band.value).toBeNull();
  });
});

describe('useCutRhythm · 什么时候才惊动渲染层', () => {
  /**
   * 用对象身份判断"重算没有"：computed 只在版本号变了才失效，
   * 没失效时读到的是同一个缓存对象——同一格里连记几次都不该换新。
   */
  it('同一格里的后续样本不产生新对象', () => {
    const rhythm = useCutRhythm();
    const bins = Array.from({ length: RHYTHM_MIN_COVERED_BINS }, (_, i) => i);
    fillBins(rhythm, buf, bins);
    const filled = rhythm.band.value;
    expect(filled).not.toBeNull();

    // 上一次记账落在第 9 格，第 0 格是"跨格"：这一次必须换新
    buf.fill(100);
    rhythm.sample(buf.field, binCenter(0), DURATION);
    const crossed = rhythm.band.value;
    expect(crossed).not.toBe(filled);

    // 之后三样还在第 0 格里：账照记，但不再惊动渲染层
    for (let i = 0; i < 3; i += 1) {
      buf.fill(i % 2 === 0 ? 190 : 100);
      rhythm.sample(buf.field, binCenter(0), DURATION);
    }
    expect(rhythm.band.value).toBe(crossed);
  });

  it('跨到新格才让渲染层重算一次', () => {
    const rhythm = useCutRhythm();
    const bins = Array.from({ length: RHYTHM_MIN_COVERED_BINS }, (_, i) => i);
    fillBins(rhythm, buf, bins);
    const before = rhythm.band.value;
    expect(before).not.toBeNull();

    buf.fill(200);
    rhythm.sample(buf.field, binCenter(RHYTHM_BINS - 1), DURATION);
    expect(rhythm.band.value).not.toBe(before);
  });
});
