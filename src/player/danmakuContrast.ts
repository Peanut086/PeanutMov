/**
 * 弹幕智能配色（纯函数层，11-17）
 *
 * 弹幕颜色由源站给定（绝大多数是白），默认描边又只有一层淡阴影：遇到雪景、天空、
 * 白墙这类亮画面，白字直接糊进背景里——这就是「弹幕不随背景自适应」的成因。
 * 这里按弹幕矩形取画面平均亮度，只在**原色看不清**时接管颜色，其余情况原色不动。
 *
 * 判定口径（WCAG 2.1 相对亮度 + 对比度，弹幕按大字号取 3:1 门槛）：
 * 1) 原色对背景对比度达标 → 保留原色，只把描边换成反极性（亮字配暗边）；
 * 2) 不达标 → 沿原色色相朝"离背景更远"的一侧推到能看清（亮底上的黄变橄榄金）；
 * 3) 同色相推到底仍不达标，或原色本就没色相（白/灰）→ 退回黑或白里更清晰的那个。
 * 进出适配带用两个阈值（2.6 / 3.4）做迟滞，避免亮度在临界值附近时颜色抖。
 *
 * 取不到帧（跨域视频污染画布 / 原生 surface 未就绪）时一律返回 null，
 * 渲染层退回旧行为，不做任何"猜色"。
 */

/** 亮度场网格：与氛围光同一档成本（32×18 = 576 格，逐格取均值） */
export const LUMA_COLS = 32;
export const LUMA_ROWS = 18;
export const LUMA_CELLS = LUMA_COLS * LUMA_ROWS;

/** 对比度低于该值才接管颜色 */
const ADAPT_BELOW = 2.6;
/** 已接管后，对比度回到该值以上才交还原色（迟滞带） */
const KEEP_ABOVE = 3.4;
/** 沿色相调整明度的上下限与步长 */
const MIN_LIGHTNESS = 0.06;
const MAX_LIGHTNESS = 0.96;
const LIGHTNESS_STEP = 0.04;
/** 明度试探的最大步数：覆盖 [MIN, MAX] 全区间（(0.96-0.06)/0.04 = 22.5） */
const LIGHTNESS_STEPS = 24;
/** 低于该饱和度就没有"色相"可保（白、灰、近黑），直接走黑白 */
const MIN_HUE_SATURATION = 0.12;

export interface LumaField {
  /** row-major，长度 `LUMA_CELLS`，每格 0~255 平均亮度 */
  cells: Uint8Array;
  /** 采样时刻（performance.now），渲染层用它判断"这一帧还没看过" */
  at: number;
}

export interface PaintRect {
  /** 弹幕容器内的 CSS px 矩形 */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DanmakuPaint {
  /** `#rrggbb` */
  fill: string;
  /** 描边色（含 alpha） */
  stroke: string;
  /** 阴影色（含 alpha） */
  shadow: string;
  /** 本次是否处于接管态（渲染层带着它做迟滞） */
  adapted: boolean;
  /** 稳定标识：变了才重建位图 */
  key: string;
}

type Rgb = [number, number, number];

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 相对亮度 0~1 */
export function relativeLuma(rgb: Rgb): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** 两个相对亮度（0~1）的对比度 1~21 */
export function contrastOf(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

export function rgbOf(color: number): Rgb {
  const value = Number.isFinite(color) ? Math.max(0, Math.min(0xffffff, Math.trunc(color))) : 0xffffff;
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function hexOf(rgb: Rgb): string {
  const value = ((rgb[0] & 0xff) << 16) | ((rgb[1] & 0xff) << 8) | (rgb[2] & 0xff);
  return `#${value.toString(16).padStart(6, '0')}`;
}

/**
 * 亮度场在给定矩形上的均值（0~1）。
 *
 * 矩形按画布尺寸归一化后落进 32×18 网格；完全出屏（还没滚进来 / 已经滚出去）
 * 返回 null，由调用方保持上一次的判定，避免入场瞬间颜色跳一下。
 */
export function averageLuma(
  field: LumaField | null,
  rect: PaintRect,
  canvasWidth: number,
  canvasHeight: number,
): number | null {
  if (!field || canvasWidth <= 0 || canvasHeight <= 0) return null;
  const x0 = Math.max(0, Math.min(canvasWidth, rect.left));
  const x1 = Math.max(0, Math.min(canvasWidth, rect.left + rect.width));
  const y0 = Math.max(0, Math.min(canvasHeight, rect.top));
  const y1 = Math.max(0, Math.min(canvasHeight, rect.top + rect.height));
  if (x1 - x0 <= 0.5 || y1 - y0 <= 0.5) return null;

  const c0 = Math.min(LUMA_COLS - 1, Math.floor((x0 / canvasWidth) * LUMA_COLS));
  const c1 = Math.max(c0, Math.min(LUMA_COLS - 1, Math.ceil((x1 / canvasWidth) * LUMA_COLS) - 1));
  const r0 = Math.min(LUMA_ROWS - 1, Math.floor((y0 / canvasHeight) * LUMA_ROWS));
  const r1 = Math.max(r0, Math.min(LUMA_ROWS - 1, Math.ceil((y1 / canvasHeight) * LUMA_ROWS) - 1));

  let sum = 0;
  let n = 0;
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      sum += field.cells[r * LUMA_COLS + c] ?? 0;
      n += 1;
    }
  }
  if (n === 0) return null;
  return sum / n / 255;
}

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const mix = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [Math.round(mix(h + 1 / 3) * 255), Math.round(mix(h) * 255), Math.round(mix(h - 1 / 3) * 255)];
}

/** 沿原色相两侧试探明度：取"改动最小且能看清"的那个，都不够看清就退回黑白 */
function readableFill(source: Rgb, bgLuma: number): Rgb {
  const whiteRatio = contrastOf(1, bgLuma);
  const blackRatio = contrastOf(0, bgLuma);
  const neutral: Rgb = whiteRatio >= blackRatio ? [255, 255, 255] : [0, 0, 0];
  const [h, s, l0] = rgbToHsl(source);
  // 低饱和的原色（白/灰）没有色相可依，直接走黑白，免得绕一圈还是看不清
  if (s < MIN_HUE_SATURATION) return neutral;
  const saturation = Math.min(1, Math.max(0.25, s));
  // 两侧都要试：对比度是**比值**而不是差值，浅灰底（0.45）上白字只有 2.1，而黑字有 10
  // ——按"离背景更远"只会提亮，正好把唯一有效的方向排除掉。
  for (let k = 1; k <= LIGHTNESS_STEPS; k += 1) {
    // 同一步长先暗后亮：暗的一边比值涨得快，视觉上"压暗"也更接近原来的阅读感
    for (const l of [l0 - k * LIGHTNESS_STEP, l0 + k * LIGHTNESS_STEP]) {
      if (l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue;
      const candidate = hslToRgb(h, saturation, l);
      if (contrastOf(relativeLuma(candidate), bgLuma) >= KEEP_ABOVE) return candidate;
    }
  }
  // 同色相推到底仍够不上门槛时退回黑白（例如亮底上的中黄推成土黄也看不清）
  return neutral;
}

const DARK_STROKE = { stroke: 'rgba(0,0,0,0.8)', shadow: 'rgba(0,0,0,0.7)' };
const LIGHT_STROKE = { stroke: 'rgba(255,255,255,0.85)', shadow: 'rgba(255,255,255,0.75)' };

/** 取不到帧（或用户关掉智能配色）时的旧行为：原色 + 深色阴影/描边 */
export function legacyPaint(sourceColor: number): DanmakuPaint {
  return { fill: hexOf(rgbOf(sourceColor)), ...DARK_STROKE, adapted: false, key: 'legacy' };
}

/**
 * 决定一条弹幕的最终配色。
 *
 * @param sourceColor 源站给定颜色（0xRRGGBB）
 * @param bgLuma 弹幕矩形下的画面相对亮度（0~1）；null = 取不到帧
 * @param adapted 上一次是否处于接管态（迟滞用，避免临界值附近颜色来回抖）
 */
export function resolvePaint(sourceColor: number, bgLuma: number | null, adapted: boolean): DanmakuPaint | null {
  if (bgLuma === null) return null;
  const source = rgbOf(sourceColor);
  const ratio = contrastOf(relativeLuma(source), bgLuma);
  // 迟滞：未接管时要"确实看不清"才动手；已接管时要"确实看得清"才交还原色
  const keep = adapted ? ratio >= KEEP_ABOVE : ratio >= ADAPT_BELOW;
  const fill = keep ? source : readableFill(source, bgLuma);
  // 描边永远站在字的对立面：亮字配暗边、暗字配亮边，无论画面明暗都能给出轮廓
  const polarity = relativeLuma(fill) > 0.5 ? DARK_STROKE : LIGHT_STROKE;
  const hex = hexOf(fill);
  return { fill: hex, ...polarity, adapted: !keep, key: `${hex}|${polarity.stroke}` };
}
