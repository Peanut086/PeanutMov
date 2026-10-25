/**
 * 弹幕渲染层（v1.7 / CHG-22）
 *
 * `<canvas>` 覆盖层 + rAF 驱动，不依赖播放器引擎：
 * - `tick(currentTimeSec)` 由外部在 timeupdate 事件注入（倍速/暂停天然对齐）；
 * - 滚动 / 顶部 / 底部三模式；同屏密度上限 `DANMAKU_MAX_ONSCREEN`；
 * - 底部安全区（字幕区）禁显；文字带描边保证可读。
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
}

const SCROLL_LANE_HEIGHT_RATIO = 0.12;

export class DanmakuOverlay {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private rafId: number | null = null;
  private comments: DanmakuComment[] = [];
  private cursor = 0;
  private tracks: Track[] = [];
  private settings: DanmakuSettings;
  private getTime: () => number;
  private lastTime = -1;
  private canvasWidth = 0;
  private canvasHeight = 0;

  constructor(options: { settings: DanmakuSettings; getTime: () => number }) {
    this.settings = options.settings;
    this.getTime = options.getTime;
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
    this.settings = settings;
    this.resize();
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
  }

  private resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvasWidth = canvas.width;
    this.canvasHeight = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    const now = this.getTime();
    if (now !== this.lastTime) {
      // 外部尚未 tick 到本帧时间（低频 timeupdate）：插入光标推进按真实时钟兜底
      this.lastTime = now;
    }
    this.spawn(now);
    this.redraw(now);
  }

  /** 把进入时间窗的弹幕铺进轨道 */
  private spawn(now: number): void {
    while (this.cursor < this.comments.length) {
      const comment = this.comments[this.cursor]!;
      if (comment.time > now + 0.2) break;
      this.cursor += 1;
      if (now - comment.time > 1) continue; // 过期（seek 后残留）
      if (this.tracks.length >= DANMAKU_MAX_ONSCREEN) break;
      const width = this.measure(comment.text);
      const duration = Math.max(4, 10 / Math.max(0.5, this.settings.speed));
      const lane = this.allocateLane(comment, width, duration, now);
      if (lane < 0) continue; // 该模式通道已满，丢弃（密度上限语义）
      this.tracks.push({ comment, lane, bornAt: now, duration, x: this.canvasWidth, width });
    }
  }

  private measure(text: string): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    ctx.font = `${this.settings.fontSize}px sans-serif`;
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const w = this.canvasWidth;
    const h = this.canvasHeight;
    const alpha = this.settings.opacity;
    const fontSize = this.settings.fontSize;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, fontSize / 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';

    const still: Track[] = [];
    for (const track of this.tracks) {
      const age = now - track.bornAt;
      if (track.comment.mode === 'scroll') {
        if (age > track.duration || track.x + track.width < 0) continue;
        const progress = age / track.duration;
        const x = w - progress * (w + track.width);
        track.x = x;
        const y = 20 + track.lane * h * SCROLL_LANE_HEIGHT_RATIO + fontSize / 2;
        this.drawComment(ctx, track.comment, x, y, alpha);
        still.push(track);
      } else {
        if (age > 4) continue;
        const slotH = this.canvasHeight * (this.settings.areaPercent / 100) / Math.max(1, this.laneCount(track.comment.mode));
        const y = track.comment.mode === 'top' ? slotH * track.lane + slotH / 2 : h - this.safeBottomPx() - slotH * track.lane - slotH / 2;
        const xCenter = (w - this.measure(track.comment.text)) / 2;
        this.drawComment(ctx, track.comment, xCenter, y, alpha);
        still.push(track);
      }
    }
    this.tracks = still;
  }

  private drawComment(
    ctx: CanvasRenderingContext2D,
    comment: DanmakuComment,
    x: number,
    y: number,
    alpha: number,
  ): void {
    const color = `#${(comment.color & 0xffffff).toString(16).padStart(6, '0')}`;
    ctx.globalAlpha = alpha;
    ctx.strokeText(comment.text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(comment.text, x, y);
    ctx.globalAlpha = 1;
  }
}
