<script setup lang="ts">
/**
 * 下载页（页面蓝图 §7）
 *
 * 汇总卡 + 状态筛选（Segmented）+ 任务列表 + 全部暂停/继续。
 * 四态：loading 骨架 / empty 引导 / error 汇总区错误卡（列表仍可操作）/ offline 横幅。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import type { DownloadTask } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import PullToRefresh from '@/components/common/PullToRefresh.vue';
import DownloadSummary from '@/components/download/DownloadSummary.vue';
import DownloadItem from '@/components/download/DownloadItem.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useHaptic } from '@/composables/useHaptic';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const downloads = useDownloadStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();
const { haptic } = useHaptic();

const filter = ref<'all' | 'active' | 'completed' | 'failed'>('all');
const menuOpen = ref(false);
const detailTask = ref<DownloadTask | null>(null);
const detailOpen = ref(false);
const refreshing = ref(false);

/** 功能扩展-10：批量模式 */
const batchMode = ref(false);
const selectedIds = ref<Set<string>>(new Set());
const batchOperating = ref(false);
const storageUsage = ref<{ totalBytes: number; fileCount: number } | null>(null);

const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '下载中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
];

const loading = computed(() => downloads.state === 'idle');
const isEmpty = computed(() => downloads.state === 'empty' || downloads.tasks.length === 0);

/** OPT-13: 追踪已完成通知，避免重复 Toast */
const notifiedCompletedIds = new Set<string>();

/** OPT-13: 监听下载完成事件，触发触觉反馈 + Toast */
watch(
  () => downloads.tasks,
  (tasks) => {
    // REV-19: 清理已删除任务的 ID，防止 Set 无限增长
    const taskIds = new Set(tasks.map((t) => t.id));
    for (const id of notifiedCompletedIds) {
      if (!taskIds.has(id)) {
        notifiedCompletedIds.delete(id);
      }
    }
    for (const task of tasks) {
      if (task.status === 'completed' && !notifiedCompletedIds.has(task.id)) {
        notifiedCompletedIds.add(task.id);
        haptic('medium');
        toast.success(`「${task.title}」下载完成`);
      }
    }
  },
  { deep: true },
);

const filtered = computed(() => {
  switch (filter.value) {
    case 'active':
      return downloads.tasks.filter((t) => t.status === 'downloading' || t.status === 'queued' || t.status === 'paused');
    case 'completed':
      return downloads.tasks.filter((t) => t.status === 'completed');
    case 'failed':
      return downloads.tasks.filter((t) => t.status === 'failed');
    default:
      return downloads.tasks;
  }
});

const activeDownloading = computed(() => downloads.tasks.some((t) => t.status === 'downloading'));
const hasPaused = computed(() => downloads.tasks.some((t) => t.status === 'paused'));
const hasFailed = computed(() => downloads.tasks.some((t) => t.status === 'failed'));

/** 功能扩展-10：批量选择相关 */
const selectedCount = computed(() => selectedIds.value.size);
const canBatchDelete = computed(() => selectedCount.value > 0);

/** 功能扩展-10：格式化存储大小 */
const storageText = computed(() => {
  if (!storageUsage.value) return '计算中…';
  const { totalBytes, fileCount } = storageUsage.value;
  if (totalBytes === 0) return '暂无占用';
  const mb = totalBytes / 1024 / 1024;
  const gb = mb / 1024;
  const sizeText = gb >= 1 ? `${gb.toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
  return `${sizeText}（${fileCount} 个文件）`;
});

onMounted(async () => {
  try {
    await downloads.load();
    await loadStorageUsage();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
});

/** 功能扩展-10：加载存储占用 */
async function loadStorageUsage(): Promise<void> {
  try {
    storageUsage.value = await downloads.calculateStorageUsage();
  } catch {
    storageUsage.value = null;
  }
}

/** 功能扩展-10：切换批量模式 */
function toggleBatchMode(): void {
  batchMode.value = !batchMode.value;
  if (!batchMode.value) {
    selectedIds.value.clear();
  }
}

/** 功能扩展-10：切换单个选择 */
function toggleSelect(task: DownloadTask): void {
  if (selectedIds.value.has(task.id)) {
    selectedIds.value.delete(task.id);
  } else {
    selectedIds.value.add(task.id);
  }
}

/** 功能扩展-10：全选当前筛选 */
function selectAll(): void {
  for (const task of filtered.value) {
    selectedIds.value.add(task.id);
  }
}

/** 功能扩展-10：取消全选 */
function deselectAll(): void {
  selectedIds.value.clear();
}

/** 功能扩展-10：反选 */
function invertSelection(): void {
  const newSet = new Set<string>();
  for (const task of filtered.value) {
    if (!selectedIds.value.has(task.id)) {
      newSet.add(task.id);
    }
  }
  selectedIds.value = newSet;
}

/** 功能扩展-10：批量删除 */
async function batchDelete(): Promise<void> {
  if (selectedCount.value === 0 || batchOperating.value) return;
  const ok = await ui.confirm({
    title: `删除 ${selectedCount.value} 个任务？`,
    message: '将删除选中的下载任务与本地文件，此操作不可撤销。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  batchOperating.value = true;
  try {
    await downloads.removeMany(Array.from(selectedIds.value), true);
    toast.success(`已删除 ${selectedCount.value} 个任务`);
    selectedIds.value.clear();
    batchMode.value = false;
    await loadStorageUsage();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    batchOperating.value = false;
  }
}

/** 功能扩展-10：清理失败任务 */
async function clearFailed(): Promise<void> {
  menuOpen.value = false;
  const failedCount = downloads.tasks.filter((t) => t.status === 'failed').length;
  if (failedCount === 0) {
    toast.info('没有失败的任务');
    return;
  }
  const ok = await ui.confirm({
    title: `清理 ${failedCount} 个失败任务？`,
    message: '将删除所有状态为"失败"的任务记录与文件。',
    confirmText: '清理',
    danger: true,
  });
  if (!ok) return;
  try {
    await downloads.clearFailed();
    toast.success(`已清理 ${failedCount} 个失败任务`);
    await loadStorageUsage();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  try {
    await downloads.load();
  } finally {
    refreshing.value = false;
  }
}

async function pauseAll(): Promise<void> {
  menuOpen.value = false;
  await downloads.pauseAll();
  toast.info('已暂停全部下载');
}

async function resumeAll(): Promise<void> {
  menuOpen.value = false;
  await downloads.resumeAll();
  toast.info('已继续全部下载');
}

async function clearCompleted(): Promise<void> {
  menuOpen.value = false;
  const ok = await ui.confirm({
    title: '清除已完成记录？',
    message: '只删除列表记录，已下载的文件请单独删除。',
    confirmText: '清除',
  });
  if (!ok) return;
  await downloads.clearCompleted();
  toast.success('已清除已完成记录');
}

async function onPause(task: DownloadTask): Promise<void> {
  try {
    await downloads.pause(task.id);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function onResume(task: DownloadTask): Promise<void> {
  try {
    await downloads.resume(task.id);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function onRetry(task: DownloadTask): Promise<void> {
  try {
    await downloads.retry(task.id);
    toast.info('已重新加入队列');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function onRemove(task: DownloadTask): Promise<void> {
  const ok = await ui.confirm({
    title: '删除下载？',
    message: `将删除「${task.title}${task.episodeNumber !== null ? ` 第 ${task.episodeNumber} 集` : ''}」的本地文件与记录。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await downloads.remove(task.id, true);
    detailOpen.value = false;
    detailTask.value = null;
    toast.success('已删除');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function onPlay(task: DownloadTask): void {
  if (task.status !== 'completed') return;
  void router.push({
    name: 'player',
    params: { mediaId: task.mediaId, episodeId: task.episodeId },
  });
}

function onSelect(task: DownloadTask): void {
  if (task.status === 'completed') {
    onPlay(task);
    return;
  }
  detailTask.value = task;
  detailOpen.value = true;
}

function goLibrary(): void {
  void router.push('/library');
}
</script>

<template>
  <SafeArea tabbar data-route="downloads">
    <AppHeader title="下载">
      <template #actions>
        <!-- 功能扩展-10：批量模式切换 -->
        <button
          v-if="!isEmpty"
          class="header-batch"
          type="button"
          :aria-label="batchMode ? '退出批量' : '批量操作'"
          @click="toggleBatchMode"
        >
          <svg v-if="!batchMode" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 5h2V3c-1.1 0-2 .9-2 2zm0 8h2v-2H3v2zm4 8h2v-2H7v2zM3 9h2V7H3v2zm10-6h-2v2h2V3zm6 0v2h2c0-1.1-.9-2-2-2zM5 21v-2H3c0 1.1.9 2 2 2zm-2-4h2v-2H3v2zM9 3H7v2h2V3zm2 18h2v-2h-2v2zm8-8h2v-2h-2v2zm0 8c1.1 0 2-.9 2-2h-2v2zm0-12h2V7h-2v2zm0 8h2v-2h-2v2zm-4 4h2v-2h-2v2zm0-16h2V3h-2v2z" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
        <button class="header-menu" type="button" aria-label="下载操作" @click="menuOpen = true">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5.5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="18.5" cy="12" r="1.7" />
          </svg>
        </button>
      </template>
    </AppHeader>

    <PullToRefresh :loading="refreshing" @refresh="refresh">
    <div class="downloads-body">
      <OfflineBanner v-if="isOffline" text="离线模式，已完成内容可正常播放" />

      <!-- loading -->
      <template v-if="loading">
        <div class="summary-skeleton">
          <div class="skeleton summary-skeleton__line" />
          <div class="skeleton summary-skeleton__bar" />
          <div class="skeleton summary-skeleton__line summary-skeleton__line--short" />
        </div>
        <div class="list-skeleton">
          <SkeletonPoster v-for="n in 4" :key="`dl-sk-${n}`" />
        </div>
      </template>

      <!-- empty -->
      <EmptyState
        v-else-if="isEmpty"
        variant="download"
        title="还没有下载任务"
        description="在详情页选择集数即可离线观看"
        action-text="去媒体库"
        @action="goLibrary"
      />

      <!-- success -->
      <template v-else>
        <div v-if="downloads.error" class="downloads-error" role="alert">
          <span class="downloads-error__text">{{ downloads.error.message }}</span>
          <button class="btn btn--secondary btn--sm" type="button" @click="refresh">重试</button>
        </div>

        <DownloadSummary :summary="downloads.summary" />

        <!-- 功能扩展-10：存储占用展示 -->
        <div class="storage-info">
          <span class="storage-info__label">本地存储</span>
          <span class="storage-info__value">{{ storageText }}</span>
        </div>

        <div class="downloads-filter">
          <SegmentedControl v-model="filter" :options="FILTER_OPTIONS" label="下载筛选" block />
        </div>

        <ul class="downloads-list">
          <li v-for="task in filtered" :key="task.id">
            <DownloadItem
              :task="task"
              :offline="isOffline"
              :batch-mode="batchMode"
              :selected="selectedIds.has(task.id)"
              @play="onPlay"
              @pause="onPause"
              @resume="onResume"
              @retry="onRetry"
              @remove="onRemove"
              @select="onSelect"
              @toggle-select="toggleSelect"
            />
          </li>
        </ul>

        <EmptyState
          v-if="filtered.length === 0"
          variant="download"
          title="该状态下没有任务"
          description="切换到「全部」查看其它任务"
          action-text="查看全部"
          @action="filter = 'all'"
        />

        <p v-if="refreshing" class="downloads-refreshing">正在刷新…</p>
      </template>
    </div>
    </PullToRefresh>

    <BottomSheet v-model="menuOpen" title="下载操作">
      <ul class="sheet-list">
        <li>
          <button class="sheet-list__item" type="button" :disabled="!activeDownloading" @click="pauseAll">
            全部暂停
          </button>
        </li>
        <li>
          <button class="sheet-list__item" type="button" :disabled="!hasPaused" @click="resumeAll">
            全部继续
          </button>
        </li>
        <li>
          <button class="sheet-list__item" type="button" @click="clearCompleted">清除已完成记录</button>
        </li>
        <li>
          <button class="sheet-list__item" type="button" :disabled="!hasFailed" @click="clearFailed">
            清理失败任务
          </button>
        </li>
        <li>
          <button class="sheet-list__item" type="button" @click="refresh">刷新</button>
        </li>
      </ul>
    </BottomSheet>

    <BottomSheet v-model="detailOpen" :title="detailTask?.title ?? '任务'">
      <div v-if="detailTask" class="task-detail">
        <p class="task-detail__line">
          集号：{{ detailTask.episodeNumber !== null ? `第 ${detailTask.episodeNumber} 集` : '单片' }}
        </p>
        <p class="task-detail__line">状态：{{ detailTask.status }}</p>
        <p v-if="detailTask.errorMessage" class="task-detail__line task-detail__line--error">
          {{ detailTask.errorMessage }}
        </p>
      </div>
      <ul class="sheet-list">
        <li v-if="detailTask?.status === 'downloading'">
          <button class="sheet-list__item" type="button" @click="detailTask && onPause(detailTask)">暂停</button>
        </li>
        <li v-if="detailTask?.status === 'paused'">
          <button class="sheet-list__item" type="button" @click="detailTask && onResume(detailTask)">继续</button>
        </li>
        <li v-if="detailTask?.status === 'failed'">
          <button class="sheet-list__item" type="button" @click="detailTask && onRetry(detailTask)">重试</button>
        </li>
        <li>
          <button
            class="sheet-list__item sheet-list__item--danger"
            type="button"
            @click="detailTask && onRemove(detailTask)"
          >
            删除任务与文件
          </button>
        </li>
      </ul>
    </BottomSheet>

    <!-- 功能扩展-10：批量操作栏 -->
    <Transition name="batch-bar">
      <div v-if="batchMode && !isEmpty" class="batch-bar">
        <div class="batch-bar__controls">
          <button class="batch-bar__btn batch-bar__btn--text" type="button" @click="selectAll">全选</button>
          <button class="batch-bar__btn batch-bar__btn--text" type="button" @click="deselectAll">取消全选</button>
          <button class="batch-bar__btn batch-bar__btn--text" type="button" @click="invertSelection">反选</button>
        </div>
        <div class="batch-bar__actions">
          <span class="batch-bar__count">已选 {{ selectedCount }} 项</span>
          <button
            class="batch-bar__btn batch-bar__btn--danger"
            type="button"
            :disabled="!canBatchDelete || batchOperating"
            @click="batchDelete"
          >
            删除
          </button>
        </div>
      </div>
    </Transition>
  </SafeArea>
</template>

<style scoped>
.header-menu {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-primary);
}

.header-menu svg {
  width: 20px;
  height: 20px;
}

.downloads-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-3) var(--layout-page-padding-x) var(--layout-tabbar-safe);
}

.summary-skeleton {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
}

.summary-skeleton__line {
  height: var(--line-height-14);
  width: 60%;
}

.summary-skeleton__line--short {
  width: 40%;
}

.summary-skeleton__bar {
  height: 4px;
  border-radius: var(--radius-full);
}

.list-skeleton {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-3);
  margin-top: var(--space-5);
}

.downloads-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-danger-soft);
  border: 1px solid rgba(255, 90, 95, 0.3);
}

.downloads-error__text {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-caption);
  color: var(--color-text-primary);
}

.downloads-filter {
  margin-top: var(--space-4);
}

.downloads-list {
  display: flex;
  flex-direction: column;
  margin-top: var(--space-2);
}

.downloads-refreshing {
  padding: var(--space-3);
  text-align: center;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.sheet-list {
  display: flex;
  flex-direction: column;
}

.sheet-list__item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.sheet-list__item:disabled {
  color: var(--color-text-disabled);
}

.sheet-list__item--danger {
  color: var(--color-danger);
}

.task-detail {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-bottom: var(--space-3);
}

.task-detail__line {
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.task-detail__line--error {
  color: var(--color-danger);
}

/* 功能扩展-10：批量模式按钮 */
.header-batch {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-primary);
}

.header-batch svg {
  width: 20px;
  height: 20px;
}

/* 功能扩展-10：存储占用展示 */
.storage-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  margin-top: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
}

.storage-info__label {
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.storage-info__value {
  font: var(--text-body);
  color: var(--color-text-primary);
  font-weight: 500;
}

/* 功能扩展-10：批量操作栏 */
.batch-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--layout-page-padding-x) calc(var(--space-3) + env(safe-area-inset-bottom, 0));
  background-color: var(--color-bg-surface);
  border-top: 1px solid var(--color-border);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.08);
  z-index: 100;
}

.batch-bar__controls {
  display: flex;
  gap: var(--space-2);
}

.batch-bar__actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.batch-bar__count {
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.batch-bar__btn {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-md);
  font: var(--text-caption);
  font-weight: 500;
  transition: background-color 0.15s ease;
}

.batch-bar__btn--text {
  background-color: var(--color-bg-elevated);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
}

.batch-bar__btn--text:active {
  background-color: var(--color-bg-hover);
}

.batch-bar__btn--danger {
  background-color: var(--color-danger);
  color: white;
}

.batch-bar__btn--danger:active {
  background-color: var(--color-danger-dark);
}

.batch-bar__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 批量栏进出动画 */
.batch-bar-enter-active,
.batch-bar-leave-active {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.batch-bar-enter-from,
.batch-bar-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
