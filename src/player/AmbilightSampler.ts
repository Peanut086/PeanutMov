/**
 * 画面氛围光取样与绘制（C-09）
 *
 * 飞利浦 Ambilight 的思路搬到竖屏：把画面四条边的颜色采出来、模糊后溢出到画框外，
 * 上下黑边变成随剧情呼吸的光晕。
 *
 * 成本红线（性能约束来自实验室稿的真机实测）：
 * - 取样固定 32×18，绝不按视频原始分辨率 `getImageData`；
 * - 每边只取最外一圈像素求均值，统计量与画面复杂度无关；
 * - 绘制只写 4 条线性渐变，模糊交给 CSS 的合成层。
 *
 * 拿不到像素是常态而不是异常：原生 ExoPlayer 的 surface 在 WebView 之下，跨域
 * `<video>` 会污染画布。这里一律返回 `null`，由调用方关掉氛围光——不许黑屏。
 */

export const AMBILIGHT_SAMPLE_W = 32;
export const AMBILIGHT_SAMPLE_H = 18;

export type AmbilightEdge = 'top' | 'bottom' | 'left' | 'right';
export type Rgb = [number, number, number];
export type AmbilightEdges = Record<AmbilightEdge, Rgb | null>;

/** 纯黑（信箱黑边、未出帧）与近灰（雪原、字幕条）不产生光晕 */
const MIN_LUMA = 16;
const MIN_CHROMA = 10;
/** 渐变带占据画框的长度比例：中间留给画面本身 */
const BAND_SPAN = 0.5;
/** 强度 100 时的峰值不透明度：再高就变成舞台灯而不是氛围 */
const PEAK_ALPHA = 0.85;

const EDGES: AmbilightEdge[] = ['top', 'bottom', 'left', 'right'];

/**
 * 取最外一圈的平均色。
 * @param data `getImageData().data`
 * @param dark 达标返回颜色，全黑/无彩返回 null（这一侧不发光）
 */
export function averageEdge(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  edge: AmbilightEdge,
): Rgb | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const push = (i: number): void => {
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
    n += 1;
  };
  if (edge === 'top') for (let x = 0; x < width; x++) push(x * 4);
  else if (edge === 'bottom') for (let x = 0; x < width; x++) push(((height - 1) * width + x) * 4);
  else if (edge === 'left') for (let y = 0; y < height; y++) push(y * width * 4);
  else for (let y = 0; y < height; y++) push((y * width + width - 1) * 4);

  if (n === 0) return null;
  const rgb: Rgb = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  const luma = Math.max(rgb[0], rgb[1], rgb[2]);
  const chroma = luma - Math.min(rgb[0], rgb[1], rgb[2]);
  if (luma < MIN_LUMA || chroma < MIN_CHROMA) return null;
  return rgb;
}

/** 降采样 + 四边平均。取不到像素（污染画布 / 原生 surface / 尺寸为 0）返回 null。 */
export function sampleEdges(
  source: CanvasImageSource,
  ctx: CanvasRenderingContext2D,
): AmbilightEdges | null {
  ctx.save();
  ctx.clearRect(0, 0, AMBILIGHT_SAMPLE_W, AMBILIGHT_SAMPLE_H);
  try {
    ctx.drawImage(source, 0, 0, AMBILIGHT_SAMPLE_W, AMBILIGHT_SAMPLE_H);
  } catch {
    ctx.restore();
    return null;
  }
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, AMBILIGHT_SAMPLE_W, AMBILIGHT_SAMPLE_H).data;
  } catch {
    // 画布被跨域视频污染：SecurityError，氛围光只能放弃
    ctx.restore();
    return null;
  }
  ctx.restore();
  const edges = {} as AmbilightEdges;
  for (const edge of EDGES) edges[edge] = averageEdge(data, AMBILIGHT_SAMPLE_W, AMBILIGHT_SAMPLE_H, edge);
  return edges;
}

/** 画布尺寸：与 CSS 盒子一致（DPR 由调用方钳过，这里只做整数化与下限保护） */
export function glowCanvasSize(cssWidth: number, cssHeight: number, dpr: number): { w: number; h: number } {
  const factor = Math.max(1, Math.min(2, dpr));
  return {
    w: Math.max(1, Math.round(Math.max(0, cssWidth) * factor)),
    h: Math.max(1, Math.round(Math.max(0, cssHeight) * factor)),
  };
}

/**
 * 把四边颜色画成向内衰减的渐变带。
 * @param intensity 0~100（设置项），映射到 `PEAK_ALPHA`
 */
export function paintAmbilight(
  ctx: CanvasRenderingContext2D,
  edges: AmbilightEdges,
  width: number,
  height: number,
  intensity: number,
): void {
  const alpha = Math.min(1, Math.max(0, intensity / 100)) * PEAK_ALPHA;
  ctx.clearRect(0, 0, width, height);
  if (alpha <= 0) return;

  const bands: Array<{ edge: AmbilightEdge; x: number; y: number; w: number; h: number; from: [number, number]; to: [number, number] }> = [
    { edge: 'top', x: 0, y: 0, w: width, h: height * 0.42, from: [0, 0], to: [0, height * BAND_SPAN] },
    { edge: 'bottom', x: 0, y: height * 0.58, w: width, h: height * 0.42, from: [0, height], to: [0, height * (1 - BAND_SPAN)] },
    { edge: 'left', x: 0, y: 0, w: width * 0.4, h: height, from: [0, 0], to: [width * BAND_SPAN * 0.9, 0] },
    { edge: 'right', x: width * 0.6, y: 0, w: width * 0.4, h: height, from: [width, 0], to: [width * (1 - BAND_SPAN * 0.9), 0] },
  ];

  for (const band of bands) {
    const rgb = edges[band.edge];
    if (!rgb || band.w <= 0 || band.h <= 0) continue;
    const gradient = ctx.createLinearGradient(band.from[0], band.from[1], band.to[0], band.to[1]);
    gradient.addColorStop(0, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`);
    gradient.addColorStop(1, `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(band.x, band.y, band.w, band.h);
  }
}
