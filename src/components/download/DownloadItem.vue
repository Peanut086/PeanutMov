<script setup lang="ts">
/**
 * 下载任务行（页面蓝图 §7）
 *
 * 行高 88+：海报 48×72 + 片名/集号 + 进度条 + 状态文案 + 行内操作按钮。
 * 操作按状态切换：下载中→暂停；已暂停→继续；失败→重试；已完成→播放；均可删除。
 *
 * C-11 收尾仪式：`celebrate` 为真时播一遍 580ms 的编舞（勾描绘 → 冲击波 → 徽章弹入 →
 * 行体落定）+ 一簇共享火花。勾与徽章本身是常驻的静态终态，动画只是"怎么到达终态"，
 * 所以 reduced-motion 下什么都不用改——全局规则把时长压到 0，直接就是完成态。
 */
import { computed, nextTick, ref, watch } from 'vue';

import type { DownloadTask } from '@/types';

import { burstSparks } from '@/services/sparkField';
import PosterImage from '@/components/common/PosterImage.vue';
import { IMG_W_INLINE } from '@/shared/imageSize';
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
  /** 刚刚完成（由下载页编排，批量完成时恒为假） */
  celebrate?: boolean;
  /**
   * EXT-04/FR-60 后处理阶段（下载页从 store 取该任务的最新一次上报）。
   * 只用于「转封装中」这一进行态——转封装发生在分片写完之后，任务状态要到
   * runner 整体返回才迁移，长视频可持续几分钟，期间进度条已 100% 却仍写「下载中…」。
   * 终态（成功/失败/跳过）走持久化的 `task.remux`，不依赖这个瞬态映射。
   */
  postprocess?: { stage: 'remux' | 'subtitles'; state: 'start' | 'progress' | 'done' | 'skipped' | 'failed' } | null;
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

const remuxing = computed(() => {
  const stage = props.postprocess;
  if (!stage || stage.stage !== 'remux' || stage.state !== 'start') return false;
  return props.task.status === 'downloading' || props.task.status === 'queued';
});

const statusText = computed(() => {
  switch (props.task.status) {
    case 'queued':
      return props.offline ? '等待网络' : '等待下载';
    case 'downloading':
      if (remuxing.value) return '转封装中…';
      return props.task.speedBps > 0
        ? `${formatSpeed(props.task.speedBps)} · 剩余 ${formatEta((props.task.totalBytes ?? 0) - props.task.downloadedBytes, props.task.speedBps) || '未知'}`
        : '下载中…';
    case 'paused':
      return props.offline ? '已暂停 · 等待网络' : '已暂停';
    case 'completed': {
      const size = formatBytes(props.task.totalBytes ?? props.task.downloadedBytes);
      // OPT-05：失败/跳过此前不落库，用户只知道"文件一直是 .ts"，不知道是转封装出了问题
      if (props.task.remux?.status === 'failed') return `已完成 · ${size} · 转封装失败，仍为 TS`;
      return `已完成 · ${size}`;
    }
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

const checkEl = ref<HTMLElement | null>(null);
/** 换行 / 卸载后到达的旧回调不能再往屏幕上撒粒子 */
let burstToken = 0;

watch(
  () => props.celebrate,
  async (on) => {
    if (!on) return;
    const current = ++burstToken;
    await nextTick();
    const el = checkEl.value;
    if (current !== burstToken || !el) return;
    const rect = el.getBoundingClientRect();
    burstSparks(rect.left + rect.width / 2, rect.top + rect.height / 2);
  },
  { immediate: true },
);

/** E2：速度 sparkline —— 最近 20 个速度采样的环形缓冲，反映瞬时速度波动 */
const SPEED_SAMPLE_MAX = 20;
const speedSamples = ref<number[]>([]);

watch(
  () => [props.task.speedBps, props.task.status] as const,
  ([bps, status]) => {
    if (status !== 'downloading') {
      if (speedSamples.value.length > 0) speedSamples.value = [];
      return;
    }
    const next = speedSamples.value.concat(bps);
    speedSamples.value =
      next.length > SPEED_SAMPLE_MAX ? next.slice(next.length - SPEED_SAMPLE_MAX) : next;
  },
  { immediate: true },
);

const showSparkline = computed(
  () => props.task.status === 'downloading' && speedSamples.value.length >= 2,
);

const sparklinePath = computed(() => {
  const samples = speedSamples.value;
  if (samples.length < 2) return '';
  const w = 44;
  const h = 14;
  const pad = 1.5;
  const max = Math.max(...samples, 1);
  const stepX = (w - pad * 2) / (samples.length - 1);
  return samples
    .map((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - (v / max) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});
</script>

<template>
  <article
    class="download-item"
    :class="{
      'download-item--batch': batchMode,
      'download-item--selected': selected,
      'download-item--downloading': task.status === 'downloading',
      'download-item--celebrate': celebrate,
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
      <span class="download-item__thumb">
        <span class="download-item__poster">
          <PosterImage :src="task.posterUrl" :alt="task.title" :width-px="IMG_W_INLINE" />
        </span>
        <!-- C-11：完成勾是常驻终态，收尾动画只负责"画出来"这一下 -->
        <span v-if="canPlay" ref="checkEl" class="download-item__check" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <circle class="download-item__check-ring" cx="12" cy="12" r="10" />
            <path class="download-item__check-tick" d="M7.5 12.4 10.8 15.6 16.6 9.3" />
          </svg>
        </span>
      </span>

      <span class="download-item__body">
        <span class="download-item__title truncate-1">
          {{ task.title }}
          <template v-if="task.episodeNumber !== null"> · 第 {{ task.episodeNumber }} 集</template>
        </span>

        <span class="download-item__status-row">
          <span class="download-item__status">{{ statusText }}</span>
          <svg
            v-if="showSparkline"
            class="download-item__spark"
            viewBox="0 0 44 14"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              :d="sparklinePath"
              fill="none"
              stroke="var(--color-brand)"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
        <span class="download-item__size">
          {{ sizeText }}
          <template v-if="task.status === 'downloading' || task.status === 'paused'"> · {{ percent }}%</template>
          <span v-if="canPlay" class="download-item__badge">可离线观看</span>
        </span>
      </span>
    </button>

    <!-- E2：胶片进度条（16px 齿孔 filmstrip，进度填充品牌色） -->
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
  padding: var(--space-3) 0 20px;
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

.download-item__thumb {
  position: relative;
  flex: 0 0 auto;
  width: 44px;
}

.download-item__poster {
  display: block;
  width: 100%;
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

/* E2：胶片进度条 —— 16px 高，上下齿孔（repeating-gradient），进度填充品牌色 */
.download-item__progress {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 16px;
  background-color: #0b0d11;
  border-radius: 0 0 var(--radius-card) var(--radius-card);
  overflow: hidden;
}

/* 齿孔：沿上下边缘的浅色穿孔，压在填充与非填充区之上 */
.download-item__progress::before,
.download-item__progress::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2.5px;
  z-index: 2;
  background-image: repeating-linear-gradient(
    90deg,
    rgba(255, 255, 255, 0.5) 0 3px,
    transparent 3px 9px
  );
}

.download-item__progress::before {
  top: 2.5px;
}

.download-item__progress::after {
  bottom: 2.5px;
}

.download-item__progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--color-brand), var(--color-brand-strong));
  transition: width 0.3s ease;
}

.download-item__progress-bar--danger {
  background: var(--color-danger);
}

.download-item__progress-bar--success {
  background: var(--color-success);
}

/* E2：状态文案 + 速度 sparkline 同行 */
.download-item__status-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.download-item__spark {
  flex: 0 0 auto;
  width: 44px;
  height: 14px;
  opacity: 0.85;
}

/* OPT-13: 下载中卡片微弱呼吸动画 */
.download-item--downloading {
  animation: download-breathe 2s ease-in-out infinite;
}

@keyframes download-breathe {
  0%, 100% { border-color: var(--color-border); }
  50% { border-color: var(--color-brand); }
}

/* ---------- C-11 完成收尾仪式 ---------- */

.download-item__check {
  position: absolute;
  right: -5px;
  bottom: -5px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  border: 1px solid var(--color-success);
  color: var(--color-success);
}

.download-item__check svg {
  position: relative;
  z-index: 1;
  display: block;
}

.download-item__check-ring,
.download-item__check-tick {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* 圆环周长 2πr≈63、勾长约 14：常驻态就是"画完了"，动画只补从空到满那一下 */
.download-item__check-ring {
  stroke-dasharray: 63;
}

.download-item__check-tick {
  stroke-dasharray: 14;
}

.download-item__check::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  border: 1px solid var(--color-success);
  opacity: 0;
  pointer-events: none;
}

.download-item__badge {
  display: inline-block;
  margin-left: var(--space-1);
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background-color: var(--color-success-soft);
  border: 1px solid var(--color-success);
  color: var(--color-success);
  font: var(--text-caption);
  font-size: 10.5px;
  line-height: 1.5;
  vertical-align: middle;
  white-space: nowrap;
}

/* 三组动画：勾（含冲击波）+ 徽章 + 行体落定，火花走共享 canvas */
.download-item--celebrate {
  animation: item-settle 420ms var(--ease-decelerate);
}

.download-item--celebrate .download-item__check-ring {
  animation: check-ring 420ms var(--ease-decelerate) both;
}

.download-item--celebrate .download-item__check-tick {
  animation: check-tick 240ms var(--ease-decelerate) 220ms both;
}

.download-item--celebrate .download-item__check::after {
  animation: check-wave 520ms var(--ease-decelerate) 120ms both;
}

.download-item--celebrate .download-item__badge {
  animation: badge-pop 320ms var(--ease-decelerate) 260ms both;
}

@keyframes item-settle {
  0% { transform: scale(1); }
  45% { transform: scale(1.014); }
  100% { transform: scale(1); }
}

@keyframes check-ring {
  from { stroke-dashoffset: 63; }
  to { stroke-dashoffset: 0; }
}

@keyframes check-tick {
  from { stroke-dashoffset: 14; }
  to { stroke-dashoffset: 0; }
}

@keyframes check-wave {
  from { opacity: 0.7; transform: scale(1); }
  to { opacity: 0; transform: scale(3.4); }
}

@keyframes badge-pop {
  0% { opacity: 0; transform: scale(0.82); }
  70% { opacity: 1; transform: scale(1.06); }
  100% { opacity: 1; transform: scale(1); }
}

.download-item__status {
  flex: 1 1 auto;
  min-width: 0;
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
  padding: var(--space-3) var(--space-3) 20px;
  margin-bottom: var(--space-2);
  transition: background-color 0.15s ease;
}

.download-item--batch .download-item__progress {
  border-radius: 0 0 var(--radius-md) var(--radius-md);
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

/* E2：reduced-motion —— 静态 bar + 文本，去掉呼吸/进度过渡与速度折线 */
@media (prefers-reduced-motion: reduce) {
  .download-item--downloading {
    animation: none;
  }

  .download-item__progress-bar {
    transition: none;
  }

  .download-item__spark {
    display: none;
  }
}
</style>
