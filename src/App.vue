<script setup lang="ts">
import { computed, onErrorCaptured, ref } from 'vue';
import { useRoute } from 'vue-router';

import AppTabBar from '@/components/layout/AppTabBar.vue';
import ToastHost from '@/components/common/ToastHost.vue';

/**
 * 根组件（SCF）：
 * - `RouterView` 页面渲染（进入动画为纯 CSS keyframes，见 §过渡）
 * - `ToastHost`（全局轻提示宿主，uiStore 驱动）
 * - 错误边界：捕获子树未处理异常 → 可恢复错误页（NFR-R04）
 * - 底部 TabBar 仅在 `meta.requiresLayout === true` 的路由渲染
 *
 * 过渡说明：这里**不使用** `<Transition mode="out-in">`。
 * 实测（390px / 连续快速路由切换）：out-in 模式下 leave 阶段再触发导航，
 * Vue 会残留 `fade-leave-active` 且不触发 transitionend，导致新页面停在
 * 半透明状态（内容变暗不可读）。改用"进入即播放的 CSS 动画"：
 * 动画由浏览器保证结束，不会因为连续导航而卡住。
 */
const route = useRoute();
const showTabBar = computed(() => route.meta.requiresLayout === true);

const fatal = ref<Error | null>(null);

onErrorCaptured((err) => {
  fatal.value = err instanceof Error ? err : new Error(String(err));
  // 返回 false：阻止继续冒泡到 window.onerror，由本组件展示兜底页
  return false;
});

function recover(): void {
  fatal.value = null;
}
</script>

<template>
  <div class="app-root">
    <div v-if="fatal" class="app-fatal" role="alert">
      <h1 class="page-title">页面出错了</h1>
      <p class="text-secondary">
        可能是数据读取或渲染异常。你可以重试；若反复出现，请返回首页或重启 App。
      </p>
      <pre class="app-fatal__detail">{{ fatal.message }}</pre>
      <div class="app-fatal__actions">
        <button class="app-fatal__btn app-fatal__btn--primary" type="button" @click="recover">
          重试
        </button>
        <RouterLink class="app-fatal__btn" to="/" @click="recover">返回首页</RouterLink>
      </div>
    </div>

    <template v-else>
      <!-- 底部 TabBar 为 fixed，由外壳统一预留空间，页面无需各自处理 -->
      <div class="app-content" :class="{ 'app-content--tabbar': showTabBar }">
        <RouterView v-slot="{ Component, route: current }">
          <component :is="Component" :key="current.fullPath" class="route-view" />
        </RouterView>
      </div>

      <AppTabBar v-if="showTabBar" />

      <ToastHost />
    </template>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  background-color: var(--color-bg-base);
}

/* 内容容器：为 fixed 的 TabBar 预留高度，避免内容被遮挡 */
.app-content {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.app-content--tabbar {
  padding-bottom: calc(var(--layout-tabbar-height) + var(--safe-bottom));
}

/* 进入动画定义在 global.css 的 .route-view（两处同步，二选一改） */

.app-fatal {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: auto;
  max-width: var(--layout-content-max-width);
  padding: var(--space-6);
  text-align: center;
}

.app-fatal__detail {
  max-height: 160px;
  overflow: auto;
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-tertiary);
  font: var(--text-caption);
  text-align: left;
  white-space: pre-wrap;
  word-break: break-word;
}

.app-fatal__actions {
  display: flex;
  justify-content: center;
  gap: var(--space-3);
}

.app-fatal__btn {
  min-height: 44px;
  padding: 0 var(--space-5);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  border: var(--border-strong);
  color: var(--color-text-primary);
  font: var(--text-button-sm);
  background-color: var(--color-bg-surface);
  transition: var(--transition-color);
}

.app-fatal__btn--primary {
  background-color: var(--color-brand);
  border-color: transparent;
  color: var(--color-text-on-brand);
  font: var(--text-button);
}
</style>
