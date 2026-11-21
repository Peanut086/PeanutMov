<script setup lang="ts">
/**
 * 剧集列表（设计规范 8.5 EpisodeChip）
 *
 * 网格：`repeat(auto-fill, minmax(56px, 1fr))`，gap 8，最小高 40。
 * 状态：当前播放（品牌描边）、已看（对勾）、已下载（绿点）、不可播（禁用色 + Toast）。
 * 集数 > 50 时分批渲染（先 50，底部"显示更多"），避免长剧首屏卡顿（AC-32）。
 *
 * 三种排布，默认口径不变：
 * - `compact`：横向滚动芯片（OPT-08）；
 * - `film`：一集一格的胶片墙（G-B07），画面由父级抽好传进来，本组件不认识抽帧；
 * - 都不传：数字芯片网格（历史形态）。
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
    /** 20261121 功能扩展-G-B07：胶片墙模式（一集一格画面），由父级开关 */
    film?: boolean;
    /** 胶片墙的画面：剧集 id → JPEG data URL（缺键 = 这一集没有画面可画） */
    filmFrames?: Record<string, string>;
    /** 胶片墙里还在抽帧的剧集 id（抽完会自动消失） */
    filmWaiting?: string[];
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
    film: false,
    filmFrames: () => ({}),
    filmWaiting: () => [],
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

/**
 * 胶片墙里这一集的画面。
 *
 * 只有真的抽出一帧才画 `<img>`：没画面的格子留空白板 + 集数，
 * 拿海报或上一集的画面顶替会把「这一集还没下载 / 抽不出来」说成「抽出来了」。
 */
function filmFrameOf(ep: Episode): string | undefined {
  return props.film ? props.filmFrames[ep.id] : undefined;
}

/** 还在排队抽帧：这一格暂时空白，但稍后会自己填上 */
function isFilmWaiting(ep: Episode): boolean {
  return props.film && props.filmWaiting.includes(ep.id);
}
</script>

<template>
  <div class="episode-list" :class="{ 'episode-list--compact': compact, 'episode-list--film': film }">
    <div
      class="episode-list__grid"
      :class="{ 'episode-list__grid--compact': compact, 'episode-list__grid--film': film }"
      role="list"
    >
      <button
        v-for="ep in visible"
        :key="ep.id"
        class="episode-chip"
        :class="{
          'episode-chip--current': ep.id === currentId,
          'episode-chip--unavailable': isUnavailable(ep),
          'episode-chip--resolving': ep.id === resolvingId,
          'episode-chip--compact': compact,
          'ep-film': film,
          'ep-film--waiting': isFilmWaiting(ep),
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
        <template v-if="film">
          <span class="ep-film__plate">
            <img
              v-if="filmFrameOf(ep)"
              class="ep-film__frame"
              :src="filmFrameOf(ep)"
              alt=""
              decoding="async"
            />
            <span class="film-perf film-perf--top" aria-hidden="true" />
            <span class="film-perf film-perf--bottom" aria-hidden="true" />
          </span>
          <span class="ep-film__count">{{ ep.number }}</span>
          <IconCheck v-if="isWatched(ep)" class="episode-chip__check" :size="12" />
          <span v-if="isDownloaded(ep)" class="ep-film__dot" aria-label="已下载" />
        </template>
        <template v-else>
          <span class="episode-chip__number">{{ ep.number }}</span>
          <IconCheck v-if="isWatched(ep)" class="episode-chip__check" :size="12" />
          <span v-if="isDownloaded(ep)" class="episode-chip__dot" aria-label="已下载" />
        </template>
      </button>
    </div>

    <!-- 胶片墙同样分批渲染：长剧超过 50 集时「显示更多」必须还在，否则看不全 -->
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

/* =========================================================
 * 胶片墙（G-B07）：一集一格画面 + 上下齿孔 + 集数胶囊
 *
 * 画面由父级抽出后通过 `filmFrames` 传进来，本组件只决定"有没有画面"：
 * 没抽出的格子留空白板 + 集数，绝不拿海报或邻集画面顶替。
 * 状态类（--current / --unavailable / --resolving）沿用芯片原有口径，
 * 只是底色被画面盖住，所以改用"外圈 + 集数胶囊"来表意。
 * =======================================================*/
.episode-list--film {
  gap: var(--space-2);
}

.episode-list__grid--film {
  /* 132 起步：375 宽的手机约 2 列，横屏 / 平板自动加列 */
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: var(--space-3);
}

.ep-film {
  min-width: 0;
  height: auto;
  padding: 0;
  gap: 0;
  overflow: hidden;
}

.ep-film__plate {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  background-color: var(--color-bg-surface);
}

.ep-film__frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* 按压反馈：底色被画面盖住，`background-color` 点了看不见，只能作用在画面上 */
.ep-film:active .ep-film__plate {
  filter: brightness(0.82);
}

/* 排队抽帧中：底板呼吸，明确"这一格会自己填上" */
.ep-film--waiting .ep-film__plate {
  animation: ep-film-waiting 1.2s var(--ease-in-out) infinite;
}

@keyframes ep-film-waiting {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}

.ep-film__count {
  position: absolute;
  left: var(--space-2);
  /* 9 = 齿孔带 6px + 上沿 1px + 2px 呼吸，集数压在孔带上方 */
  bottom: 9px;
  min-width: 22px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background-color: var(--color-overlay-control);
  color: var(--color-text-primary);
  font: var(--font-weight-semibold) 12px / 16px var(--font-family-number);
  text-align: center;
}

/* 当前集：画面盖住了品牌底色，所以用外圈 + 品牌胶囊表达 */
.ep-film.episode-chip--current {
  box-shadow: 0 0 0 2px var(--color-brand);
}

.ep-film.episode-chip--current .ep-film__count {
  background: var(--gradient-brand-cta);
  color: var(--color-brand-ink);
  font-weight: var(--font-weight-bold);
}

/* 不可播（REV-20）：整格压暗 + 集数删除线，与数字口径一致 */
.ep-film.episode-chip--unavailable {
  cursor: not-allowed;
}

.ep-film.episode-chip--unavailable .ep-film__plate {
  opacity: 0.4;
}

.ep-film.episode-chip--unavailable .ep-film__count {
  color: var(--color-text-disabled);
  text-decoration: line-through;
}

/* 已下载点挪到左上，避免和左下的集数胶囊打架 */
.ep-film__dot {
  position: absolute;
  left: 4px;
  top: 4px;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background-color: var(--color-success);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
}

@media (prefers-reduced-motion: reduce) {
  .ep-film--waiting .ep-film__plate {
    animation: none;
  }
}
</style>
