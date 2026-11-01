<script setup lang="ts">
/**
 * 下载页（页面蓝图 §7）
 *
 * 汇总卡 + 状态筛选（Segmented）+ 任务列表 + 全部暂停/继续。
 * 四态：loading 骨架 / empty 引导 / error 汇总区错误卡（列表仍可操作）/ offline 横幅。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { DownloadTask } from '@/types';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import EmptyState from '@/components/common/EmptyState.vue';
import SegmentedControl from '@/components/common/SegmentedControl.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import DownloadSummary from '@/components/download/DownloadSummary.vue';
import DownloadItem from '@/components/download/DownloadItem.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const downloads = useDownloadStore();
const toast = useToast();
const ui = useUiStore();
const { isOffline } = useOnlineStatus();

const filter = ref<'all' | 'active' | 'completed' | 'failed'>('all');
const menuOpen = ref(false);
const detailTask = ref<DownloadTask | null>(null);
const detailOpen = ref(false);
const refreshing = ref(false);

const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '下载中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
];

const loading = computed(() => downloads.state === 'idle');
const isEmpty = computed(() => downloads.state === 'empty' || downloads.tasks.length === 0);

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

onMounted(async () => {
  try {
    await downloads.load();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
});

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
        <button class="header-menu" type="button" aria-label="下载操作" @click="menuOpen = true">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5.5" cy="12" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="18.5" cy="12" r="1.7" />
          </svg>
        </button>
      </template>
    </AppHeader>

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

        <div class="downloads-filter">
          <SegmentedControl v-model="filter" :options="FILTER_OPTIONS" label="下载筛选" block />
        </div>

        <ul class="downloads-list">
          <li v-for="task in filtered" :key="task.id">
            <DownloadItem
              :task="task"
              :offline="isOffline"
              @play="onPlay"
              @pause="onPause"
              @resume="onResume"
              @retry="onRetry"
              @remove="onRemove"
              @select="onSelect"
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
</style>
