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
 * - B-04 互动：`pick()` 按点击坐标命中单条并冻结它（其余照常滚动），canvas 全程不吃指针事件。
 *
 * 设计取舍：不用 DOM 弹幕（数百节点调度易掉帧），canvas 绘制成本恒定。
 */
import { DANMAKU_MAX_ONSCREEN } from '@/shared/constants';
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
  /** 文字位图（入场时渲染一次，字体/像素比变化后按需重建） */
  bitmap: HTMLCanvasElement | null;
  bitmapFontSize: number;
  bitmapDpr: number;
  bitmapPad: number;
  bitmapHeight: number;
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
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
    container.appendChild(canvas);
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    this.start();
  }

  detach(): void {
    this.stop();
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
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
    this.resize();
    this.lastDrawnTime = Number.NaN;
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

  private resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
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
      this.tracks.push({
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
      });
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
    if (
      track.bitmap !== null
      && track.bitmapFontSize === fontSize
      && track.bitmapDpr === dpr
      && (track as unknown as { _bold?: boolean })._bold === bold
      && (track as unknown as { _stroke?: string })._stroke === strokeMode
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
        bctx.shadowColor = 'rgba(0,0,0,0.7)';
        bctx.shadowBlur = lineWidth;
        bctx.shadowOffsetX = 1;
        bctx.shadowOffsetY = 1;
        bctx.fillStyle = `#${(track.comment.color & 0xffffff).toString(16).padStart(6, '0')}`;
        bctx.fillText(track.comment.text, pad, baseline);
        bctx.shadowColor = 'transparent';
        bctx.shadowBlur = 0;
        bctx.shadowOffsetX = 0;
        bctx.shadowOffsetY = 0;
      } else if (strokeMode === 'outline') {
        bctx.strokeStyle = 'rgba(0,0,0,0.8)';
        bctx.strokeText(track.comment.text, pad, baseline);
        bctx.fillStyle = `#${(track.comment.color & 0xffffff).toString(16).padStart(6, '0')}`;
        bctx.fillText(track.comment.text, pad, baseline);
      } else {
        bctx.fillStyle = `#${(track.comment.color & 0xffffff).toString(16).padStart(6, '0')}`;
        bctx.fillText(track.comment.text, pad, baseline);
      }
    }
    track.bitmap = bitmap;
    track.bitmapFontSize = fontSize;
    track.bitmapDpr = dpr;
    track.bitmapPad = pad;
    track.bitmapHeight = height;
    (track as unknown as { _bold: boolean })._bold = bold;
    (track as unknown as { _stroke: string })._stroke = strokeMode;
    return bitmap;
  }
}
