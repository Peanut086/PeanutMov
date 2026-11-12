<script setup lang="ts">
/**
 * EXT-06/FR-68：回看播放器
 *
 * - HLS 优先原生 ExoPlayer（回看源同样不发 CORS 头），失败回退 HlsEngine / VideoEngine；
 *   复用 Fullscreen / Orientation 控制器
 * - 直播播放器（LivePlayer）不支持进度；回看是"点播"语义，故独立组件，
 *   不接 PlayerController（无剧集/历史/字幕/弹幕）
 * - 状态：idle / loading / playing / paused / ended / error
 * - 事件：`retry`（重新加载）/ `back`（返回节目单）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { FullscreenController } from '@/player/FullscreenController';
import { HlsEngine } from '@/player/HlsEngine';
import { NativeEngine, type NativeEngineEvents } from '@/player/NativeEngine';
import { OrientationController } from '@/player/OrientationController';
import { applyNativeUnderlay } from '@/player/nativeUnderlay';
import { VideoEngine, type VideoEngineEvents } from '@/player/VideoEngine';
import { normalizeFormat } from '@/sources/base/normalize';
import SeekBar from '@/components/player/SeekBar.vue';
import { deviceService } from '@/services/deviceService';
import { isExoPlayerAvailable } from '@/native/exoPlayerPlugin';
import { setPlayerImmersive } from '@/native/playerUi';
import type { PlaybackSource } from '@/types';
import { formatClock } from '@/shared/time';
import { logger } from '@/shared/logger';
import { IPTV_USER_AGENT, TIMEOUT_REPLAY_START_MS } from '@/shared/constants';
import { guessFormatFromUrl } from '@/shared/url';

const props = defineProps<{
  /** 已渲染好的回看地址（含时间占位符），为空则展示 idle */
  url: string | null;
  channelName: string;
  programmeTitle: string;
  /** 节目时间文案，如 `11月06日 20:00 – 21:00` */
  timeLabel: string;
  /** 节目起点时刻（ms），用于把页面进度换算成绝对时间显示 */
  startAt: number;
}>();

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'back'): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const state = ref<'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'>('idle');
const errorMessage = ref<string | null>(null);
const currentTime = ref(0);
const duration = ref(0);
const buffered = ref(0);
const fullscreen = ref(false);
const durationUnknown = ref(false);
/** 原生引擎生效中：舞台必须透明，否则盖住叠在 WebView 之下的原生画面 */
const nativeActive = ref(false);

type ReplayEngine = HlsEngine | VideoEngine | NativeEngine;
let engine: ReplayEngine | null = null;
/** 加载代次：换节目/卸载后作废仍在飞的旧加载（原生能力探测是异步的） */
let loadSeq = 0;
/** FR-68：回看起播看门狗（与直播同口径） */
let startTimer: ReturnType<typeof setTimeout> | null = null;

function clearStartTimer(): void {
  if (startTimer !== null) {
    clearTimeout(startTimer);
    startTimer = null;
  }
}

/** 起播超时：未进入 playing/paused 即报错并给出"重试/返回节目单"（模板已有两个动作） */
function armStartTimer(next: ReplayEngine): void {
  clearStartTimer();
  startTimer = setTimeout(() => {
    startTimer = null;
    // 期间已重载/卸载：本次计时作废
    if (engine !== next) return;
    if (state.value === 'playing' || state.value === 'paused' || state.value === 'ended') return;
    logger.warn('回看起播超时', { channel: props.channelName, template: props.programmeTitle });
    state.value = 'error';
    errorMessage.value = '起播超时，请检查网络或源是否支持回看';
  }, TIMEOUT_REPLAY_START_MS);
}

const fullscreenController = new FullscreenController({
  onChange: (fs) => {
    fullscreen.value = fs;
  },
  onEnter: () => {
    void deviceService.setStatusBarVisible(false);
    void setPlayerImmersive(true);
    void orientationController.lock('landscape');
  },
  onExit: () => {
    void setPlayerImmersive(false);
    void deviceService.setStatusBarVisible(true);
    void orientationController.lock('portrait');
  },
});
const orientationController = new OrientationController();

/** 绝对时间（节目起点 + 已播秒数），拖动时给用户"这是几点"的参照 */
const absoluteTime = computed(() => {
  if (!Number.isFinite(props.startAt) || props.startAt <= 0) return '';
  const date = new Date(props.startAt + currentTime.value * 1000);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
});

const canControl = computed(() => state.value === 'playing' || state.value === 'paused' || state.value === 'ended');

function engineEvents(): VideoEngineEvents {
  return {
    onLoadedMetadata: (len) => {
      duration.value = Number.isFinite(len) && len > 0 ? len : 0;
      durationUnknown.value = duration.value === 0;
      if (state.value !== 'error') state.value = 'playing';
    },
    onTimeUpdate: (time, total, buf) => {
      currentTime.value = Number.isFinite(time) ? time : 0;
      if (Number.isFinite(total) && total > 0) duration.value = total;
      buffered.value = Number.isFinite(buf) ? buf : 0;
    },
    onPlay: () => {
      if (state.value !== 'error') state.value = 'playing';
    },
    onPause: () => {
      if (state.value !== 'error' && state.value !== 'ended') state.value = 'paused';
    },
    onWaiting: () => {
      if (state.value !== 'error' && state.value !== 'ended') state.value = 'loading';
    },
    onPlaying: () => {
      if (state.value !== 'error') state.value = 'playing';
    },
    onEnded: () => {
      state.value = 'ended';
    },
    onError: (error) => {
      state.value = 'error';
      errorMessage.value = error.message;
    },
  };
}

/** 原生引擎事件 → 回看状态机（原生不上报 play/pause，暂停态由 togglePlay 维护） */
function nativeEvents(): NativeEngineEvents {
  const { onLoadedMetadata, onTimeUpdate, onWaiting, onEnded, onError } = engineEvents();
  return {
    // 原生只给时长；宽高占位 0（回看面板不用画面尺寸）
    onLoadedMetadata: (len) => onLoadedMetadata(len, 0, 0),
    onTimeUpdate,
    onWaiting,
    onEnded,
    onError,
  };
}

function createEngine(format: PlaybackSource['format'], useNative: boolean): ReplayEngine {
  if (useNative) return new NativeEngine(nativeEvents());
  return format === 'hls'
    ? new HlsEngine({ ...engineEvents(), onQualityChange: () => undefined })
    : new VideoEngine(engineEvents());
}

function destroyEngine(): void {
  clearStartTimer();
  engine?.destroy();
  engine = null;
  nativeActive.value = false;
}

/* 原生画面在 WebView 之下：页面底色要挖洞让画，切回 WebView 引擎/卸载时还原 */
let releaseUnderlay: (() => void) | null = null;
watch(
  [nativeActive, fullscreen],
  ([native, full]) => {
    releaseUnderlay?.();
    releaseUnderlay = null;
    const stage = containerRef.value;
    if (native && stage) releaseUnderlay = applyNativeUnderlay(stage, full);
  },
  { flush: 'post' },
);

/** 起播一次：成功返回 null，失败返回可读原因（失败即销毁引擎，不留孤儿出声） */
async function tryEngine(
  next: ReplayEngine,
  source: PlaybackSource,
  container: HTMLElement,
  seq: number,
  useNative: boolean,
): Promise<string | null> {
  nativeActive.value = useNative;
  engine = next;
  next.attach(container);
  armStartTimer(next);
  try {
    await next.load(source);
    if (seq !== loadSeq || engine !== next) return '已切换';
    await next.play();
    if (seq !== loadSeq || engine !== next) return '已切换';
    return null;
  } catch (e) {
    if (seq !== loadSeq || engine !== next) return '已切换';
    logger.warn(
      useNative ? '回看原生引擎加载失败' : '回看加载失败',
      { host: safeHost(source.url), channel: props.channelName, template: props.programmeTitle },
      e,
    );
    next.destroy();
    engine = null;
    return e instanceof Error ? e.message : '回看加载失败';
  }
}

/** 日志只保留 host（需求「安全与隐私」：不记录完整回看 URL） */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid>';
  }
}

async function load(url: string): Promise<void> {
  const seq = ++loadSeq;
  destroyEngine();
  errorMessage.value = null;
  currentTime.value = 0;
  duration.value = 0;
  buffered.value = 0;
  durationUnknown.value = false;
  const container = containerRef.value;
  if (!container) return;
  state.value = 'loading';
  fullscreenController.setElement(container);

  // 回看地址多由 catchup 模板渲染而来（?playseek= 等），认不出格式时按 HLS 试
  const normalized = normalizeFormat(url, 'mp4');
  const format = guessFormatFromUrl(url) ?? (normalized === 'mp4' ? 'hls' : normalized);
  const source: PlaybackSource = {
    url,
    format,
    headers: { 'User-Agent': IPTV_USER_AGENT },
    subtitles: [],
    lineId: 'replay',
    quality: null,
    expiresAt: null,
    isLocal: false,
    isLive: false,
  };

  // 与直播同因：IPTV 源站不发 CORS 头，hls.js 拉不到清单，故 HLS 优先原生
  const useNative = format === 'hls' && (await isExoPlayerAvailable());
  if (seq !== loadSeq) return;

  let failure = await tryEngine(createEngine(format, useNative), source, container, seq, useNative);
  if (failure === null || seq !== loadSeq) return;
  if (useNative) {
    failure = await tryEngine(createEngine(format, false), source, container, seq, false);
    if (failure === null || seq !== loadSeq) return;
  }

  state.value = 'error';
  errorMessage.value = failure;
}

/**
 * REV-01：首次挂载时 `props.url` 往往已就绪，而 `watch` 默认不带 `immediate`
 * 不会触发 → 状态停在 idle（黑屏且无错误）。挂载后主动加载一次；
 * 之后的 url 变化（重试 / 换节目）继续由 watch 处理。
 */
watch(
  () => props.url,
  (url) => {
    if (!url) {
      loadSeq++;
      destroyEngine();
      state.value = 'idle';
      return;
    }
    void load(url);
  },
);

/** 一旦离开 loading（playing/paused/ended/error）即撤掉看门狗 */
watch(state, (value) => {
  if (value !== 'loading') clearStartTimer();
  // 与点播 AC-53 同口径：连接中/播放中保屏，暂停、播完、失败交还系统超时
  void deviceService.keepAwake(value === 'loading' || value === 'playing');
});

onMounted(() => {
  if (props.url) void load(props.url);
});

function togglePlay(): void {
  if (!engine) return;
  // 原生引擎不上报 play/pause，状态得自己维护（WebView 引擎重复置同值无副作用）
  if (state.value === 'playing') {
    engine.pause();
    state.value = 'paused';
  } else {
    void engine.play();
    state.value = 'playing';
  }
}

function onSeek(sec: number): void {
  if (!engine) return;
  engine.seek(sec);
  currentTime.value = sec;
  if (state.value === 'ended') {
    void engine.play();
    state.value = 'playing';
  }
}

async function toggleFullscreen(): Promise<void> {
  await fullscreenController.toggle();
}

onBeforeUnmount(() => {
  loadSeq++;
  destroyEngine();
  releaseUnderlay?.();
  releaseUnderlay = null;
  // 卸载时 state 可能仍是 playing（watcher 不会再跑），显式释放避免常亮泄漏到其它页面
  void deviceService.keepAwake(false);
  fullscreenController.destroy();
  void orientationController.lock('portrait');
});
</script>

<template>
  <section
    class="replay-player"
    :class="{ 'replay-player--fullscreen': fullscreen, 'replay-player--native': nativeActive }"
  >
    <div ref="containerRef" class="replay-player__stage" />

    <div v-if="state === 'idle'" class="replay-player__overlay">
      <p>回看地址尚未就绪</p>
    </div>
    <div v-else-if="state === 'loading'" class="replay-player__overlay" role="status">
      <span class="replay-player__spinner" aria-hidden="true" />
      <p>正在连接回看流…</p>
    </div>
    <div v-else-if="state === 'error'" class="replay-player__overlay">
      <p class="replay-player__overlay-title">回看播放失败</p>
      <p class="replay-player__overlay-detail">{{ errorMessage ?? '该源可能不支持回看' }}</p>
      <div class="replay-player__overlay-actions">
        <button class="btn btn--secondary btn--sm" type="button" @click="emit('retry')">重试</button>
        <button class="btn btn--ghost btn--sm" type="button" @click="emit('back')">返回节目单</button>
      </div>
    </div>
    <div v-else-if="state === 'ended'" class="replay-player__overlay replay-player__overlay--soft">
      <p>节目已播放完毕</p>
    </div>

    <button
      v-if="canControl"
      class="replay-player__tap"
      type="button"
      :aria-label="state === 'playing' ? '暂停' : '播放'"
      @click="togglePlay"
    />

    <div class="replay-player__controls">
      <div class="replay-player__meta">
        <span class="replay-player__channel truncate-1">{{ channelName }}</span>
        <span v-if="programmeTitle" class="replay-player__title truncate-1">{{ programmeTitle }}</span>
        <span v-if="timeLabel" class="replay-player__time">{{ timeLabel }}</span>
      </div>

      <SeekBar
        v-if="canControl"
        :current-time="currentTime"
        :duration="duration"
        :buffered="buffered"
        :disabled="duration <= 0"
        @seek="onSeek"
      />

      <div class="replay-player__row">
        <button
          class="replay-player__btn"
          type="button"
          :disabled="!canControl"
          :aria-label="state === 'playing' ? '暂停' : '播放'"
          @click="togglePlay"
        >
          {{ state === 'playing' ? '暂停' : '播放' }}
        </button>
        <span class="replay-player__clock">
          {{ formatClock(currentTime) }}<template v-if="absoluteTime"> · {{ absoluteTime }}</template>
          <template v-if="durationUnknown"> · 时长未知</template>
        </span>
        <button class="replay-player__btn" type="button" aria-label="全屏" @click="toggleFullscreen">
          {{ fullscreen ? '退出全屏' : '全屏' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.replay-player {
  position: relative;
  width: 100%;
  /* REV-35：播放画布底色统一走 token（与 player.css 的 --color-bg-sunken 同义） */
  background-color: var(--color-bg-sunken);
  overflow: hidden;
}

.replay-player--fullscreen {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  aspect-ratio: auto;
}

/* 原生画面叠在 WebView 之下，舞台底色必须透明才看得见 */
.replay-player--native {
  background-color: transparent;
}

.replay-player__stage {
  width: 100%;
  aspect-ratio: 16 / 9;
}

.replay-player--fullscreen .replay-player__stage {
  height: 100%;
  aspect-ratio: auto;
}

.replay-player__stage :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.replay-player__overlay {
  position: absolute;
  inset: 0 0 auto 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 0 var(--space-4);
  color: rgba(255, 255, 255, 0.8);
  font: var(--text-caption);
  text-align: center;
  background-color: rgba(0, 0, 0, 0.45);
}

.replay-player__overlay--soft {
  background-color: rgba(0, 0, 0, 0.6);
}

.replay-player__overlay-title {
  font: var(--text-label-strong);
}

.replay-player__overlay-detail {
  color: rgba(255, 255, 255, 0.56);
}

.replay-player__overlay-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.replay-player__spinner {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.24);
  border-top-color: var(--color-brand);
  animation: replay-spin 800ms linear infinite;
}

@keyframes replay-spin {
  to {
    transform: rotate(360deg);
  }
}

.replay-player__tap {
  position: absolute;
  inset: 0;
  background: transparent;
}

.replay-player__controls {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3) var(--space-3);
  background-color: var(--color-bg-base);
}

.replay-player--fullscreen .replay-player__controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.86), transparent);
}

.replay-player__meta {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  min-width: 0;
}

.replay-player__channel {
  flex: 0 0 auto;
  max-width: 40%;
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.replay-player--fullscreen .replay-player__channel,
.replay-player--fullscreen .replay-player__title,
.replay-player--fullscreen .replay-player__time,
.replay-player--fullscreen .replay-player__clock {
  /* REV-35：全屏控制条文字改走 token */
  color: var(--color-text-primary);
}

.replay-player__title {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.replay-player__time {
  flex: 0 0 auto;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-number);
}

.replay-player__row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.replay-player__btn {
  flex: 0 0 auto;
  min-height: 36px;
  min-width: 64px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
  color: var(--color-text-primary);
  font: var(--text-caption);
}

.replay-player--fullscreen .replay-player__btn {
  background-color: rgba(255, 255, 255, 0.14);
  border-color: transparent;
  /* REV-35：全屏按钮文字改走 token */
  color: var(--color-text-primary);
}

.replay-player__btn:disabled {
  color: var(--color-text-disabled);
}

.replay-player__clock {
  flex: 1 1 auto;
  min-width: 0;
  text-align: center;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  font-family: var(--font-family-number);
}
</style>
