/**
 * 画面氛围光的取样与绘制（C-09 · 纯函数层）
 *
 * 三件必须钉死的事：
 * 1. 取样只有 32×18，且每边只看最外一圈——这是真机帧率红线的来源；
 * 2. 黑边 / 无彩画面返回 null，不发光（否则整屏被灰雾糊住）；
 * 3. 像素读不回来（跨域污染）时返回 null 而不是抛错——氛围光是锦上添花，不能黑屏。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AMBILIGHT_SAMPLE_H,
  AMBILIGHT_SAMPLE_W,
  averageEdge,
  glowCanvasSize,
  paintAmbilight,
  sampleEdges,
  type AmbilightEdges,
  type AmbilightEdge,
  type Rgb,
} from '@/player/AmbilightSampler';

const W = AMBILIGHT_SAMPLE_W;
const H = AMBILIGHT_SAMPLE_H;

function blankFrame(): Uint8ClampedArray {
  return new Uint8ClampedArray(W * H * 4);
}

function put(px: Uint8ClampedArray, index: number, [r, g, b]: Rgb): void {
  px[index] = r;
  px[index + 1] = g;
  px[index + 2] = b;
  px[index + 3] = 255;
}

function paintRow(px: Uint8ClampedArray, y: number, color: Rgb): void {
  for (let x = 0; x < W; x++) put(px, (y * W + x) * 4, color);
}

function paintCol(px: Uint8ClampedArray, x: number, color: Rgb): void {
  for (let y = 0; y < H; y++) put(px, (y * W + x) * 4, color);
}

/** 四边各涂一种颜色，中间保持黑（模拟竖屏播放时上下有黑边的画面） */
function ringFrame(): Uint8ClampedArray {
  const px = blankFrame();
  paintRow(px, 0, [200, 40, 40]);
  paintRow(px, H - 1, [40, 60, 220]);
  paintCol(px, 0, [60, 200, 80]);
  paintCol(px, W - 1, [230, 200, 40]);
  return px;
}

/** 只涂一条边（角像素归该边）：这样均色可以被精确断言 */
function singleEdge(edge: AmbilightEdge, color: Rgb): Uint8ClampedArray {
  const px = blankFrame();
  if (edge === 'top') paintRow(px, 0, color);
  else if (edge === 'bottom') paintRow(px, H - 1, color);
  else if (edge === 'left') paintCol(px, 0, color);
  else paintCol(px, W - 1, color);
  return px;
}

interface GradientStub {
  stops: string[];
  addColorStop: (offset: number, color: string) => void;
}

interface FakeCtx {
  clearRects: number;
  fillRects: Array<{ x: number; y: number; w: number; h: number; gradient: GradientStub }>;
  drawImage: ReturnType<typeof vi.fn>;
  getImageData: ReturnType<typeof vi.fn>;
  createLinearGradient: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

function makeCtx(frame: Uint8ClampedArray): FakeCtx {
  const ctx: FakeCtx = {
    clearRects: 0,
    fillRects: [],
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: frame })),
    createLinearGradient: vi.fn(),
  };
  ctx.createLinearGradient.mockImplementation(() => {
    const gradient: GradientStub = {
      stops: [],
      addColorStop(_offset: number, color: string) {
        this.stops.push(color);
      },
    };
    return gradient;
  });
  ctx.clearRect = vi.fn(() => {
    ctx.clearRects += 1;
  });
  ctx.fillRect = vi.fn((x: number, y: number, w: number, h: number) => {
    ctx.fillRects.push({ x, y, w, h, gradient: (ctx as unknown as { fillStyle: GradientStub }).fillStyle });
  });
  ctx.save = vi.fn();
  ctx.restore = vi.fn();
  ctx.fillStyle = null;
  return ctx;
}

describe('averageEdge 四边均色', () => {
  it('只统计最外一圈：内部像素不参与', () => {
    const px = singleEdge('top', [200, 40, 40]);
    paintRow(px, 5, [0, 0, 255]);
    expect(averageEdge(px, W, H, 'top')).toEqual([200, 40, 40]);
  });

  it.each([
    ['top', [200, 40, 40]],
    ['bottom', [40, 60, 220]],
    ['left', [60, 200, 80]],
    ['right', [230, 200, 40]],
  ] as Array<[AmbilightEdge, number[]]>)('%s 边取到自身均色', (edge, color) => {
    expect(averageEdge(singleEdge(edge, color as Rgb), W, H, edge)).toEqual(color);
  });

  it('信箱黑边返回 null：这一侧不发光', () => {
    expect(averageEdge(blankFrame(), W, H, 'top')).toBeNull();
    const px = blankFrame();
    paintRow(px, 0, [4, 4, 8]);
    expect(averageEdge(px, W, H, 'top')).toBeNull();
  });

  it('近灰画面（雪原 / 字幕条）返回 null：无彩不产生色偏', () => {
    const px = blankFrame();
    paintRow(px, 0, [210, 208, 212]);
    expect(averageEdge(px, W, H, 'top')).toBeNull();
  });

  it('半明半暗取均值后仍达标则返回均色', () => {
    const px = blankFrame();
    for (let x = 0; x < W; x++) put(px, x * 4, x % 2 === 0 ? [220, 20, 20] : [0, 0, 0]);
    expect(averageEdge(px, W, H, 'top')).toEqual([110, 10, 10]);
  });
});

describe('sampleEdges 降采样取样', () => {
  it('一次 drawImage 到 32×18，再读回一次像素', () => {
    const ctx = makeCtx(ringFrame());
    const edges = sampleEdges({} as CanvasImageSource, ctx as unknown as CanvasRenderingContext2D);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, W, H);
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, W, H);
    expect(edges).not.toBeNull();
    expect(Object.values(edges as AmbilightEdges).every((c) => c !== null)).toBe(true);
    expect(edges?.top?.[0]).toBeGreaterThan(edges?.top?.[2] as number);
  });

  it('画布被跨域视频污染时返回 null，不抛错', () => {
    const ctx = makeCtx(ringFrame());
    ctx.getImageData.mockImplementation(() => {
      throw new DOMException('tainted', 'SecurityError');
    });
    expect(sampleEdges({} as CanvasImageSource, ctx as unknown as CanvasRenderingContext2D)).toBeNull();
  });

  it('原生 surface 上 drawImage 直接失败时同样返回 null', () => {
    const ctx = makeCtx(ringFrame());
    ctx.drawImage.mockImplementation(() => {
      throw new Error('not drawable');
    });
    expect(sampleEdges({} as CanvasImageSource, ctx as unknown as CanvasRenderingContext2D)).toBeNull();
  });

  it('取样前清空、结束后还原状态：不留残影', () => {
    const ctx = makeCtx(ringFrame());
    sampleEdges({} as CanvasImageSource, ctx as unknown as CanvasRenderingContext2D);
    expect(ctx.clearRects).toBe(1);
    expect(ctx.save).toHaveBeenCalledTimes(1);
    expect(ctx.restore).toHaveBeenCalledTimes(1);
  });
});

describe('glowCanvasSize 光晕画布尺寸', () => {
  it('按 DPR 放大并钳到 1~2 倍', () => {
    expect(glowCanvasSize(400, 200, 3)).toEqual({ w: 800, h: 400 });
    expect(glowCanvasSize(400, 200, 1.5)).toEqual({ w: 600, h: 300 });
    expect(glowCanvasSize(400, 200, 0.5)).toEqual({ w: 400, h: 200 });
  });

  it('零尺寸（happy-dom 无布局）也至少给 1px，避免 0 宽画布', () => {
    expect(glowCanvasSize(0, 0, 2)).toEqual({ w: 1, h: 1 });
  });
});

describe('paintAmbilight 渐变光带', () => {
  const ALL: AmbilightEdges = {
    top: [200, 40, 40],
    bottom: [40, 60, 220],
    left: [60, 200, 80],
    right: [230, 200, 40],
  };

  it('四边都有色时画四条光带', () => {
    const ctx = makeCtx(blankFrame());
    paintAmbilight(ctx as unknown as CanvasRenderingContext2D, ALL, 400, 200, 85);
    expect(ctx.fillRects).toHaveLength(4);
  });

  it('峰值不透明度封顶 0.85：85% 强度只到 0.722', () => {
    const ctx = makeCtx(blankFrame());
    paintAmbilight(ctx as unknown as CanvasRenderingContext2D, ALL, 400, 200, 85);
    const first = ctx.fillRects[0]?.gradient.stops[0];
    expect(first).toBe('rgba(200, 40, 40, 0.722)');
    expect(ctx.fillRects[0]?.gradient.stops[1]).toBe('rgba(200, 40, 40, 0)');
  });

  it('强度 0 只清空画布，不画任何光带', () => {
    const ctx = makeCtx(blankFrame());
    paintAmbilight(ctx as unknown as CanvasRenderingContext2D, ALL, 400, 200, 0);
    expect(ctx.clearRects).toBe(1);
    expect(ctx.fillRects).toHaveLength(0);
  });

  it('null 的边直接跳过：黑边一侧不留半透明矩形', () => {
    const ctx = makeCtx(blankFrame());
    paintAmbilight(ctx as unknown as CanvasRenderingContext2D, { ...ALL, left: null }, 400, 200, 60);
    expect(ctx.fillRects).toHaveLength(3);
  });

  it('光带从画框外向内衰减，中间留给画面本身', () => {
    const ctx = makeCtx(blankFrame());
    paintAmbilight(ctx as unknown as CanvasRenderingContext2D, ALL, 400, 200, 80);
    const [top, bottom, left, right] = ctx.fillRects;
    expect(top?.y).toBe(0);
    expect(bottom?.y).toBeGreaterThan(200 * 0.5);
    expect(left?.x).toBe(0);
    expect(right?.x).toBeGreaterThan(400 * 0.5);
    expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 0, 0, 100);
  });

  it('超出 [0,100] 的强度按端点钳制', () => {
    const ctx = makeCtx(blankFrame());
    paintAmbilight(ctx as unknown as CanvasRenderingContext2D, ALL, 400, 200, 250);
    expect(ctx.fillRects[0]?.gradient.stops[0]).toBe('rgba(200, 40, 40, 0.850)');
  });
});
