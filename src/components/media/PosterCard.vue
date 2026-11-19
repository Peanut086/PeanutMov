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
import { computed, onBeforeUnmount, ref, useTemplateRef } from 'vue';

import type { MediaItem } from '@/types';

import PosterImage from '@/components/common/PosterImage.vue';
import IconCheck from '@/components/icons/IconCheck.vue';
import IconHeart from '@/components/icons/IconHeart.vue';
import IconDownload from '@/components/icons/IconDownload.vue';
import { mediaTypeLabel } from '@/components/common/format';
import { useHaptic } from '@/composables/useHaptic';
import { prefersReducedMotion } from '@/composables/useSpring';
import { beginSharedCover } from '@/composables/useSharedElement';
import { isLowEndDevice } from '@/shared/deviceTier';
import { IMG_W_CARD } from '@/shared/imageSize';
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
    /** M4：长按弹出扇形快捷盘（收藏/下载/分享），关闭时沿用 longpress 事件 */
    quickActions?: boolean;
  }>(),
  { progress: 0, badge: '', demo: false, downloaded: false, showMeta: true, quickActions: false },
);

const emit = defineEmits<{
  (e: 'select', item: MediaItem): void;
  (e: 'longpress', item: MediaItem): void;
  (e: 'quick-favorite', item: MediaItem): void;
  (e: 'quick-download', item: MediaItem): void;
  (e: 'quick-share', item: MediaItem): void;
}>();

const { haptic } = useHaptic();

/** 演示角标：显式传入或由数据自身 isDemo 决定（避免调用方漏传） */
const showDemo = computed(() => props.demo || props.item.isDemo);

const ariaLabel = computed(() =>
  props.item.year !== null ? `${props.item.title}，${props.item.year}` : props.item.title,
);

const progressPercent = computed(() => Math.round(Math.min(1, Math.max(0, props.progress)) * 100));

/**
 * E4：共享元素 key。用 `card:` 前缀与详情 hero 的 mediaId key 区分，
 * 返程（详情→列表）按它重新定位卡片，不会误落到详情 hero 或播放舞台。
 */
const coverKey = computed(() => `card:${props.item.sourceId}:${props.item.id}`);

let pressTimer: ReturnType<typeof setTimeout> | null = null;
/** 长按已触发：随后的 click 需要被吞掉，避免误导航 */
let longPressFired = false;

// M4 场记快捷盘：长按 450ms 弹扇形（收藏/下载/分享）
const radialOpen = ref(false);
const radialX = ref(0);
const radialY = ref(0);
let pressX = 0;
let pressY = 0;

const RADIAL_RADIUS = 56;
const radialActions = computed(() => {
  const angles = [-150, -90, -30];
  const keys = ['favorite', 'download', 'share'] as const;
  const labels = ['收藏', '下载', '分享'];
  return keys.map((k, i) => {
    const rad = (angles[i]! * Math.PI) / 180;
    return {
      key: k,
      label: labels[i]!,
      dx: Math.cos(rad) * RADIAL_RADIUS,
      dy: Math.sin(rad) * RADIAL_RADIUS,
      delay: i * 30,
    };
  });
});

function openRadial(): void {
  const card = cardEl.value;
  if (!card) return;
  const r = card.getBoundingClientRect();
  radialX.value = Math.min(Math.max(r.left + r.width / 2, 70), window.innerWidth - 70);
  radialY.value = Math.max(r.top + r.height * 0.45, 80);
  radialOpen.value = true;
  document.addEventListener('keydown', onRadialKey);
}

function closeRadial(): void {
  if (!radialOpen.value) return;
  radialOpen.value = false;
  document.removeEventListener('keydown', onRadialKey);
  cardEl.value?.focus();
}

function onRadialKey(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeRadial();
}

function quick(key: 'favorite' | 'download' | 'share'): void {
  closeRadial();
  if (key === 'favorite') emit('quick-favorite', props.item);
  else if (key === 'download') emit('quick-download', props.item);
  else emit('quick-share', props.item);
}

function onCardKeydown(ev: KeyboardEvent): void {
  if (props.quickActions && ev.key === 'Enter') {
    ev.preventDefault();
    haptic('medium');
    openRadial();
  }
}

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
  // M4：长按判定期间移动 >10px 视为滚动/滑动，取消长按防误触
  if (pressTimer !== null && Math.hypot(ev.clientX - pressX, ev.clientY - pressY) > 10) {
    clearPressTimer();
  }
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

function onPointerDown(ev: PointerEvent): void {
  longPressFired = false;
  pressX = ev.clientX;
  pressY = ev.clientY;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressFired = true;
    haptic('medium');
    if (props.quickActions) {
      openRadial();
      return;
    }
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
  }, 450);
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
  // E4：去程共享元素 —— 把本卡封面克隆进浮层，详情 hero 挂载后接上形变。
  // 单例守卫（pending 已存在则跳过）保证快速连点不叠 clone；动效关闭/图未加载静默跳过。
  beginSharedCover(cardEl.value?.querySelector('.poster-image') ?? null);
  emit('select', props.item);
}

onBeforeUnmount(() => {
  cancelPress();
  resetPose();
  radialOpen.value = false;
  document.removeEventListener('keydown', onRadialKey);
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
    @keydown="onCardKeydown"
  >
    <div class="poster-card__frame">
      <PosterImage
        :src="item.posterUrl"
        :alt="item.title"
        :fallback-title="item.title"
        :cover-key="coverKey"
        :width-px="IMG_W_CARD"
      />

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

  <!-- M4：扇形快捷盘（Teleport 到 body，避免按钮嵌套与网格裁切） -->
  <Teleport to="body">
    <div v-if="radialOpen" class="qc-radial">
      <div class="qc-radial__scrim" @click="closeRadial" />
      <div
        class="qc-radial__fan"
        :style="{ left: `${radialX}px`, top: `${radialY}px` }"
        role="menu"
        :aria-label="`${item.title} 快捷操作`"
      >
        <button
          v-for="a in radialActions"
          :key="a.key"
          class="qc-radial__btn"
          :class="`qc-radial__btn--${a.key}`"
          :style="{ '--dx': `${a.dx}px`, '--dy': `${a.dy}px`, '--qd': `${a.delay}ms` }"
          type="button"
          role="menuitem"
          @click="quick(a.key)"
        >
          <IconHeart v-if="a.key === 'favorite'" :size="18" />
          <IconDownload v-else-if="a.key === 'download'" :size="18" />
          <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
            <path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4" />
          </svg>
          <span class="qc-radial__label">{{ a.label }}</span>
        </button>
      </div>
    </div>
  </Teleport>
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

/* M4 场记快捷盘 */
.qc-radial {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
}

.qc-radial__scrim {
  position: absolute;
  inset: 0;
  background: var(--color-bg-overlay-soft);
}

.qc-radial__fan {
  position: absolute;
  width: 0;
  height: 0;
}

.qc-radial__btn {
  position: absolute;
  left: 0;
  top: 0;
  width: 56px;
  height: 56px;
  border-radius: var(--radius-full);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  background: var(--color-bg-glass-strong);
  border: 1px solid var(--color-border-glass);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-3);
  transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy)));
  animation: qc-pop 300ms cubic-bezier(0.34, 1.56, 0.64, 1) var(--qd, 0ms) both;
}

.qc-radial__btn--favorite {
  color: var(--color-brand-text);
}

.qc-radial__label {
  font-size: 10px;
  line-height: 1;
  color: var(--color-text-secondary);
}

@keyframes qc-pop {
  from {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.4);
  }
  to {
    opacity: 1;
    transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .qc-radial__btn {
    animation: none;
  }
}
</style>
