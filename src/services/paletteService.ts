/**
 * 动态取色（详情页 / 播放页作用域染色）
 *
 * 海报是跨域资源，把 `<img>` 直接画进 canvas 会污染位图（`getImageData` 抛 SecurityError），
 * 所以统一走 `requestBytes` 拿字节流，再用 blob URL 解码后取样。
 *
 * 只缓存「海报主色」这一事实（HSL），角色色（填充 / 文字 / 描边阴影）在应用时按当前主题
 * 与页面底色现算——同一份缓存深浅色两套主题都能用。「看过这张、判定它没有主色」同样落库
 * （负记录），灰调海报不会被反复重新解码。
 *
 * 消费方分两条路：`paletteForPoster` 会补齐缓存（可能要拉海报字节），`peekPalette` 只读缓存
 * ——整墙浏览要用后者，否则首屏会变成几十张大图请求。
 */
import { kvRepo } from '@/db/repositories/kvRepo';
import { requestBytes } from '@/services/danmaku/nativeHttp';
import { logger } from '@/shared/logger';

/** 海报主色（HSL，h 0-360，s/l 0-1） */
export interface PaletteSeed {
  h: number;
  s: number;
  l: number;
}

type Rgb = [number, number, number];

const KV_PREFIX = 'palette:v1:';
const MEM_LIMIT = 50;
const FETCH_TIMEOUT_MS = 6000;
/** 取样画布尺寸：够统计主色，又不至于在低端机上产生可感知开销 */
const SAMPLE_W = 36;
const SAMPLE_H = 54;
/** 主色门槛：达不到就不染色（灰调海报染出来与默认琥珀无差别，反而丢品牌识别） */
const MIN_BUCKET_SHARE = 0.08;
const MIN_SEED_SATURATION = 0.18;
/** 文字级用途的 WCAG 下限（与设计规范 §9 的 AA 口径一致） */
const MIN_TEXT_CONTRAST = 4.5;
/** 填充色上的反白/反黑文字下限；达不到则换另一个方向 */
const MIN_INK_CONTRAST = 4.5;

const PALETTE_VARS = [
  '--color-brand',
  '--color-brand-strong',
  '--color-brand-press',
  '--color-brand-text',
  '--color-brand-ink',
  '--color-text-on-brand',
  '--color-brand-soft',
  '--gradient-brand',
  '--shadow-brand',
  '--shadow-focus',
] as const;

const memCache = new Map<string, PaletteSeed | null>();
const inflight = new Map<string, Promise<PaletteSeed | null>>();

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** FNV-1a：海报 URL 可能很长且带签名参数，压成短键再落库 */
function cacheKey(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${KV_PREFIX}${(hash >>> 0).toString(36)}`;
}

/* ---------- 色彩换算 ---------- */

function hslToRgb(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [channel(0) * 255, channel(8) * 255, channel(4) * 255];
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function toRgba(rgb: Rgb, alpha: number): string {
  return `rgba(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])}, ${alpha})`;
}

function channelLuminance(c255: number): number {
  const v = c255 / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: Rgb): number {
  return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 把明度推到满足对比度的位置。方向按底色自动判定：
 * 浅底往暗推、深底往亮推，避免在浅底上把主色越推越亮反而更看不清。
 */
function fitLightness(h: number, s: number, start: number, bg: Rgb, min: number): number {
  const dir = luminance(bg) > 0.35 ? -1 : 1;
  let l = clamp(start, 0, 1);
  for (let i = 0; i < 50; i += 1) {
    if (contrast(hslToRgb(h, s, l), bg) >= min) return l;
    const next = clamp(l + dir * 0.02, 0, 1);
    if (next === l) break;
    l = next;
  }
  return l;
}

/* ---------- 主色取样 ---------- */

function mimeOf(url: string): string | undefined {
  const clean = url.split(/[?#]/)[0] ?? url;
  const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
    bmp: 'image/bmp',
  };
  return map[ext];
}

async function decode(bytes: Uint8Array, url: string): Promise<ImageBitmap | null> {
  const mime = mimeOf(url);
  try {
    return await createImageBitmap(new Blob([bytes], mime ? { type: mime } : undefined));
  } catch {
    // 源站扩展名与实际编码不符（爬虫源常见）：交给浏览器的内容嗅探再试一次
    try {
      return await createImageBitmap(new Blob([bytes]));
    } catch {
      return null;
    }
  }
}

/**
 * `data:` / `blob:` 海报（演示条目、本地缓存封面）直接解码，不取字节流。
 * 这两类 URL 同源，不会污染画布。
 */
async function decodeInline(url: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  return img.naturalWidth > 0 ? img : null;
}

/** 24 个色相桶做加权统计；权重偏向高饱和与画面中部（封面主体通常在中间） */
function dominantOf(source: CanvasImageSource & { close?: () => void }): PaletteSeed | null {
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, SAMPLE_W, SAMPLE_H);
  source.close?.();

  let data: ImageData;
  try {
    data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
  } catch {
    return null;
  }

  interface Bucket {
    weight: number;
    sat: number;
    light: number;
    hx: number;
    hy: number;
  }
  const buckets = new Map<number, Bucket>();
  let total = 0;
  const pixels = data.data;

  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const { h, s, l } = rgbToHsl(pixels[i] ?? 0, pixels[i + 1] ?? 0, pixels[i + 2] ?? 0);
    if (s < 0.12 || l < 0.1 || l > 0.92) continue;

    const px = (i / 4) % SAMPLE_W;
    const py = Math.floor(i / 4 / SAMPLE_W);
    const centerBias = clamp(1 - (Math.abs(px / SAMPLE_W - 0.5) + Math.abs(py / SAMPLE_H - 0.5)) * 0.6, 0.4, 1);
    const weight = s * s * centerBias;
    if (weight <= 0) continue;

    const key = Math.round(h / 15) % 24;
    const bucket = buckets.get(key) ?? { weight: 0, sat: 0, light: 0, hx: 0, hy: 0 };
    const rad = (h * Math.PI) / 180;
    bucket.weight += weight;
    bucket.sat += weight * s;
    bucket.light += weight * l;
    bucket.hx += weight * Math.cos(rad);
    bucket.hy += weight * Math.sin(rad);
    buckets.set(key, bucket);
    total += weight;
  }

  let best: { key: number; bucket: Bucket } | null = null;
  for (const [key, bucket] of buckets) {
    if (!best || bucket.weight > best.bucket.weight) best = { key, bucket };
  }
  if (!best || total <= 0) return null;
  if (best.bucket.weight / total < MIN_BUCKET_SHARE) return null;

  const mean = (value: number): number => value / best.bucket.weight;
  const s = mean(best.bucket.sat);
  if (s < MIN_SEED_SATURATION) return null;

  return {
    h: ((Math.atan2(mean(best.bucket.hy), mean(best.bucket.hx)) * 180) / Math.PI + 360) % 360,
    s,
    l: clamp(mean(best.bucket.light), 0.12, 0.88),
  };
}

/** `null` 也进缓存：判定过不可染色的海报不该每次进详情页都重试一遍网络 */
function memoize(key: string, seed: PaletteSeed | null): void {
  if (memCache.has(key)) memCache.delete(key);
  memCache.set(key, seed);
  while (memCache.size > MEM_LIMIT) {
    const oldest = memCache.keys().next();
    if (oldest.done) break;
    memCache.delete(oldest.value);
  }
}

const REMOTE_URL = /^https?:\/\//i;
const INLINE_URL = /^(data:image|blob:)/i;

/** 200 空响应在原生通路是空 Uint8Array（base64 缺省），先拦掉再解码，别走异常通道 */
async function decodeRemote(url: string): Promise<ImageBitmap | null> {
  const bytes = await requestBytes(url, { timeoutMs: FETCH_TIMEOUT_MS, retries: 0 });
  if (bytes.byteLength === 0) return null;
  return decode(bytes, url);
}

/** 落库形态：主色本身，或「判定过无主色」的负记录 */
type CachedSeed = PaletteSeed | { none: true };

/**
 * 读缓存，并把「查过但是灰调」与「根本没查过」分开——`kvRepo.get` 对两者都返回 null，
 * 所以负结论要落成 `{none:true}`。色相墙靠这个区分决定要不要补取色，
 * 详情页靠它决定要不要重新解码。
 */
async function readCached(key: string): Promise<{ state: 'cold' } | { state: 'known'; seed: PaletteSeed | null }> {
  try {
    const stored = await kvRepo.get<CachedSeed>(key);
    if (!stored) return { state: 'cold' };
    if ('none' in stored) return { state: 'known', seed: null };
    if (typeof stored.h !== 'number') return { state: 'cold' };
    const seed: PaletteSeed = { h: stored.h, s: stored.s, l: stored.l };
    memoize(key, seed);
    return { state: 'known', seed };
  } catch (e) {
    logger.warn('读取取色缓存失败', e);
    return { state: 'cold' };
  }
}

async function extract(url: string): Promise<PaletteSeed | null> {
  const key = cacheKey(url);
  const remote = REMOTE_URL.test(url);
  if (remote) {
    const cached = await readCached(key);
    if (cached.state === 'known') return cached.seed;
  }

  const source = remote ? await decodeRemote(url) : await decodeInline(url);
  if (!source) return null;
  const seed = dominantOf(source);
  memoize(key, seed);
  if (remote) void kvRepo.set(key, seed ?? { none: true }).catch(() => undefined);
  return seed;
}

/**
 * 取海报主色：内存 → IndexedDB → 取样。
 * 任何一步失败都返回 `null`，调用方保持默认品牌色（不阻塞、不提示）。
 */
export function paletteForPoster(url: string | null | undefined): Promise<PaletteSeed | null> {
  if (!url || !(REMOTE_URL.test(url) || INLINE_URL.test(url))) return Promise.resolve(null);
  const key = cacheKey(url);
  if (memCache.has(key)) return Promise.resolve(memCache.get(key) ?? null);

  const running = inflight.get(key);
  if (running) return running;

  const task = extract(url)
    .catch((e: unknown) => {
      logger.warn('海报取色失败', e);
      memoize(key, null);
      return null;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, task);
  return task;
}

/** `peekPalette` 的结果：`known=false` 表示缓存里还没有这条海报的任何结论 */
export interface PalettePeek {
  known: boolean;
  seed: PaletteSeed | null;
}

/**
 * 只读缓存的取色（色相墙用）：内存 → IndexedDB，**绝不解码、绝不联网**。
 *
 * 与 `paletteForPoster` 的唯一区别就是这条边界——整墙浏览时不该为了排版去拉几十张海报字节。
 * `known: false` 时才值得回头调 `paletteForPoster` 补取；`known: true, seed: null` 是
 * 「已经判定过这是灰调海报」，再取也不会有结果。
 */
export async function peekPalette(url: string | null | undefined): Promise<PalettePeek> {
  if (!url || !REMOTE_URL.test(url)) return { known: false, seed: null };
  const key = cacheKey(url);
  if (memCache.has(key)) return { known: true, seed: memCache.get(key) ?? null };
  const cached = await readCached(key);
  return cached.state === 'known' ? { known: true, seed: cached.seed } : { known: false, seed: null };
}

/**
 * 取海报的可绘制图：与 `paletteForPoster` 共用同一条解码通路（那边只要主色，这边要整张图）。
 *
 * 跨源海报仍然走字节流——直接把远程 URL 挂到 `img` 上再画进画布会污染画布，
 * 之后连 `toBlob` 都调不动（明信片正是要导出，所以必须复用这条通路）。
 * 任何一步失败都返回 null：调用方自己留空位并说明原因，不画假图。
 */
export async function loadPosterImage(
  url: string | null | undefined,
): Promise<ImageBitmap | HTMLImageElement | null> {
  if (!url || !(REMOTE_URL.test(url) || INLINE_URL.test(url))) return null;
  try {
    return REMOTE_URL.test(url) ? await decodeRemote(url) : await decodeInline(url);
  } catch (e) {
    logger.debug('海报解码失败', { error: (e as Error)?.message ?? String(e) });
    return null;
  }
}

/* ---------- 角色色派生 ---------- */

const DARK_FALLBACK_BG: Rgb = [0, 0, 0];
const LIGHT_FALLBACK_BG: Rgb = [237, 239, 243];

function parseRgb(raw: string): Rgb | null {
  const match = raw.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : Number(match[4]);
  if (alpha < 0.95) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** 页面实际底色：拿元素自身的背景色，取不到时按主题兜底 */
export function pageBackground(el: HTMLElement): Rgb {
  const computed = parseRgb(window.getComputedStyle(el).backgroundColor);
  if (computed) return computed;
  const parent = el.parentElement;
  if (parent && parent !== document.body) return pageBackground(parent);
  return document.documentElement.getAttribute('data-theme') === 'light' ? LIGHT_FALLBACK_BG : DARK_FALLBACK_BG;
}

/**
 * 派生作用域内覆盖的品牌色变量组。
 * 只覆盖品牌族 + 由品牌族组成的渐变/阴影，中性色（背景、文字、分割线）一律不动。
 */
export function deriveVars(seed: PaletteSeed, bg: Rgb): Record<string, string> {
  const h = seed.h;
  const s = clamp(Math.max(seed.s, 0.4), 0, 0.92);
  const dark = luminance(bg) < 0.35;

  // 填充色：保留海报明度倾向，但锁在「有色相又不刺眼」的区间
  const fillL = clamp(dark ? clamp(seed.l, 0.4, 0.58) : clamp(seed.l, 0.3, 0.46), 0, 1);
  const fillRgb = hslToRgb(h, s, fillL);
  const whiteInk = contrast([255, 255, 255], fillRgb);
  const darkInk = contrast([23, 15, 0], fillRgb);
  const inkOnFill =
    whiteInk >= MIN_INK_CONTRAST
      ? '#FFFFFF'
      : darkInk >= MIN_INK_CONTRAST
        ? '#170F00'
        : whiteInk >= darkInk
          ? '#FFFFFF'
          : '#170F00';

  const textL = fitLightness(h, s, dark ? 0.66 : 0.36, bg, MIN_TEXT_CONTRAST);
  const textRgb = hslToRgb(h, s, textL);
  const strongS = Math.min(s + 0.06, 0.95);
  const strongL = fitLightness(h, strongS, textL, bg, MIN_TEXT_CONTRAST);
  const strongRgb = hslToRgb(h, strongS, strongL);
  const pressL = clamp(fillL + (dark ? -0.08 : -0.06), 0.06, 0.94);
  const pressRgb = hslToRgb(h, s, pressL);

  return {
    '--color-brand': toHex(fillRgb),
    '--color-brand-strong': toHex(strongRgb),
    '--color-brand-press': toHex(pressRgb),
    '--color-brand-text': toHex(textRgb),
    '--color-brand-ink': inkOnFill,
    '--color-text-on-brand': inkOnFill,
    '--color-brand-soft': toRgba(textRgb, dark ? 0.14 : 0.12),
    '--gradient-brand': `linear-gradient(135deg, ${toHex(strongRgb)} 0%, ${toHex(fillRgb)} 55%, ${toHex(pressRgb)} 100%)`,
    '--shadow-brand': `0 6px 22px ${toRgba(fillRgb, 0.26)}`,
    '--shadow-focus': `0 0 0 3px ${toRgba(textRgb, 0.35)}`,
  };
}

/** 应用染色；返回 false 表示海报不适合染色（保持默认品牌色） */
export function applyPalette(el: HTMLElement, seed: PaletteSeed | null): boolean {
  if (!seed) return false;
  const vars = deriveVars(seed, pageBackground(el));
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
  el.dataset.palette = 'on';
  return true;
}

export function clearPalette(el: HTMLElement): void {
  for (const name of PALETTE_VARS) el.style.removeProperty(name);
  delete el.dataset.palette;
}

/** 单测辅助：清空进程内缓存，避免用例互相串色 */
export function __resetPaletteCache(): void {
  memCache.clear();
  inflight.clear();
}

/**
 * 在海报主色上偏移色相，派生一个「文字级可读」的强调色（详情页分段主色切换用）。
 * 明度沿用 `deriveVars` 里文字色的同一套对比度拟合，所以不会滚到某段就出现看不清的标题。
 */
export function accentFor(seed: PaletteSeed, hueShift: number, bg: Rgb): string {
  const h = (seed.h + hueShift + 360) % 360;
  const s = Math.max(seed.s, 0.4);
  const dark = luminance(bg) < 0.35;
  return toHex(hslToRgb(h, s, fitLightness(h, s, dark ? 0.66 : 0.36, bg, MIN_TEXT_CONTRAST)));
}
