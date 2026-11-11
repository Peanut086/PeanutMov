<script setup lang="ts">
/**
 * 下载汇总卡（页面蓝图 §7）
 *
 * 总任务数、总进度、各状态计数；数据来自 `downloadStore.summary`。
 */
import { computed, ref, watch } from 'vue';

import type { DownloadSummary } from '@/types';

import { formatBytes, formatEta, toPercent } from '@/components/common/format';

const props = defineProps<{
  summary: DownloadSummary;
  speedBps?: number;
  /** C-11：一次完成一批时，只有这里庆祝一次（各任务行静默变勾） */
  celebrate?: boolean;
}>();

const percent = computed(() => {
  if (props.summary.totalBytes <= 0) {
    return props.summary.completed > 0 ? 100 : 0;
  }
  return toPercent(props.summary.downloadedBytes / props.summary.totalBytes);
});

const eta = computed(() => {
  const remain = props.summary.totalBytes - props.summary.downloadedBytes;
  if (!props.speedBps || props.speedBps <= 0 || remain <= 0) return '';
  return formatEta(remain, props.speedBps);
});

const counts = computed(() => {
  const s = props.summary;
  return [
    { label: '下载中', value: s.downloading },
    { label: '等待', value: s.queued },
    { label: '已暂停', value: s.paused },
    { label: '已完成', value: s.completed },
    { label: '失败', value: s.failed },
  ].filter((c) => c.value > 0);
});

/** 进度变化时触发脉冲：移除 class → nextTick → 重新添加，让 animation 重新播放 */
const pulseKey = ref(0);
watch(percent, () => {
  pulseKey.value++;
});
</script>

<template>
  <section
    class="download-summary"
    :class="{ 'download-summary--celebrate': celebrate }"
    aria-label="下载概览"
  >
    <div class="download-summary__head">
      <span class="download-summary__count">共 {{ summary.total }} 个任务</span>
      <span class="download-summary__bytes">
        {{ formatBytes(summary.downloadedBytes) }} / {{ formatBytes(summary.totalBytes) }}
      </span>
    </div>

    <div
      class="download-summary__bar"
      role="progressbar"
      :aria-valuenow="percent"
      aria-valuemin="0"
      aria-valuemax="100"
      aria-label="总下载进度"
    >
      <span
        class="download-summary__bar-fill"
        :class="{ 'download-summary__bar-fill--pulse': summary.downloading > 0 }"
        :key="`fill-${pulseKey}`"
        :style="{ width: `${percent}%` }"
      />
    </div>

    <div class="download-summary__foot">
      <span class="download-summary__percent">{{ percent }}%</span>
      <span v-if="eta" class="download-summary__eta">剩余 {{ eta }}</span>
      <span class="download-summary__counts">
        <template v-for="(c, idx) in counts" :key="c.label">
          <span v-if="idx > 0" class="download-summary__sep" aria-hidden="true">·</span>
          {{ c.label }} {{ c.value }}
        </template>
      </span>
    </div>
  </section>
</template>

<style scoped>
.download-summary {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

/* ---------- C-11 批量完成：整批只在这里庆祝一次 ---------- */
.download-summary--celebrate {
  animation: summary-lift 560ms var(--ease-decelerate);
}

.download-summary--celebrate .download-summary__percent {
  animation: summary-percent 380ms var(--ease-decelerate) 110ms both;
}

@keyframes summary-lift {
  0% {
    transform: scale(1);
    border-color: var(--color-border);
  }
  35% {
    transform: scale(1.006);
    border-color: var(--color-success);
    box-shadow: 0 4px 22px var(--color-success-soft);
  }
  100% {
    transform: scale(1);
    border-color: var(--color-border);
  }
}

@keyframes summary-percent {
  45% {
    transform: scale(1.16);
    color: var(--color-success);
  }
}

.download-summary__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}

.download-summary__count {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.download-summary__bytes {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.download-summary__bar {
  display: block;
  height: 4px;
  border-radius: var(--radius-full);
  background-color: var(--color-overlay-track);
  overflow: hidden;
}

.download-summary__bar-fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background-color: var(--color-brand);
  transition: width var(--duration-base) var(--ease-standard);
}

/* 下载中时进度条亮度脉冲，像心跳监护仪的波形跳动 */
.download-summary__bar-fill--pulse {
  animation: progress-pulse 300ms var(--ease-standard);
}

@keyframes progress-pulse {
  0% {
    filter: brightness(1);
  }
  50% {
    filter: brightness(1.3);
  }
  100% {
    filter: brightness(1);
  }
}

.download-summary__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.download-summary__percent {
  font: var(--text-label-strong);
  font-family: var(--font-family-number);
  color: var(--color-text-secondary);
}

.download-summary__counts {
  margin-left: auto;
}

.download-summary__sep {
  margin: 0 var(--space-1);
}
</style>
