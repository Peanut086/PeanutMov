/**
 * 封面共享元素转场（列表封面 ⇄ 播放画面）
 *
 * 去程：点击时把封面 `<img>` 复制到一个视口固定的浮层里，原图先隐去；
 * 播放页挂载后调用 `finishSharedCover(stageEl)`，浮层图用 280ms 从封面矩形
 * 形变到视频舞台矩形，再淡出交回真实画面。
 *
 * 返程：播放页返回前调用 `rewindSharedCover(stageEl, coverKey, posterUrl)`，
 * 把海报立在舞台矩形上；目标页 enter 完成后由 App.vue 触发
 * `finishSharedCoverRewind()`，收回到**卡片当前位置**。卡片按 `data-cover-key`
 * 重新查询而不是持有元素引用——虚拟列表会回收 DOM，攥着的引用必然过期；
 * 查不到、还没加载、已滚出视口，一律原地淡出，绝不飞错位图。
 *
 * 形变走 left/top/width/height 而不是 transform：封面 2:3、舞台 16:9，
 * 非等比缩放会把海报拉歪，而改尺寸能让 `object-fit: cover` 每帧自己重裁。
 * 浮层加 `contain`，把这份逐帧布局限制在自己的子树里。
 */
import { ref } from 'vue';

const DURATION_MS = 280;
const EASE = 'cubic-bezier(0.22, 0.9, 0.26, 1)';
const FADE_MS = 120;
/** 播放页没能接上（重定向、加载异常）时的兜底清理 */
const STALE_MS = 2500;
/** 动画看门狗：页面被节流时动画不会推进，到点直接收尾，浮层绝不长期盖住播放页 */
const GUARD_MS = DURATION_MS + FADE_MS + 400;

/** 转场进行中：App.vue 据此把页面滑入换成淡入，避免位移叠加 */
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

let pending: PendingCover | null = null;

/** 返程中的浮层：源矩形是播放舞台，目标矩形等目标页渲染出来再查 */
interface RewindingCover {
  overlay: HTMLDivElement;
  clone: HTMLImageElement;
  from: Rect;
  fromRadius: string;
  coverKey: string;
  timer: ReturnType<typeof setTimeout>;
}

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
}

function dispose(p: PendingCover): void {
  clearTimeout(p.timer);
  p.overlay.remove();
  p.restore();
  sharedCoverActive.value = false;
}

/** 放弃转场（导航未发生或中途失败），恢复原封面显示 */
export function cancelSharedCover(): void {
  if (!pending) return;
  dispose(pending);
  pending = null;
}

/**
 * 开始转场：`source` 传封面容器或封面 `<img>` 本身。
 * 封面未加载、已滑出视口、动效被系统关闭时静默跳过，导航行为与现状一致。
 */
export function beginSharedCover(source: Element | null | undefined): void {
  if (pending || typeof document === 'undefined' || reducedMotion()) return;
  // 返程浮层还没收干净就再次进入：直接撤掉，不允许两层封面叠着
  if (rewinding) cancelSharedCoverRewind();

  const img =
    source instanceof HTMLImageElement ? source : (source?.querySelector('img') ?? null);
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
  clone.style.cssText =
    'position:absolute;object-fit:cover;display:block;will-change:left,top,width,height,border-radius;';
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

/**
 * 播放页调用：把浮层封面形变到目标矩形并淡出。
 * 没有进行中的转场、目标不可见时立即清理，不产生任何动画。
 */
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

  const toRadius = radiusOf(target as Element);
  const run = (async () => {
    await p.clone.animate(
      [
        {
          top: `${p.from.top}px`,
          left: `${p.from.left}px`,
          width: `${p.from.width}px`,
          height: `${p.from.height}px`,
          borderRadius: p.fromRadius,
        },
        {
          top: `${to.top}px`,
          left: `${to.left}px`,
          width: `${to.width}px`,
          height: `${to.height}px`,
          borderRadius: toRadius,
        },
      ],
      { duration: DURATION_MS, easing: EASE, fill: 'forwards' },
    ).finished;
    await p.overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: FADE_MS,
      easing: 'linear',
      fill: 'forwards',
    }).finished;
  })().catch(() => {
    // 动画被打断（页面被销毁等）：直接收尾
  });

  // 后台/节流标签页不出帧，Animation.finished 会一直挂着，因此限时收尾
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

/* ---------- 返程：舞台 → 原卡片 ---------- */

/** 目标页重建封面要时间（DetailView 不在 KeepAlive 名单里），给一小段等待预算 */
const REWIND_SETTLE_MS = 260;
const REWIND_POLL_MS = 32;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 按 id 重新查询当前挂在 DOM 上的封面；图片没解码完不算查到 */
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
  return rect.top < vp.clientHeight && rect.top + rect.height > 0 && rect.left < vp.clientWidth && rect.left + rect.width > 0;
}

/** 撤掉返程浮层：动画跑到一半也要保证 DOM 不残留 */
function cancelSharedCoverRewind(): void {
  const p = rewinding;
  if (!p) return;
  rewinding = null;
  clearTimeout(p.timer);
  p.overlay.remove();
  sharedCoverActive.value = false;
}

/**
 * 播放页返回前调用：凭海报 URL 重建一张封面立在舞台矩形上。
 * 舞台不可见、海报缺失、动效被系统关闭时静默跳过，返回行为与现状一致。
 */
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
  clone.style.cssText =
    'position:absolute;object-fit:cover;display:block;will-change:left,top,width,height,border-radius;';
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

/**
 * 目标页 enter 完成后调用（App.vue 的 Transition 钩子）：把浮层收回卡片当前位置。
 * 等不到卡片、卡片被回收或已滚出视口时原地淡出，不产生错位飞行。
 */
export async function finishSharedCoverRewind(): Promise<void> {
  const p = rewinding;
  if (!p || typeof document === 'undefined') return;

  const deadline = Date.now() + REWIND_SETTLE_MS;
  let found = findCoverTarget(p.coverKey);
  while (!found && Date.now() < deadline) {
    await delay(REWIND_POLL_MS);
    found = findCoverTarget(p.coverKey);
  }
  // 等待期间被看门狗撤走或新一轮转场抢占
  if (rewinding !== p) return;

  const to = found ? rectOf(found.img) : null;
  if (
    !found ||
    !to ||
    to.width < 24 ||
    to.height < 24 ||
    !inViewport(to) ||
    reducedMotion() ||
    typeof p.clone.animate !== 'function'
  ) {
    cancelSharedCoverRewind();
    return;
  }

  rewinding = null;
  clearTimeout(p.timer);

  const previousVisibility = found.img.style.visibility;
  found.img.style.visibility = 'hidden';
  const toRadius = radiusOf(found.host);

  const run = (async () => {
    await p.clone.animate(
      [
        {
          top: `${p.from.top}px`,
          left: `${p.from.left}px`,
          width: `${p.from.width}px`,
          height: `${p.from.height}px`,
          borderRadius: p.fromRadius,
        },
        {
          top: `${to.top}px`,
          left: `${to.left}px`,
          width: `${to.width}px`,
          height: `${to.height}px`,
          borderRadius: toRadius,
        },
      ],
      { duration: DURATION_MS, easing: EASE, fill: 'forwards' },
    ).finished;
  })().catch(() => {
    // 动画被打断（页面被销毁等）：按跑完处理，下方照常交回真图
  });

  let guard: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    run,
    new Promise<void>((resolve) => {
      guard = setTimeout(resolve, GUARD_MS);
    }),
  ]);
  clearTimeout(guard);

  // 落点与卡片重合，直接交回真图，不再叠一层淡出
  found.img.style.visibility = previousVisibility;
  p.overlay.remove();
  sharedCoverActive.value = false;
}
