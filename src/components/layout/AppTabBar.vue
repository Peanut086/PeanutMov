<script setup lang="ts">
/**
 * 底部 Tab 栏（设计规范 8.15）
 *
 * 高度 56 + safe-bottom；4 个 Tab 等分；选中态品牌色；下载 Tab 带未完成数角标。
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
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-tabbar);
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  height: calc(var(--layout-tabbar-height) + var(--safe-bottom));
  padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left);
  background-color: var(--color-bg-surface);
  border-top: var(--border-default);
}

.tabbar__item {
  min-width: 44px;
  min-height: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  color: var(--color-text-tertiary);
  transition: var(--transition-color);
}

.tabbar__item:active {
  background-color: rgba(255, 255, 255, 0.06);
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
  width: 24px;
  height: 24px;
  transition: var(--transition-transform);
}

.tabbar__label {
  font: var(--text-caption);
}

.tabbar__badge {
  position: absolute;
  top: 0;
  right: 0;
  transform: translate(6px, -4px);
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: var(--color-brand);
  color: var(--color-text-on-brand);
  font: var(--font-weight-semibold) var(--font-size-12) / 1 var(--font-family-base);
}
</style>
