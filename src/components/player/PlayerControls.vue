<script setup lang="ts">
/**
 * 播放控制条（设计规范 8.11）
 *
 * 顶部：返回 + 标题（片名 · 第 N 集）+ 右侧投屏/字幕。
 * 底部：进度条 + 时间 + 播放/暂停（56）/上下集 + 倍速/字幕/清晰度/全屏/下载。
 * 显隐由父级 `visible` 控制，300ms opacity 过渡（不位移，避免画面抖动）。
 * 隐藏态：底部保留 2px 微进度条（类似 YouTube/B站），让用户感知播放进度。
 */
import { computed } from 'vue';

import type { PlaybackRate } from '@/types';

import SeekBar from '@/components/player/SeekBar.vue';
import IconBack from '@/components/icons/IconBack.vue';
import IconPlay from '@/components/icons/IconPlay.vue';
import IconPause from '@/components/icons/IconPause.vue';
import IconSpeed from '@/components/icons/IconSpeed.vue';
import IconSubtitle from '@/components/icons/IconSubtitle.vue';
import IconFullscreen from '@/components/icons/IconFullscreen.vue';
import IconDownload from '@/components/icons/IconDownload.vue';
import IconCast from '@/components/icons/IconCast.vue';
import IconChevron from '@/components/icons/IconChevron.vue';
import IconAspectRatio from '@/components/icons/IconAspectRatio.vue';
import IconPip from '@/components/icons/IconPip.vue';
import { useHaptic } from '@/composables/useHaptic';

const props = withDefaults(
  defineProps<{
    visible: boolean;
    title: string;
    episodeLabel: string;
    playing: boolean;
    waiting: boolean;
    currentTime: number;
    duration: number;
    buffered: number;
    rate: PlaybackRate;
    canPrev: boolean;
    canNext: boolean;
    /** 单集影片隐藏上下集按钮（AC-42） */
    showEpisodeNav: boolean;
    fullscreen: boolean;
    /** 是否已有字幕（高亮图标） */
    subtitleActive: boolean;
    /** 清晰度档位文本 */
    qualityLabel: string;
    /** 是否显示下载按钮 */
    canDownload: boolean;
    /** 正在下载 */
    downloading?: boolean;
    /** 当前平台不支持投屏（AC-84）：渲染为禁用态 */
    castDisabled?: boolean;
    immersive?: boolean;
    /**
     * 紧凑模式（竖屏 16:9 画面内）：进度条与时间同排、倍速/清晰度/全屏并入主控制行，
     * 底部总高从 ~180px 收到 ~100px（设计规范 6.6 竖屏口径）。
     * 横屏/全屏空间充足，保持原布局。
     */
    compact?: boolean;
    /** P1-2：弹幕是否开启 */
    danmakuEnabled?: boolean;
    /** P1-4：键盘/进度条步进秒数 */
    seekStep?: number;
    /** OPT-06：当前环境是否支持画中画 */
    pipSupported?: boolean;
    /** OPT-06：是否已处于画中画状态 */
    pipActive?: boolean;
    /** A-03：进度条胶片预览的缩略图（下标即格号，null = 未就绪） */
    film?: (string | null)[] | null;
    /** B-06：片头/片尾区间标记（秒），null 时进度条不画分段 */
    marks?: { introEndSec: number | null; creditsStartSec: number | null } | null;
  }>(),
  { downloading: false, castDisabled: false, immersive: false, compact: false, danmakuEnabled: false, seekStep: 10, pipSupported: false, pipActive: false, film: null, marks: null },
);

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'toggle-play'): void;
  (e: 'prev'): void;
  (e: 'next'): void;
  (e: 'seek', sec: number): void;
  (e: 'seeking', sec: number): void;
  (e: 'open-speed'): void;
  (e: 'open-subtitle'): void;
  (e: 'open-quality'): void;
  (e: 'open-display-mode'): void;
  (e: 'toggle-fullscreen'): void;
  (e: 'download'): void;
  (e: 'cast'): void;
  (e: 'toggle-danmaku'): void;
  (e: 'open-danmaku-settings'): void;
  (e: 'open-danmaku-style'): void;
  (e: 'toggle-pip'): void;
}>();

const rateLabel = computed(() => `${props.rate}x`);
const playLabel = computed(() => (props.playing ? '暂停' : '播放'));

const { haptic } = useHaptic();

function onTogglePlay(): void {
  haptic('light');
  emit('toggle-play');
}

/** 微进度条百分比（控制条隐藏时显示） */
const miniProgress = computed(() =>
  props.duration > 0 ? Math.min(100, Math.max(0, (props.currentTime / props.duration) * 100)) : 0,
);
const miniBuffered = computed(() =>
  props.duration > 0 ? Math.min(100, Math.max(0, (props.buffered / props.duration) * 100)) : 0,
);
</script>

<template>
  <div
    class="player-controls"
    :class="{
      'player-controls--hidden': !visible,
      'player-controls--immersive': immersive,
      'player-controls--compact': compact,
    }"
  >
    <div class="player-scrim player-scrim--top" aria-hidden="true" />
    <div class="player-scrim player-scrim--bottom" aria-hidden="true" />

    <!-- 顶部 -->
    <header class="controls-top">
      <button class="controls-btn" type="button" aria-label="返回" @click="emit('back')">
        <IconBack :size="24" />
      </button>

      <div class="controls-top__title">
        <span class="controls-top__name truncate-1">{{ title }}</span>
        <span v-if="episodeLabel" class="controls-top__episode">{{ episodeLabel }}</span>
      </div>

      <div class="controls-top__actions">
        <!-- P1-2：弹幕开关按钮 -->
        <button
          class="controls-btn"
          :class="{ 'controls-btn--active': danmakuEnabled }"
          type="button"
          :aria-label="danmakuEnabled ? '关闭弹幕' : '开启弹幕'"
          @click="emit('toggle-danmaku')"
        >
          <span class="danmaku-icon" aria-hidden="true">弹</span>
        </button>
        <button
          v-if="danmakuEnabled"
          class="controls-btn"
          type="button"
          aria-label="弹幕样式调节"
          @click="emit('open-danmaku-style')"
        >
          <span class="danmaku-style-icon" aria-hidden="true">彩</span>
        </button>
        <button
          class="controls-btn"
          type="button"
          :aria-label="castDisabled ? '投屏（当前平台不支持投屏）' : '投屏'"
          :aria-disabled="castDisabled ? 'true' : undefined"
          :disabled="castDisabled"
          :title="castDisabled ? '当前平台不支持投屏' : undefined"
          @click="emit('cast')"
        >
          <IconCast :size="20" />
        </button>
        <button
          class="controls-btn"
          :class="{ 'controls-btn--active': subtitleActive }"
          type="button"
          aria-label="字幕"
          @click="emit('open-subtitle')"
        >
          <IconSubtitle :size="20" />
        </button>
      </div>
    </header>

    <!-- 底部 -->
    <footer class="controls-bottom">
      <SeekBar
        :current-time="currentTime"
        :duration="duration"
        :buffered="buffered"
        :disabled="waiting && duration === 0"
        :inline="compact || immersive"
        :seek-step="seekStep"
        :film="film"
        :marks="marks"
        @seek="emit('seek', $event)"
        @seeking="emit('seeking', $event)"
      />

      <div class="controls-row">
        <div class="controls-row__side">
          <button
            v-if="showEpisodeNav"
            class="controls-btn controls-btn--nav"
            type="button"
            aria-label="上一集"
            :disabled="!canPrev"
            @click="emit('prev')"
          >
            <span class="nav-icon nav-icon--prev" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 5.6v12.8L9.4 12Z" /><rect x="5" y="5.6" width="2.2" height="12.8" rx="1" /></svg>
            </span>
          </button>
        </div>

        <button
          class="controls-play"
          type="button"
          :aria-label="playLabel"
          :aria-busy="waiting ? 'true' : undefined"
          @click="onTogglePlay"
        >
          <span v-if="waiting" class="controls-play__spinner" aria-hidden="true" />
          <IconPause v-else-if="playing" :size="28" />
          <IconPlay v-else :size="28" />
        </button>

        <div class="controls-row__side controls-row__side--end">
          <button
            v-if="showEpisodeNav"
            class="controls-btn controls-btn--nav"
            type="button"
            aria-label="下一集"
            :disabled="!canNext"
            @click="emit('next')"
          >
            <span class="nav-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 5.6v12.8L14.6 12Z" /><rect x="16.8" y="5.6" width="2.2" height="12.8" rx="1" /></svg>
            </span>
          </button>

          <!-- 紧凑模式：倍速 / 清晰度 / 字幕 / 全屏并进本行，省掉独立 secondary 行 -->
          <template v-if="compact">
            <button class="controls-mini" type="button" :aria-label="`倍速 ${rateLabel}`" @click="emit('open-speed')">
              {{ rateLabel }}
            </button>
            <button class="controls-mini" type="button" aria-label="清晰度" @click="emit('open-quality')">
              {{ qualityLabel }}
            </button>
            <button class="controls-mini controls-mini--icon" type="button" aria-label="画面比例" @click="emit('open-display-mode')">
              <IconAspectRatio :size="18" />
            </button>
            <button
              class="controls-mini controls-mini--icon"
              :class="{ 'controls-mini--active': subtitleActive }"
              type="button"
              aria-label="字幕"
              @click="emit('open-subtitle')"
            >
              <IconSubtitle :size="18" />
            </button>
            <button
              v-if="pipSupported"
              class="controls-mini controls-mini--icon"
              :class="{ 'controls-mini--active': pipActive }"
              type="button"
              :aria-label="pipActive ? '退出画中画' : '画中画'"
              @click="emit('toggle-pip')"
            >
              <IconPip :size="18" :active="pipActive" />
            </button>
            <button
              class="controls-mini controls-mini--icon"
              type="button"
              :aria-label="fullscreen ? '退出全屏' : '全屏'"
              @click="emit('toggle-fullscreen')"
            >
              <IconFullscreen :size="18" :exit="fullscreen" />
            </button>
          </template>
        </div>
      </div>

      <div v-if="!compact" class="controls-secondary">
        <button class="controls-secondary__btn" type="button" aria-label="倍速" @click="emit('open-speed')">
          <IconSpeed :size="18" />
          <span class="controls-secondary__text">{{ rateLabel }}</span>
        </button>

        <button class="controls-secondary__btn" type="button" aria-label="清晰度" @click="emit('open-quality')">
          <span class="controls-secondary__text">{{ qualityLabel }}</span>
          <IconChevron :size="14" direction="down" />
        </button>

        <button class="controls-secondary__btn" type="button" aria-label="画面比例" @click="emit('open-display-mode')">
          <IconAspectRatio :size="18" />
        </button>

        <button
          v-if="canDownload"
          class="controls-secondary__btn"
          type="button"
          aria-label="下载本集"
          :disabled="downloading"
          @click="emit('download')"
        >
          <IconDownload :size="18" :done="downloading" />
        </button>

        <button
          v-if="pipSupported"
          class="controls-secondary__btn"
          type="button"
          :aria-label="pipActive ? '退出画中画' : '画中画'"
          @click="emit('toggle-pip')"
        >
          <IconPip :size="18" :active="pipActive" />
        </button>

        <button
          class="controls-secondary__btn"
          type="button"
          :aria-label="fullscreen ? '退出全屏' : '全屏'"
          @click="emit('toggle-fullscreen')"
        >
          <IconFullscreen :size="18" :exit="fullscreen" />
        </button>
      </div>
    </footer>

    <!-- 控制条隐藏时的微进度条（底部 2px，类似 YouTube/B站） -->
    <div v-if="!visible && duration > 0" class="mini-progress" aria-hidden="true">
      <div class="mini-progress__buffered" :style="{ width: `${miniBuffered}%` }" />
      <div class="mini-progress__played" :style="{ width: `${miniProgress}%` }" />
    </div>
  </div>
</template>

<style scoped>
.player-controls {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  opacity: 1;
  transition: opacity var(--duration-slow) var(--ease-standard);
  /* 空白区域放行给下层手势层（单击显隐、横滑快进、竖滑音量/亮度、长按 2x） */
  pointer-events: none;
}

/* 仅顶部/底部控制栏本身可点；隐藏态显式关掉，避免 pointer-events:auto 子元素穿透 */
.controls-top,
.controls-bottom {
  pointer-events: auto;
}

.player-controls--hidden,
.player-controls--hidden .controls-top,
.player-controls--hidden .controls-bottom {
  pointer-events: none;
}

.player-controls--hidden {
  opacity: 0;
}

/*
 * 紧凑模式（竖屏 16:9）：顶部 88→52、底部 120→96。
 * 目的：把画面可见高度从 50px 提到 ~110px，进度条回到画面最底部而不是"半腰"。
 */
.player-controls--compact .controls-top {
  min-height: 52px;
  padding-top: var(--space-1);
  padding-bottom: var(--space-1);
}

.player-controls--compact .controls-bottom {
  gap: 0;
  padding: var(--space-1) max(var(--space-3), var(--safe-right))
    calc(var(--space-1) + var(--safe-bottom)) max(var(--space-3), var(--safe-left));
}

.player-controls--compact .controls-play {
  width: 48px;
  height: 48px;
}

.player-controls--compact .controls-btn--nav {
  width: 40px;
  height: 40px;
}

.controls-top {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: calc(48px + var(--safe-top));
  padding: var(--safe-top) max(var(--space-3), var(--safe-right)) 0 max(var(--space-3), var(--safe-left));
}

.controls-top__title {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1 1 auto;
  min-width: 0;
}

.controls-top__name {
  font: var(--text-body-strong);
  color: #ffffff;
}

.controls-top__episode {
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.68);
}

.controls-top__actions {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.controls-btn {
  width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: #ffffff;
}

.controls-btn--active {
  color: var(--color-brand-strong);
}

.controls-btn:disabled {
  color: var(--color-text-disabled);
  pointer-events: none;
}

.controls-btn:active:not(:disabled) {
  background-color: rgba(255, 255, 255, 0.12);
}

/* P1-2：弹幕图标样式 */
.danmaku-icon {
  font-size: 18px;
  font-weight: 700;
  line-height: 1;
}

.danmaku-style-icon {
  font-size: 14px;
  font-weight: 700;
  line-height: 1;
  background: linear-gradient(135deg, #ff6b6b, #4fc3f7, #69db7c);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.controls-bottom {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) max(var(--space-3), var(--safe-right))
    calc(var(--space-2) + var(--safe-bottom)) max(var(--space-3), var(--safe-left));
}

.controls-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.controls-row__side {
  flex: 1 1 0;
  display: flex;
  align-items: center;
}

.controls-row__side--end {
  justify-content: flex-end;
}

.controls-btn--nav {
  width: 44px;
  height: 44px;
}

.nav-icon,
.nav-icon--prev {
  display: inline-flex;
  width: 24px;
  height: 24px;
}

.nav-icon svg {
  width: 24px;
  height: 24px;
}

.controls-play {
  position: relative;
  width: 56px;
  height: 56px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: rgba(255, 255, 255, 0.12);
  color: #ffffff;
  transition: background-color var(--duration-fast) var(--ease-standard);
}

.controls-play:active {
  background-color: rgba(255, 255, 255, 0.2);
}

.controls-play__spinner {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.28);
  border-top-color: #ffffff;
  animation: controls-spin 800ms linear infinite;
}

@keyframes controls-spin {
  to {
    transform: rotate(360deg);
  }
}

.controls-secondary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-bottom: 2px;
}

/* 紧凑模式：一行内的小号文字按钮（倍速/清晰度）+ 图标按钮（字幕/全屏） */
.controls-mini {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 36px;
  height: 36px;
  padding: 0 var(--space-1);
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.9);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

/* 视觉高度 36，命中区扩到 44（规范 §12.1，与 .controls-secondary__btn 同一手法） */
.controls-mini::after {
  content: '';
  position: absolute;
  inset: -4px -2px;
}

.controls-mini--icon {
  width: 36px;
  padding: 0;
}

.controls-mini--active {
  color: var(--color-brand);
}

.controls-mini:active {
  background-color: rgba(255, 255, 255, 0.12);
}

.controls-secondary__btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 36px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  color: rgba(255, 255, 255, 0.92);
}

/* 视觉高度 36，命中区扩到 44（规范 §12.1） */
.controls-secondary__btn::after {
  content: '';
  position: absolute;
  inset: -4px -2px;
}

.controls-secondary__btn:active {
  background-color: rgba(255, 255, 255, 0.12);
}

.controls-secondary__btn:disabled {
  color: var(--color-text-disabled);
}

.controls-secondary__text {
  font: var(--text-label-strong);
  font-family: var(--font-family-number);
}

/* 全屏进度条贴底：按钮行上移、轨道沉到 footer 最底（order），
   配合 inline 时间行，轨道不再高悬于控制区顶部（YouTube/B站口径） */
.player-controls--immersive .controls-row {
  order: 1;
}

.player-controls--immersive .controls-secondary {
  order: 2;
  justify-content: flex-end;
}

.player-controls--immersive :deep(.seekbar) {
  order: 3;
}

/* 控制条隐藏时的微进度条 */
.mini-progress {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background-color: rgba(255, 255, 255, 0.16);
  pointer-events: none;
  z-index: 4;
}

.mini-progress__buffered {
  position: absolute;
  inset: 0 auto 0 0;
  height: 100%;
  background-color: rgba(255, 255, 255, 0.32);
  transition: width 300ms linear;
}

.mini-progress__played {
  position: absolute;
  inset: 0 auto 0 0;
  height: 100%;
  background-color: var(--color-brand);
  transition: width 300ms linear;
}
</style>
