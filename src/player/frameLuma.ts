/**
 * 画面亮度场取样（弹幕智能配色的像素来源，11-17）
 *
 * 两条引擎各一条路：
 * - WebView 引擎：`drawImage(video, …)` 画进 32×18 的临时画布，一次只读 576 格；
 * - 原生 ExoPlayer：surface 垫在 WebView 之下，DOM 里没有视频元素可画，只能让原生
 *   `PixelCopy` 抓帧后回传 576 格亮度（`ExoPlayer.sampleFrameLuma`）。
 *
 * 两条路都只采得到**内容区**，信箱黑边由这里铺成 0（黑）后交出去：黑边上的白字本来
 * 就看得清，判成暗背景正好保持原色，比按画面边缘的颜色误判要安全。
 *
 * 每格存的是 WCAG 相对亮度 ×255（不是 gamma 域的 RGB 均值）：用后者会把中间调判得偏亮，
 * 白字在普通画面上就会被无端改色。
 *
 * 失败分两类，调用方要的区别只有"还要不要继续问"：
 * - 返回 `null` = 这一轮拿不到（首帧未到、桥还在路上），下一轮再说；
 * - 抛 `FrameLumaUnavailableError` = 这条路永远拿不到（画布被跨域视频污染、原生
 *   不是 SurfaceView、老安装包没有该方法），调用方据此关掉功能而不是空转。
 */
import { LUMA_COLS, LUMA_ROWS, type LumaField } from '@/player/danmakuContrast';
import { ExoPlayer } from '@/native/exoPlayerPlugin';
import type { ResizeMode } from '@/types';

/** 永远拿不到帧的原因（区别于"这一轮没有"） */
export type FrameLumaBlockReason = 'tainted' | 'unsupported' | 'no-video';

/** 这条路永久不通：调用方据此关掉功能，而不是空转轮询 */
export class FrameLumaUnavailableError extends Error {
  readonly reason: FrameLumaBlockReason;

  constructor(reason: FrameLumaBlockReason, message: string) {
    super(message);
    this.name = 'FrameLumaUnavailableError';
    this.reason = reason;
  }
}

/** 归一化矩形（0~1），描述内容区在画布里的位置 */
export interface ContentBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const FULL_BOX: ContentBox = { left: 0, top: 0, width: 1, height: 1 };

/** 取样入口：给定画布尺寸与画面比例，回一张覆盖整块画布的亮度场 */
export type FrameLumaSource = (
  canvasWidth: number,
  canvasHeight: number,
  resize: ResizeMode,
) => LumaField | null | Promise<LumaField | null>;

/** `object-fit: contain` 下内容区在画布里的归一化矩形；拿不到视频尺寸视为铺满 */
export function containBox(
  canvasWidth: number,
  canvasHeight: number,
  videoWidth: number,
  videoHeight: number,
): ContentBox {
  if (canvasWidth <= 0 || canvasHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return FULL_BOX;
  const scale = Math.min(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const width = (videoWidth * scale) / canvasWidth;
  const height = (videoHeight * scale) / canvasHeight;
  return { left: (1 - width) / 2, top: (1 - height) / 2, width, height };
}

/** sRGB 8bit 单通道 → 线性分量（与 `danmakuContrast.channel` 同一口径） */
function linearize(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** 内容区格子 → 铺满画布的亮度场（格外为 0 = 黑边） */
export function fitCells(cells: ArrayLike<number>, box: ContentBox, out?: Uint8Array): Uint8Array {
  const field = out ?? new Uint8Array(LUMA_COLS * LUMA_ROWS);
  field.fill(0);
  const bw = Math.min(1, Math.max(0, box.width));
  const bh = Math.min(1, Math.max(0, box.height));
  const bl = Math.min(1, Math.max(0, box.left));
  const bt = Math.min(1, Math.max(0, box.top));
  for (let r = 0; r < LUMA_ROWS; r += 1) {
    const y = (r + 0.5) / LUMA_ROWS;
    if (y < bt || y > bt + bh || bh <= 0) continue;
    const sy = Math.min(LUMA_ROWS - 1, Math.max(0, Math.floor(((y - bt) / bh) * LUMA_ROWS)));
    for (let c = 0; c < LUMA_COLS; c += 1) {
      const x = (c + 0.5) / LUMA_COLS;
      if (x < bl || x > bl + bw || bw <= 0) continue;
      const sx = Math.min(LUMA_COLS - 1, Math.max(0, Math.floor(((x - bl) / bw) * LUMA_COLS)));
      field[r * LUMA_COLS + c] = cells[sy * LUMA_COLS + sx] ?? 0;
    }
  }
  return field;
}

let scratch: CanvasRenderingContext2D | null = null;

function ensureScratch(): CanvasRenderingContext2D | null {
  if (scratch) return scratch;
  if (typeof document === 'undefined') return null;
  const el = document.createElement('canvas');
  el.width = LUMA_COLS;
  el.height = LUMA_ROWS;
  // 每轮都要读回像素，明确告诉浏览器别按 GPU 纹理优化
  scratch = el.getContext('2d', { willReadFrequently: true });
  return scratch;
}

/**
 * WebView 引擎：从 DOM 里的 `<video>` 取样。
 *
 * 跨域视频（绝大多数源站直链没开 CORS，`VideoEngine` 刻意不设 `crossOrigin`）会污染
 * 画布，`getImageData` 抛 SecurityError —— 这条路永久不通，抛出让调用方收摊。
 *
 * 调用方只在"正在播放"时取样，所以连续若干轮都找不到视频元素就说明这条引擎路本来
 * 就不通（engineKind 报错了），继续轮询没有意义。
 */
export function videoFrameLumaSource(getStage: () => HTMLElement | null): FrameLumaSource {
  const NO_VIDEO_LIMIT = 20;
  let noVideo = 0;
  return (canvasWidth, canvasHeight, resize) => {
    const video = getStage()?.querySelector('video');
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0 || video.readyState < 2) {
      if (video) noVideo = 0;
      else if ((noVideo += 1) >= NO_VIDEO_LIMIT) throw new FrameLumaUnavailableError('no-video', 'DOM 中没有视频元素');
      return null;
    }
    noVideo = 0;
    const ctx = ensureScratch();
    if (!ctx) throw new FrameLumaUnavailableError('unsupported', '无 2D 上下文');
    const box = resize === 'contain' ? containBox(canvasWidth, canvasHeight, video.videoWidth, video.videoHeight) : FULL_BOX;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, LUMA_COLS, LUMA_ROWS);
    try {
      ctx.drawImage(
        video,
        box.left * LUMA_COLS,
        box.top * LUMA_ROWS,
        Math.max(1, box.width * LUMA_COLS),
        Math.max(1, box.height * LUMA_ROWS),
      );
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SecurityError') {
        throw new FrameLumaUnavailableError('tainted', '画布被跨域视频污染');
      }
      return null;
    }
    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, LUMA_COLS, LUMA_ROWS).data;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'SecurityError') {
        throw new FrameLumaUnavailableError('tainted', '画布被跨域视频污染');
      }
      return null;
    }
    const cells = new Uint8Array(LUMA_COLS * LUMA_ROWS);
    for (let i = 0; i < cells.length; i += 1) {
      const luma = 0.2126 * linearize(data[i * 4] ?? 0) + 0.7152 * linearize(data[i * 4 + 1] ?? 0) + 0.0722 * linearize(data[i * 4 + 2] ?? 0);
      cells[i] = Math.round(Math.min(1, Math.max(0, luma)) * 255);
    }
    return { cells, at: performance.now() };
  };
}

/**
 * 原生引擎：桥接 `ExoPlayer.sampleFrameLuma`。
 *
 * 原生只认 surface（= 内容区），并把它在播放器容器里的归一化矩形一起回传；JS 侧据此
 * 把格子铺到整块弹幕画布上（画布比容器略大时，多出来的一圈按黑边处理）。
 * `pending` 闸门保证不等桥的轮次不会排队堆积。
 */
export function nativeFrameLumaSource(): FrameLumaSource {
  let pending = false;
  const field: LumaField = { cells: new Uint8Array(LUMA_COLS * LUMA_ROWS), at: 0 };
  return async () => {
    if (pending) return null;
    pending = true;
    let result: Awaited<ReturnType<typeof ExoPlayer.sampleFrameLuma>>;
    try {
      result = await ExoPlayer.sampleFrameLuma({ cols: LUMA_COLS, rows: LUMA_ROWS });
    } catch (e) {
      // 老安装包没有该方法 / 插件未注册：桥异常是永久性的
      throw new FrameLumaUnavailableError('unsupported', e instanceof Error ? e.message : 'sampleFrameLuma 不可用');
    } finally {
      pending = false;
    }
    if (result.unsupported === true) throw new FrameLumaUnavailableError('unsupported', '原生 surface 不可截取');
    if (result.available !== true || !Array.isArray(result.cells)) return null;
    fitCells(result.cells, result.box ?? FULL_BOX, field.cells);
    field.at = performance.now();
    return field;
  };
}
