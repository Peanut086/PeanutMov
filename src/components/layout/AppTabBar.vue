<script setup lang="ts">
/**
 * 底部 Tab 栏（设计规范 8.15；CHG-13 起为 5 Tab）
 *
 * 高度 56 + safe-bottom；5 个 Tab 等分；选中态品牌色；下载 Tab 带未完成数角标。
 * 图标内联 SVG 组件（统一 24 线性风格），不使用图标字体。
 */
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useDownloadStore } from '@/stores/downloadStore';
import { useUiStore, type TabKey } from '@/stores/uiStore';

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
const ui = useUiStore();
const downloads = useDownloadStore();

/**
 * 角标数据来源：仅展示汇总，不需要任务列表。
 * TabBar 在首页/Tab 切换时反复挂载，`load()` 内部幂等（重复订阅有保护），
 * 但避免每次挂载都读库，这里只在 store 尚未进入终态时加载一次。
 */
onMounted(() => {
  if (downloads.state === 'idle') void downloads.load().catch(() => undefined);
});

const activeTab = computed<string>(() => {
  const metaTab = typeof route.meta.tab === 'string' ? route.meta.tab : null;
  if (metaTab) return metaTab;
  const matched = route.matched.find((r) => typeof r.meta.tab === 'string')?.meta.tab;
  return typeof matched === 'string' ? matched : 'home';
});

/** 未完成任务数（进行中 + 等待 + 暂停） */
const pendingCount = computed(
  () => downloads.summary.downloading + downloads.summary.queued + downloads.summary.paused,
);

const badgeText = computed(() => (pendingCount.value > 99 ? '99+' : String(pendingCount.value)));

function go(tab: TabItem): void {
  ui.setActiveTab(tab.key);
  if (route.path === tab.to) {
    globalThis.scrollTo?.({ top: 0, behavior: 'smooth' });
    return;
  }
  void router.push(tab.to);
}
</script>

<template>
  <nav class="tabbar" aria-label="主导航">
    <button
      v-for="tab in tabs"
      :key="tab.key"
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

.tabbar__item {
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
