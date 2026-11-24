/**
 * 封面共享元素转场（列表封面 ⇄ 播放画面）
 *
 * 去程：点击时把封面 `<img>` 复制到视口固定浮层，播放页挂载后飞向视频舞台并淡出。
 * 返程：返回前把海报立在舞台矩形上，目标页 enter 后收回卡片当前位置；卡片按
 * `data-cover-key` 重新查询，虚拟列表回收 DOM 时不会攥着过期引用。
 *
 * 飞行只改 `transform/opacity`，不再逐帧改 `top/left/width/height`。2:3 与 16:9
 * 之间保持等比缩放，并在落点淡出交回真实画面，避免非等比拉伸与逐帧布局。
 */
import { ref } from 'vue';

const DURATION_MS = 280;
const EASE = 'cubic-bezier(0.22, 0.9, 0.26, 1)';
const FADE_MS = 120;
const STALE_MS = 2500;
const GUARD_MS = DURATION_MS + FADE_MS + 400;
const REWIND_SETTLE_MS = 260;
const REWIND_POLL_MS = 32;
const MAX_REWIND_RETARGETS = 4;

export const sharedCoverActive = ref(false);

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PendingCover {
  overlay: HTMLDivElement;
  clone: HTMLImageElement;
  from: Rect;
  fromRadius: string;
  restore: () => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RewindingCover {
  overlay: HTMLDivElement;
  clone: HTMLImageElement;
  from: Rect;
  fromRadius: string;
  coverKey: string;
  timer: ReturnType<typeof setTimeout>;
  restore?: () => void;
  animation?: Animation;
}

let pending: PendingCover | null = null;
let rewinding: RewindingCover | null = null;

function rectOf(el: Element): Rect {
  const box = el.getBoundingClientRect();
  return { top: box.top, left: box.left, width: box.width, height: box.height };
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function radiusOf(el: Element): string {
  return window.getComputedStyle(el).borderRadius || '0px';
}

function place(el: HTMLElement, rect: Rect): void {
  el.style.top = `${rect.top}px`;
  el.style.left = `${rect.left}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.transformOrigin = 'top left';
}

function flightFrames(from: Rect, to: Rect, fromRadius: string, toRadius: string): Keyframe[] {
  const transform = `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})`;
  return [
    { transform: 'translate(0px, 0px) scale(1)', borderRadius: fromRadius },
    { transform, borderRadius: toRadius },
  ];
}

function nearRect(a: Rect, b: Rect, threshold: number): boolean {
  return (
    Math.abs(a.top - b.top) < threshold &&
    Math.abs(a.left - b.left) < threshold &&
    Math.abs(a.width - b.width) < threshold &&
    Math.abs(a.height - b.height) < threshold
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function fadeOverlay(overlay: HTMLElement): Promise<void> {
  if (typeof overlay.animate !== 'function') return;
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: FADE_MS,
        easing: 'linear',
        fill: 'forwards',
      }).finished,
      new Promise<void>((resolve) => {
        guard = setTimeout(resolve, FADE_MS + 400);
      }),
    ]);
  } catch {
    // 动画被打断时直接交回真实画面。
  } finally {
    clearTimeout(guard);
  }
}

function dispose(p: PendingCover): void {
  clearTimeout(p.timer);
  p.overlay.remove();
  p.restore();
  sharedCoverActive.value = false;
}

export function cancelSharedCover(): void {
  if (!pending) return;
  dispose(pending);
  pending = null;
}

export function beginSharedCover(source: Element | null | undefined): void {
  if (pending || typeof document === 'undefined' || reducedMotion()) return;
  if (rewinding) cancelSharedCoverRewind();

  const img = source instanceof HTMLImageElement ? source : (source?.querySelector('img') ?? null);
  if (!img?.complete || img.naturalWidth === 0) return;

  const from = rectOf(img);
  if (from.width < 16 || from.height < 16) return;
  const viewportH = document.documentElement.clientHeight;
  if (from.top >= viewportH || from.top + from.height <= 0) return;

  const clipHost = img.closest('.poster-image') ?? source;
  if (!clipHost) return;

  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;pointer-events:none;contain:layout paint style;z-index:calc(var(--z-toast) - 1);';

  const clone = img.cloneNode(false) as HTMLImageElement;
  clone.removeAttribute('loading');
  clone.style.cssText = 'position:absolute;object-fit:cover;display:block;will-change:transform,opacity;';
  place(clone, from);
  clone.style.borderRadius = radiusOf(clipHost);

  const previousVisibility = img.style.visibility;
  img.style.visibility = 'hidden';
  overlay.appendChild(clone);
  document.body.appendChild(overlay);

  pending = {
    overlay,
    clone,
    from,
    fromRadius: clone.style.borderRadius,
    restore: () => {
      img.style.visibility = previousVisibility;
    },
    timer: setTimeout(cancelSharedCover, STALE_MS),
  };
  sharedCoverActive.value = true;
}

export async function finishSharedCover(target: Element | null | undefined): Promise<void> {
  const p = pending;
  if (!p) return;
  pending = null;
  clearTimeout(p.timer);

  const to = target ? rectOf(target) : null;
  const animatable =
    !!to &&
    to.width >= 24 &&
    to.height >= 24 &&
    !reducedMotion() &&
    typeof p.clone.animate === 'function';
  if (!to || !animatable) {
    dispose(p);
    return;
  }

  const run = (async () => {
    await p.clone.animate(flightFrames(p.from, to, p.fromRadius, radiusOf(target as Element)), {
      duration: DURATION_MS,
      easing: EASE,
      fill: 'forwards',
    }).finished;
    await fadeOverlay(p.overlay);
  })().catch(() => {
    // 动画被打断时直接收尾。
  });

  let guard: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    run,
    new Promise<void>((resolve) => {
      guard = setTimeout(resolve, GUARD_MS);
    }),
  ]);
  clearTimeout(guard);
  dispose(p);
}

function findCoverTarget(coverKey: string): { host: HTMLElement; img: HTMLImageElement } | null {
  for (const el of document.querySelectorAll<HTMLElement>('[data-cover-key]')) {
    if (el.dataset.coverKey !== coverKey) continue;
    const img = el.querySelector('img');
    if (img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0) {
      return { host: el, img };
    }
  }
  return null;
}

function inViewport(rect: Rect): boolean {
  const vp = document.documentElement;
  return (
    rect.top < vp.clientHeight &&
    rect.top + rect.height > 0 &&
    rect.left < vp.clientWidth &&
    rect.left + rect.width > 0
  );
}

async function waitForStableTarget(
  coverKey: string,
): Promise<{ host: HTMLElement; img: HTMLImageElement; rect: Rect } | null> {
  const deadline = Date.now() + REWIND_SETTLE_MS;
  let previous: { img: HTMLImageElement; rect: Rect } | null = null;
  let stableFrames = 0;

  while (Date.now() < deadline) {
    const found = findCoverTarget(coverKey);
    if (!found) {
      previous = null;
      stableFrames = 0;
      await delay(REWIND_POLL_MS);
      continue;
    }
    const rect = rectOf(found.img);
    if (previous !== null && previous.img === found.img && nearRect(rect, previous.rect, 0.5)) stableFrames += 1;
    else stableFrames = 0;
    if (stableFrames >= 2) return { ...found, rect };
    previous = { img: found.img, rect };
    await nextFrame();
  }
  return null;
}

function hideCoverImage(img: HTMLImageElement): () => void {
  const previousVisibility = img.style.visibility;
  img.style.visibility = 'hidden';
  return () => {
    img.style.visibility = previousVisibility;
  };
}

function cancelSharedCoverRewind(): void {
  const p = rewinding;
  if (!p) return;
  rewinding = null;
  clearTimeout(p.timer);
  p.animation?.cancel?.();
  p.animation = undefined;
  p.restore?.();
  p.restore = undefined;
  p.overlay.remove();
  sharedCoverActive.value = false;
}

export function rewindSharedCover(
  stage: Element | null | undefined,
  coverKey: string | null | undefined,
  posterUrl: string | null | undefined,
): void {
  if (rewinding || pending || !coverKey || !posterUrl || !stage) return;
  if (typeof document === 'undefined' || reducedMotion()) return;

  const from = rectOf(stage);
  if (from.width < 24 || from.height < 24) return;

  const overlay = document.createElement('div');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText =
    'position:fixed;inset:0;pointer-events:none;contain:layout paint style;z-index:calc(var(--z-toast) - 1);';

  const clone = document.createElement('img');
  clone.src = posterUrl;
  clone.alt = '';
  clone.style.cssText = 'position:absolute;object-fit:cover;display:block;will-change:transform,opacity;';
  place(clone, from);
  clone.style.borderRadius = radiusOf(stage);
  overlay.appendChild(clone);
  document.body.appendChild(overlay);

  rewinding = {
    overlay,
    clone,
    from,
    fromRadius: clone.style.borderRadius,
    coverKey,
    timer: setTimeout(cancelSharedCoverRewind, STALE_MS),
  };
  sharedCoverActive.value = true;
}

export async function finishSharedCoverRewind(): Promise<void> {
  const p = rewinding;
  if (!p || typeof document === 'undefined') return;

  const found = await waitForStableTarget(p.coverKey);
  if (rewinding !== p) return;
  if (
    !found ||
    found.rect.width < 24 ||
    found.rect.height < 24 ||
    !inViewport(found.rect) ||
    reducedMotion() ||
    typeof p.clone.animate !== 'function'
  ) {
    cancelSharedCoverRewind();
    return;
  }

  let current: { host: HTMLElement; img: HTMLImageElement } = found;
  p.restore = hideCoverImage(current.img);
  let retargets = 0;

  while (rewinding === p) {
    const latest = findCoverTarget(p.coverKey);
    if (!latest) {
      cancelSharedCoverRewind();
      return;
    }
    if (latest.img !== current.img) {
      p.restore?.();
      current = latest;
      p.restore = hideCoverImage(current.img);
    }

    const to = rectOf(current.img);
    if (to.width < 24 || to.height < 24 || !inViewport(to)) {
      cancelSharedCoverRewind();
      return;
    }

    let moved = false;
    let animation: Animation | null = null;
    const onMove = (): void => {
      if (!nearRect(rectOf(current.img), to, 1)) {
        moved = true;
        animation?.cancel();
      }
    };
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    animation = p.clone.animate(
      flightFrames(p.from, to, p.fromRadius, radiusOf(current.host)),
      { duration: DURATION_MS, easing: EASE, fill: 'forwards' },
    );
    p.animation = animation;
    try {
      await animation.finished;
    } catch {
      // cancel() 会拒绝 finished；是否重定向由下方落点检查决定。
    }
    window.removeEventListener('scroll', onMove, true);
    window.removeEventListener('resize', onMove);
    if (p.animation === animation) p.animation = undefined;
    if (rewinding !== p) return;

    const landed = rectOf(current.img);
    if (moved || !nearRect(landed, to, 1)) {
      animation.cancel();
      retargets += 1;
      if (retargets > MAX_REWIND_RETARGETS) {
        cancelSharedCoverRewind();
        return;
      }
      continue;
    }

    p.restore?.();
    p.restore = undefined;
    await fadeOverlay(p.overlay);
    if (rewinding !== p) return;
    clearTimeout(p.timer);
    p.overlay.remove();
    rewinding = null;
    sharedCoverActive.value = false;
    return;
  }
}
