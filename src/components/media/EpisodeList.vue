<script setup lang="ts">
/**
 * 剧集列表（设计规范 8.5 EpisodeChip）
 *
 * 网格：`repeat(auto-fill, minmax(56px, 1fr))`，gap 8，最小高 40。
 * 状态：当前播放（品牌描边）、已看（对勾）、已下载（绿点）、不可播（禁用色 + Toast）。
 * 集数 > 50 时分批渲染（先 50，底部"显示更多"），避免长剧首屏卡顿（AC-32）。
 */
import { computed, ref, watch } from 'vue';

import type { Episode } from '@/types';

import IconCheck from '@/components/icons/IconCheck.vue';

const props = withDefaults(
  defineProps<{
    episodes: Episode[];
    /** 当前播放剧集 id */
    currentId?: string | null;
    /** 已看过的剧集号 */
    watchedNumbers?: number[];
    /** 已下载的剧集 id */
    downloadedIds?: string[];
    /** 已确认解析不到播放地址的剧集 id（REV-20：渲染禁用态） */
    unavailableIds?: string[];
    /** 起播批次大小 */
    batchSize?: number;
    /** 正在打开播放页的标志，由父级传入 */
    playingNavigate?: boolean;
    /** 正在解析播放地址的剧集 id（父级预检 resolvePlay 期间显示加载态） */
    resolvingId?: string | null;
    /** OPT-08：紧凑模式，横向滚动芯片布局 */
    compact?: boolean;
  }>(),
  {
    currentId: null,
    watchedNumbers: () => [],
    downloadedIds: () => [],
    unavailableIds: () => [],
    batchSize: 50,
    playingNavigate: false,
    resolvingId: null,
    compact: false,
  },
);

const emit = defineEmits<{
  (e: 'select', episode: Episode): void;
  (e: 'unavailable', episode: Episode): void;
  (e: 'playing'): void;
}>();

const visibleCount = ref(props.batchSize);

watch(
  () => props.episodes,
  () => {
    visibleCount.value = props.batchSize;
  },
);

const sorted = computed(() => [...props.episodes].sort((a, b) => a.number - b.number));
const visible = computed(() => sorted.value.slice(0, visibleCount.value));
const hasMore = computed(() => sorted.value.length > visibleCount.value);

function isWatched(ep: Episode): boolean {
  return props.watchedNumbers.includes(ep.number);
}

function isDownloaded(ep: Episode): boolean {
  return props.downloadedIds.includes(ep.id);
}

/** 已确认解析不到播放地址（REV-20）：渲染禁用态并阻止点击进入播放页 */
function isUnavailable(ep: Episode): boolean {
  return props.unavailableIds.includes(ep.id);
}

function onClick(ep: Episode): void {
  // AC-92：防止重复点击
  if (props.playingNavigate) {
    emit('playing');
    return;
  }
  // 地址探测由父级完成（详情页播放前预检 `resolvePlay`），
  // 探测为空的集由父级写入 `unavailableIds`，这里渲染禁用态并回传 `unavailable`。
  if (isUnavailable(ep)) {
    emit('unavailable', ep);
    return;
  }
  emit('select', ep);
}
</script>

<template>
  <div class="episode-list" :class="{ 'episode-list--compact': compact }">
    <div class="episode-list__grid" :class="{ 'episode-list__grid--compact': compact }" role="list">
      <button
        v-for="ep in visible"
        :key="ep.id"
        class="episode-chip"
        :class="{
          'episode-chip--current': ep.id === currentId,
          'episode-chip--unavailable': isUnavailable(ep),
          'episode-chip--resolving': ep.id === resolvingId,
          'episode-chip--compact': compact,
        }"
        type="button"
        role="listitem"
        :aria-current="ep.id === currentId ? 'true' : undefined"
        :aria-disabled="isUnavailable(ep) ? 'true' : undefined"
        :aria-busy="ep.id === resolvingId ? 'true' : undefined"
        :aria-label="
          ep.id === resolvingId
            ? `第 ${ep.number} 集（正在解析播放地址）`
            : isUnavailable(ep)
              ? `第 ${ep.number} 集（暂无可播放地址）`
              : `第 ${ep.number} 集${ep.title && ep.title !== `第 ${ep.number} 集` ? ` ${ep.title}` : ''}`
        "
        :title="isUnavailable(ep) ? '该集暂无可播放地址' : undefined"
        @click="onClick(ep)"
      >
        <span class="episode-chip__number">{{ ep.number }}</span>
        <IconCheck v-if="isWatched(ep)" class="episode-chip__check" :size="12" />
        <span v-if="isDownloaded(ep)" class="episode-chip__dot" aria-label="已下载" />
      </button>
    </div>

    <button
      v-if="hasMore && !compact"
      class="episode-list__more"
      type="button"
      @click="visibleCount += batchSize"
    >
      显示更多（还有 {{ sorted.length - visibleCount }} 集）
    </button>
  </div>
</template>

<style scoped>
.episode-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.episode-list__grid {
  display: grid;
  /* 6 列：375 宽下每格约 48px，一屏可看 12–18 集 */
  grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
  gap: var(--space-2);
}

.episode-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  height: 40px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  font: var(--font-weight-semibold) 13px / 1 var(--font-family-number);
  transition: var(--transition-color);
}

.episode-chip:active {
  background-color: var(--color-overlay-press-strong);
}

/* 视觉高度 40，命中区扩到 44（规范 §12.1） */
.episode-chip::after {
  content: '';
  position: absolute;
  inset: -2px -4px;
}

/* 当前集：品牌渐变实心 + 深色字，一屏内最醒目的元素 */
.episode-chip--current {
  border-color: transparent;
  background: var(--gradient-brand-cta);
  color: var(--color-brand-ink);
  font-weight: var(--font-weight-bold);
  box-shadow: var(--shadow-brand);
}

/* 不可播（REV-20 / AC-33）：设计规范禁用色，删除线示意无地址 */
.episode-chip--unavailable {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.episode-chip--unavailable .episode-chip__number {
  text-decoration: line-through;
}

/* 解析中（AC-92 补充）：呼吸提示，明确"点了、在解析"，不再静默干等 */
.episode-chip--resolving {
  animation: episode-chip-resolving 1.1s var(--ease-in-out) infinite;
  cursor: progress;
}

@keyframes episode-chip-resolving {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

.episode-chip__check {
  position: absolute;
  top: 2px;
  right: 2px;
  color: var(--color-success);
}

.episode-chip__dot {
  position: absolute;
  left: 4px;
  bottom: 4px;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background-color: var(--color-success);
}

.episode-list__more {
  align-self: center;
  min-height: 44px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-full);
  border: var(--border-strong);
  color: var(--color-text-secondary);
  font: var(--text-button-sm);
}

/* OPT-08：紧凑模式 - 横向滚动芯片 */
.episode-list--compact {
  gap: var(--space-2);
}

.episode-list__grid--compact {
  display: flex;
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  gap: var(--space-2);
  padding-bottom: var(--space-1);
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
  /* REV-15：compact 模式 scroll-snap，提升横向浏览体验 */
  scroll-snap-type: x proximity;
}

.episode-list__grid--compact::-webkit-scrollbar {
  display: none;
}

.episode-chip--compact {
  flex: 0 0 auto;
  min-width: 52px;
  height: 36px;
  padding: 0 var(--space-3);
  font-size: 12px;
  /* REV-15：scroll-snap 对齐 */
  scroll-snap-align: start;
}

/* 紧凑模式视觉更矮（36），命中区同样补到 44 */
.episode-chip--compact::after {
  inset: -4px -4px;
}
</style>
