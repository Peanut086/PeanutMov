<script setup lang="ts">
/**
 * 下载任务行（页面蓝图 §7）
 *
 * 行高 88+：海报 48×72 + 片名/集号 + 进度条 + 状态文案 + 行内操作按钮。
 * 操作按状态切换：下载中→暂停；已暂停→继续；失败→重试；已完成→播放；均可删除。
 */
import { computed } from 'vue';

import type { DownloadTask } from '@/types';

import PosterImage from '@/components/common/PosterImage.vue';
import { formatBytes, formatEta, formatSpeed, toPercent } from '@/components/common/format';
import IconPlay from '@/components/icons/IconPlay.vue';
import IconPause from '@/components/icons/IconPause.vue';
import IconRefresh from '@/components/icons/IconRefresh.vue';
import IconTrash from '@/components/icons/IconTrash.vue';

const props = defineProps<{
  task: DownloadTask;
  offline?: boolean;
  batchMode?: boolean;
  selected?: boolean;
}>();

const emit = defineEmits<{
  (e: 'play', task: DownloadTask): void;
  (e: 'pause', task: DownloadTask): void;
  (e: 'resume', task: DownloadTask): void;
  (e: 'retry', task: DownloadTask): void;
  (e: 'remove', task: DownloadTask): void;
  (e: 'select', task: DownloadTask): void;
  (e: 'toggleSelect', task: DownloadTask): void;
}>();

const percent = computed(() => {
  if (props.task.totalBytes !== null && props.task.totalBytes > 0) {
    return toPercent(props.task.downloadedBytes / props.task.totalBytes);
  }
  return props.task.status === 'completed' ? 100 : 0;
});

const sizeText = computed(() => {
  const { totalBytes, downloadedBytes, format, status } = props.task;
  if (totalBytes !== null) {
    // HLS 清单无总大小，下载中的 totalBytes 是按已完成分片均值估算的
    const approx = format === 'hls' && status !== 'completed' ? '约 ' : '';
    return `${formatBytes(downloadedBytes)} / ${approx}${formatBytes(totalBytes)}`;
  }
  return formatBytes(downloadedBytes);
});

const statusText = computed(() => {
  switch (props.task.status) {
    case 'queued':
      return props.offline ? '等待网络' : '等待下载';
    case 'downloading':
      return props.task.speedBps > 0
        ? `${formatSpeed(props.task.speedBps)} · 剩余 ${formatEta((props.task.totalBytes ?? 0) - props.task.downloadedBytes, props.task.speedBps) || '未知'}`
        : '下载中…';
    case 'paused':
      return props.offline ? '已暂停 · 等待网络' : '已暂停';
    case 'completed':
      return `已完成 · ${formatBytes(props.task.totalBytes ?? props.task.downloadedBytes)} · 可离线观看`;
    case 'failed':
      return props.task.errorMessage ?? '下载失败';
    case 'canceled':
      return '已取消';
    default:
      return '';
  }
});

const barTone = computed(() => {
  if (props.task.status === 'failed') return 'danger';
  if (props.task.status === 'completed') return 'success';
  return 'brand';
});

const canPlay = computed(() => props.task.status === 'completed');
</script>

<template>
  <article
    class="download-item"
    :class="{
      'download-item--batch': batchMode,
      'download-item--selected': selected,
      'download-item--downloading': task.status === 'downloading',
    }"
    :data-status="task.status"
  >
    <!-- 功能扩展-10：批量模式复选框 -->
    <button
      v-if="batchMode"
      class="download-item__checkbox"
      type="button"
      :aria-label="selected ? '取消选择' : '选择'"
      @click.stop="emit('toggleSelect', task)"
    >
      <svg v-if="selected" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M19 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.11 0 2-.9 2-2V5c0-1.1-.89-2-2-2zm-9 14l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M19 5v14H5V5h14m0-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
      </svg>
    </button>

    <button class="download-item__main" type="button" @click="emit('select', task)">
      <span class="download-item__poster">
        <PosterImage :src="task.posterUrl" :alt="task.title" />
      </span>

      <span class="download-item__body">
        <span class="download-item__title truncate-1">
          {{ task.title }}
          <template v-if="task.episodeNumber !== null"> · 第 {{ task.episodeNumber }} 集</template>
        </span>

        <span class="download-item__status">{{ statusText }}</span>
        <span class="download-item__size">
          {{ sizeText }}
          <template v-if="task.status === 'downloading' || task.status === 'paused'"> · {{ percent }}%</template>
        </span>
      </span>
    </button>

    <!-- OPT-13: 卡片底部 3px 进度条 -->
    <div
      class="download-item__progress"
      role="progressbar"
      :aria-valuenow="percent"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-label="`下载进度 ${percent}%`"
    >
      <div
        class="download-item__progress-bar"
        :class="`download-item__progress-bar--${barTone}`"
        :style="{ width: `${Math.max(2, percent)}%` }"
      />
    </div>

    <!-- 功能扩展-10：批量模式下隐藏操作按钮 -->
    <div v-if="!batchMode" class="download-item__actions">
      <button
        v-if="canPlay"
        class="download-item__action download-item__action--play"
        type="button"
        aria-label="播放已下载内容"
        @click.stop="emit('play', task)"
      >
        <IconPlay :size="20" />
      </button>

      <button
        v-else-if="task.status === 'downloading' || task.status === 'queued'"
        class="download-item__action"
        type="button"
        aria-label="暂停下载"
        @click.stop="emit('pause', task)"
      >
        <IconPause :size="20" />
      </button>

      <button
        v-else-if="task.status === 'paused'"
        class="download-item__action"
        type="button"
        aria-label="继续下载"
        @click.stop="emit('resume', task)"
      >
        <IconPlay :size="20" />
      </button>

      <button
        v-else-if="task.status === 'failed'"
        class="download-item__action"
        type="button"
        aria-label="重试下载"
        @click.stop="emit('retry', task)"
      >
        <IconRefresh :size="20" />
      </button>

      <button
        class="download-item__action download-item__action--danger"
        type="button"
        aria-label="删除下载"
        @click.stop="emit('remove', task)"
      >
        <IconTrash :size="20" />
      </button>
    </div>
  </article>
</template>

<style scoped>
.download-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--color-divider);
  position: relative;
}

.download-item__main {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  flex: 1 1 auto;
  min-width: 0;
  min-height: 72px;
  text-align: left;
}

.download-item__poster {
  flex: 0 0 auto;
  width: 44px;
  border-radius: 8px;
  overflow: hidden;
}

.download-item__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 auto;
  min-width: 0;
}

.download-item__title {
  font: var(--font-weight-semibold) 13px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

/* OPT-13: 卡片底部 3px 进度条 */
.download-item__progress {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
  background-color: var(--color-overlay-track);
  border-radius: 0 0 var(--radius-card) var(--radius-card);
  overflow: hidden;
}

.download-item__progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--color-brand), var(--color-brand-strong));
  transition: width 0.3s ease;
  border-radius: inherit;
}

.download-item__progress-bar--danger {
  background: var(--color-danger);
}

.download-item__progress-bar--success {
  background: var(--color-success);
}

/* OPT-13: 下载中卡片微弱呼吸动画 */
.download-item--downloading {
  animation: download-breathe 2s ease-in-out infinite;
}

@keyframes download-breathe {
  0%, 100% { border-color: var(--color-border); }
  50% { border-color: var(--color-brand); }
}

.download-item__status {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.download-item[data-status='failed'] .download-item__status {
  color: var(--color-danger);
}

.download-item__size {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.download-item__actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.download-item__action {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  transition: var(--transition-color);
}

.download-item__action:active {
  background-color: var(--color-overlay-press-strong);
}

.download-item__action--play {
  color: var(--color-brand-text);
}

.download-item__action--danger {
  color: var(--color-danger);
}

/* 功能扩展-10：批量模式样式 */
.download-item--batch {
  background-color: var(--color-bg-surface);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  margin-bottom: var(--space-2);
  transition: background-color 0.15s ease;
}

.download-item--selected {
  background-color: var(--color-brand-soft);
  border: 1px solid var(--color-brand);
}

.download-item__checkbox {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  transition: color 0.15s ease;
}

.download-item--selected .download-item__checkbox {
  color: var(--color-brand);
}

.download-item__checkbox svg {
  width: 24px;
  height: 24px;
}
</style>
