/**
 * 「一帧明信片」的绘制与导出（G-C04）
 *
 * 把正在看的这一部排成一张 4:5 的明信片：三种版式（票根 / 极简 / 胶片）×
 * 两种图源（海报 / 本机画面），台词可选带上当前字幕那一行。
 *
 * 三条硬口径（与 A-03 进度条胶片、G-B02 原位放映同一族）：
 * - **画面只来自本机成品**：在线源没有可随机读的容器，只能用人物海报，
 *   「画面」这一档由 UI 直接关掉，不假装有帧。
 * - 原生抽帧长边被夹在 256px，所以清晰画面只出现在放得下它的小图区（不超过约 2 倍放大）；
 *   需要大图氛围时一律用「同一帧自身的高斯模糊底」，不做 4 倍拉伸的糊砖。
 * - 台词就是当前字幕行；没有字幕时开关不可用，不拿影片简介冒充台词。
 *
 * 导出通路：`Blob → base64 → 私有目录 postcards/postcard.png → CastShare.shareFile`。
 * 文件名固定覆盖，不靠"记得删"控制体积；交给系统分享面板，不写相册（本机没有媒体库写入能力）。
 * Web 环境没有原生文件与分享面板，退回 `<a download>`。
 */
import type { PaletteSeed } from '@/services/paletteService';
import { arrayBufferToBase64, blobToArrayBuffer, ensureDir, isFsAvailable, writeBase64 } from '@/native/fs';
import { isCastShareAvailable, shareFile } from '@/native/castPlugin';
import { extractSeekFrames, isMediaToolAvailable } from '@/native/mediaToolPlugin';
import { loadPosterImage } from '@/services/paletteService';
import { formatDateStamp, formatPlayerClock } from '@/shared/time';
import { logger } from '@/shared/logger';

export const POSTCARD_W = 1080;
export const POSTCARD_H = 1350;

/** 导出落盘用固定名：每次覆盖，私有目录里永远只有一张 */
const EXPORT_PATH = 'postcards/postcard.png';
/** 抽帧长边：原生上限就是 256，清晰小图区最大按 2 倍放大算 */
const FRAME_EDGE = 256;
const FRAME_QUALITY = 82;
/** 胶片格三张的时间间距（±6s：够换掉同一段镜头，又不至于跨到另一场戏） */
const CELL_SPREAD_MS = 6000;

const PAD = 84;
/** 与 `--font-family-base` / `--font-family-number` 同族，画布上只留能落地的部分 */
export const STACK_BASE =
  '-apple-system, "PingFang SC", "HarmonyOS Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", Roboto, sans-serif';
export const STACK_NUM = 'Inter, "SF Pro Display", Roboto, "Helvetica Neue", Arial, sans-serif';

export type PostcardLayout = 'ticket' | 'minimal' | 'film';
export type PostcardImageSource = 'poster' | 'frame';
/** 为什么没有本机画面：UI 按原因出不同的一句话，不统一写成"不支持" */
export type PostcardFramesReason = 'ok' | 'no-bridge' | 'no-file' | 'none';

export type PostcardFailReason = 'draw' | 'encode' | 'no-fs' | 'no-target' | 'error';

export interface PostcardContent {
  title: string;
  /** `1998 · 美国 · 动作`，缺项自动跳过 */
  meta: string | null;
  /** `第 3 集`；电影传 null，版式上不留空槽 */
  episodeLabel: string | null;
  /** 当前字幕台词；null / 空串表示此刻没有台词 */
  line: string | null;
  positionSec: number;
  durationSec: number;
  posterUrl: string | null;
  /** 已抽好的本机画面（data URL），没有就是空数组 */
  frames: string[];
  /** 海报主色；取不到时用中性冷色，不硬套品牌橙 */
  accent: PaletteSeed | null;
}

export interface Drawable {
  source: CanvasImageSource;
  width: number;
  height: number;
  /** 源图上的取样窗口：胶片格从一张竖海报切三段时用 */
  crop?: { x: number; y: number; w: number; h: number };
}

export interface PostcardAssets {
  /** 大图与模糊底共用那一张（海报或中间那一帧） */
  hero: Drawable | null;
  /** 胶片版式的 1~3 格 */
  cells: Drawable[];
}

/* ---------- 取数 ---------- */

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * 胶片格要的三个时间点：中间是此刻，左右各推 ±6s，越界的贴回边界。
 * 时长未知就只要此刻——没有分母就不假装"这也是一场的三格"。
 */
export function postcardFrameTimes(positionSec: number, durationSec: number): number[] {
  const at = Math.max(0, Math.round(positionSec * 1000));
  if (!(durationSec > 0)) return [at];
  const end = Math.round(durationSec * 1000) - 1;
  const times = [at - CELL_SPREAD_MS, at, at + CELL_SPREAD_MS].map((t) => clamp(t, 0, end));
  // 贴近头尾时三三会撞成同一秒，重复的时间点只是多解一遍码
  return [...new Set(times)];
}

export interface PostcardFrames {
  frames: string[];
  reason: PostcardFramesReason;
}

/**
 * 抽明信片要用的那几帧（串行一次调用，原生内部自己排队）。
 * 没有任何一层会重试坏文件：抽不出就是抽不出，交给 UI 说清楚。
 */
export async function fetchPostcardFrames(
  localPath: string | null | undefined,
  positionSec: number,
  durationSec: number,
): Promise<PostcardFrames> {
  if (!isMediaToolAvailable()) return { frames: [], reason: 'no-bridge' };
  if (!localPath) return { frames: [], reason: 'no-file' };
  const times = postcardFrameTimes(positionSec, durationSec);
  let frames: string[] = [];
  try {
    const raw = await extractSeekFrames(localPath, times, FRAME_EDGE, FRAME_QUALITY);
    frames = (raw ?? []).filter((f): f is string => typeof f === 'string' && f.length > 0);
  } catch (e) {
    logger.debug('明信片抽帧失败（退回海报）', { error: (e as Error)?.message ?? String(e) });
    return { frames: [], reason: 'none' };
  }
  return { frames, reason: frames.length > 0 ? 'ok' : 'none' };
}

function sizeOf(source: CanvasImageSource): { width: number; height: number } {
  const bitmap = source as ImageBitmap;
  const image = source as HTMLImageElement;
  return {
    width: bitmap.width ?? image.naturalWidth ?? 0,
    height: bitmap.height ?? image.naturalHeight ?? 0,
  };
}

async function decodeDataUrl(dataUrl: string): Promise<Drawable | null> {
  // data: 图源同源，不会污染画布，直接交给 Image 解码
  const img = new Image();
  img.decoding = 'async';
  img.src = dataUrl;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const { width, height } = sizeOf(img);
  return width > 0 && height > 0 ? { source: img, width, height } : null;
}

/** 一张竖海报切成三格：上/中/下各取一条 16:9 的窗口，仍诚实标注图源是海报 */
function posterCells(poster: Drawable): Drawable[] {
  const windowH = Math.round(poster.width * (9 / 16));
  if (windowH >= poster.height) return [poster];
  return [0.28, 0.5, 0.72].map((a) => ({
    source: poster.source,
    width: poster.width,
    height: poster.height,
    crop: {
      x: 0,
      y: clamp(Math.round(poster.height * a - windowH / 2), 0, poster.height - windowH),
      w: poster.width,
      h: windowH,
    },
  }));
}

/**
 * 把图源解成画布可用的资产。海报走 `paletteService` 的字节流通路（跨源直挂 `img` 会污染画布，
 * 那样连 `toBlob` 都调不动）；画面用已经抽好的 data URL。
 */
export async function loadPostcardAssets(
  content: PostcardContent,
  image: PostcardImageSource,
): Promise<PostcardAssets> {
  const useFrame = image === 'frame' && content.frames.length > 0;
  let hero: Drawable | null = null;
  if (useFrame) {
    // 三格取中间那格当大图：头尾两格常常落在镜头切换的两侧
    const heroFrame = content.frames[Math.floor((content.frames.length - 1) / 2)] ?? content.frames[0];
    hero = heroFrame ? await decodeDataUrl(heroFrame) : null;
  } else if (content.posterUrl) {
    const poster = await loadPosterImage(content.posterUrl);
    if (poster) {
      const { width, height } = sizeOf(poster);
      if (width > 0 && height > 0) hero = { source: poster, width, height };
    }
  }
  if (useFrame) {
    const cells = await Promise.all(content.frames.slice(0, 3).map(decodeDataUrl));
    return { hero, cells: cells.filter((c): c is Drawable => c !== null) };
  }
  return { hero, cells: hero ? posterCells(hero) : [] };
}

/* ---------- 配色 ---------- */

export interface Ink {
  bgTop: string;
  bgBottom: string;
  accent: string;
  plate: string;
  hairline: string;
  text: string;
  textDim: string;
}

/** 主色只决定「气质」：底色压到很暗、文字保持高对比，不拿海报主色当大面积背景 */
export function inkOf(seed: PaletteSeed | null): Ink {
  const h = Math.round(seed?.h ?? 214);
  const s = clamp(seed?.s ?? 0.3, 0.16, 0.68);
  return {
    bgTop: hsl(h, s * 0.55, 0.06),
    bgBottom: hsl((h + 26) % 360, s * 0.45, 0.13),
    accent: hsl(h, Math.max(s, 0.52), 0.64),
    plate: hsla(h, Math.max(s, 0.4), 0.62, 0.18),
    hairline: hsla(h, 0.4, 0.9, 0.16),
    text: hsl(h, 0.18, 0.97),
    textDim: hsla(h, 0.2, 0.92, 0.66),
  };
}

export function hsl(h: number, s: number, l: number): string {
  return `hsl(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

export function hsla(h: number, s: number, l: number, a: number): string {
  return `hsla(${h}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%, ${a})`;
}

/* ---------- 画布基元 ---------- */

type Ctx = CanvasRenderingContext2D;

/** 老 WebView 没有 `roundRect`，自己走圆弧，画不出来也只是少个圆角 */
export function traceRoundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

/** cover 裁剪：够铺满就居中切，装不下就按短边贴切 */
export function drawCover(
  ctx: Ctx,
  d: Drawable,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = 0,
): void {
  const sw = d.crop?.w ?? d.width;
  const sh = d.crop?.h ?? d.height;
  const sx = d.crop?.x ?? 0;
  const sy = d.crop?.y ?? 0;
  if (radius > 0) {
    ctx.save();
    traceRoundRect(ctx, x, y, w, h, radius);
    ctx.clip();
  }
  const scale = Math.max(w / sw, h / sh);
  const drawW = sw * scale;
  const drawH = sh * scale;
  ctx.drawImage(d.source, sx, sy, sw, sh, x - (drawW - w) / 2, y - (drawH - h) / 2, drawW, drawH);
  if (radius > 0) ctx.restore();
}

/**
 * 模糊满铺：拿同一张图自身当氛围底，所以「画面」档绝不会画出别人的镜头。
 * 不支持 `filter` 的老画布跳过模糊，只压暗铺一张——仍然是同一帧，只是没有雾化边缘。
 */
export function drawAmbient(
  ctx: Ctx,
  d: Drawable,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  const bleed = 72;
  if ('filter' in ctx) ctx.filter = 'blur(44px)';
  drawCover(ctx, d, x - bleed, y - bleed, w + bleed * 2, h + bleed * 2);
  ctx.restore();
}

/** ASCII 词整体不断行，其余按字断（中英混排的片名两头都要顾） */
function tokenize(text: string): string[] {
  return text.match(/[A-Za-z0-9]+|[ ]+|[^\sA-Za-z0-9]/g) ?? [];
}

/** 逐行量宽，超出 `maxLines` 的最后一行加省略号 */
export function wrapText(ctx: Ctx, text: string, maxWidth: number, maxLines: number): string[] {
  // 单个英文词比整行还宽时按字母拆，否则一定画到卡片外面
  const units: string[] = [];
  for (const piece of tokenize(text)) {
    const splittable = piece.length > 1 && /^[\w' -]+$/.test(piece) && ctx.measureText(piece).width > maxWidth;
    if (splittable) units.push(...Array.from(piece));
    else units.push(piece);
  }

  const lines: string[] = [];
  let current = '';
  for (const piece of units) {
    const next = current + piece;
    if (current && ctx.measureText(next).width > maxWidth) {
      lines.push(current.trimEnd());
      current = piece.trimStart();
      if (lines.length === maxLines) break;
    } else {
      current = next;
    }
  }
  if (lines.length < maxLines && current) lines.push(current.trimEnd());
  if (lines.length > maxLines) lines.length = maxLines;
  // 还有词没排进去，才给末行加省略号
  if (current && lines.length === maxLines && lines.join('').replace(/\s/g, '') !== text.replace(/\s/g, '')) {
    const last = lines[maxLines - 1] ?? '';
    lines[maxLines - 1] = shrinkToFit(ctx, `${last}…`, maxWidth);
  }
  return lines;
}

export function shrinkToFit(ctx: Ctx, text: string, maxWidth: number): string {
  let out = text;
  while (out.length > 1 && ctx.measureText(out).width > maxWidth) {
    out = `${out.slice(0, -2).trimEnd()}…`;
  }
  return out;
}

export function font(size: number, weight: number | string, stack = STACK_BASE): string {
  return `${weight} ${size}px ${stack}`;
}

function progressOf(content: PostcardContent): number | null {
  if (!(content.durationSec > 0) || !(content.positionSec >= 0)) return null;
  return clamp(content.positionSec / content.durationSec, 0, 1);
}

/** `看到 12:34 / 45:00`；时长未知只写已看到的位置，不编一个 0:00 分母 */
function timecodeOf(content: PostcardContent): string {
  const at = formatPlayerClock(content.positionSec);
  return content.durationSec > 0 ? `${at} / ${formatPlayerClock(content.durationSec)}` : at;
}

/* ---------- 共用的几块 ---------- */

function paintBackdrop(ctx: Ctx, ink: Ink, hero: Drawable | null, alpha: number): void {
  const gradient = ctx.createLinearGradient(0, 0, POSTCARD_W * 0.4, POSTCARD_H);
  gradient.addColorStop(0, ink.bgTop);
  gradient.addColorStop(1, ink.bgBottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, POSTCARD_W, POSTCARD_H);
  if (hero) drawAmbient(ctx, hero, 0, 0, POSTCARD_W, POSTCARD_H, alpha);
}

function drawPill(ctx: Ctx, ink: Ink, text: string, x: number, y: number): number {
  ctx.font = font(30, 600);
  const w = ctx.measureText(text).width + 44;
  const h = 58;
  ctx.fillStyle = ink.plate;
  traceRoundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = ink.accent;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 22, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  return w;
}

function drawQuote(ctx: Ctx, ink: Ink, line: string, x: number, y: number, w: number): number {
  ctx.font = font(42, 400);
  const lines = wrapText(ctx, `「${line}」`, w, 3);
  let dy = y;
  ctx.fillStyle = ink.text;
  for (const text of lines) {
    dy += 60;
    ctx.fillText(text, x, dy);
  }
  ctx.fillStyle = ink.accent;
  ctx.fillRect(x - 24, y + 12, 6, Math.max(60, lines.length * 60) - 24);
  return dy - y;
}

function drawProgress(ctx: Ctx, ink: Ink, content: PostcardContent, x: number, y: number, w: number): void {
  const h = 8;
  ctx.fillStyle = ink.hairline;
  traceRoundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  const p = progressOf(content);
  if (p === null) return;
  ctx.fillStyle = ink.accent;
  traceRoundRect(ctx, x, y, Math.max(h, w * p), h, h / 2);
  ctx.fill();
}

function drawFootnote(ctx: Ctx, ink: Ink, content: PostcardContent, x: number, y: number): void {
  ctx.font = font(26, 500);
  ctx.fillStyle = ink.textDim;
  const mark = 'PEANUTMOV';
  ctx.fillText(mark, x, y);
  const stamp = content.episodeLabel ? `${content.episodeLabel} · ${formatDateStamp()}` : formatDateStamp();
  ctx.font = font(26, 400);
  ctx.fillText(stamp, x + ctx.measureText(mark).width + 68, y);
}

/** 片名 + 元信息 + 时间码：三种版式共用的文字块，返回底部 y */
function drawTitles(
  ctx: Ctx,
  ink: Ink,
  content: PostcardContent,
  x: number,
  y: number,
  w: number,
  opts: { size: number; lines: number; withTimecode: boolean },
): number {
  ctx.fillStyle = ink.text;
  ctx.font = font(opts.size, 700);
  const lines = wrapText(ctx, content.title || '未命名', w, opts.lines);
  let dy = y;
  const step = Math.round(opts.size * 1.28);
  for (const line of lines) {
    dy += step;
    ctx.fillText(line, x, dy - Math.round(opts.size * 0.24));
  }
  dy += step * 0.2;
  if (content.meta) {
    ctx.font = font(30, 400);
    ctx.fillStyle = ink.textDim;
    dy += 44;
    ctx.fillText(shrinkToFit(ctx, content.meta, w), x, dy);
  }
  if (opts.withTimecode) {
    ctx.font = font(34, 500, STACK_NUM);
    ctx.fillStyle = ink.textDim;
    dy += 56;
    ctx.fillText(timecodeOf(content), x, dy);
  }
  return dy;
}

/* ---------- 三种版式 ---------- */

/** 票根：模糊底 + 清晰小卡 + 撕票虚线，信息最全 */
function composeTicket(ctx: Ctx, ink: Ink, content: PostcardContent, assets: PostcardAssets): void {
  paintBackdrop(ctx, ink, assets.hero, 0.5);
  ctx.fillStyle = hsla(0, 0, 0, 0.42);
  ctx.fillRect(0, 0, POSTCARD_W, POSTCARD_H);

  drawPill(ctx, ink, content.episodeLabel ?? '观影纪念', PAD, 100);

  const cardW = 336;
  const cardH = 504;
  if (assets.hero) {
    drawCover(ctx, assets.hero, PAD, 236, cardW, cardH, 22);
  } else {
    // 既没海报也没画面：留一块明确的空位，不画假图
    ctx.font = font(28, 400);
    ctx.fillStyle = ink.textDim;
    ctx.fillText('无封面', PAD + 120, 236 + cardH / 2);
  }
  ctx.strokeStyle = ink.hairline;
  ctx.lineWidth = 2;
  traceRoundRect(ctx, PAD, 236, cardW, cardH, 22);
  ctx.stroke();

  drawTitles(ctx, ink, content, PAD + cardW + 52, 260, POSTCARD_W - PAD - (PAD + cardW + 52), {
    size: 60,
    lines: 3,
    withTimecode: true,
  });

  const tearY = 812;
  ctx.strokeStyle = ink.hairline;
  ctx.lineWidth = 2;
  ctx.setLineDash([16, 14]);
  ctx.beginPath();
  ctx.moveTo(PAD - 24, tearY);
  ctx.lineTo(POSTCARD_W - PAD + 24, tearY);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const nx of [-34, POSTCARD_W + 34]) {
    ctx.fillStyle = ink.bgBottom;
    ctx.beginPath();
    ctx.arc(nx, tearY, 34, 0, Math.PI * 2);
    ctx.fill();
  }

  let cursor = tearY + 76;
  if (content.line) cursor += drawQuote(ctx, ink, content.line, PAD, cursor, POSTCARD_W - PAD * 2) + 44;
  drawProgress(ctx, ink, content, PAD, cursor, POSTCARD_W - PAD * 2);
  drawFootnote(ctx, ink, content, PAD, cursor + 96);
}

/** 极简：大面积留白给排版，画面缩成右下角一枚小章 */
function composeMinimal(ctx: Ctx, ink: Ink, content: PostcardContent, assets: PostcardAssets): void {
  paintBackdrop(ctx, ink, assets.hero, 0.22);

  ctx.fillStyle = ink.accent;
  ctx.fillRect(PAD, 300, 132, 8);

  ctx.font = font(28, 500);
  ctx.fillStyle = ink.textDim;
  ctx.fillText(content.episodeLabel ?? '电影', PAD, 268);

  const textBottom = drawTitles(ctx, ink, content, PAD, 380, POSTCARD_W - PAD * 2, {
    size: 92,
    lines: 4,
    withTimecode: false,
  });

  if (content.line) drawQuote(ctx, ink, content.line, PAD, textBottom + 40, POSTCARD_W - PAD * 2 - 340);

  if (assets.hero) {
    const chipW = 300;
    const chipH = 200;
    drawCover(ctx, assets.hero, POSTCARD_W - PAD - chipW, POSTCARD_H - 470, chipW, chipH, 16);
    ctx.strokeStyle = ink.hairline;
    ctx.lineWidth = 2;
    traceRoundRect(ctx, POSTCARD_W - PAD - chipW, POSTCARD_H - 470, chipW, chipH, 16);
    ctx.stroke();
    ctx.font = font(24, 400);
    ctx.fillStyle = ink.textDim;
    ctx.fillText(
      content.frames.length > 0 ? '本机画面' : '人物海报',
      POSTCARD_W - PAD - chipW,
      POSTCARD_H - 470 + chipH + 40,
    );
  }

  ctx.font = font(104, 600, STACK_NUM);
  ctx.fillStyle = ink.text;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(formatPlayerClock(content.positionSec), PAD, POSTCARD_H - 200);
  if (content.durationSec > 0) {
    ctx.font = font(34, 500, STACK_NUM);
    ctx.fillStyle = ink.textDim;
    ctx.fillText(`/ ${formatPlayerClock(content.durationSec)}`, PAD, POSTCARD_H - 152);
  }

  drawProgress(ctx, ink, content, PAD, POSTCARD_H - 116, POSTCARD_W - PAD * 2);
  drawFootnote(ctx, ink, content, PAD, POSTCARD_H - 56);
}

/** 胶片：三格并排 + 齿孔带，格数按实际抽到的来，绝不用海报补成三格 */
function composeFilm(ctx: Ctx, ink: Ink, content: PostcardContent, assets: PostcardAssets): void {
  paintBackdrop(ctx, ink, null, 0);

  drawPill(ctx, ink, content.episodeLabel ?? '观影纪念', PAD, 100);

  drawTitles(ctx, ink, content, PAD, 246, POSTCARD_W - PAD * 2, {
    size: 62,
    lines: 2,
    withTimecode: false,
  });

  const cells = assets.cells.slice(0, 3);
  // 一格都没有也要按一格的几何铺底板，否则带齿孔的长条会退化成负宽度
  const cols = Math.max(1, cells.length);
  const gap = 22;
  const cellH = Math.round((POSTCARD_W - PAD * 2 - gap * (cols - 1)) / cols / (16 / 9));
  const cellW = Math.round(cellH * (16 / 9));
  const stripW = cols * cellW + gap * (cols - 1);
  const x0 = Math.round((POSTCARD_W - stripW) / 2);
  const perfH = 34;
  const y0 = 620;

  ctx.fillStyle = hsla(0, 0, 0, 0.55);
  traceRoundRect(ctx, x0 - 26, y0 - perfH - 18, stripW + 52, cellH + (perfH + 18) * 2, 18);
  ctx.fill();

  // 齿孔：两条等距方孔，胶片之所以是胶片就靠它
  const holes = Math.max(2, Math.round(stripW / 62));
  const holeW = 26;
  const holeGap = (stripW - holeW * holes) / (holes - 1);
  ctx.fillStyle = hsla(0, 0, 1, 0.82);
  for (const rowY of [y0 - perfH, y0 + cellH + 16]) {
    for (let i = 0; i < holes; i += 1) {
      traceRoundRect(ctx, x0 + i * (holeW + holeGap), rowY, holeW, perfH - 12, 6);
      ctx.fill();
    }
  }

  cells.forEach((cell, i) => {
    const x = x0 + i * (cellW + gap);
    drawCover(ctx, cell, x, y0, cellW, cellH, 10);
    ctx.strokeStyle = ink.hairline;
    ctx.lineWidth = 2;
    traceRoundRect(ctx, x, y0, cellW, cellH, 10);
    ctx.stroke();
    if (cells.length > 1) {
      ctx.font = font(24, 600, STACK_NUM);
      ctx.fillStyle = hsla(0, 0, 1, 0.72);
      ctx.fillText(String(i + 1).padStart(2, '0'), x + 16, y0 + cellH - 18);
    }
  });

  if (cells.length === 0) {
    ctx.font = font(30, 400);
    ctx.fillStyle = ink.textDim;
    ctx.fillText('没有可用画面', x0, y0 + cellH / 2);
  }

  let cursor = y0 + cellH + perfH + 90;
  if (content.line) cursor += drawQuote(ctx, ink, content.line, PAD, cursor, POSTCARD_W - PAD * 2) + 48;
  drawProgress(ctx, ink, content, PAD, cursor, POSTCARD_W - PAD * 2);
  ctx.font = font(32, 500, STACK_NUM);
  ctx.fillStyle = ink.textDim;
  ctx.fillText(timecodeOf(content), PAD, cursor + 84);
  drawFootnote(ctx, ink, content, PAD, POSTCARD_H - 56);
}

/**
 * 排版主入口：只管画，不管取数。
 * 单独导出是为了让版式几何能被测试钉住（坐标 NaN 在画布上只会静默不画，肉眼难发现）。
 */
export function composePostcard(
  ctx: Ctx,
  layout: PostcardLayout,
  content: PostcardContent,
  assets: PostcardAssets,
): void {
  ctx.save();
  ctx.clearRect(0, 0, POSTCARD_W, POSTCARD_H);
  ctx.textBaseline = 'alphabetic';
  const ink = inkOf(content.accent);
  if (layout === 'minimal') composeMinimal(ctx, ink, content, assets);
  else if (layout === 'film') composeFilm(ctx, ink, content, assets);
  else composeTicket(ctx, ink, content, assets);
  ctx.restore();
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  if (typeof canvas.toBlob === 'function') {
    return new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  }
  // 少数 WebView 只认 dataURL：同一张画布换个出口，画质一致
  const dataUrl = canvas.toDataURL('image/png');
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image') || comma < 0) return null;
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * 画布 → PNG 的共同通路（明信片与票根卡同一条）：
 * 任何一步失败都抛 `PostcardError`，由弹层换成一句人话。
 */
export async function drawToPng(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PostcardError('draw', '这台机器没能给出画布');
  draw(ctx);
  let blob: Blob | null = null;
  try {
    blob = await canvasToBlob(canvas);
  } catch (e) {
    // 唯一现实的失败是画布被污染；这里的图都是同源字节流，真出现就是 WebView 的限制
    throw new PostcardError('encode', (e as Error)?.message ?? '无法导出图片');
  }
  if (!blob) throw new PostcardError('encode', '导出没有拿到图片');
  return blob;
}

/** 画一张明信片：取数 → 排版 → 编码 */
export async function renderPostcard(
  layout: PostcardLayout,
  content: PostcardContent,
  image: PostcardImageSource,
): Promise<Blob> {
  const assets = await loadPostcardAssets(content, image);
  return drawToPng(POSTCARD_W, POSTCARD_H, (ctx) => composePostcard(ctx, layout, content, assets));
}

export class PostcardError extends Error {
  constructor(
    readonly reason: PostcardFailReason,
    message: string,
  ) {
    super(message);
    this.name = 'PostcardError';
  }
}

function downloadInBrowser(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // 立刻 revoke 会让部分 WebView 取消下载，留一个宏任务
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 卡片家族共同的导出落盘目标：固定文件名覆盖写，私有目录里永远只有一张，
 * 不需要额外的清理入口（明信片与票根卡各占一个目录，互不覆盖）。
 */
export interface ImageExportTarget {
  /** 私有目录下的子目录 */
  dir: string;
  /** 相对 `Directory.Data` 的固定落盘路径 */
  path: string;
  /** Web 环境退回 `<a download>` 时给的文件名 */
  fileName: string;
}

/**
 * 交给系统分享面板（原生）或下载（Web）。
 * 两条通路都没有"写相册"的能力，所以文案一律说"交给分享面板"，不许诺落相册。
 */
export async function shareImageBlob(
  blob: Blob,
  title: string,
  target: ImageExportTarget,
): Promise<{ ok: boolean; reason?: PostcardFailReason; message?: string }> {
  if (!isFsAvailable()) {
    try {
      downloadInBrowser(blob, target.fileName);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'error', message: (e as Error)?.message ?? '浏览器没能保存' };
    }
  }
  try {
    await ensureDir(target.dir);
    const base64 = arrayBufferToBase64(await blobToArrayBuffer(blob));
    if (!base64) return { ok: false, reason: 'encode', message: '没有可用的 base64 通路' };
    await writeBase64(target.path, base64);
    if (!(await isCastShareAvailable())) return { ok: false, reason: 'no-target', message: '本机没有分享面板' };
    await shareFile({ path: target.path, mime: 'image/png', title });
    return { ok: true };
  } catch (e) {
    const message = (e as Error)?.message ?? '分享失败';
    logger.debug('卡片分享失败', { message, path: target.path });
    return { ok: false, reason: 'error', message };
  }
}

const POSTCARD_TARGET: ImageExportTarget = { dir: 'postcards', path: EXPORT_PATH, fileName: 'postcard.png' };

export async function sharePostcard(
  blob: Blob,
  title: string,
): Promise<{ ok: boolean; reason?: PostcardFailReason; message?: string }> {
  return shareImageBlob(blob, title, POSTCARD_TARGET);
}

export const POSTCARD_LAYOUT_LABEL: Record<PostcardLayout, string> = {
  ticket: '票根',
  minimal: '极简',
  film: '胶片',
};

export const POSTCARD_FRAMES_NOTE: Record<PostcardFramesReason, string> = {
  ok: '',
  'no-bridge': '本机暂不支持抽帧 · 只能用人物海报',
  'no-file': '在线源没有可随机读的文件 · 只能用人物海报',
  none: '这一帧没能抽出来 · 只能用人物海报',
};
