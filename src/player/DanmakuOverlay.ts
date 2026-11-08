/**
 * 弹幕渲染层（v1.7 / CHG-22）
 *
 * `<canvas>` 覆盖层 + rAF 驱动，不依赖播放器引擎：
 * - `tick(currentTimeSec)` 由外部在 timeupdate 事件注入（倍速/暂停天然对齐）；
 * - 原生引擎 1s 才轮询一次进度，帧内用 rAF 时钟在 anchor 上插值，避免弹幕每秒跳一次；
 * - 滚动 / 顶部 / 底部三模式；同屏密度上限 `DANMAKU_MAX_ONSCREEN`；
 * - 底部安全区（字幕区）禁显；文字入场时栅格化成位图，每帧只贴图（描边文字逐帧重绘极慢）。
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

const SCROLL_LANE_HEIGHT_RATIO = 0.12;
/** 画面重绘上限 30fps：弹幕不需要 60fps，把 GPU/CPU 留给视频 */
const FRAME_INTERVAL_MS = 33;
/** 进度轮询间隔 1s，帧内插值最多向前补 1.2s，避免轮询迟到后弹幕跑飞 */
const MAX_EXTRAPOLATE_SEC = 1.2;


export class DanmakuOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private comments: DanmakuComment[] = [];
  private cursor = 0;
  private tracks: Track[] = [];
  private settings: DanmakuSettings;
  private getTime: () => number;
  private isPlaying: () => boolean;
  private getRate: () => number;
  private lastTime = -1;
  /** 最近一次 timeupdate 的媒体时间与到达时刻（帧内插值的锚点） */
  private anchorTime = 0;
  private anchorStamp = 0;
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
    }
    this.resize();
    this.lastDrawnTime = Number.NaN;
  }

  /** 全量替换弹幕（已按时间排序；merge 由服务层完成） */
  load(comments: DanmakuComment[]): void {
    this.comments = [...comments].sort((a, b) => a.time - b.time);
    this.cursor = 0;
    this.tracks = [];
  }

  clear(): void {
    this.comments = [];
    this.cursor = 0;
    this.tracks = [];
    this.redraw();
  }

  /** 每帧由 timeupdate 驱动：时间回跳（seek）时重置光标 */
  tick(currentTimeSec: number): void {
    if (currentTimeSec < this.lastTime - 1) {
      // seek 回跳/换集：清空轨道重定位
      this.tracks = [];
      this.cursor = this.comments.findIndex((c) => c.time >= currentTimeSec);
      if (this.cursor < 0) this.cursor = this.comments.length;
    }
    this.lastTime = currentTimeSec;
    this.anchorTime = currentTimeSec;
    this.anchorStamp = performance.now();
  }

  /** 帧内时间：暂停时停在锚点，播放中按真实时钟在锚点上补间 */
  private currentTime(): number {
    if (!this.isPlaying()) {
      // 暂停/缓冲：媒体时间不前进，直接以播放器时间为准
      this.anchorTime = this.getTime();
      this.anchorStamp = performance.now();
      this.wasPlaying = false;
      return this.anchorTime;
    }
    if (!this.wasPlaying || this.anchorStamp === 0) {
      // 开始/恢复播放：以当前锚点为起点重新计时，避免把暂停时长算进补间
      if (this.anchorStamp === 0) this.anchorTime = this.getTime();
      this.anchorStamp = performance.now();
      this.wasPlaying = true;
    }
    const elapsed = ((performance.now() - this.anchorStamp) / 1000) * this.getRate();
    return this.anchorTime + Math.max(0, Math.min(elapsed, MAX_EXTRAPOLATE_SEC));
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
    if (stamp - this.lastFrameAt < FRAME_INTERVAL_MS) return;
    this.lastFrameAt = stamp;
    const now = this.currentTime();
    if (now === this.lastDrawnTime) return; // 暂停/缓冲画面不变：跳过重绘
    this.lastDrawnTime = now;
    this.spawn(now);
    this.redraw(now);
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

  private redraw(now: number = this.getTime()): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    const fontSize = this.settings.fontSize;
    // 同屏透明度统一设置一次，避免每条弹幕都改状态
    ctx.globalAlpha = this.settings.opacity;

    const usableH = h * (this.settings.areaPercent / 100);
    const fixedSlots = Math.max(1, Math.floor(usableH / (fontSize + 8)));
    const slotH = usableH / fixedSlots;
    const bottomEdge = h - this.safeBottomPx();

    const still: Track[] = [];
    for (const track of this.tracks) {
      const age = now - track.bornAt;
      if (track.comment.mode === 'scroll') {
        if (age > track.duration || track.x + track.width < 0) continue;
        const progress = age / track.duration;
        const x = w - progress * (w + track.width);
        track.x = x;
        const y = 20 + track.lane * h * SCROLL_LANE_HEIGHT_RATIO + fontSize / 2;
        this.drawTrack(ctx, track, x, y);
        still.push(track);
      } else {
        if (age > 4) continue;
        const y = track.comment.mode === 'top' ? slotH * track.lane + slotH / 2 : bottomEdge - slotH * track.lane - slotH / 2;
        this.drawTrack(ctx, track, (w - track.width) / 2, y);
        still.push(track);
      }
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
