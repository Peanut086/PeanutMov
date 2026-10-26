<script setup lang="ts">
/**
 * 播放控制条（设计规范 8.11）
 *
 * 顶部：返回 + 标题（片名 · 第 N 集）+ 右侧投屏/字幕。
 * 底部：进度条 + 时间 + 播放/暂停（56）/上下集 + 倍速/字幕/清晰度/全屏/下载。
 * 显隐由父级 `visible` 控制，300ms opacity 过渡（不位移，避免画面抖动）。
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
  }>(),
  { downloading: false, castDisabled: false, immersive: false },
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
  (e: 'toggle-fullscreen'): void;
  (e: 'download'): void;
  (e: 'cast'): void;
}>();

const rateLabel = computed(() => `${props.rate}x`);
const playLabel = computed(() => (props.playing ? '暂停' : '播放'));
</script>

<template>
  <div
    class="player-controls"
    :class="{
      'player-controls--hidden': !visible,
      'player-controls--immersive': immersive,
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
          @click="emit('toggle-play')"
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
        </div>
      </div>

      <div class="controls-secondary">
        <button class="controls-secondary__btn" type="button" aria-label="倍速" @click="emit('open-speed')">
          <IconSpeed :size="18" />
          <span class="controls-secondary__text">{{ rateLabel }}</span>
        </button>

        <button class="controls-secondary__btn" type="button" aria-label="清晰度" @click="emit('open-quality')">
          <span class="controls-secondary__text">{{ qualityLabel }}</span>
          <IconChevron :size="14" direction="down" />
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
          class="controls-secondary__btn"
          type="button"
          :aria-label="fullscreen ? '退出全屏' : '全屏'"
          @click="emit('toggle-fullscreen')"
        >
          <IconFullscreen :size="18" :exit="fullscreen" />
        </button>
      </div>
    </footer>
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
}

.player-controls--hidden {
  opacity: 0;
  pointer-events: none;
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

.player-controls--immersive .controls-secondary {
  justify-content: flex-end;
}
</style>
