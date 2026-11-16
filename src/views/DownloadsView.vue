<script setup lang="ts">
/**
 * 下载页（页面蓝图 §7）
 *
 * 汇总卡 + 状态筛选（Segmented）+ 任务列表 + 全部暂停/继续。
 * 四态：loading 骨架 / empty 引导 / error 汇总区错误卡（列表仍可操作）/ offline 横幅。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
import DownloadBatchGroup from '@/components/download/DownloadBatchGroup.vue';
import SkeletonPoster from '@/components/media/SkeletonPoster.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useToast } from '@/composables/useToast';
import { useHaptic } from '@/composables/useHaptic';
import { useCompletionCeremony } from '@/composables/useCompletionCeremony';
import { attachSparkCanvas } from '@/services/sparkField';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';
import type { BatchProgress } from '@/services/downloadBatch';
import { downloadService } from '@/services/downloadService';
import { appEvents, type OfflineOptimizeSnapshot } from '@/services/events';
import { getOfflineOptimizeState } from '@/services/offlineRemuxMigration';

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

/**
 * OPT-05：任务详情说明转封装结果。此前只有成功才落库，失败/跳过完全无痕迹——
 * 用户只会看到「开了转封装但文件一直是 .ts」，分不清是没生效、跳过了还是出了错。
 */
function remuxDetailText(remux: NonNullable<DownloadTask['remux']>): string {
  if (remux.status === 'done') {
    return `已转封装为 MP4（耗时 ${((remux.durationMs ?? 0) / 1000).toFixed(1)}s）`;
  }
  if (remux.status === 'failed') return `转封装失败${remux.reason ? `（${remux.reason}）` : ''}，文件保留为 TS`;
  if (remux.status === 'skipped') return `转封装已跳过${remux.reason ? `（${remux.reason}）` : ''}`;
  return '';
}

const detailRemuxText = computed(() => (detailTask.value?.remux ? remuxDetailText(detailTask.value.remux) : ''));

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

/**
 * C-11 完成收尾仪式：一次只完成一项 → 那一行放收尾动画；一次完成一批 → 只有汇总卡庆祝，
 * 各行静默变勾。触觉与 Toast 也收在这里一起发（原先逐项各震一次，缓存 12 集会连震 12 下）。
 */
const { celebrateId, celebrateSummary, observe: observeCompletions } = useCompletionCeremony();
const sparkCanvas = ref<HTMLCanvasElement | null>(null);

/** OPT-16: 去掉 deep:true（store 每次不可变替换数组，浅 watch 已能触发） */
watch(
  () => downloads.tasks,
  (tasks) => {
    const { fresh, bulk } = observeCompletions(tasks);
    if (fresh.length === 0) return;
    haptic('medium');
    if (bulk) toast.success(`${fresh.length} 个下载完成`);
    else toast.success(`「${fresh[0]?.title ?? ''}」下载完成`);
  },
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

// EXT-04：按 batchId 分组任务（有 batchId 的归组，无 batchId 的单独成组）
const batchGroups = computed(() => {
  const groups = new Map<string, { batchId: string; label: string; tasks: DownloadTask[] }>();
  const noBatch: DownloadTask[] = [];

  for (const task of filtered.value) {
    if (task.batchId) {
      if (!groups.has(task.batchId)) {
        groups.set(task.batchId, {
          batchId: task.batchId,
          label: task.title || '本批下载',
          tasks: [],
        });
      }
      groups.get(task.batchId)!.tasks.push(task);
    } else {
      noBatch.push(task);
    }
  }

  // 把无 batchId 的任务作为单独一组（batchId 为空字符串）
  if (noBatch.length > 0) {
    groups.set('', { batchId: '', label: '单独下载', tasks: noBatch });
  }

  return Array.from(groups.values());
});

// EXT-04：计算每个批次的进度
function getBatchProgress(tasks: DownloadTask[]): BatchProgress {
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.status === 'completed').length,
    failed: tasks.filter((t) => t.status === 'failed').length,
    active: tasks.filter((t) => t.status === 'downloading' || t.status === 'queued').length,
    canceled: tasks.filter((t) => t.status === 'canceled').length,
  };
}

// EXT-04：限速展示
const speedLimitText = computed(() => {
  const { limit } = downloadService.getSpeedLimit();
  switch (limit) {
    case 'low':
      return '慢速 512KB/s';
    case 'medium':
      return '中速 2MB/s';
    case 'high':
      return '快速 5MB/s';
    default:
      return '不限速';
  }
});

const currentSpeedText = computed(() => {
  const { totalBps } = downloadService.getCurrentSpeed();
  if (totalBps <= 0) return '—';
  const kb = totalBps / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB/s`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB/s`;
});

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

/** P0-1：离线文件后台优化（.ts → .mp4）状态 */
const optimizing = ref<OfflineOptimizeSnapshot>(getOfflineOptimizeState());
const optimizingText = computed(() => {
  const s = optimizing.value;
  const base = `正在优化离线文件 ${s.done + 1}/${s.total}`;
  return s.percent > 0 ? `${base} · ${Math.round(s.percent * 100)}%` : base;
});
const offOptimize = appEvents.on('offline:optimize', (state) => {
  const wasActive = optimizing.value.active;
  optimizing.value = state;
  // 优化结束：文件路径与体积都变了，刷新列表与占用统计
  if (wasActive && !state.active) {
    void downloads.load().catch(() => undefined);
    void loadStorageUsage();
  }
});
onBeforeUnmount(() => {
  offOptimize();
  // 火花画布是模块级单例：切走页面必须交还，否则 rAF 循环会留在后台空转
  attachSparkCanvas(null);
});

onMounted(async () => {
  attachSparkCanvas(sparkCanvas.value);
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
    const { removed, filesLeftBehind, failed } = await downloads.removeMany(
      Array.from(selectedIds.value),
      true,
    );
    const parts = [`已删除 ${removed} 个任务`];
    if (failed > 0) parts.push(`${failed} 个未能删除`);
    if (filesLeftBehind > 0) parts.push(`${filesLeftBehind} 个本地文件没删掉，需手动清理`);
    const text = parts.join('，');
    if (failed > 0 || filesLeftBehind > 0) toast.error(text);
    else toast.success(text);
    selectedIds.value.clear();
    batchMode.value = false;
    await loadStorageUsage();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    batchOperating.value = false;
  }
}

// EXT-04：重试本批失败项
async function retryBatch(batchId: string): Promise<void> {
  if (!batchId || batchOperating.value) return;
  batchOperating.value = true;
  try {
    const result = await downloadService.retryBatch(batchId);
    if (result.retried > 0) {
      toast.success(`已重试 ${result.retried} 个失败任务`);
    } else {
      toast.info('没有可重试的任务');
    }
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    batchOperating.value = false;
  }
}

// EXT-04：删除本批已完成
async function deleteBatchCompleted(batchId: string): Promise<void> {
  if (!batchId || batchOperating.value) return;
  const group = batchGroups.value.find((g) => g.batchId === batchId);
  if (!group) return;
  const completedCount = group.tasks.filter((t) => t.status === 'completed').length;
  if (completedCount === 0) {
    toast.info('没有已完成的任务');
    return;
  }
  const ok = await ui.confirm({
    title: `删除 ${completedCount} 个已完成任务？`,
    message: '将删除选中的下载任务与本地文件，此操作不可撤销。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  batchOperating.value = true;
  try {
    const completedIds = group.tasks.filter((t) => t.status === 'completed').map((t) => t.id);
    const { removed, filesLeftBehind, failed } = await downloads.removeMany(completedIds, true);
    const parts = [`已删除 ${removed} 个任务`];
    if (failed > 0) parts.push(`${failed} 个未能删除`);
    if (filesLeftBehind > 0) parts.push(`${filesLeftBehind} 个本地文件没删掉，需手动清理`);
    const text = parts.join('，');
    if (failed > 0 || filesLeftBehind > 0) toast.error(text);
    else toast.success(text);
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
    const { removed, filesLeftBehind } = await downloads.clearFailed();
    const parts = [`已清理 ${removed} 个失败任务`];
    if (filesLeftBehind > 0) parts.push(`${filesLeftBehind} 个残留文件没删掉，需手动清理`);
    const text = parts.join('，');
    if (filesLeftBehind > 0) toast.error(text);
    else toast.success(text);
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
    message: '将删除全部已完成任务的记录与本地文件（释放存储空间），此操作不可撤销。',
    confirmText: '清除',
    danger: true,
  });
  if (!ok) return;
  try {
    const { removed, filesLeftBehind } = await downloads.clearCompleted();
    const parts = [`已清除 ${removed} 条记录`];
    if (filesLeftBehind > 0) parts.push(`${filesLeftBehind} 个本地文件没删掉，需手动清理`);
    const text = parts.join('，');
    if (filesLeftBehind > 0) toast.error(text);
    else toast.success(text);
    await loadStorageUsage();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
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
    const { fileLeftBehind } = await downloads.remove(task.id, true);
    detailOpen.value = false;
    detailTask.value = null;
    // 记录删了但文件还在：不说就等于在本地留了个谁也找不到的孤儿
    if (fileLeftBehind) toast.error('记录已删除，但本地文件没删掉，需手动清理');
    else toast.success('已删除');
    await loadStorageUsage();
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function onPlay(task: DownloadTask): void {
  if (task.status !== 'completed') return;
  void router.push({
    name: 'player',
    params: { mediaId: task.mediaId, episodeId: task.episodeId },
    // 带上任务当初解析到的线路：本地文件缺失时才会退回在线播放，
    // 没有这个提示就只能落到第一条线路，而那一线路未必有这一集
    query: { local: '1', ...(task.lineId ? { lineId: task.lineId } : {}) },
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
    <div class="downloads-body" data-scroll="page">
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

        <DownloadSummary class="state-enter" :summary="downloads.summary" :celebrate="celebrateSummary" />

        <!-- 功能扩展-10：存储占用展示 -->
        <div class="storage-info">
          <span class="storage-info__label">本地存储</span>
          <span class="storage-info__value">{{ storageText }}</span>
        </div>

        <!-- P0-1：离线文件后台优化提示（转封装完成后自动消失） -->
        <div v-if="optimizing.active" class="optimizing-hint" role="status">
          <span class="optimizing-hint__spinner" aria-hidden="true" />
          <span class="optimizing-hint__text">{{ optimizingText }}</span>
        </div>

        <div class="downloads-filter">
          <SegmentedControl v-model="filter" :options="FILTER_OPTIONS" label="下载筛选" block />
        </div>

        <!-- EXT-04：限速展示 -->
        <div v-if="activeDownloading" class="downloads-speed">
          <span class="speed-label">限速：{{ speedLimitText }}</span>
          <span class="speed-value">当前：{{ currentSpeedText }}</span>
        </div>

        <!-- EXT-04：按批次分组展示 -->
        <div v-if="batchGroups.length > 0" class="downloads-batches state-enter">
          <div v-for="group in batchGroups" :key="group.batchId" class="batch-group">
            <DownloadBatchGroup
              v-if="group.batchId"
              :progress="getBatchProgress(group.tasks)"
              :label="group.label"
              :busy="batchOperating"
              @retry="retryBatch(group.batchId)"
              @delete-completed="deleteBatchCompleted(group.batchId)"
            />
            <TransitionGroup tag="ul" name="dl-flip" class="downloads-list">
              <li v-for="task in group.tasks" :key="task.id">
                <DownloadItem
                  :task="task"
                  :offline="isOffline"
                  :batch-mode="batchMode"
                  :selected="selectedIds.has(task.id)"
                  :celebrate="task.id === celebrateId"
                  :postprocess="downloads.postprocess[task.id] ?? null"
                  @play="onPlay"
                  @pause="onPause"
                  @resume="onResume"
                  @retry="onRetry"
                  @remove="onRemove"
                  @select="onSelect"
                  @toggle-select="toggleSelect"
                />
              </li>
            </TransitionGroup>
          </div>
        </div>

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
        <p v-if="detailRemuxText" class="task-detail__line">{{ detailRemuxText }}</p>
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

    <!-- C-11：全页共享的火花画布（各任务行只往它撒粒子，自己不建 canvas） -->
    <canvas ref="sparkCanvas" class="downloads-sparks" aria-hidden="true" />
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

/* C-11 火花层：盖在内容之上、页面框架之下，不吃事件 */
.downloads-sparks {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: calc(var(--z-content) + 1);
  pointer-events: none;
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

/* E2：队列 reorder FLIP —— 排序变化时行体平滑位移（200ms） */
.dl-flip-move {
  transition: transform 200ms var(--ease-standard);
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

/* P0-1：离线文件优化提示 */
.optimizing-hint {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  margin-top: var(--space-2);
  border-radius: var(--radius-md);
  background-color: var(--color-brand-soft);
}

.optimizing-hint__text {
  font: var(--text-label);
  color: var(--color-brand-text);
}

.optimizing-hint__spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid var(--color-brand-soft);
  border-top-color: var(--color-brand-text);
  animation: optimizing-spin 0.9s linear infinite;
}

@keyframes optimizing-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .optimizing-hint__spinner {
    animation: none;
  }

  .dl-flip-move {
    transition: none;
  }
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

/* EXT-04：限速展示 */
.downloads-speed {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  margin-bottom: var(--space-2);
  background-color: var(--color-bg-surface);
  border-radius: var(--radius-md);
  font-size: var(--text-caption);
}

.downloads-speed .speed-label {
  color: var(--color-text-secondary);
}

.downloads-speed .speed-value {
  color: var(--color-primary);
  font-weight: 500;
}

/* EXT-04：批次分组 */
.downloads-batches {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.batch-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.batch-group .downloads-list {
  margin-top: 0;
}
</style>
