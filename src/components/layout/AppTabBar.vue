<script setup lang="ts">
/**
 * 底部 Tab 栏（设计规范 8.15；CHG-13 起为 5 Tab）
 *
 * 高度 56 + safe-bottom；5 个 Tab 等分；选中态品牌色；下载 Tab 带未完成数角标。
 * 图标内联 SVG 组件（统一 24 线性风格），不使用图标字体。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useDownloadStore } from '@/stores/downloadStore';
import type { TabKey } from '@/stores/uiStore';
import { useHaptic } from '@/composables/useHaptic';
import { animateSpring, prefersReducedMotion } from '@/composables/useSpring';
import { logger } from '@/shared/logger';
import { scrollToTop } from '@/shared/scroll';

interface TabItem {
  key: TabKey;
  label: string;
  to: string;
}

const tabs: TabItem[] = [
  { key: 'home', label: '首页', to: '/' },
  { key: 'library', label: '媒体库', to: '/library' },
  { key: 'live', label: '直播', to: '/live' },
  { key: 'downloads', label: '下载', to: '/downloads' },
  { key: 'me', label: '我的', to: '/settings' },
];

const route = useRoute();
const router = useRouter();
const downloads = useDownloadStore();
const { haptic } = useHaptic();

/**
 * 角标数据来源：仅展示汇总，不需要任务列表。
 * TabBar 在首页/Tab 切换时反复挂载，`load()` 内部幂等（重复订阅有保护），
 * 但避免每次挂载都读库，这里只在 store 尚未进入终态时加载一次。
 */
onMounted(() => {
  if (downloads.state === 'idle') void downloads.load().catch(() => undefined);
});

function isTabKey(value: unknown): value is TabKey {
  return typeof value === 'string' && tabs.some((tab) => tab.key === value);
}

/** 选中态唯一来源是路由 `meta.tab`，不再另存一份 store 状态（两处不同步必然错高亮）。 */
const activeTab = computed<TabKey>(() => {
  const raw = route.meta.tab ?? route.matched.find((r) => typeof r.meta.tab === 'string')?.meta.tab;
  if (raw === undefined) return 'home';
  if (isTabKey(raw)) return raw;
  logger.warn('路由 meta.tab 与底部 Tab 不匹配，按首页处理', { tab: raw, path: route.path });
  return 'home';
});

/** 未完成任务数（进行中 + 等待 + 暂停） */
const pendingCount = computed(
  () => downloads.summary.downloading + downloads.summary.queued + downloads.summary.paused,
);

const badgeText = computed(() => (pendingCount.value > 99 ? '99+' : String(pendingCount.value)));

function go(tab: TabItem): void {
  haptic('light');
  if (route.path === tab.to) {
    // 点击当前 Tab：滚动内层容器回顶（window.scrollTo 对内层 overflow 容器无效）
    scrollToTop();
    return;
  }
  void router.push(tab.to);
}

/* ---------- C4：选中态弹簧滑动指示器 ---------- */
const navRef = useTemplateRef<HTMLElement>('nav');
const itemEls: HTMLElement[] = [];
const pillX = ref(0);
const pillW = ref(0);
const pillReady = ref(false);
let stopSpring: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;

function setItemRef(el: unknown, index: number): void {
  if (el instanceof HTMLElement) itemEls[index] = el;
}

/** 量真实按钮矩形，而不是按 1/5 算：安全区/内边距/字号变化都不会让胶囊错位 */
function measureActive(): { x: number; w: number } | null {
  const nav = navRef.value;
  const index = tabs.findIndex((tab) => tab.key === activeTab.value);
  const el = index >= 0 ? itemEls[index] : undefined;
  if (!nav || !el) return null;
  const navRect = nav.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0) return null;
  return { x: rect.left - navRect.left, w: rect.width };
}

function syncPill(animated: boolean): void {
  const target = measureActive();
  if (!target) return;
  pillW.value = target.w;
  stopSpring?.();
  stopSpring = null;

  // 首次定位与系统减动效都直接吸附：进场不该看到胶囊从最左边飞过来
  if (!animated || !pillReady.value || prefersReducedMotion()) {
    pillX.value = target.x;
    pillReady.value = true;
    return;
  }
  stopSpring = animateSpring({
    from: pillX.value,
    target: target.x,
    onFrame: (value) => {
      pillX.value = value;
    },
    onSettle: () => {
      stopSpring = null;
    },
  });
}

watch(activeTab, () => syncPill(true));

onMounted(() => {
  void nextTick(() => syncPill(false));
  if (typeof ResizeObserver === 'function' && navRef.value) {
    resizeObserver = new ResizeObserver(() => syncPill(false));
    resizeObserver.observe(navRef.value);
  }
});

onBeforeUnmount(() => {
  stopSpring?.();
  stopSpring = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <nav ref="nav" class="tabbar" aria-label="主导航">
    <!-- C4：滑动胶囊。绝对定位不占 grid 格，压在按钮之下 -->
    <span
      class="tabbar__pill"
      :class="{ 'tabbar__pill--ready': pillReady }"
      :style="{ width: `${pillW}px`, transform: `translate(${pillX}px, -50%)` }"
      aria-hidden="true"
    />
    <button
      v-for="(tab, index) in tabs"
      :key="tab.key"
      :ref="(el) => setItemRef(el, index)"
      class="tabbar__item"
      :class="{ 'tabbar__item--active': activeTab === tab.key }"
      type="button"
      :aria-current="activeTab === tab.key ? 'page' : undefined"
      @click="go(tab)"
    >
      <span class="tabbar__icon-wrap">
        <svg
          v-if="tab.key === 'home'"
          class="tabbar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 10.6 12 3.6l8.5 7v9.1a1.3 1.3 0 0 1-1.3 1.3H4.8a1.3 1.3 0 0 1-1.3-1.3Z" />
          <path d="M9.4 21V14h5.2v7" />
        </svg>
        <svg
          v-else-if="tab.key === 'library'"
          class="tabbar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3.6" y="3.6" width="7" height="7" rx="1.6" />
          <rect x="13.4" y="3.6" width="7" height="7" rx="1.6" />
          <rect x="3.6" y="13.4" width="7" height="7" rx="1.6" />
          <rect x="13.4" y="13.4" width="7" height="7" rx="1.6" />
        </svg>
        <svg
          v-else-if="tab.key === 'live'"
          class="tabbar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <rect x="3.2" y="6.4" width="17.6" height="13" rx="2" />
          <path d="m8.4 3.2 3.6 3.2 3.6-3.2" />
          <path d="m10.4 10.6 4.4 2.3-4.4 2.3Z" />
        </svg>
        <svg
          v-else-if="tab.key === 'downloads'"
          class="tabbar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3.6v11" />
          <path d="m7.8 10.4 4.2 4.2 4.2-4.2" />
          <path d="M4.6 19.4h14.8" />
        </svg>
        <svg
          v-else
          class="tabbar__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="8.4" r="3.9" />
          <path d="M4.4 20.6c0-3.8 3.4-5.8 7.6-5.8s7.6 2 7.6 5.8" />
        </svg>
        <span
          v-if="tab.key === 'downloads' && pendingCount > 0"
          class="tabbar__badge"
          aria-hidden="true"
        >{{ badgeText }}</span>
      </span>
      <span class="tabbar__label">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
/* 悬浮玻璃胶囊（v2 重设计）：脱离屏幕边缘，浮在内容之上 */
.tabbar {
  position: fixed;
  left: var(--layout-tabbar-inset);
  right: var(--layout-tabbar-inset);
  bottom: calc(var(--layout-tabbar-gap) + var(--safe-bottom));
  z-index: var(--z-tabbar);
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  align-items: center;
  height: var(--layout-tabbar-height);
  padding: 0 var(--space-1);
  border-radius: var(--radius-xl);
  background-color: var(--color-bg-glass);
  -webkit-backdrop-filter: var(--blur-tabbar);
  backdrop-filter: var(--blur-tabbar);
  border: 1px solid var(--color-border-glass);
  box-shadow: var(--shadow-float);
}

/*
 * C4：选中态胶囊。位置由弹簧逐帧写 transform，所以这里**不能**给 transform 加过渡，
 * 否则 CSS 缓动会和物理积分打架，看起来像拖影。
 */
.tabbar__pill {
  position: absolute;
  top: 50%;
  left: 0;
  z-index: 0;
  height: 44px;
  border-radius: var(--radius-md);
  background-color: var(--color-brand-soft);
  border: 1px solid var(--color-border-glass);
  opacity: 0;
  pointer-events: none;
  will-change: transform;
}

.tabbar__pill--ready {
  opacity: 1;
  transition: opacity var(--duration-base) var(--ease-standard);
}

.tabbar__item {
  position: relative;
  z-index: 1;
  min-width: 44px;
  min-height: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  border-radius: var(--radius-md);
  color: var(--color-text-tertiary);
  transition: var(--transition-color);
}

.tabbar__item:active {
  background-color: var(--color-overlay-press);
}

.tabbar__item:active .tabbar__icon {
  transform: scale(0.94);
}

.tabbar__item--active {
  color: var(--color-brand-text);
}

.tabbar__item--active .tabbar__icon {
  transform: translateY(-1px);
}

.tabbar__icon-wrap {
  position: relative;
  display: inline-flex;
}

.tabbar__icon {
  width: 22px;
  height: 22px;
  transition: var(--transition-transform);
}

.tabbar__label {
  font: var(--font-weight-medium) 10px / 1 var(--font-family-base);
  letter-spacing: 0.01em;
}

.tabbar__item--active .tabbar__label {
  font-weight: var(--font-weight-semibold);
}

/* 角标：红色未读数，压在图标右上 */
.tabbar__badge {
  position: absolute;
  top: -2px;
  right: -4px;
  transform: translate(6px, -4px);
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: var(--color-danger);
  color: #ffffff;
  font: var(--font-weight-bold) 9.5px / 1 var(--font-family-number);
  box-shadow: 0 0 0 2px var(--color-bg-base);
}
</style>
