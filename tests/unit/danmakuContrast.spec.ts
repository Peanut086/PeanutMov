import { describe, expect, it } from 'vitest';

import {
  LUMA_CELLS,
  LUMA_COLS,
  LUMA_ROWS,
  averageLuma,
  contrastOf,
  hexOf,
  legacyPaint,
  relativeLuma,
  resolvePaint,
  rgbOf,
  type LumaField,
} from '@/player/danmakuContrast';
import { containBox, fitCells } from '@/player/frameLuma';

/** 造一张整片均匀亮度的亮度场 */
function flatField(value: number): LumaField {
  const cells = new Uint8Array(LUMA_CELLS);
  cells.fill(value);
  return { cells, at: 1 };
}

const RECT = { left: 100, top: 100, width: 240, height: 24 };
const CANVAS = { w: 1280, h: 720 };

describe('亮度与对比度口径', () => {
  it('纯黑=0、纯白=1，中间灰按 sRGB 传递函数而非线性', () => {
    expect(relativeLuma([0, 0, 0])).toBeCloseTo(0, 6);
    expect(relativeLuma([255, 255, 255])).toBeCloseTo(1, 6);
    // 128 的相对亮度约 0.216：如果按 gamma 域均值算会得到 0.502，中间调会被判得过亮
    expect(relativeLuma([128, 128, 128])).toBeCloseTo(0.2159, 3);
  });

  it('对比度对称且黑白互配为 21:1', () => {
    expect(contrastOf(1, 0)).toBeCloseTo(21, 5);
    expect(contrastOf(0, 1)).toBeCloseTo(21, 5);
    expect(contrastOf(0.5, 0.5)).toBeCloseTo(1, 5);
  });
});

describe('resolvePaint：只在原色看不清时接管', () => {
  it('取不到帧 → null（渲染层退回旧行为）', () => {
    expect(resolvePaint(0xffffff, null, false)).toBeNull();
  });

  it('暗背景上的白字：保持原色，描边走深色', () => {
    const paint = resolvePaint(0xffffff, 0.05, false)!;
    expect(paint.fill).toBe('#ffffff');
    expect(paint.adapted).toBe(false);
    expect(paint.shadow).toBe('rgba(0,0,0,0.7)');
  });

  it('雪景上的白字：改成能看清的深色，描边换成亮边', () => {
    const paint = resolvePaint(0xffffff, 0.85, false)!;
    expect(paint.adapted).toBe(true);
    expect(relativeLuma(rgbOf(parseInt(paint.fill.slice(1), 16)))).toBeLessThan(0.2);
    expect(paint.stroke).toBe('rgba(255,255,255,0.85)');
    // 接管后必须真的能看清
    const bg = 0.85;
    const luma = relativeLuma(rgbOf(parseInt(paint.fill.slice(1), 16)));
    expect(contrastOf(luma, bg)).toBeGreaterThanOrEqual(3.4);
  });

  it('亮底上的黄字保留色相（不退化成纯黑）', () => {
    const paint = resolvePaint(0xffd400, 0.8, false)!;
    const [r, g, b] = rgbOf(parseInt(paint.fill.slice(1), 16));
    expect(paint.adapted).toBe(true);
    // 橄榄金：仍然是黄橙系（R>G>B），而不是灰/黑/白
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(Math.max(r, g, b)).toBeGreaterThan(0);
  });

  it('浅灰底（相对亮度 0.45）上的白字也要压暗：不能因"没过半亮"就不动', () => {
    const paint = resolvePaint(0xffffff, 0.45, false)!;
    expect(paint.adapted).toBe(true);
    expect(paint.fill).toBe('#000000');
    expect(contrastOf(0, 0.45)).toBeGreaterThanOrEqual(3.4);
  });

  it('迟滞：对比度落在 2.6~3.4 之间时，未接管不动、已接管不撤', () => {
    // 白字对 0.28 的背景：1.05/0.33 ≈ 3.18，正好落在迟滞带里
    const bg = 0.28;
    const fresh = resolvePaint(0xffffff, bg, false)!;
    expect(fresh.adapted).toBe(false);
    expect(fresh.fill).toBe('#ffffff');
    // 已经接管过就不因"回到 3.18"交还原色：这就是不抖的关键
    const held = resolvePaint(0xffffff, bg, true)!;
    expect(held.adapted).toBe(true);
    expect(held.fill).toBe('#000000');
    // 回到 3.4 以上才交还原色
    const released = resolvePaint(0xffffff, 0.2, true)!;
    expect(released.adapted).toBe(false);
    expect(released.fill).toBe('#ffffff');
  });

  it('接管态稳定：同一背景重复判定得到同一个 key（位图不重建）', () => {
    const first = resolvePaint(0xffffff, 0.9, false)!;
    const second = resolvePaint(0xffffff, 0.9, first.adapted)!;
    expect(second.key).toBe(first.key);
  });

  it('非法颜色按白处理，不抛异常', () => {
    expect(resolvePaint(Number.NaN, 0.9, false)!.fill).not.toBe('');
    expect(hexOf([0x12, 0x34, 0x56])).toBe('#123456');
  });
});

describe('averageLuma：弹幕矩形落在哪就取哪', () => {
  it('完全出屏（还没滚进来）返回 null，由调用方保持上一次的判定', () => {
    const field = flatField(255);
    expect(averageLuma(field, { left: CANVAS.w, top: 100, width: 200, height: 24 }, CANVAS.w, CANVAS.h)).toBeNull();
    expect(averageLuma(field, { left: -300, top: 100, width: 200, height: 24 }, CANVAS.w, CANVAS.h)).toBeNull();
    expect(averageLuma(null, RECT, CANVAS.w, CANVAS.h)).toBeNull();
  });

  it('均匀场取回该亮度；局部亮块只在压到它时改变均值', () => {
    const dark = flatField(0);
    expect(averageLuma(dark, RECT, CANVAS.w, CANVAS.h)).toBeCloseTo(0, 6);
    const mixed = flatField(0);
    // 右上角刷亮：压在右上与压在左下的矩形结果不同
    for (let i = 0; i < LUMA_COLS; i += 1) mixed.cells[i] = 255;
    const top = averageLuma(mixed, { left: 100, top: 0, width: 240, height: 20 }, CANVAS.w, CANVAS.h)!;
    const bottom = averageLuma(mixed, { left: 100, top: 400, width: 240, height: 20 }, CANVAS.w, CANVAS.h)!;
    expect(top).toBeGreaterThan(bottom);
    expect(bottom).toBeCloseTo(0, 6);
  });
});

describe('信箱黑边与内容区映射', () => {
  it('containBox：横屏视频落在竖画布中间，上下留黑', () => {
    const box = containBox(1080, 1920, 1920, 1080);
    expect(box.width).toBeCloseTo(1, 6);
    expect(box.height).toBeCloseTo((1080 / 1920) * (1080 / 1920), 3);
    expect(box.top).toBeCloseTo((1 - box.height) / 2, 6);
    // 拿不到视频尺寸 = 铺满（宁可当没有黑边，也不把画面判成一半黑）
    expect(containBox(1080, 1920, 0, 0)).toEqual({ left: 0, top: 0, width: 1, height: 1 });
  });

  it('fitCells：box 外填 0，box 内取内容格（黑边判成暗背景=保持原色）', () => {
    const src = new Uint8Array(LUMA_CELLS).fill(200);
    const out = fitCells(src, { left: 0, top: 0.3, width: 1, height: 0.4 });
    const rowIn = 9;
    const rowOut = 1;
    for (let c = 0; c < LUMA_COLS; c += 1) {
      expect(out[rowIn * LUMA_COLS + c]).toBe(200);
      expect(out[rowOut * LUMA_COLS + c]).toBe(0);
    }
    expect(out.length).toBe(LUMA_CELLS);
  });

  it('fitCells 收得住越界的 box，不越读源数组', () => {
    const src = new Uint8Array(LUMA_CELLS).fill(120);
    const out = fitCells(src, { left: -0.2, top: 0, width: 1.6, height: 1.4 }, new Uint8Array(LUMA_CELLS));
    let nonZero = 0;
    for (const v of out) if (v > 0) nonZero += 1;
    expect(nonZero).toBe(LUMA_COLS * LUMA_ROWS);
    expect(out[LUMA_CELLS - 1]).toBe(120);
    expect(out[0]).toBe(120);
  });

  it('整片刷亮的画面：任意一条弹幕都判成亮背景', () => {
    const field = flatField(255);
    const bg = averageLuma(field, RECT, CANVAS.w, CANVAS.h)!;
    expect(bg).toBeCloseTo(1, 6);
    expect(resolvePaint(0xffffff, bg, false)!.adapted).toBe(true);
  });
});

describe('legacyPaint：关掉功能时的旧行为', () => {
  it('原色 + 深色描边，key 恒定（切换时只重建一次位图）', () => {
    const paint = legacyPaint(0x00ff00);
    expect(paint.fill).toBe('#00ff00');
    expect(paint.stroke).toBe('rgba(0,0,0,0.8)');
    expect(paint.adapted).toBe(false);
    expect(paint.key).toBe('legacy');
    expect(legacyPaint(0xff0000).key).toBe(paint.key);
  });
});
