/**
 * 共享火花层（C-11 下载完成收尾仪式）
 *
 * 一次完成只该有几颗火星子，但下载 12 集会一口气全完成——所以全页只允许一张
 * canvas、一个 rAF 循环：粒子跑完自动停循环，页面卸载时 detach 把画布还回去。
 *
 * 降级顺序（按验收红线）：reduced-motion / 低端机直接不放火花，只保留勾；
 * DPR 上限 2，低端 1。
 */
import { prefersReducedMotion } from '@/composables/useSpring';
import { isLowEndDevice } from '@/shared/deviceTier';

export const SPARK_COUNT = 16;
/** 粒子寿命衰减系数：约 0.7s 内散尽，整场收尾压在 800ms 预算内 */
const LIFE_DECAY = 1.4;
const GRAVITY = 210;
const DRAG = 0.985;
/** 单帧最大步长：切后台回来时不要用几十秒的 dt 把粒子一次性算死 */
const MAX_FRAME_MS = 200;

const SPARK_COLORS = ['#FFC761', '#F0A82E', '#34D399', '#60A5FA'] as const;

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: string;
}

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let particles: Spark[] = [];
let frame = 0;
let last = 0;

function dpr(): number {
  const raw = globalThis.devicePixelRatio || 1;
  return Math.min(raw, isLowEndDevice() ? 1 : 2);
}

/** 画布自身的尺寸：不用 window 内部尺寸，这样它挂在哪个定位上下文里都对得上 */
function sizeCanvas(): void {
  if (!canvas) return;
  const ratio = dpr();
  const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function stopLoop(): void {
  if (frame !== 0) {
    cancelAnimationFrame(frame);
    frame = 0;
  }
  last = 0;
}

function clear(): void {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
}

function advance(now: number): void {
  frame = 0;
  const dt = Math.min(MAX_FRAME_MS, now - last) / 1000;
  last = now;
  if (!ctx) {
    particles = [];
    return;
  }
  clear();
  const alive: Spark[] = [];
  for (const s of particles) {
    s.life -= dt * LIFE_DECAY;
    if (s.life <= 0) continue;
    s.vy += GRAVITY * dt;
    s.vx *= DRAG;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    alive.push(s);
    ctx.globalAlpha = Math.max(0, Math.min(1, s.life));
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size * Math.max(0.2, s.life), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  particles = alive;
  if (particles.length > 0) frame = requestAnimationFrame(advance);
  else last = 0;
}

/** 火花数量：不适合放火花的场合直接给 0，让调用方连画布都不用碰 */
export function sparkCount(): number {
  if (prefersReducedMotion() || isLowEndDevice()) return 0;
  return SPARK_COUNT;
}

/** 挂载 / 卸载全页唯一的火花画布（传 null 即卸载） */
export function attachSparkCanvas(el: HTMLCanvasElement | null): void {
  if (el === canvas) return;
  const hadCanvas = canvas !== null;
  stopLoop();
  if (hadCanvas) window.removeEventListener('resize', sizeCanvas);
  canvas = el;
  ctx = el?.getContext('2d') ?? null;
  particles = [];
  if (!el) return;
  sizeCanvas();
  window.addEventListener('resize', sizeCanvas);
}

/**
 * 在视口坐标 (clientX, clientY) 放一簇火花。
 * 返回实际粒子数（0 = 已降级或画布未挂载），调用方可据此决定要不要补别的反馈。
 */
export function burstSparks(clientX: number, clientY: number): number {
  const count = sparkCount();
  if (!count || !ctx || !canvas) return 0;
  sizeCanvas();
  const origin = canvas.getBoundingClientRect();
  const x = clientX - origin.left;
  const y = clientY - origin.top;
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const speed = 70 + Math.random() * 130;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 40,
      life: 1,
      size: 1.6 + Math.random() * 2.2,
      color: SPARK_COLORS[i % SPARK_COLORS.length] as string,
    });
  }
  if (frame === 0) {
    last = 0;
    frame = requestAnimationFrame(advance);
  }
  return count;
}

/** 单测辅助：读当前存活粒子数 / 清空进程内状态 */
export function __sparkCount(): number {
  return particles.length;
}

export function __resetSparkField(): void {
  attachSparkCanvas(null);
}
