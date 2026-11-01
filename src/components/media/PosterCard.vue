<script setup lang="ts">
/**
 * 海报卡（设计规范 8.4）
 *
 * 结构：海报 2:3 + 标题 2 行 + 可选副信息；角标（集数/演示/已下载）+ 进度条。
 * 图片懒加载与失败占位由 `PosterImage` 负责。
 * 无障碍：整卡为 button，`aria-label="片名，年份"`。
 */
import { computed } from 'vue';

import type { MediaItem } from '@/types';

import PosterImage from '@/components/common/PosterImage.vue';
import IconCheck from '@/components/icons/IconCheck.vue';
import { mediaTypeLabel } from '@/components/common/format';

const props = withDefaults(
  defineProps<{
    item: MediaItem;
    /** 进度 0~1，>0 时显示底部进度条 */
    progress?: number;
    /** 左上角角标文本（如"第 3 集"） */
    badge?: string;
    /** 右上角"演示"角标 */
    demo?: boolean;
    /** 右上角已下载标记 */
    downloaded?: boolean;
    /** 是否显示副标题（年份 · 类型） */
    showMeta?: boolean;
  }>(),
  { progress: 0, badge: '', demo: false, downloaded: false, showMeta: true },
);

const emit = defineEmits<{ (e: 'select', item: MediaItem): void; (e: 'longpress', item: MediaItem): void }>();

/** 演示角标：显式传入或由数据自身 isDemo 决定（避免调用方漏传） */
const showDemo = computed(() => props.demo || props.item.isDemo);

const ariaLabel = computed(() =>
  props.item.year !== null ? `${props.item.title}，${props.item.year}` : props.item.title,
);

const progressPercent = computed(() => Math.round(Math.min(1, Math.max(0, props.progress)) * 100));

let pressTimer: ReturnType<typeof setTimeout> | null = null;
/** 长按已触发：随后的 click 需要被吞掉，避免误导航 */
let longPressFired = false;

function onPointerDown(): void {
  longPressFired = false;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    longPressFired = true;
    emit('longpress', props.item);
  }, 500);
}

function cancelPress(): void {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
  }
}

function onClick(): void {
  if (pressTimer !== null) {
    clearTimeout(pressTimer);
    pressTimer = null;
    return;
  }
  if (longPressFired) {
    longPressFired = false;
    return;
  }
  emit('select', props.item);
}
</script>

<template>
  <button
    class="poster-card"
    type="button"
    :aria-label="ariaLabel"
    @pointerdown="onPointerDown"
    @pointerup="cancelPress"
    @pointerleave="cancelPress"
    @pointercancel="cancelPress"
    @contextmenu.prevent
    @click="onClick"
  >
    <div class="poster-card__frame">
      <PosterImage :src="item.posterUrl" :alt="item.title" />

      <span v-if="badge" class="poster-card__badge">{{ badge }}</span>
      <span v-else-if="item.episodeCount && item.episodeCount > 1" class="poster-card__badge">
        全 {{ item.episodeCount }} 集
      </span>

      <span v-if="showDemo" class="poster-card__badge poster-card__badge--demo">演示</span>
      <span v-else-if="downloaded" class="poster-card__badge poster-card__badge--done" aria-label="已下载">
        <IconCheck :size="14" />
      </span>

      <div
        v-if="progressPercent > 0"
        class="poster-card__progress"
        role="progressbar"
        :aria-valuenow="progressPercent"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-label="`已观看 ${progressPercent}%`"
      >
        <span class="poster-card__progress-fill" :style="{ width: `${progressPercent}%` }" />
      </div>
    </div>

    <span class="poster-card__title clamp-2">{{ item.title }}</span>
    <span v-if="showMeta" class="poster-card__meta">
      {{ item.year ?? '未知年份' }} · {{ mediaTypeLabel(item.type) }}
    </span>
  </button>
</template>

<style scoped>
.poster-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  min-width: 0;
  text-align: left;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.poster-card:active {
  transform: scale(0.985);
}

.poster-card__frame {
  position: relative;
  width: 100%;
  border-radius: var(--radius-card);
  overflow: hidden;
  background-color: var(--color-bg-surface);
}

/* 角标统一为半透明胶囊，压在海报上不抢画面 */
.poster-card__badge {
  position: absolute;
  top: var(--space-2);
  left: var(--space-2);
  height: 20px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  border-radius: 6px;
  background-color: rgba(0, 0, 0, 0.62);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  color: #ffffff;
  font: var(--font-weight-semibold) 10.5px / 1 var(--font-family-number);
  letter-spacing: 0.01em;
}

.poster-card__badge--demo,
.poster-card__badge--done {
  left: auto;
  right: var(--space-2);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
}

/* 已下载：实心绿底 + 深色对勾，比文字更易扫读 */
.poster-card__badge--done {
  width: 20px;
  padding: 0;
  justify-content: center;
  background-color: var(--color-success);
  color: #04140d;
}

.poster-card__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background-color: rgba(255, 255, 255, 0.22);
}

.poster-card__progress-fill {
  display: block;
  height: 100%;
  border-radius: 0 2px 2px 0;
  background-color: var(--color-brand);
}

.poster-card__title {
  font: var(--font-weight-semibold) 13px / 1.35 var(--font-family-base);
  color: var(--color-text-primary);
}

.poster-card__meta {
  font: var(--font-weight-regular) 11px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}
</style>
