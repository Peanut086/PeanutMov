/**
 * 弹幕渲染层（v1.7 / CHG-22）
 *
 * `<canvas>` 覆盖层 + rAF 驱动，不依赖播放器引擎：
 * - `tick(currentTimeSec)` 由外部在 timeupdate 事件注入（倍速/暂停天然对齐）；
 * - 原生引擎 1s 才轮询一次进度，帧内用 rAF 时钟在 anchor 上插值；轮询迟到的漂移
 *   按 0.8s 窗口斜率消化（`driftDebt`），不再"冻结-猛窜"；
 * - 默认跟随 rAF 逐帧重绘（~60fps），单帧成本超限自动降回 30fps；
 * - 滚动 / 顶部 / 底部三模式；同屏密度上限 `DANMAKU_MAX_ONSCREEN`；
 * - 底部安全区（字幕区）禁显；文字入场时栅格化成位图，每帧只贴图（描边文字逐帧重绘极慢）；
 * - B-04 互动：`pick()` 按点击坐标命中单条并冻结它（其余照常滚动），canvas 全程不吃指针事件；
 * - 智能配色：播放器按 ~3Hz 推一帧 32×18 亮度场（`setLumaField`），只在原色看不清时
 *   接管颜色。配色判定跟着采样节奏走而不是逐帧走——逐帧重建位图就是上面那条红线。
 * - 容器几何（旋屏 / 沉浸态 / PiP）变化后背板跟着重测：canvas 的 CSS 盒子自己会跟，
 *   背板不跟就等于把整块贴图拉伸，字号与亮度场映射一起错。
 *
 * 设计取舍：不用 DOM 弹幕（数百节点调度易掉帧），canvas 绘制成本恒定。
 */
import { DANMAKU_MAX_ONSCREEN } from '@/shared/constants';
import { averageLuma, legacyPaint, resolvePaint, type DanmakuPaint, type LumaField, type PaintRect } from '@/player/danmakuContrast';
import type { DanmakuComment, DanmakuSettings } from '@/types';

interface Track {
  comment: DanmakuComment;
  /** 通道（滚动按行，顶/底按槽位） */
  lane: number;
  /** 进入时间（秒） */
  bornAt: number;
  /** 滚动全程时长（秒） */
  duration: number;
  x: number;
  width: number;
  /** 文字位图（入场时栅格化一次，字体/像素比/配色变化后按需重建） */
  bitmap: HTMLCanvasElement | null;
  bitmapFontSize: number;
  bitmapDpr: number;
  bitmapPad: number;
  bitmapHeight: number;
  bitmapBold: boolean;
  bitmapStroke: DanmakuSettings['strokeStyle'];
  /** 位图是按哪套配色画的；与 `paint.key` 不一致才重建 */
  bitmapPaintKey: string;
  /** 当前配色（null = 还没判定过，按旧行为） */
  paint: DanmakuPaint | null;
  /** 上次判定是否处于接管态（迟滞用） */
  adapted: boolean;
}

/** 被点中的弹幕：钉在点中瞬间的坐标上，其余条目照常滚动 */
interface Pick {
  track: Track;
  x: number;
  y: number;
  /** 冻结时已走完的比例，解冻后按它续接，不回头也不瞬移 */
  progress: number;
  lifespan: number;
}

export interface DanmakuPick {
  comment: DanmakuComment;
  /** 条目在弹幕容器内的 CSS px 矩形（含位图留白），操作条按它定位 */
  rect: { left: number; top: number; width: number; height: number };
}

const SCROLL_LANE_HEIGHT_RATIO = 0.12;
/** 顶/底固定条目的驻留时长（秒） */
const FIXED_LIFESPAN_SEC = 4;
/** 命中框在文字矩形外放大的触控余量：弹幕才十几个像素高，按字面框点几乎点不中 */
const HIT_PAD_X = 4;
const HIT_MIN_HEIGHT = 32;
/** 成本超限时的降帧闸门间隔（30fps 兜底）：实测逐帧重绘单帧均值 ~0.5ms，正常不触发 */
const FRAME_INTERVAL_MS = 33;
const COST_DEGRADE_MS = 8;
const COST_RECOVER_MS = 4;
/** 进度轮询间隔 1s，帧内插值最多向前补 2.5s（1.2s 时桥接迟到 3s 会造成 1.4s+ 的弹幕冻结） */
const MAX_EXTRAPOLATE_SEC = 2.5;
/** 漂移斜率消化的时间窗 */
const DRIFT_SLEW_WINDOW_MS = 800;
/** 小于该漂移直接硬对齐（肉眼不可见，不值得引入变速） */
const DRIFT_TOLERANCE_SEC = 0.05;
/** 超过该漂移视为 seek/换集（含前跳），清轨道重定位游标 */
const BIG_JUMP_SEC = 2;
/**
 * 几何落定窗口（毫秒）。与 `NativeEngine` 的画面对齐同一套口径：旋屏/全屏时视口分几步落定，
 * 单次防抖会停在中间态（那边真机实测错位数秒），所以变化后逐帧追到尺寸不再变才收工。
 */
const RECT_SETTLE_MS = 2000;

export class DanmakuOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private comments: DanmakuComment[] = [];
  private cursor = 0;
  private tracks: Track[] = [];
  private picked: Pick | null = null;
  private settings: DanmakuSettings;
  private getTime: () => number;
  private isPlaying: () => boolean;
  private getRate: () => number;
  private lastTime = -1;
  /** 最近一次 timeupdate 的媒体时间与到达时刻（帧内插值的锚点） */
  private anchorTime = 0;
  private anchorStamp = 0;
  /** 待消化的锚点漂移（秒），在 `DRIFT_SLEW_WINDOW_MS` 内线性衰减到 0 */
  private driftDebt = 0;
  private debtStamp = 0;
  /** 成本超限时的降帧闸门（0 = 跟随 rAF 逐帧重绘） */
  private frameGateMs = 0;
  private costEma = 0;
  private wasPlaying = false;
  private dpr = 1;
  private lastFrameAt = 0;
  private lastDrawnTime = Number.NaN;
  private canvasWidth = 0;
  private canvasHeight = 0;
  /** 最近一帧画面亮度场（null = 还没有 / 智能配色不可用） */
  private lumaField: LumaField | null = null;
  /** 上一次真正套用过的几何（`宽x高x像素比`）；一致就跳过 resize()，别空跑清画布 */
  private sizeKey = '';
  private rectObserver: ResizeObserver | null = null;
  private rectSettleRaf: number | null = null;
  private rectSettleUntil = 0;
  /** 事件回调句柄（卸载时要拿同一个函数去 removeEventListener） */
  private onGeometryChange: (() => void) | null = null;

  constructor(options: {
    settings: DanmakuSettings;
    getTime: () => number;
    isPlaying?: () => boolean;
    getRate?: () => number;
  }) {
    this.settings = options.settings;
    this.getTime = options.getTime;
    this.isPlaying = options.isPlaying ?? (() => false);
    this.getRate = options.getRate ?? (() => 1);
  }

  /** 挂载到容器（覆盖层，pointer-events:none 不挡手势） */
  attach(container: HTMLElement): void {
    this.detach();
    const canvas = document.createElement('canvas');
    canvas.className = 'danmaku-overlay';
    // 层级走岛内尺度（--z-danmaku:2，在字幕 3 / 微进度 4 / HUD 5 之下）；
    // 原先写死 5 与 HUD 同层，弹幕会盖住字幕和手势反馈。取不到变量时退回 2。
    canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:var(--z-danmaku,2);';
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    this.watchGeometry();
    this.start();
  }

  detach(): void {
    this.stop();
    this.teardownGeometry();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    // 下一轮 attach 必须先量一次：新 canvas 的 width/height 还是默认的 300×150
    this.sizeKey = '';
    this.tracks = [];
    this.picked = null;
  }

  setSettings(settings: DanmakuSettings): void {
    const prev = this.settings;
    this.settings = settings;
    // 字号变化：所有已入屏位图作废，下次绘制时按新字号重建
    if (settings.fontSize !== prev.fontSize) {
      for (const track of this.tracks) {
        track.bitmap = null;
        track.width = this.measure(track.comment.text);
      }
    }
    // 速度变化：按比例重算已入屏 track 的剩余时长，视觉速度连续不跳变
    if (settings.speed !== prev.speed) {
      const now = this.currentTime();
      for (const track of this.tracks) {
        const oldDuration = track.duration;
        const newDuration = Math.max(4, 10 / Math.max(0.5, settings.speed));
        const age = now - track.bornAt;
        const ratio = age / oldDuration;
        track.duration = newDuration;
        track.bornAt = now - ratio * newDuration;
      }
    }
    // 区域/安全区变化：裁剪超出新 laneCount 的固定弹幕轨道
    if (settings.areaPercent !== prev.areaPercent || settings.safeBottomPercent !== prev.safeBottomPercent) {
      const newLanes = this.laneCount('scroll');
      this.tracks = this.tracks.filter((t) => t.comment.mode !== 'scroll' || t.lane < newLanes);
      // 区域一改，原坐标就不可信了；冻结的条目直接放行
      this.picked = null;
    }
    // 智能配色开关变化：关掉时立刻把接管的条目交还原色，开启时等下一帧亮度场
    if (settings.autoContrast !== prev.autoContrast && settings.autoContrast === false) this.lumaField = null;
    this.refreshPaints();
    this.resize();
    this.lastDrawnTime = Number.NaN;
  }

  /** 弹幕容器尺寸（CSS px）：取样方按它把亮度场铺成整块画布 */
  get canvasSize(): { width: number; height: number } {
    return { width: this.canvasWidth, height: this.canvasHeight };
  }

  /**
   * 推一帧画面亮度场（播放器侧按 ~3Hz 调用）。
   *
   * 配色只在采样节奏上重算（每帧重算要逐条读网格 + 重建位图，是这层明确要避免的成本），
   * 判定结果没变的条目位图继续复用。传 null 表示"这条路取不到帧"，全部退回旧行为。
   */
  setLumaField(field: LumaField | null): void {
    this.lumaField = this.settings.autoContrast ? field : null;
    this.refreshPaints();
  }

  /** 逐条重算配色，变了才让位图作废 */
  private refreshPaints(): void {
    for (const track of this.tracks) {
      const paint = this.paintOf(track);
      track.adapted = paint.adapted;
      if (paint.key !== track.paint?.key) {
        track.paint = paint;
        track.bitmap = null;
      }
    }
  }

  /** 单条弹幕的配色：取不到帧 / 开关关掉 → 旧行为 */
  private paintOf(track: Track): DanmakuPaint {
    const fallback = legacyPaint(track.comment.color);
    if (!this.settings.autoContrast || this.lumaField === null) return fallback;
    const bg = averageLuma(this.lumaField, this.paintRectOf(track), this.canvasWidth, this.canvasHeight);
    return resolvePaint(track.comment.color, bg, track.adapted) ?? fallback;
  }

  /** 条目的绘制矩形（CSS px，含描边留白），与 `drawTrack` 的落点一致 */
  private paintRectOf(track: Track): PaintRect {
    const height = track.bitmapHeight || Math.ceil(this.settings.fontSize * 1.5);
    const pad = track.bitmapPad || 4;
    const centered = track.comment.mode !== 'scroll';
    const x = centered ? (this.canvasWidth - track.width) / 2 : track.x;
    const baseline = centered
      ? this.fixedBaselineY(track.comment.mode as 'top' | 'bottom', track.lane)
      : this.scrollBaselineY(track.lane);
    return { left: x - pad, top: baseline - height / 2, width: track.width + pad * 2, height };
  }

  /** 全量替换弹幕（已按时间排序；merge 由服务层完成） */
  load(comments: DanmakuComment[]): void {
    this.comments = [...comments].sort((a, b) => a.time - b.time);
    this.cursor = 0;
    this.tracks = [];
    this.picked = null;
  }

  clear(): void {
    this.comments = [];
    this.cursor = 0;
    this.tracks = [];
    this.picked = null;
    this.redraw();
  }

  /** 每帧由 timeupdate 驱动：seek（含前跳/换集）时清轨道重定位；小漂移斜率消化 */
  tick(currentTimeSec: number): void {
    const stamp = performance.now();
    const predicted = this.anchorStamp === 0 ? currentTimeSec : this.extrapolate(stamp);
    const drift = currentTimeSec - predicted;
    const absDrift = Math.abs(drift);
    const seekJump = currentTimeSec < this.lastTime - 1 || absDrift > BIG_JUMP_SEC;
    if (seekJump) {
      // seek/换集（前跳与回跳同等处理）：清空轨道，二分重定位游标
      this.tracks = [];
      this.picked = null;
      this.driftDebt = 0;
      this.cursor = this.lowerBound(currentTimeSec);
    } else if (absDrift > DRIFT_TOLERANCE_SEC) {
      // 轮询迟到的中等漂移：不硬拽锚点，把差值摊到接下来 0.8s 内平滑消化
      this.driftDebt = -drift;
      this.debtStamp = stamp;
    }
    this.lastTime = currentTimeSec;
    this.anchorTime = currentTimeSec;
    this.anchorStamp = stamp;
  }

  /** 有序数组上第一个 time >= target 的下标（游标重定位用，替代 O(n) findIndex） */
  private lowerBound(target: number): number {
    let lo = 0;
    let hi = this.comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.comments[mid] as DanmakuComment).time >= target) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** 帧内时间：暂停时停在锚点，播放中按真实时钟在锚点上补间（含漂移斜率校正） */
  private currentTime(): number {
    if (!this.isPlaying()) {
      // 暂停/缓冲：媒体时间不前进，直接以播放器时间为准
      this.anchorTime = this.getTime();
      this.anchorStamp = performance.now();
      this.driftDebt = 0;
      this.wasPlaying = false;
      return this.anchorTime;
    }
    if (!this.wasPlaying || this.anchorStamp === 0) {
      // 开始/恢复播放：以当前锚点为起点重新计时，避免把暂停时长算进补间
      if (this.anchorStamp === 0) this.anchorTime = this.getTime();
      this.anchorStamp = performance.now();
      this.wasPlaying = true;
    }
    return this.extrapolate(performance.now());
  }

  /** 在锚点上外推媒体时间，并把 `driftDebt` 线性衰减地叠加进去 */
  private extrapolate(stamp: number): number {
    const elapsedSec = ((stamp - this.anchorStamp) / 1000) * this.getRate();
    let t = this.anchorTime + Math.max(0, Math.min(elapsedSec, MAX_EXTRAPOLATE_SEC));
    if (this.driftDebt !== 0) {
      const k = (stamp - this.debtStamp) / DRIFT_SLEW_WINDOW_MS;
      if (k >= 1) this.driftDebt = 0;
      else t += this.driftDebt * (1 - k);
    }
    return t;
  }

  /**
   * 盯着容器几何：竖屏 16:9 画面带 → 沉浸态铺满是必然会发生的一次尺寸跳变，
   * 而 canvas 的 CSS 盒子（100%×100%）跟得上、背板跟不上，整块贴图会被拉伸——
   * 表现就是弹幕字号不对，且横竖两个方向系数不同还会拉变形。
   */
  private watchGeometry(): void {
    this.teardownGeometry();
    const canvas = this.canvas;
    if (!canvas) return;
    const pump = (): void => {
      if (this.rectSettleRaf !== null) return;
      this.rectSettleRaf = requestAnimationFrame(() => {
        this.rectSettleRaf = null;
        this.resize();
        if (performance.now() < this.rectSettleUntil) pump();
      });
    };
    // 变化那一刻开一个落定窗口，逐帧量到尺寸不再变才停；ResizeObserver 的初次回调也会走进来，
    // 所以挂在 watch 回调里的首次测量，即使早于本 tick 的布局落定也追得回来
    const schedule = (): void => {
      this.rectSettleUntil = performance.now() + RECT_SETTLE_MS;
      pump();
    };
    this.onGeometryChange = schedule;
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    document.addEventListener('fullscreenchange', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
    if (typeof ResizeObserver !== 'undefined') {
      this.rectObserver = new ResizeObserver(schedule);
      this.rectObserver.observe(canvas);
    }
  }

  private teardownGeometry(): void {
    if (this.rectSettleRaf !== null) {
      cancelAnimationFrame(this.rectSettleRaf);
      this.rectSettleRaf = null;
    }
    this.rectSettleUntil = 0;
    const handler = this.onGeometryChange;
    if (handler !== null) {
      window.removeEventListener('resize', handler);
      window.removeEventListener('orientationchange', handler);
      document.removeEventListener('fullscreenchange', handler);
      window.visualViewport?.removeEventListener('resize', handler);
      this.onGeometryChange = null;
    }
    if (this.rectObserver !== null) {
      this.rectObserver.disconnect();
      this.rectObserver = null;
    }
  }

  private resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const key = `${rect.width}x${rect.height}x${dpr}`;
    // 落定窗口里每帧都会进来：给 width/height 赋值本身会清空画布，尺寸没变就别白动
    if (key === this.sizeKey) return;
    this.sizeKey = key;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    // 逻辑坐标用 CSS px：绘制时 ctx 已被 dpr 缩放，这里再用设备像素会让弹幕画到屏幕外
    this.canvasWidth = Math.max(1, rect.width);
    this.canvasHeight = Math.max(1, rect.height);
    this.dpr = dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.lastDrawnTime = Number.NaN;
  }

  private start(): void {
    if (this.rafId !== null) return;
    const loop = (): void => {
      this.frame();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private frame(): void {
    if (!this.ctx) return;
    const stamp = performance.now();
    if (stamp - this.lastFrameAt < this.frameGateMs) return;
    this.lastFrameAt = stamp;
    const now = this.currentTime();
    if (now === this.lastDrawnTime) return; // 暂停/缓冲画面不变：跳过重绘
    this.lastDrawnTime = now;
    const drawStart = performance.now();
    this.spawn(now);
    this.redraw(now);
    const costMs = performance.now() - drawStart;
    // 成本兜底：逐帧重绘持续超过 8ms 降回 30fps，回落到 4ms 以下再恢复
    this.costEma += (costMs - this.costEma) * 0.1;
    if (this.costEma > COST_DEGRADE_MS && this.frameGateMs === 0) this.frameGateMs = FRAME_INTERVAL_MS;
    else if (this.frameGateMs > 0 && this.costEma < COST_RECOVER_MS) this.frameGateMs = 0;
  }

  /** 把进入时间窗的弹幕铺进轨道 */
  private spawn(now: number): void {
    const densityCoeff = this.settings.density === 'sparse' ? 0.6 : this.settings.density === 'dense' ? 1.5 : 1;
    const maxOnScreen = Math.max(10, Math.round(DANMAKU_MAX_ONSCREEN * densityCoeff));
    while (this.cursor < this.comments.length) {
      const comment = this.comments[this.cursor]!;
      if (comment.time > now + 0.2) break;
      this.cursor += 1;
      if (now - comment.time > 1) continue; // 过期（seek 后残留）
      // 过滤顶部/底部固定弹幕
      if (this.settings.filterTop && comment.mode === 'top') continue;
      if (this.settings.filterBottom && comment.mode === 'bottom') continue;
      if (this.tracks.length >= maxOnScreen) break;
      const width = this.measure(comment.text);
      const duration = Math.max(4, 10 / Math.max(0.5, this.settings.speed));
      const lane = this.allocateLane(comment, width, duration, now);
      if (lane < 0) continue; // 该模式通道已满，丢弃（密度上限语义）
      const track: Track = {
        comment,
        lane,
        bornAt: now,
        duration,
        x: this.canvasWidth,
        width,
        bitmap: null,
        bitmapFontSize: 0,
        bitmapDpr: 0,
        bitmapPad: 0,
        bitmapHeight: 0,
        bitmapBold: this.settings.bold,
        bitmapStroke: this.settings.strokeStyle,
        bitmapPaintKey: '',
        paint: null,
        adapted: false,
      };
      // 入场时还在屏外，先按旧配色占位；下一轮亮度场（≤330ms）进来再判定
      track.paint = this.paintOf(track);
      this.tracks.push(track);
    }
  }

  private measure(text: string): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const weight = this.settings.bold ? 'bold ' : '';
    ctx.font = `${weight}${this.settings.fontSize}px sans-serif`;
    return ctx.measureText(text).width;
  }

  /** 轨道分配：滚动找最空行，顶/底找空槽；满则 -1（width/duration 预留给精确车距计算） */
  private allocateLane(comment: DanmakuComment, _width: number, _duration: number, now: number): number {
    const lanes = this.laneCount(comment.mode);
    for (let lane = 0; lane < lanes; lane += 1) {
      const occupied = this.tracks.some((track) => {
        if (track.lane !== lane || track.comment.mode !== comment.mode) return false;
        if (comment.mode === 'scroll') {
          // 同行需保持车距：前一条尾端已离开右缘才可进
          const tail = track.x + track.width;
          return tail > this.canvasWidth - 24;
        }
        return now - track.bornAt < track.duration;
      });
      if (!occupied) return lane;
    }
    return -1;
  }

  private laneCount(mode: DanmakuComment['mode']): number {
    if (mode === 'scroll') {
      // 可用高度 = 画布 × areaPercent − 底部安全区
      const usable = this.canvasHeight * (this.settings.areaPercent / 100) - this.safeBottomPx();
      return Math.max(1, Math.floor(usable / (this.canvasHeight * SCROLL_LANE_HEIGHT_RATIO)));
    }
    return Math.max(1, Math.floor((this.canvasHeight * (this.settings.areaPercent / 100)) / (this.settings.fontSize + 8)));
  }

  private safeBottomPx(): number {
    return (this.canvasHeight * this.settings.safeBottomPercent) / 100;
  }

  /** 滚动条目基线 y（绘制与命中框共用，避免两处公式漂移） */
  private scrollBaselineY(lane: number): number {
    return 20 + lane * this.canvasHeight * SCROLL_LANE_HEIGHT_RATIO + this.settings.fontSize / 2;
  }

  private fixedBaselineY(mode: 'top' | 'bottom', lane: number): number {
    const usableH = this.canvasHeight * (this.settings.areaPercent / 100);
    const slots = Math.max(1, Math.floor(usableH / (this.settings.fontSize + 8)));
    const slotH = usableH / slots;
    const center = slotH * lane + slotH / 2;
    return mode === 'top' ? center : this.canvasHeight - this.safeBottomPx() - center;
  }

  /** 条目在媒体时间 `now` 下的绘制坐标（滚动顺带写回 `track.x`，供左缘离屏判定） */
  private positionOf(track: Track, now: number): { x: number; y: number } {
    if (track.comment.mode !== 'scroll') {
      return { x: (this.canvasWidth - track.width) / 2, y: this.fixedBaselineY(track.comment.mode, track.lane) };
    }
    const x = this.canvasWidth - ((now - track.bornAt) / track.duration) * (this.canvasWidth + track.width);
    track.x = x;
    return { x, y: this.scrollBaselineY(track.lane) };
  }

  /** 驻留时长：滚动看路程，顶/底固定 4s */
  private lifespanOf(track: Track): number {
    return track.comment.mode === 'scroll' ? track.duration : FIXED_LIFESPAN_SEC;
  }

  /**
   * 单击命中（B-04）：命中则把该条冻结在原地，返回原文与矩形；没命中返回 null。
   *
   * canvas 始终是 `pointer-events:none`——点击由手势层递进来，所以互动开关关掉时
   * 手势链路一行都不用改。调用方（识别器）已保证只在「单击且位移 < 8px」时走到这里。
   */
  pick(clientX: number, clientY: number): DanmakuPick | null {
    const canvas = this.canvas;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const track = this.hitTrack(clientX - box.left, clientY - box.top);
    if (!track) return null;
    const now = this.currentTime();
    const lifespan = this.lifespanOf(track);
    // 重罚同一条：接着冻在原地，别把位置瞬移到它「本该走到」的地方
    const same = this.picked?.track === track ? this.picked : null;
    if (this.picked && !same) this.releasePick();
    const pos = same ? { x: same.x, y: same.y } : this.positionOf(track, now);
    const progress = same ? same.progress : Math.min(1, Math.max(0, (now - track.bornAt) / lifespan));
    const pad = track.bitmapPad || HIT_PAD_X;
    const height = track.bitmapHeight || Math.ceil(this.settings.fontSize * 1.5);
    this.picked = { track, x: pos.x, y: pos.y, progress, lifespan };
    return {
      comment: track.comment,
      rect: { left: pos.x - pad, top: pos.y - height / 2, width: track.width + pad * 2, height },
    };
  }

  /** 解除冻结：按冻结时的比例续接时间轴，从原地继续走完剩下的路 */
  releasePick(): void {
    const pick = this.picked;
    if (!pick) return;
    this.picked = null;
    pick.track.bornAt = this.currentTime() - pick.progress * pick.lifespan;
  }

  /** 当前被冻结的弹幕（未命中/已放行时为 null） */
  get pickedComment(): DanmakuComment | null {
    return this.picked?.track.comment ?? null;
  }

  /** 容器内 CSS px 坐标 → 命中的条目（后画的在上面，从尾部往前找） */
  private hitTrack(x: number, y: number): Track | null {
    if (x < 0 || y < 0 || x > this.canvasWidth || y > this.canvasHeight) return null;
    const now = this.currentTime();
    const half = Math.max(Math.ceil(this.settings.fontSize * 1.5), HIT_MIN_HEIGHT) / 2;
    for (let i = this.tracks.length - 1; i >= 0; i -= 1) {
      const track = this.tracks[i]!;
      const pick = this.picked;
      const pos = pick && pick.track === track ? { x: pick.x, y: pick.y } : this.positionOf(track, now);
      if (x >= pos.x - HIT_PAD_X && x <= pos.x + track.width + HIT_PAD_X && y >= pos.y - half && y <= pos.y + half) {
        return track;
      }
    }
    return null;
  }

  private redraw(now: number = this.getTime()): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    // 同屏透明度统一设置一次，避免每条弹幕都改状态
    ctx.globalAlpha = this.settings.opacity;

    const pick = this.picked;
    const still: Track[] = [];
    for (const track of this.tracks) {
      if (pick && pick.track === track) {
        // 冻结期间不推进也不淘汰：点中的那一条停在原处等用户操作
        this.drawTrack(ctx, track, pick.x, pick.y);
        still.push(track);
        continue;
      }
      const age = now - track.bornAt;
      const scrolledOff = track.comment.mode === 'scroll' && track.x + track.width < 0;
      if (age > this.lifespanOf(track) || scrolledOff) continue;
      const pos = this.positionOf(track, now);
      this.drawTrack(ctx, track, pos.x, pos.y);
      still.push(track);
    }
    ctx.globalAlpha = 1;
    this.tracks = still;
  }

  /** 贴已栅格化的文字位图（位图在入场时生成一次） */
  private drawTrack(ctx: CanvasRenderingContext2D, track: Track, x: number, y: number): void {
    const bitmap = this.ensureBitmap(track);
    const pad = track.bitmapPad;
    ctx.drawImage(bitmap, x - pad, y - track.bitmapHeight / 2, bitmap.width / this.dpr, bitmap.height / this.dpr);
  }

  /** 文字 → 离屏位图：描边+填充只做一次，每帧只 drawImage */
  private ensureBitmap(track: Track): HTMLCanvasElement {
    const fontSize = this.settings.fontSize;
    const dpr = this.dpr;
    const bold = this.settings.bold;
    const strokeMode = this.settings.strokeStyle;
    const paint = track.paint ?? legacyPaint(track.comment.color);
    if (
      track.bitmap !== null
      && track.bitmapFontSize === fontSize
      && track.bitmapDpr === dpr
      && track.bitmapBold === bold
      && track.bitmapStroke === strokeMode
      && track.bitmapPaintKey === paint.key
    ) {
      return track.bitmap;
    }
    const weight = bold ? 'bold ' : '';
    const lineWidth = strokeMode === 'none' ? 0 : Math.max(2, fontSize / 8);
    const pad = strokeMode === 'none' ? 2 : Math.ceil(lineWidth / 2) + 2;
    const height = Math.ceil(fontSize * 1.5);
    const width = Math.max(1, Math.ceil(track.width + pad * 2));
    const bitmap = document.createElement('canvas');
    bitmap.width = Math.max(1, Math.round(width * dpr));
    bitmap.height = Math.max(1, Math.round(height * dpr));
    const bctx = bitmap.getContext('2d');
    if (bctx) {
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.font = `${weight}${fontSize}px sans-serif`;
      bctx.textBaseline = 'middle';
      bctx.lineWidth = lineWidth;
      const baseline = height / 2;
      if (strokeMode === 'shadow') {
        bctx.shadowColor = paint.shadow;
        bctx.shadowBlur = lineWidth;
        bctx.shadowOffsetX = 1;
        bctx.shadowOffsetY = 1;
        bctx.fillStyle = paint.fill;
        bctx.fillText(track.comment.text, pad, baseline);
        bctx.shadowColor = 'transparent';
        bctx.shadowBlur = 0;
        bctx.shadowOffsetX = 0;
        bctx.shadowOffsetY = 0;
      } else if (strokeMode === 'outline') {
        bctx.strokeStyle = paint.stroke;
        bctx.strokeText(track.comment.text, pad, baseline);
        bctx.fillStyle = paint.fill;
        bctx.fillText(track.comment.text, pad, baseline);
      } else {
        bctx.fillStyle = paint.fill;
        bctx.fillText(track.comment.text, pad, baseline);
      }
    }
    track.bitmap = bitmap;
    track.bitmapFontSize = fontSize;
    track.bitmapDpr = dpr;
    track.bitmapPad = pad;
    track.bitmapHeight = height;
    track.bitmapBold = bold;
    track.bitmapStroke = strokeMode;
    track.bitmapPaintKey = paint.key;
    return bitmap;
  }
}
