<script setup lang="ts">
/**
 * 源健康治理中心（EXT-01）
 *
 * 页面职责：组装汇总 / 7 日趋势 / 失败分布 / 批量治理四块，
 * 并处理首屏加载、加载失败、无源空态与批量操作确认。
 *
 * 数据来源：`sourceStore`（源列表 + 健康中心 state/actions），
 * 组件本身不直接调用 service / 不直接读 IndexedDB。
 *
 * 稳定性：卸载后置 `alive=false`，避免异步批量操作完成后向已销毁页面弹 toast；
 * 不注册定时器或全局事件监听，无资源需要清理。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

import { toErrorShape } from '@/shared/errors';

import AppHeader from '@/components/layout/AppHeader.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import BatchActions from '@/components/health/BatchActions.vue';
import FailureDistribution from '@/components/health/FailureDistribution.vue';
import HealthSummary from '@/components/health/HealthSummary.vue';
import HealthTrend from '@/components/health/HealthTrend.vue';
import LoadFailurePanel from '@/components/health/LoadFailurePanel.vue';
import QuarantinePanel from '@/components/health/QuarantinePanel.vue';

import { useSourceStore } from '@/stores/sourceStore';
import { useUiStore } from '@/stores/uiStore';
import { useToast } from '@/composables/useToast';

const router = useRouter();
const store = useSourceStore();
const ui = useUiStore();
const toast = useToast();

/** 卸载标记：异步操作完成后不再触发 toast */
let alive = true;

onMounted(() => {
  void store.loadHealthCenter();
});

onUnmounted(() => {
  alive = false;
});

const loading = computed(() => store.healthCenterLoading);
/** 首次进入且尚无数据时用整页 loading，避免四块空卡闪一下 */
const isFirstLoading = computed(() => loading.value && store.healthCenterLoadedAt === null);
const isEmpty = computed(() => !loading.value && store.healthCenterSummary.total === 0);
const busy = computed(() => store.healthCenterBusy);

const progressText = computed(() => {
  if (busy.value === 'recheck') {
    const progress = store.healthProgress;
    if (progress && progress.total > 0 && progress.done < progress.total) {
      return `复检中 ${progress.done}/${progress.total}`;
    }
    return '复检中…';
  }
  const progress = store.healthCenterProgress;
  if (progress && progress.total > 0) return `处理中 ${progress.done}/${progress.total}`;
  return '处理中…';
});

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

const updatedText = computed(() => {
  const at = store.healthCenterLoadedAt;
  if (at === null) return '';
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())} 更新`;
});

function reload(): void {
  void store.loadHealthCenter();
}

function goToSources(): void {
  void router.push({ name: 'settings', query: { sources: '1' } });
}

function goBackToSettings(): void {
  void router.replace({ name: 'settings' });
}

async function onRecheck(): Promise<void> {
  if (busy.value !== null || store.healthChecking) return;
  const total = store.failedEnabledSources.length;
  if (total === 0) {
    toast.info('没有可复检的失败源');
    return;
  }
  try {
    const checked = await store.recheckFailedSources();
    if (!alive) return;
    if (checked === 0) toast.info('已有检测任务在进行，请稍候');
    else toast.success(`已复检 ${checked} 个失败源`);
  } catch (e) {
    if (alive) toast.error(toErrorShape(e).message);
  }
}

function onCancelRecheck(): void {
  store.cancelHealthCheck();
  toast.info('已取消复检');
}

async function onCleanup(): Promise<void> {
  if (busy.value !== null) return;
  const targets = store.failedEnabledSources;
  if (targets.length === 0) {
    toast.info('没有需要清理的失败源');
    return;
  }
  const names = targets
    .slice(0, 3)
    .map((source) => `「${source.name}」`)
    .join('、');
  const confirmed = await ui.confirm({
    title: `清理 ${targets.length} 个失败源？`,
    message: `将把这些源标记为「已禁用」（不删除配置，可随时恢复）：${names}${
      targets.length > 3 ? ' 等' : ''
    }。其中含「连接超时」的源，请确认不是临时网络问题。`,
    confirmText: '清理',
    danger: true,
  });
  if (!confirmed) return;
  try {
    const result = await store.cleanupFailedSources();
    if (!alive) return;
    if (result.done === 0 && result.failed === 0) {
      toast.info('没有需要清理的失败源');
      return;
    }
    const failedPart = result.failed > 0 ? `，${result.failed} 个失败` : '';
    toast.success(`已禁用 ${result.done} 个失败源${failedPart}`);
  } catch (e) {
    if (alive) toast.error(toErrorShape(e).message);
  }
}

async function onRestore(): Promise<void> {
  if (busy.value !== null) return;
  const total = store.disabledSources.length;
  if (total === 0) {
    toast.info('没有需要恢复的源');
    return;
  }
  const confirmed = await ui.confirm({
    title: `恢复 ${total} 个已禁用的源？`,
    message:
      '将清除自动禁用标记并重新启用，健康状态复位为「未检测」。恢复后建议执行一次复检确认可用性。',
    confirmText: '恢复',
  });
  if (!confirmed) return;
  try {
    const result = await store.restoreDisabledSources();
    if (!alive) return;
    if (result.done === 0 && result.failed === 0) {
      toast.info('没有需要恢复的源');
      return;
    }
    const failedPart = result.failed > 0 ? `，${result.failed} 个失败` : '';
    toast.success(`已恢复 ${result.done} 个源${failedPart}`);
  } catch (e) {
    if (alive) toast.error(toErrorShape(e).message);
  }
}
</script>

<template>
  <div class="health-center">
    <AppHeader title="源健康中心" back>
      <template #actions>
        <button
          class="health-center__refresh"
          type="button"
          aria-label="刷新健康数据"
          :disabled="loading"
          @click="reload"
        >
          <LoadingSpinner v-if="loading" :size="16" />
          <span v-else>刷新</span>
        </button>
      </template>
    </AppHeader>

    <div class="health-center__body">
      <div v-if="isFirstLoading" class="health-center__loading" data-state="loading">
        <LoadingSpinner :size="24" />
        <span>加载中…</span>
      </div>

      <ErrorState
        v-else-if="store.healthCenterError"
        :error="store.healthCenterError"
        :show-retry="true"
        hint="可能原因：本地数据库读取异常。可重试；若持续失败请返回设置页。"
        back-text="返回设置"
        @retry="reload"
        @back="goBackToSettings"
      />

      <EmptyState
        v-else-if="isEmpty"
        variant="source"
        title="还没有可治理的源"
        description="添加源之后，这里会汇总健康状态、失败原因分布与最近 7 天的健康率趋势。"
        action-text="去添加源"
        @action="goToSources"
      />

      <template v-else>
        <p v-if="updatedText" class="health-center__updated">{{ updatedText }}</p>

        <HealthSummary :summary="store.healthCenterSummary" :loading="loading" />

        <HealthTrend :points="store.healthTrend" :loading="loading" />

        <FailureDistribution
          :buckets="store.failureBuckets"
          :failed-total="store.healthCenterSummary.failed"
          :loading="loading"
        />

        <BatchActions
          :failed-count="store.failedEnabledSources.length"
          :cleanup-count="store.failedEnabledSources.length"
          :disabled-count="store.disabledSources.length"
          :busy="busy"
          :rechecking="store.healthChecking"
          :progress-text="progressText"
          @recheck="onRecheck"
          @cleanup="onCleanup"
          @restore="onRestore"
          @cancel="onCancelRecheck"
        />

        <QuarantinePanel />

        <LoadFailurePanel />

        <p class="health-center__footer">
          趋势快照保存在本机（最多保留 30 天）；「已禁用」的失败源需先恢复才会重新参与复检。
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.health-center {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background-color: var(--color-bg-base);
}

.health-center__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: 0 var(--layout-page-padding-x) var(--space-8);
}

.health-center__refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  min-height: var(--touch-min);
  padding: 0 var(--space-2);
  font: var(--text-button-sm);
  color: var(--color-brand-text);
  background: none;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: var(--transition-color);
}

.health-center__refresh:active:not(:disabled) {
  background-color: var(--color-overlay-press);
}

.health-center__refresh:disabled {
  color: var(--color-text-disabled);
  cursor: default;
}

.health-center__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.health-center__updated {
  margin-top: calc(var(--space-1) * -1);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-align: right;
}

.health-center__footer {
  font: var(--text-caption);
  line-height: 1.65;
  color: var(--color-text-tertiary);
}
</style>
