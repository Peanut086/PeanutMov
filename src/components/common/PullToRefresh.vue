<script setup lang="ts">
/**
 * 下拉刷新组件（OPT-05）
 *
 * 包裹滚动容器，监听 touchstart/touchmove/touchend 实现下拉刷新。
 * 仅使用 transform/opacity 动画，保证 GPU 合成层性能。
 * 支持 prefers-reduced-motion。
 *
 * 用法：
 *   <PullToRefresh @refresh="handleRefresh" :loading="isRefreshing">
 *     <div class="scroll-container">...</div>
 *   </PullToRefresh>
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';

import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import CountdownRing from '@/components/common/CountdownRing.vue';
import { useHaptic } from '@/composables/useHaptic';

const props = withDefaults(
  defineProps<{
    /** 外部刷新状态，为 true 时保持 spinner 显示 */
    loading?: boolean;
    /** 下拉触发阈值（px） */
    threshold?: number;
    /** 最大下拉距离（px） */
    maxPull?: number;
  }>(),
  {
    loading: false,
    threshold: 60,
    maxPull: 120,
  },
);

const emit = defineEmits<{
  (e: 'refresh'): void;
}>();

const { haptic } = useHaptic();

/** 当前下拉距离（px） */
const pullDistance = ref(0);
/** 是否正在触摸 */
const touching = ref(false);
/** 触摸起始 Y 坐标 */
const startY = ref(0);
/** 是否已触发刷新（松手后等待 loading 结束） */
const triggered = ref(false);

/** 根元素引用，用于检测可滚动子容器 */
const rootRef = ref<HTMLElement | null>(null);
/** 实际滚动容器（插槽内或祖先里真正在滚的那个）；null 表示滚的是文档 */
let scrollEl: HTMLElement | null = null;
/** 文档滚动模式：指示器必须钉在视口上，否则会随页面滚出屏幕 */
const documentScroll = ref(false);
/** 文档模式下指示器的视口锚点（内容区上沿，即顶栏/筛选条下方） */
const anchorTop = ref(0);

/** 指示器盒子高度，与 .ptr-indicator 的 height 同步 */
const INDICATOR_HEIGHT = 64;

/** 是否处于激活状态（下拉超过阈值或正在刷新） */
const isActive = computed(() => pullDistance.value >= props.threshold || props.loading || triggered.value);

/** 是否处于 reduced-motion 模式 */
const reducedMotion = ref(false);

let mediaQuery: MediaQueryList | null = null;

onMounted(() => {
  if (typeof window === 'undefined') return;
  mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.value = mediaQuery.matches;
  const handler = (e: MediaQueryListEvent): void => {
    reducedMotion.value = e.matches;
  };
  mediaQuery.addEventListener('change', handler);
  onBeforeUnmount(() => {
    mediaQuery?.removeEventListener('change', handler);
  });
});

/** 用户能滚的容器：overflow-y 允许滚动，且内容确实溢出了 */
function isScrollable(el: HTMLElement): boolean {
  const overflowY = window.getComputedStyle(el).overflowY;
  const canScroll = overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
  return canScroll && el.scrollHeight > el.clientHeight + 1;
}

/**
 * 找出真正在滚的容器（REV-02 + 11-14 #4）。
 *
 * 只在挂载时找一次是不够的：数据回来后内容才撑高。更要紧的是本 App 的骨架
 * `min-height:100%` 没有确定高度，内层 body 的 `overflow-y:auto` 从不溢出，
 * **滚的是文档**——找不到容器时必须按文档处理，而不是当成"永远在顶部"。
 */
function resolveScroller(): void {
  scrollEl = null;
  const root = rootRef.value;
  if (!root) return;
  for (let i = 0; i < root.children.length; i += 1) {
    const child = root.children[i];
    if (child instanceof HTMLElement && isScrollable(child)) {
      scrollEl = child;
      return;
    }
  }
  let node = root.parentElement;
  while (node && node !== document.body) {
    if (isScrollable(node)) {
      scrollEl = node;
      return;
    }
    node = node.parentElement;
  }
}

/** 判断滚动容器是否位于顶部 */
function isAtTop(): boolean {
  if (scrollEl) return scrollEl.scrollTop <= 0;
  return (window.scrollY || document.documentElement.scrollTop || 0) <= 0;
}

function onTouchStart(e: TouchEvent): void {
  if (props.loading || triggered.value) return;
  resolveScroller();
  /* 只在滚动容器位于顶部时响应下拉 */
  if (!isAtTop()) return;
  documentScroll.value = scrollEl === null;
  if (documentScroll.value) {
    // 内容区上沿此刻在视口里的位置：指示器从这里往下滑出，不会盖住顶栏
    anchorTop.value = Math.max(0, Math.round(rootRef.value?.getBoundingClientRect().top ?? 0));
  }
  touching.value = true;
  startY.value = e.touches[0].clientY;
}

function onTouchMove(e: TouchEvent): void {
  if (!touching.value || props.loading || triggered.value) return;
  if (!isAtTop()) return;

  const deltaY = e.touches[0].clientY - startY.value;
  if (deltaY <= 0) {
    pullDistance.value = 0;
    return;
  }
  /* 阻尼效果：越往下拉阻力越大 */
  const damped = Math.min(props.maxPull, deltaY * 0.5);
  pullDistance.value = damped;
}

function onTouchEnd(): void {
  if (!touching.value) return;
  touching.value = false;

  if (pullDistance.value >= props.threshold && !props.loading) {
    triggered.value = true; // 先锁定，防止重复触发（REV-03）
    // 释放后停在指示器盒高处，与 .ptr-indicator 的 64px 一致（A1①：消除 60/64 分叉导致的 4px 偏差）
    pullDistance.value = INDICATOR_HEIGHT;
    haptic('light');
    emit('refresh');
  } else {
    pullDistance.value = 0;
  }
}

/**
 * 系统手势/来电等打断（touchcancel）：仅收回下拉，不触发刷新（A1③）。
 * 复用 onTouchEnd 会让「已经过阈值但被系统打断」误发 refresh。
 */
function onTouchCancel(): void {
  if (!touching.value) return;
  touching.value = false;
  triggered.value = false;
  pullDistance.value = 0;
}

/** 外部 loading 结束后，收回下拉 */
function onLoadingChange(): void {
  if (!props.loading && triggered.value) {
    triggered.value = false;
    pullDistance.value = 0;
  }
}

/* 监听 loading 变化，刷新完成后收回下拉 */
watch(() => props.loading, onLoadingChange);

/** 指示器位移（跟随 pullDistance） */
const indicatorStyle = computed<CSSProperties>(() => {
  const transition = touching.value
    ? 'none'
    : reducedMotion.value
      ? 'transform 0.1s ease'
      : 'transform 0.3s cubic-bezier(0.2, 0, 0, 1)';
  if (!documentScroll.value) {
    return { transform: `translateY(${pullDistance.value}px)`, transition };
  }
  // 文档在滚：absolute 会跟着页面滚走，且被 .pull-to-refresh 的 overflow:hidden 裁掉。
  // fixed 脱离裁剪，钉在内容区上沿；空闲时透明，避免常驻盖在顶栏/筛选条上。
  const shown = pullDistance.value > 0 || props.loading || triggered.value;
  return {
    position: 'fixed',
    top: `${anchorTop.value - INDICATOR_HEIGHT}px`,
    transform: `translateY(${pullDistance.value}px)`,
    opacity: shown ? 1 : 0,
    transition: touching.value ? 'none' : `${transition}, opacity 150ms var(--ease-standard)`,
  };
});

/** 箭头/ spinner 旋转 */
const iconRotation = computed(() => {
  if (props.loading || triggered.value) return 180;
  return (pullDistance.value / props.threshold) * 180;
});

/** F4：下拉进度环 —— 复用 B-06 环形，ratio = pullDistance / threshold */
const showRing = computed(() => !props.loading && !triggered.value && pullDistance.value > 4);
const ringTotal = computed(() => props.threshold);
const ringCountdown = computed(() => {
  if (props.loading || triggered.value) return props.threshold;
  // reduced-motion：环静态满/空（过阈值满，否则空），不做连续收放
  if (reducedMotion.value) return pullDistance.value >= props.threshold ? props.threshold : 0;
  return Math.min(props.threshold, pullDistance.value);
});
/** 过阈值「即将刷新」态 */
const ready = computed(
  () => !props.loading && !triggered.value && pullDistance.value >= props.threshold,
);
const ptrLabel = computed(() => {
  if (props.loading || triggered.value) return '正在刷新';
  if (pullDistance.value >= props.threshold) return '释放刷新';
  return '下拉刷新';
});
</script>

<template>
  <div
    ref="rootRef"
    class="pull-to-refresh"
    @touchstart.passive="onTouchStart"
    @touchmove.passive="onTouchMove"
    @touchend.passive="onTouchEnd"
    @touchcancel.passive="onTouchCancel"
  >
    <!-- 下拉指示器 -->
    <div class="ptr-indicator" :style="indicatorStyle" aria-hidden="true">
      <div
        class="ptr-indicator__inner"
        :class="{ 'ptr-indicator__inner--active': isActive, 'ptr-indicator__inner--ready': ready }"
      >
        <LoadingSpinner v-if="loading || triggered" :size="20" />
        <template v-else>
          <CountdownRing
            class="ptr-indicator__ring"
            :class="{ 'ptr-indicator__ring--show': showRing }"
            :countdown="ringCountdown"
            :total="ringTotal"
            track="var(--color-overlay-track)"
            :instant="true"
          />
          <span
            class="ptr-indicator__cross"
            :class="{ 'ptr-indicator__cross--show': showRing }"
          />
          <svg
            class="ptr-indicator__arrow"
            :class="{ 'ptr-indicator__arrow--hide': showRing }"
            :style="{ transform: `rotate(${iconRotation}deg)` }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 5v14M5 12l7 7 7-7" />
          </svg>
        </template>
      </div>
      <span class="ptr-indicator__label" :class="{ 'ptr-indicator__label--ready': ready }">
        {{ ptrLabel }}
      </span>
    </div>

    <!-- 无障碍状态播报（REV-06） -->
    <div class="ptr-sr-only" role="status" aria-live="polite">
      {{ loading ? '正在刷新' : '' }}
    </div>

    <!-- 默认插槽：滚动容器 -->
    <slot />
  </div>
</template>

<style scoped>
.pull-to-refresh {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.ptr-indicator {
  position: absolute;
  top: -64px;
  left: 0;
  right: 0;
  height: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  padding-bottom: var(--space-2);
  z-index: 10;
  pointer-events: none;
}

.ptr-indicator__inner {
  position: relative;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-elevated);
  border: var(--border-default);
  color: var(--color-text-tertiary);
  opacity: 0.6;
  transition: opacity var(--duration-fast) var(--ease-standard),
    background-color var(--duration-fast) var(--ease-standard),
    box-shadow var(--duration-fast) var(--ease-standard);
}

.ptr-indicator__inner--active {
  opacity: 1;
  color: var(--color-brand);
}

/* F4：过阈值「即将刷新」—— 品牌光晕提示 */
.ptr-indicator__inner--ready {
  box-shadow: 0 0 0 3px var(--color-brand-soft);
}

/* F4：进度环与箭头交叉淡入（150ms），叠在 32px 圆心 */
.ptr-indicator__ring {
  position: absolute;
  inset: 3px;
  opacity: 0;
  transition: opacity 150ms var(--ease-standard);
}

.ptr-indicator__ring--show {
  opacity: 1;
}

/* 片头倒计时十字准星（academy leader 意象） */
.ptr-indicator__cross {
  position: absolute;
  width: 11px;
  height: 11px;
  opacity: 0;
  transition: opacity 150ms var(--ease-standard);
}

.ptr-indicator__cross--show {
  opacity: 0.55;
}

.ptr-indicator__cross::before,
.ptr-indicator__cross::after {
  content: '';
  position: absolute;
  background-color: var(--color-brand);
}

.ptr-indicator__cross::before {
  left: 50%;
  top: 0;
  width: 1.5px;
  height: 100%;
  transform: translateX(-50%);
}

.ptr-indicator__cross::after {
  top: 50%;
  left: 0;
  height: 1.5px;
  width: 100%;
  transform: translateY(-50%);
}

.ptr-indicator__arrow {
  width: 18px;
  height: 18px;
  transition: transform var(--duration-fast) var(--ease-standard),
    opacity 150ms var(--ease-standard);
}

.ptr-indicator__arrow--hide {
  opacity: 0;
}

.ptr-indicator__label {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  transition: color var(--duration-fast) var(--ease-standard);
}

.ptr-indicator__label--ready {
  color: var(--color-brand-text);
  font-weight: var(--font-weight-semibold);
}

/* 无障碍：视觉隐藏但屏幕阅读器可读 */
.ptr-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Reduced motion: 禁用箭头旋转动画 */
@media (prefers-reduced-motion: reduce) {
  .ptr-indicator__arrow,
  .ptr-indicator__ring,
  .ptr-indicator__cross,
  .ptr-indicator__label,
  .ptr-indicator__inner {
    transition: none;
  }

  .ptr-indicator {
    transition: none !important;
  }
}
</style>
