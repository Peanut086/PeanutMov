<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

/**
 * 底部 Tab 栏（SCF 占位实现，路径由 PKG-A 后续替换）
 *
 * 规格见 docs/03-设计规范/设计规范.md「BottomTabBar」：
 * 高度 56px + 安全区、4 个 Tab、选中态使用品牌色、图标 24px、点击区 ≥44×44。
 * 图标暂用内联 SVG（PKG-A 将替换为 `components/icons/*` 组件）。
 */
interface TabItem {
  key: 'home' | 'library' | 'downloads' | 'me';
  label: string;
  to: string;
  /** 内联 SVG path，24×24 线性图标 */
  path: string;
}

const tabs: TabItem[] = [
  { key: 'home', label: '首页', to: '/', path: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5' },
  { key: 'library', label: '媒体库', to: '/library', path: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { key: 'downloads', label: '下载', to: '/downloads', path: 'M12 3v11m0 0 4-4m-4 4-4-4M4 20h16' },
  { key: 'me', label: '我的', to: '/settings', path: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21c0-4 3.6-6 8-6s8 2 8 6' },
];

const route = useRoute();
const router = useRouter();

const activeTab = computed<string>(() => {
  if (typeof route.meta.tab === 'string') return route.meta.tab;
  const metaTab = route.matched.find((r) => typeof r.meta.tab === 'string')?.meta.tab;
  return typeof metaTab === 'string' ? metaTab : 'home';
});

function go(tab: TabItem): void {
  if (route.path === tab.to) return;
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
      <svg class="tabbar__icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          :d="tab.path"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
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

.tabbar__item--active {
  color: var(--color-brand-text);
}

.tabbar__icon {
  width: 24px;
  height: 24px;
}

.tabbar__label {
  font: var(--text-caption);
}
</style>
