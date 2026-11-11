<script setup lang="ts">
/**
 * 海报卡（设计规范 8.4）
 *
 * 结构：海报 2:3 + 标题 2 行 + 可选副信息；角标（集数/演示/已下载）+ 进度条。
 * 图片懒加载与失败占位由 `PosterImage` 负责。
 * 无障碍：整卡为 button，`aria-label="片名，年份"`。
 * C-08：鼠标悬停时卡片随指针 3D 倾斜 + 镜面高光；触屏没有 hover，主反馈落在
 * 长按那一刻的抬升（与既有长按菜单同一次触发，不另起一套）。
 */
import { computed, onBeforeUnmount, useTemplateRef } from 'vue';

import type { MediaItem } from '@/types';

import PosterImage from '@/components/common/PosterImage.vue';
import IconCheck from '@/components/icons/IconCheck.vue';
import { mediaTypeLabel } from '@/components/common/format';
import { useHaptic } from '@/composables/useHaptic';
import { prefersReducedMotion } from '@/composables/useSpring';
import { isLowEndDevice } from '@/shared/deviceTier';
import { liftPose, restPose, tiltPose } from '@/shared/posterTilt';

const props = withDefaults(
  defineProps<{
    item: MediaItem;
    /** 进度 0~1，>0 时显示底部进度条 */
    progress?: number;
    /** 左上角角标文本（如"第 3 集"） */
    badge?: string;
    /** 右上角"演示"角标 */
    demo?: boolean;
    /** 右上角已下载标记 */
    downloaded?: boolean;
    /** 是否显示副标题（年份 · 类型） */
    showMeta?: boolean;
  }>(),
  { progress: 0, badge: '', demo: false, downloaded: false, showMeta: true },
);

const emit = defineEmits<{ (e: 'select', item: MediaItem): void; (e: 'longpress', item: MediaItem): void }>();

const { haptic } = useHaptic();

/** 演示角标：显式传入或由数据自身 isDemo 决定（避免调用方漏传） */
const showDemo = computed(() => props.demo || props.item.isDemo);

const ariaLabel = computed(() =>
  props.item.year !== null ? `${props.item.title}，${props.item.year}` : props.item.title,
);

const progressPercent = computed(() => Math.round(Math.min(1, Math.max(0, props.progress)) * 100));

let pressTimer: ReturnType<typeof setTimeout> | null = null;
/** 长按已触发：随后的 click 需要被吞掉，避免误导航 */
let longPressFired = false;

const cardEl = useTemplateRef<HTMLElement>('card');
const sheenEl = useTemplateRef<HTMLElement>('sheen');

/** 档位只在首次交互时现读一次，不在每次 pointermove 里查 matchMedia */
let tiltOk: boolean | null = null;
let lifted = false;
let tilting = false;
let pendingFrame = 0;
let pendingX = 0;
let pendingY = 0;

function canTilt(): boolean {
  if (tiltOk === null) tiltOk = !prefersReducedMotion() && !isLowEndDevice();
  return tiltOk;
}

/** 抬升比逐帧倾斜便宜得多（一次一张卡），只跟随「减少动态效果」降级 */
function canLift(): boolean {
  return !prefersReducedMotion();
}

function applyPose(pose: ReturnType<typeof tiltPose>, withSheen: boolean): void {
  const card = cardEl.value;
  if (!card) return;
  card.style.transform = pose.transform;
  card.style.boxShadow = pose.boxShadow;
  const sheen = sheenEl.value;
  if (!sheen) return;
  sheen.style.opacity = withSheen ? '1' : '0';
  if (withSheen) {
    sheen.style.setProperty('--sheen-x', pose.sheenX);
    sheen.style.setProperty('--sheen-y', pose.sheenY);
  }
}

/**
 * 归位：内联样式清空后 CSS 的 `:active` / transition 重新接管。
 * will-change 只在交互期间挂着——虚拟网格同屏几十张卡常挂会把显存吃光。
 */
function resetPose(): void {
  if (pendingFrame !== 0) {
    cancelAnimationFrame(pendingFrame);
    pendingFrame = 0;
  }
  const card = cardEl.value;
  if (!card) return;
  applyPose(restPose(), false);
  card.style.transition = '';
  card.style.willChange = '';
  card.classList.remove('is-lifted', 'is-tilting');
  tilting = false;
  lifted = false;
  window.removeEventListener('scroll', resetPose, { capture: true });
}

function watchScroll(): void {
  // 滚动会把节点飞走或换给别的数据：立刻复位，不留一张歪卡片
  window.addEventListener('scroll', resetPose, { capture: true, passive: true });
}

function onPointerEnter(ev: PointerEvent): void {
  if (ev.pointerType !== 'mouse' || !canTilt() || tilting || lifted) return;
  tilting = true;
  const card = cardEl.value;
  if (card) {
    card.style.willChange = 'transform';
    card.style.transition = 'transform 90ms linear, box-shadow 200ms linear';
    card.classList.add('is-tilting');
  }
  watchScroll();
}

function onPointerMove(ev: PointerEvent): void {
  if (!tilting) return;
  // 一帧只算一次：快速划过海报墙时不排队重算
  pendingX = ev.clientX;
  pendingY = ev.clientY;
  if (pendingFrame !== 0) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = 0;
    const card = cardEl.value;
    if (!card || !tilting) return;
    const box = card.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    applyPose(tiltPose((pendingX - box.left) / box.width, (pendingY - box.top) / box.height), true);
  });
}

function onPointerLeave(): void {
  clearPressTimer();
  if (!tilting && !lifted) return;
  // 交回 CSS 的 fast 过渡收位（150ms，满足"离开后 300ms 内归位"）
  if (cardEl.value) cardEl.value.style.transition = '';
  resetPose();
}

function clearPressTimer(): void {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function onPointerDown(): void {
  longPressFired = false;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressFired = true;
    haptic('medium');
    if (canLift()) {
      resetPose();
      lifted = true;
      const card = cardEl.value;
      if (card) {
        card.style.willChange = 'transform';
        card.classList.add('is-lifted');
        watchScroll();
      }
      applyPose(liftPose(), false);
    }
    emit('longpress', props.item);
  }, 500);
}

function cancelPress(): void {
  clearPressTimer();
  // 松手即复位：压暗交给 BottomSheet 的遮罩，卡片不必继续悬着
  if (lifted) resetPose();
}

function onClick(): void {
  clearPressTimer();
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  emit('select', props.item);
}

onBeforeUnmount(() => {
  cancelPress();
  resetPose();
});
</script>

<template>
  <button
    ref="card"
    class="poster-card"
    type="button"
    :aria-label="ariaLabel"
    @pointerenter="onPointerEnter"
    @pointermove="onPointerMove"
    @pointerdown="onPointerDown"
    @pointerup="cancelPress"
    @pointerleave="onPointerLeave"
    @pointercancel="cancelPress"
    @contextmenu.prevent
    @click="onClick"
  >
    <div class="poster-card__frame">
      <PosterImage :src="item.posterUrl" :alt="item.title" />

      <!-- C-08：跟随指针的镜面高光，只在倾斜期间点亮 -->
      <span ref="sheen" class="poster-card__sheen" aria-hidden="true" />

      <span v-if="badge" class="poster-card__badge">{{ badge }}</span>
      <span v-else-if="item.episodeCount && item.episodeCount > 1" class="poster-card__badge">
        全 {{ item.episodeCount }} 集
      </span>

      <span v-if="showDemo" class="poster-card__badge poster-card__badge--demo">演示</span>
      <span v-else-if="downloaded" class="poster-card__badge poster-card__badge--done" aria-label="已下载">
        <IconCheck :size="14" />
      </span>

      <div
        v-if="progressPercent > 0"
        class="poster-card__progress"
        role="progressbar"
        :aria-valuenow="progressPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`已观看 ${progressPercent}%`"
      >
        <span class="poster-card__progress-fill" :style="{ width: `${progressPercent}%` }" />
      </div>
    </div>

    <span class="poster-card__title clamp-2">{{ item.title }}</span>
    <span v-if="showMeta" class="poster-card__meta">
      {{ item.year ?? '未知年份' }} · {{ mediaTypeLabel(item.type) }}
    </span>
  </button>
</template>

<style scoped>
.poster-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  text-align: left;
  transition:
    transform var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}

.poster-card:active {
  transform: scale(0.985);
}

/* C-08：抬升态只加阴影，transform 由 JS 现算（同一张卡不会两处写） */
.poster-card.is-lifted {
  box-shadow: var(--shadow-4);
}

.poster-card__frame {
  position: relative;
  width: 100%;
  border-radius: var(--radius-card);
  overflow: hidden;
  background-color: var(--color-bg-surface);
  transition: box-shadow var(--duration-base) var(--ease-standard);
}

.poster-card.is-tilting .poster-card__frame {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
}

/* 跟随指针的镜面高光：默认不透明度 0，倾斜期间由 JS 写入 --sheen-x/y */
.poster-card__sheen {
  position: absolute;
  inset: 0;
  opacity: 0;
  pointer-events: none;
  /* 0.34 是实验室稿实测的"能看出玻璃、又不至于泛白"上限 */
  background:
    radial-gradient(
      circle at var(--sheen-x, 50%) var(--sheen-y, 50%),
      rgba(255, 255, 255, 0.34),
      rgba(255, 255, 255, 0.05) 42%,
      transparent 66%
    );
  transition: opacity var(--duration-base) var(--ease-standard);
}

/* 角标统一为半透明胶囊，压在海报上不抢画面 */
/* OPT-22: 去 backdrop-filter（低端 WebView 合成开销大），底色加深补偿可读性 */
.poster-card__badge {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  height: 20px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  background-color: rgba(0, 0, 0, 0.72);
  color: #ffffff;
  font: var(--font-weight-semibold) 10.5px / 1 var(--font-family-number);
  letter-spacing: 0.01em;
}

.poster-card__badge--demo,
.poster-card__badge--done {
  left: auto;
  right: var(--space-2);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
}

/* 已下载：实心绿底 + 深色对勾，比文字更易扫读 */
.poster-card__badge--done {
  width: 20px;
  padding: 0;
  justify-content: center;
  background-color: var(--color-success);
  color: #04140d;
}

.poster-card__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background-color: rgba(255, 255, 255, 0.22);
}

.poster-card__progress-fill {
  display: block;
  height: 100%;
  border-radius: 0 2px 2px 0;
  background-color: var(--color-brand);
}

.poster-card__title {
  font: var(--font-weight-semibold) 13px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.poster-card__meta {
  font: var(--font-weight-regular) 11px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}
</style>
