<script setup lang="ts">
/**
 * 长按海报「原位放映」（G-B02）
 *
 * 卡片海报区原地长成一块 16:9 放映台：已下载的集用原生抽帧循环放（默认 12 帧 / 700ms 一格），
 * 抽不出帧的一律退回海报慢推，并把原因写在角标上——宁可只有一张会动的海报，也不假装在播。
 *
 * 手势只有三个，都在按住的那只手指上：上滑松手 = 播放，下滑松手 = 收藏，松手没滑动 = 收起并把
 * 原来的长按快捷面板接上（`dismiss('release')`）。滚动 / Esc / 点外面同样收起，不接面板。
 *
 * 形变动的是 top/left/width/height 而不是 transform：2:3 → 16:9 用 transform 会被拉变形，
 * 这与 `useSharedElement` 的取舍一致；只有一层，代价可控。基础样式写的就是「展开后的终态」，
 * 减弱动效或没有 WAAPI 时直接跳到终态。
 */
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';

import type { MediaItem } from '@/types';

import {
  peekFallbackNote,
  resolvePeekPreview,
  type PeekAnchorRect,
  type PeekClip,
  type PeekDismissReason,
  type PeekFallback,
} from '@/services/peekPreviewService';
import { prefersReducedMotion } from '@/composables/useSpring';
import { isLowEndDevice } from '@/shared/deviceTier';
import { IMG_W_CARD, sizedImage } from '@/shared/imageSize';

const props = defineProps<{
  item: MediaItem;
  /** 形变起点：卡片海报区的视口矩形 */
  anchor: PeekAnchorRect;
  /** 长按起始触点；没有触点（键盘触发）就不吃滑动 */
  origin: { x: number; y: number } | null;
}>();

const emit = defineEmits<{
  (e: 'play', clip: PeekClip | null): void;
  (e: 'favorite'): void;
  (e: 'dismiss', reason: PeekDismissReason): void;
}>();

/** 形变时长：再长就开始觉得"跟不上手" */
const MORPH_MS = 300;
const MORPH_EASE = 'cubic-bezier(0.22, 0.9, 0.26, 1)';
/** 滑动判定阈值（与实验室稿一致：48px 够明确，又不至于抬手就误触） */
const SWIPE_PX = 48;
/** 放映台与页面两侧的留白，和 `--layout-page-padding-x` 同量级 */
const STAGE_PADDING = 20;
/** 底部留给 Tab 栏的高度：放映台不压在导航上 */
const STAGE_BOTTOM_RESERVE = 84;
/** 循环节奏 */
const CYCLE_MS = 700;

const stageEl = useTemplateRef<HTMLElement>('stage');
const closing = ref(false);
const armed = ref<'none' | 'play' | 'fav'>('none');
const shift = ref(0);
const clip = ref<PeekClip | null>(null);
const fallback = ref<'loading' | PeekFallback | null>('loading');
const frameIndex = ref(0);

const motionOk = computed(() => !prefersReducedMotion());
/** 海报沿用卡片那份已加载的地址：同一个 URL，放映台不再走一次网络 */
const posterSrc = computed(() => sizedImage(props.item.posterUrl, IMG_W_CARD));
const showingFrames = computed(() => clip.value !== null && clip.value.frames.length > 0);
const currentFrame = computed<string | null>(() => {
  const frames = clip.value?.frames;
  if (!frames || frames.length === 0) return null;
  return frames[Math.min(frameIndex.value, frames.length - 1)] ?? null;
});
const progressPercent = computed(() => {
  const total = clip.value?.frames.length ?? 0;
  if (total === 0) return 0;
  return Math.round(((Math.min(frameIndex.value, total - 1) + 1) / total) * 100);
});
const note = computed(() => {
  if (fallback.value === 'loading') return '正在取帧…';
  if (fallback.value !== null) return peekFallbackNote(fallback.value);
  return clip.value ? `本地 · ${clip.value.episodeLabel}` : '';
});
const stillAnimated = computed(() => motionOk.value && !isLowEndDevice());

const stageStyle = computed(() => ({
  transform: `translate3d(0, ${shift.value}px, 0) scale(${1 - Math.min(Math.abs(shift.value) / 900, 0.08)})`,
}));

function targetRect(): PeekAnchorRect {
  const vw = window.innerWidth || document.documentElement.clientWidth || 360;
  const vh = window.innerHeight || document.documentElement.clientHeight || 640;
  const width = Math.min(vw - STAGE_PADDING * 2, 640);
  const height = Math.round((width * 9) / 16);
  return {
    top: Math.max(16, Math.round((vh - STAGE_BOTTOM_RESERVE - height) / 2)),
    left: Math.round((vw - width) / 2),
    width: Math.round(width),
    height,
  };
}

/** 展开后的终态矩形：收起时要从它演回卡片，而不是回读 DOM 上的内联样式 */
const expanded = ref<PeekAnchorRect | null>(null);

/** 基础态即终态：先把终态写进内联样式，再让 WAAPI 从卡片矩形演过来 */
function applyTarget(): PeekAnchorRect {
  const rect = targetRect();
  expanded.value = rect;
  const el = stageEl.value;
  if (el) {
    el.style.top = `${rect.top}px`;
    el.style.left = `${rect.left}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
  }
  return rect;
}

function morph(from: PeekAnchorRect, to: PeekAnchorRect): Promise<void> | null {
  const el = stageEl.value;
  if (!el || !motionOk.value || typeof el.animate !== 'function') return null;
  const frame = (r: PeekAnchorRect): Keyframe => ({
    top: `${r.top}px`,
    left: `${r.left}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  const animation = el.animate([frame(from), frame(to)], {
    duration: MORPH_MS,
    easing: MORPH_EASE,
  });
  // finished 会被 cancel reject（收起途中又被第二段 morph 打断），这里统一演成「结束」
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}

let cycleTimer: ReturnType<typeof setInterval> | null = null;

function startCycle(): void {
  if (cycleTimer !== null) return;
  cycleTimer = setInterval(() => {
    const total = clip.value?.frames.length ?? 0;
    if (total === 0) return;
    frameIndex.value = (frameIndex.value + 1) % total;
  }, CYCLE_MS);
}

function stopCycle(): void {
  if (cycleTimer === null) return;
  clearInterval(cycleTimer);
  cycleTimer = null;
}

function onPointerMove(ev: PointerEvent): void {
  if (closing.value || props.origin === null) return;
  if (ev.isPrimary === false) return;
  const dy = ev.clientY - props.origin.y;
  shift.value = Math.max(-120, Math.min(120, dy * 0.3));
  if (dy <= -SWIPE_PX) armed.value = 'play';
  else if (dy >= SWIPE_PX) armed.value = 'fav';
  else armed.value = 'none';
}

function onPointerUp(): void {
  if (closing.value) return;
  if (armed.value === 'play') {
    finish('swipe');
    emit('play', clip.value);
    return;
  }
  if (armed.value === 'fav') {
    finish('swipe');
    emit('favorite');
    return;
  }
  // 松手没滑动：收起的同时把原来的长按快捷面板接回来
  finish('release');
}

function onScroll(): void {
  if (closing.value) return;
  finish('scroll');
}

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape' || closing.value) return;
  finish('key');
}

function onScrimDown(): void {
  if (closing.value) return;
  finish('scrim');
}

function detach(): void {
  document.removeEventListener('pointermove', onPointerMove);
  document.removeEventListener('pointerup', onPointerUp);
  document.removeEventListener('pointercancel', onPointerUp);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('scroll', onScroll, { capture: true });
}

/** 演完收场动画再通知父层卸载；没有动效可演就直接收 */
function finish(reason: PeekDismissReason): void {
  closing.value = true;
  stopCycle();
  detach();
  // 从展开态演回卡片矩形：用 applyTarget 记下的那一份，样式表随时可能被别的渲染覆盖
  const done = morph(expanded.value ?? props.anchor, props.anchor);
  if (done) void done.then(() => emit('dismiss', reason));
  else emit('dismiss', reason);
}

onMounted(() => {
  const out = applyTarget();
  morph(props.anchor, out);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerUp);
  document.addEventListener('keydown', onKeydown);
  // 滚动会把卡片与矩形一起挪走：就地放映的前提没了，直接收
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });

  void resolvePeekPreview(props.item)
    .then((result) => {
      if (closing.value) return;
      clip.value = result.clip;
      fallback.value = result.clip ? null : (result.fallback ?? 'no-frames');
      // 定时器只在真有帧可轮的时候才挂上：在线源不该揣一个永远空转的 interval
      if (result.clip && result.clip.frames.length > 0) startCycle();
    })
    .catch(() => {
      if (!closing.value) fallback.value = 'no-frames';
    });
});

onBeforeUnmount(() => {
  stopCycle();
  detach();
});
</script>

<template>
  <Teleport to="body">
    <div class="poster-peek" :class="{ 'is-closing': closing }">
      <div class="poster-peek__scrim" @pointerdown="onScrimDown" />
      <div
        ref="stage"
        class="poster-peek__stage"
        :class="{ 'poster-peek__stage--armed-play': armed === 'play', 'poster-peek__stage--armed-fav': armed === 'fav' }"
        :style="stageStyle"
        role="dialog"
        :aria-label="`${item.title} 原位放映`"
      >
        <img
          v-if="currentFrame"
          :src="currentFrame"
          class="poster-peek__frame"
          alt=""
          aria-hidden="true"
          draggable="false"
        />
        <img
          v-else-if="posterSrc"
          :src="posterSrc"
          class="poster-peek__still"
          :class="{ 'is-animated': stillAnimated }"
          alt=""
          aria-hidden="true"
          draggable="false"
        />
        <span v-else class="poster-peek__noimage">{{ item.title }}</span>

        <!-- 齿孔带：沿用「过片幕布 / 胶片进度条」同一套孔距语言，压着画面上下沿走片 -->
        <span v-if="showingFrames" class="poster-peek__perf poster-peek__perf--top" aria-hidden="true" />
        <span v-if="showingFrames" class="poster-peek__perf poster-peek__perf--bottom" aria-hidden="true" />

        <span class="poster-peek__note">{{ note }}</span>

        <div class="poster-peek__bar" aria-hidden="true">
          <span class="poster-peek__bar-fill" :style="{ width: `${progressPercent}%` }" />
        </div>

        <div class="poster-peek__caption">
          <span class="poster-peek__title truncate-1">{{ item.title }}</span>
          <span class="poster-peek__hint">
            {{ origin ? '上滑播放 · 下滑收藏 · 松手回菜单' : 'Esc 关闭' }}
          </span>
        </div>

        <span
          v-if="armed === 'play'"
          class="poster-peek__cue poster-peek__cue--play"
          aria-hidden="true"
        >松手播放</span>
        <span
          v-if="armed === 'fav'"
          class="poster-peek__cue poster-peek__cue--fav"
          aria-hidden="true"
        >松手收藏</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.poster-peek {
  position: fixed;
  inset: 0;
  /* 压过内容、Tab 栏与页头，但让位给快捷面板 / 弹窗 / Toast */
  z-index: calc(var(--z-sheet) - 1);
  pointer-events: none;
}

.poster-peek__scrim {
  position: absolute;
  inset: 0;
  background: var(--color-bg-overlay-soft);
  pointer-events: auto;
  animation: peek-scrim-in 180ms var(--ease-standard) both;
}

.poster-peek.is-closing .poster-peek__scrim {
  animation: peek-scrim-out 220ms var(--ease-standard) both;
}

.poster-peek__stage {
  /* 这里写的是展开后的终态；起点由 JS 演过来，减弱动效时直接就是它 */
  position: absolute;
  box-sizing: border-box;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  border: 1px solid var(--color-border-glass);
  border-radius: var(--radius-lg);
  background-color: #06080b;
  box-shadow: var(--shadow-4);
  pointer-events: auto;
  /* transform 只用来跟随手指滑动，形变走 top/left/width/height */
  transition: border-color var(--duration-fast) var(--ease-standard);
  will-change: transform;
  touch-action: none;
  user-select: none;
}

.poster-peek__stage--armed-play {
  border-color: var(--color-brand);
}

.poster-peek__stage--armed-fav {
  border-color: var(--color-success);
}

.poster-peek__frame,
.poster-peek__still,
.poster-peek__noimage {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.poster-peek__frame {
  /* 帧与帧之间不做交叉淡入：抽帧本来就是离散画面，硬切最诚实也最省合成 */
  image-rendering: auto;
}

.poster-peek__still.is-animated {
  /* Ken Burns：慢推 + 轻微横移，9s 一趟往返，只动 transform */
  animation: peek-kenburns 9s var(--ease-in-out) infinite alternate;
}

.poster-peek__noimage {
  display: grid;
  place-items: center;
  padding: 0 var(--space-5);
  font: var(--font-weight-semibold) 14px / 1.4 var(--font-family-base);
  color: var(--color-text-secondary);
  text-align: center;
  background: var(--color-bg-surface);
}

.poster-peek__perf {
  position: absolute;
  left: 0;
  right: 0;
  height: 12px;
  z-index: 2;
  opacity: 0.5;
  background-image: repeating-linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.55) 0 3px,
    transparent 3px 9px
  );
  pointer-events: none;
}

.poster-peek__perf--top {
  top: 3px;
}

.poster-peek__perf--bottom {
  bottom: 3px;
}

.poster-peek__note {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  z-index: 3;
  padding: 3px 7px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.72);
  color: #ffffff;
  font: var(--font-weight-regular) 10.5px / 1 var(--font-family-base);
  pointer-events: none;
}

.poster-peek__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  z-index: 3;
  background: rgba(255, 255, 255, 0.2);
  pointer-events: none;
}

.poster-peek__bar-fill {
  display: block;
  height: 100%;
  background: var(--color-brand);
}

.poster-peek__caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 22px var(--space-3) 8px;
  background: linear-gradient(180deg, transparent, rgba(0, 0, 0, 0.78));
  pointer-events: none;
}

.poster-peek__title {
  min-width: 0;
  font: var(--font-weight-semibold) 13px / 1.3 var(--font-family-base);
  color: #ffffff;
}

.poster-peek__hint {
  flex: 0 0 auto;
  font: var(--font-weight-regular) 10.5px / 1 var(--font-family-base);
  color: rgba(255, 255, 255, 0.72);
}

.poster-peek__cue {
  position: absolute;
  left: 50%;
  z-index: 4;
  transform: translateX(-50%);
  padding: 5px 12px;
  border-radius: var(--radius-pill);
  font: var(--font-weight-semibold) 12px / 1 var(--font-family-base);
  color: #ffffff;
  pointer-events: none;
  animation: peek-cue 160ms var(--ease-decelerate) both;
}

.poster-peek__cue--play {
  top: var(--space-3);
  background: var(--color-brand);
}

.poster-peek__cue--fav {
  bottom: var(--space-3);
  background: var(--color-success);
  color: #04140d;
}

@keyframes peek-scrim-in {
  from {
    opacity: 0;
  }

  to {
    opacity: 1;
  }
}

@keyframes peek-scrim-out {
  from {
    opacity: 1;
  }

  to {
    opacity: 0;
  }
}

@keyframes peek-kenburns {
  from {
    transform: scale(1) translate3d(0, 0, 0);
  }

  to {
    transform: scale(1.09) translate3d(-2.5%, 1.5%, 0);
  }
}

@keyframes peek-cue {
  from {
    opacity: 0;
    transform: translateX(-50%) scale(0.9);
  }

  to {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
}

/*
 * 减弱动效：基础态就是终态（放映台已经是展开尺寸），这里只关掉会一直动的部分——
 * 遮罩淡入淡出与 Ken Burns 循环。帧循环是内容不是装饰，保留。
 */
@media (prefers-reduced-motion: reduce) {
  .poster-peek__scrim,
  .poster-peek.is-closing .poster-peek__scrim,
  .poster-peek__cue {
    animation: none;
  }

  .poster-peek__still.is-animated {
    animation: none;
  }
}
</style>
