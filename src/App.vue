<script setup lang="ts">
import { computed, onErrorCaptured, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import AppTabBar from '@/components/layout/AppTabBar.vue';
import ToastHost from '@/components/common/ToastHost.vue';
import ConfirmDialog from '@/components/common/ConfirmDialog.vue';
import SafeModeBanner from '@/components/common/SafeModeBanner.vue';
import { useTheme } from '@/composables/useTheme';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useSettingsStore } from '@/stores/settingsStore';
import { setBackFallback } from '@/native/appLifecycle';
import { hasAllFilesAccess, readCookieFile } from '@/native/netdiskPlugin';
import { getAllPlatforms } from '@/services/netdiskPlatforms';
import { reminderService } from '@/services/reminderService';
import { logger } from '@/shared/logger';
import type { Reminder } from '@/types';

/**
 * 根组件：
 * - `RouterView` 页面渲染（方向感知过渡动画，见 §过渡）
 * - `ToastHost`（全局轻提示宿主，uiStore 驱动）
 * - `ConfirmDialog`（全局确认框宿主，uiStore.confirm 驱动）
 * - 主题挂载（data-theme）与设置同步
 * - 网络状态同步（OfflineBanner 由各页读取 uiStore.isOffline）
 * - 错误边界：捕获子树未处理异常 → 可恢复错误页（NFR-R04）
 * - 底部 TabBar 仅在 `meta.requiresLayout === true` 的路由渲染
 *
 * 过渡说明：使用 `<Transition>` 包裹 RouterView，根据 route.meta.depth
 * 判断导航方向：depth 增大为前进（slide-left），depth 减小为后退（slide-right），
 * 同 depth 为 Tab 切换（fade）。不使用 mode="out-in" 以避免连续导航时
 * leave 阶段卡住导致页面停在半透明状态。
 */
const route = useRoute();
const router = useRouter();
const showTabBar = computed(() => route.meta.requiresLayout === true);

/**
 * 记录上一次路由的 depth，用于判断过渡方向。
 * 通过 beforeEach 在路由更新前快照来源 depth，
 * 避免 currentRoute 与 useRoute() 指向同一响应式引用导致方向判断失效（REV-01）。
 */
const prevDepth = ref(0);

router.beforeEach((from) => {
  prevDepth.value = (from.meta.depth ?? 0) as number;
});

/** 根据 depth 变化判断过渡方向 */
const transitionName = computed(() => {
  const from = prevDepth.value;
  const toDepth = (route.meta.depth ?? 0) as number;
  if (toDepth > from) return 'slide-left';
  if (toDepth < from) return 'slide-right';
  return 'fade';
});

const fatal = ref<Error | null>(null);

const theme = useTheme();
const settings = useSettingsStore();
const toast = useToast();
useOnlineStatus();

/** REV-10：提醒自动对账的清理函数（卸载时调用，避免监听泄漏） */
let stopReminderAutoReconcile: (() => void) | null = null;

/** 到点提醒的页内提示（Web/前台降级路径） */
function showReminderToasts(reminders: Reminder[]): void {
  if (reminders.length === 0) return;
  if (reminders.length === 1) {
    const item = reminders[0]!;
    toast.info(`${item.channelName} · ${item.programmeTitle} 即将开始`);
    return;
  }
  const head = reminders
    .slice(0, 2)
    .map((item) => `${item.channelName} · ${item.programmeTitle}`)
    .join('；');
  toast.info(`${reminders.length} 个节目即将开始：${head}${reminders.length > 2 ? ' 等' : ''}`);
}

onMounted(async () => {
  /*
   * 返回键全局兜底（v1.9/RET-01 修正）：
   * 页面监听器（播放器全屏、弹层）都没消费时，先判断能否回退路由——
   * 详情/设置等二级页按返回应回到上一页，只有栈底（首页等）才退出 App。
   * 历史栈的上一项由 vue-router 存在 history.state.back（无历史时为 ''）。
   */
  setBackFallback(() => {
    const back = router.options.history.state.back;
    if (typeof back === 'string' && back.length > 0) {
      router.back();
      return true;
    }
    /*
     * 无历史但停在二级页（如冷启动恢复到详情/订阅页）：回首页而不是退出。
     * 只有一级 Tab 页（requiresLayout）在栈底时才退出 App。
     */
    if (router.currentRoute.value.meta.requiresLayout !== true) {
      void router.replace('/');
      return true;
    }
    return false;
  });

  try {
    if (!settings.ready) await settings.load();
    theme.setMode(settings.settings?.theme ?? 'dark');
  } catch {
    /* 设置读取失败不阻塞启动；各页会单独展示错误态 */
  }

  // FIX-C：启动时检测 cookie 文件存在但 MANAGE_EXTERNAL_STORAGE 未授予 → 一次性 Toast 提醒
  try {
    const granted = await hasAllFilesAccess();
    if (!granted) {
      const platforms = getAllPlatforms();
      for (const p of platforms) {
        const cookie = await readCookieFile(p.key);
        if (cookie.exists && cookie.content) {
          toast.error('检测到网盘 Cookie 文件，但缺少「所有文件访问」权限，播放将失败。请前往 网盘账号 页授权。');
          break;
        }
      }
    }
  } catch {
    // 自检失败不阻塞启动
  }

  /*
   * REV-10：提醒自动对账（启动即对账 + 回前台再对账 + 订阅原生通知）。
   * 返回值必须保存并在卸载时调用，否则监听器会随 HMR/重建累积泄漏。
   */
  try {
    stopReminderAutoReconcile = reminderService.startAutoReconcile(showReminderToasts);
  } catch (error) {
    stopReminderAutoReconcile = null;
    logger.warn('提醒自动对账启动失败', error);
  }
});

onUnmounted(() => {
  stopReminderAutoReconcile?.();
  stopReminderAutoReconcile = null;
});

watch(
  () => settings.settings?.theme,
  (mode) => {
    if (mode) theme.setMode(mode);
  },
);

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
      <SafeModeBanner />
      <!-- 底部 TabBar 为 fixed，由外壳统一预留空间，页面无需各自处理 -->
      <div class="app-content" :class="{ 'app-content--tabbar': showTabBar }">
        <RouterView v-slot="{ Component, route: current }">
          <Transition :name="transitionName">
            <!-- 首页 KeepAlive（P0-4）：回 tab 不重闪骨架、不重新全量拉取；
                 搜索页 KeepAlive（CHG-28）：从详情/播放返回时保留关键词与结果，
                 不再因组件重建退回历史页（store 数据本身一直在，缺的是视图状态）；
                 其余页面进出 Player/Detail 等重资源页，保持即用即毁 -->
            <KeepAlive :include="['HomeView', 'SearchView']">
              <component :is="Component" :key="current.fullPath" class="route-view" />
            </KeepAlive>
          </Transition>
        </RouterView>
      </div>

      <AppTabBar v-if="showTabBar" />

      <ToastHost />
      <ConfirmDialog />
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
  /* 底部避让由各 Tab 页滚动容器负责（--layout-tabbar-safe），此处不再叠加 */
  padding-bottom: 0;
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
