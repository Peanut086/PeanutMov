/**
 * 观影口令「票根卡」（G-C10）
 *
 * 把口令正文画成一张可保存的票根：左边是片名与这一刻，右边是撕票线另一侧的时间与条码。
 *
 * 三条硬口径：
 * - **协议一字未动**。卡上的文字来自 `shareCodeService.encodeShareCode`，复制走的是同一串文本；
 *   卡片只是它的可视化，没有新增任何字段，也没有把地址/源/订阅写上去。
 * - **条码是装饰**。44 根条由口令正文散列出来，同一串口令永远画出同一根条码，
 *   但它不是任何一种码制，扫不出来——所以卡上直接印「装饰条码 · 不可扫描」，不假装能扫。
 * - 时长未知就只写已看到的位置，不编一个 `00:00` 的分母；取不到海报就没有氛围底，不拿别的图凑。
 *
 * 画布、配色、断行与导出通路全部复用明信片那一套（`postcardService`），
 * 两个产物只是版式不同，取数与失败口径必须一致。
 */
import type { PaletteSeed } from '@/services/paletteService';
import {
  STACK_BASE,
  STACK_NUM,
  drawAmbient,
  drawToPng,
  font,
  hsl,
  hsla,
  inkOf,
  loadPostcardAssets,
  shareImageBlob,
  shrinkToFit,
  traceRoundRect,
  wrapText,
  type ImageExportTarget,
  type Ink,
  type PostcardAssets,
  type PostcardFailReason,
} from '@/services/postcardService';
import { formatPlayerClock, formatDateStamp } from '@/shared/time';

export const TICKET_W = 1080;
export const TICKET_H = 540;

/** 条码根数：固定 44，卡面宽度就那么多，再多会糊成一条灰带 */
export const TICKET_BARS = 44;
const TICKET_PAD = 64;
const TEAR_X = 712;
const STUB_X = 752;
const STUB_W = 264;
/** 口令正文的字号阶梯：装不下就降档，宁可字小也不给口令加省略号 */
const CODE_SIZES = [26, 24, 22, 20, 18];

export type TicketViewer = 'owner' | 'receiver';

export interface TicketContent {
  title: string;
  /** `1998 · 美国 · 动作` */
  meta: string | null;
  /** `第 3 集`；电影传 null */
  episodeLabel: string | null;
  /** 口令正文（`#PeanutMov1.xxxx#`），卡上可复制的那一行 */
  code: string;
  positionSec: number;
  durationSec: number;
  posterUrl: string | null;
  accent: PaletteSeed | null;
  /** 视角：只换那句说明，卡上的坐标信息两种视角完全一致 */
  viewer: TicketViewer;
}

export const TICKET_CAPTION: Record<TicketViewer, string> = {
  owner: '我在 PeanutMov 看到这一刻',
  receiver: '把口令粘进搜索框，从这里续上',
};

export const TICKET_BARCODE_NOTE = '装饰条码 · 不可扫描';

/* ---------- 条码（装饰） ---------- */

/** FNV-1a：口令正文每变一个字符，整根条码就换一副样子，但同一串永远同一副 */
function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 44 根条的粗细（1~3 个单位）：纯装饰，所以不声称对应任何一种码制 */
export function ticketBarWidths(code: string): number[] {
  let state = seedOf(code || 'PeanutMov');
  const widths: number[] = [];
  for (let i = 0; i < TICKET_BARS; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    widths.push(1 + ((state >>> 27) % 3));
  }
  return widths;
}

/* ---------- 版式 ---------- */

type Ctx = CanvasRenderingContext2D;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function drawTag(ctx: Ctx, ink: Ink, text: string, x: number, y: number): number {
  ctx.font = font(26, 600, STACK_BASE);
  const w = ctx.measureText(text).width + 36;
  const h = 46;
  ctx.fillStyle = ink.plate;
  traceRoundRect(ctx, x, y, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = ink.accent;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 18, y + h / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  return w;
}

/** 撕票线：虚线 + 上下两枚半圆缺口，票根之所以是票根就靠它 */
function drawTear(ctx: Ctx, ink: Ink): void {
  ctx.strokeStyle = ink.hairline;
  ctx.lineWidth = 2;
  ctx.setLineDash([14, 12]);
  ctx.beginPath();
  ctx.moveTo(TEAR_X, 40);
  ctx.lineTo(TEAR_X, TICKET_H - 40);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = ink.bgBottom;
  // 圆心压在卡边上，露出的才是半个缺口；整圆画在卡外等于没画
  for (const ny of [0, TICKET_H]) {
    ctx.beginPath();
    ctx.arc(TEAR_X, ny, 26, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBarcode(ctx: Ctx, ink: Ink, code: string, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = hsla(0, 0, 1, 0.92);
  traceRoundRect(ctx, x, y, w, h, 14);
  ctx.fill();

  const widths = ticketBarWidths(code);
  const inset = 18;
  const gap = 2;
  const usable = w - inset * 2 - gap * (widths.length - 1);
  const total = widths.reduce((sum, v) => sum + v, 0);
  // 单位宽按根数等比铺满：条码的意义是"这是一张票"，不是编码信息
  const unit = usable > 0 && total > 0 ? usable / total : 0;
  ctx.fillStyle = hsl(0, 0, 0.08);
  let cursor = x + inset;
  for (const width of widths) {
    const barW = Math.max(1, Math.round(width * unit));
    ctx.fillRect(cursor, y + 18, barW, h - 36);
    cursor += barW + gap;
  }
  ctx.font = font(22, 400, STACK_BASE);
  ctx.fillStyle = ink.textDim;
  ctx.fillText(TICKET_BARCODE_NOTE, x, y + h + 34);
}

/**
 * 口令正文按字号阶梯降档；降到最小仍装不下就截尾盘上省略号。
 * 这里不折行：`wrapText` 断不开带 `#`/`.` 的一整串 base64url，硬排下去只会画出卡外。
 * 截断只影响这张图——弹层里的文本框与「复制口令」永远是完整的一串。
 */
function drawCode(ctx: Ctx, ink: Ink, code: string, x: number, y: number, w: number): void {
  if (!code) return;
  let size = CODE_SIZES[CODE_SIZES.length - 1];
  for (const candidate of CODE_SIZES) {
    ctx.font = font(candidate, 500, STACK_NUM);
    if (ctx.measureText(code).width <= w) {
      size = candidate;
      break;
    }
  }
  ctx.font = font(size, 500, STACK_NUM);
  ctx.fillStyle = ink.textDim;
  ctx.fillText(shrinkToFit(ctx, code, w), x, y);
}

/**
 * 排版主入口：只管画，不管取数。
 * 单独导出是为了让几何能被测试钉住（坐标 NaN 在画布上只会静默不画）。
 */
export function composeTicketCard(ctx: Ctx, content: TicketContent, assets: PostcardAssets): void {
  ctx.save();
  ctx.clearRect(0, 0, TICKET_W, TICKET_H);
  ctx.textBaseline = 'alphabetic';
  const ink = inkOf(content.accent);

  const gradient = ctx.createLinearGradient(0, 0, TICKET_W * 0.6, TICKET_H);
  gradient.addColorStop(0, ink.bgTop);
  gradient.addColorStop(1, ink.bgBottom);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, TICKET_W, TICKET_H);
  if (assets.hero) drawAmbient(ctx, assets.hero, 0, 0, TICKET_W, TICKET_H, 0.32);
  ctx.fillStyle = hsla(0, 0, 0, 0.46);
  ctx.fillRect(0, 0, TICKET_W, TICKET_H);

  drawTear(ctx, ink);

  /* 左联：片名与这一刻 */
  drawTag(ctx, ink, '观影口令', TICKET_PAD, 64);

  ctx.fillStyle = ink.text;
  ctx.font = font(56, 700, STACK_BASE);
  const lines = wrapText(ctx, content.title || '未命名', 584, 2);
  let dy = 190;
  for (const line of lines) {
    ctx.fillText(line, TICKET_PAD, dy);
    dy += 72;
  }

  const info = [content.episodeLabel, content.meta].filter(Boolean).join(' · ');
  if (info) {
    ctx.font = font(28, 400, STACK_BASE);
    ctx.fillStyle = ink.textDim;
    ctx.fillText(shrinkToFit(ctx, info, 584), TICKET_PAD, dy + 30);
  }

  ctx.font = font(30, 600, STACK_BASE);
  ctx.fillStyle = ink.accent;
  ctx.fillText(TICKET_CAPTION[content.viewer], TICKET_PAD, 356);

  const barY = 380;
  const barW = 584;
  ctx.fillStyle = ink.hairline;
  traceRoundRect(ctx, TICKET_PAD, barY, barW, 7, 3.5);
  ctx.fill();
  const known = content.durationSec > 0 && content.positionSec >= 0;
  if (known) {
    ctx.fillStyle = ink.accent;
    traceRoundRect(ctx, TICKET_PAD, barY, Math.max(7, barW * clamp(content.positionSec / content.durationSec, 0, 1)), 7, 3.5);
    ctx.fill();
  }

  /* 右联（撕下来那一半）：这一刻的时间 + 装饰条码 */
  ctx.font = font(22, 600, STACK_BASE);
  ctx.fillStyle = ink.textDim;
  ctx.fillText('PEANUTMOV', STUB_X, 72);

  ctx.font = font(24, 500, STACK_BASE);
  ctx.fillStyle = ink.accent;
  ctx.fillText('看到', STUB_X, 116);

  ctx.font = font(54, 600, STACK_NUM);
  ctx.fillStyle = ink.text;
  ctx.fillText(formatPlayerClock(content.positionSec), STUB_X, 182);
  if (content.durationSec > 0) {
    ctx.font = font(24, 500, STACK_NUM);
    ctx.fillStyle = ink.textDim;
    ctx.fillText(`/ ${formatPlayerClock(content.durationSec)}`, STUB_X, 218);
  }

  drawBarcode(ctx, ink, content.code, STUB_X, 244, STUB_W, 112);

  ctx.font = font(22, 400, STACK_BASE);
  ctx.fillStyle = ink.textDim;
  ctx.fillText(formatDateStamp(), STUB_X, 420);

  /* 底栏整条留给口令正文：这串是要被人复制的东西，宽度优先给它 */
  ctx.strokeStyle = ink.hairline;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(TICKET_PAD, 436);
  ctx.lineTo(TICKET_W - TICKET_PAD, 436);
  ctx.stroke();

  drawCode(ctx, ink, content.code, TICKET_PAD, 492, TICKET_W - TICKET_PAD * 2);
}

/* ---------- 取数与导出 ---------- */

/** 票根的图只取海报（没有本机抽帧档：口令卡要的是"坐标"，不是画面） */
export async function loadTicketAssets(content: TicketContent): Promise<PostcardAssets> {
  return loadPostcardAssets(
    {
      title: content.title,
      meta: content.meta,
      episodeLabel: content.episodeLabel,
      line: null,
      positionSec: content.positionSec,
      durationSec: content.durationSec,
      posterUrl: content.posterUrl,
      frames: [],
      accent: content.accent,
    },
    'poster',
  );
}

export async function renderTicketCard(content: TicketContent): Promise<Blob> {
  const assets = await loadTicketAssets(content);
  return drawToPng(TICKET_W, TICKET_H, (ctx) => composeTicketCard(ctx, content, assets));
}

/** 与明信片各占一个目录：票根覆盖票根，绝不覆盖用户刚存的明信片 */
const TICKET_TARGET: ImageExportTarget = { dir: 'tickets', path: 'tickets/ticket.png', fileName: 'ticket.png' };

export function shareTicketCard(
  blob: Blob,
  title: string,
): Promise<{ ok: boolean; reason?: PostcardFailReason; message?: string }> {
  return shareImageBlob(blob, title, TICKET_TARGET);
}
