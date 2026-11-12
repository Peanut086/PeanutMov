<script setup lang="ts">
/**
 * 直播播放器（CHG-13，v1 精简面）
 *
 * HLS 优先原生 ExoPlayer（IPTV 源站不发 CORS 头，hls.js 在 WebView 里拉不到清单），
 * 原生不可用/解不了再静默回退 HlsEngine / VideoEngine；
 * 不走 PlayerController 的媒体-剧集模型：直播无进度、无历史、无字幕。
 * 频道切换 = 销毁旧引擎 + 加载新 URL（直播切台即释放，技术方案口径）。
 */
import { onBeforeUnmount, ref, watch } from 'vue';

import { FullscreenController } from '@/player/FullscreenController';
import { HlsEngine } from '@/player/HlsEngine';
import { NativeEngine, type NativeEngineEvents } from '@/player/NativeEngine';
import { OrientationController } from '@/player/OrientationController';
import { applyNativeUnderlay } from '@/player/nativeUnderlay';
import { VideoEngine, type VideoEngineEvents } from '@/player/VideoEngine';
import { normalizeFormat } from '@/sources/base/normalize';
import { guessFormatFromUrl } from '@/shared/url';
import { deviceService } from '@/services/deviceService';
import { isExoPlayerAvailable } from '@/native/exoPlayerPlugin';
import { setPlayerImmersive } from '@/native/playerUi';
import type { PlaybackSource } from '@/types';
import { IPTV_USER_AGENT, TIMEOUT_LIVE_CHANNEL_MS } from '@/shared/constants';
import { logger } from '@/shared/logger';
import ChannelLogo from '@/components/live/ChannelLogo.vue';

const props = defineProps<{
  url: string | null;
  title: string;
  /** C1：频道台标（缺失时由 ChannelLogo 退成频道号牌） */
  logo?: string | null;
  /** OPT-12: 外部控制的加载态（频道切换时淡出/淡入） */
  loading?: boolean;
}>();

const emit = defineEmits<{
  /** v1.7/CHG-21：起播超时或加载失败，请求外层切换同组下一路 */
  (e: 'timeout', url: string): void;
  /** OPT-12：流已可播放（频道切换淡入完成） */
  (e: 'canplay'): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const state = ref<'idle' | 'loading' | 'playing' | 'paused' | 'error'>('idle');
const errorMessage = ref<string | null>(null);
const fullscreen = ref(false);
/** 原生引擎生效中：舞台必须透明，否则盖住叠在 WebView 之下的原生画面 */
const nativeActive = ref(false);

type LiveEngine = HlsEngine | VideoEngine | NativeEngine;
let engine: LiveEngine | null = null;
/** 加载代次：切台/卸载后作废仍在飞的旧加载（原生能力探测是异步的） */
let loadSeq = 0;
/** 起播超时定时器（CHG-21：超时没出画面通知外层切路） */
let channelTimer: ReturnType<typeof setTimeout> | null = null;
const fullscreenController = new FullscreenController({
  onChange: (fs) => {
    fullscreen.value = fs;
  },
  onEnter: () => {
    void deviceService.setStatusBarVisible(false);
    // 横屏 edge-to-edge：刘海安全边不再内缩内容，避免左侧露出白色竖条
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

function engineEvents(): VideoEngineEvents {
  return {
    onLoadedMetadata: () => {
      if (state.value !== 'error') state.value = 'playing';
    },
    onTimeUpdate: () => undefined,
    onPlay: () => {
      state.value = 'playing';
    },
    onPause: () => {
      if (state.value !== 'error') state.value = 'paused';
    },
    onWaiting: () => {
      if (state.value !== 'error') state.value = 'loading';
    },
    onPlaying: () => {
      state.value = 'playing';
      emit('canplay');
    },
    onEnded: () => {
      /* 直播流不会 ended；RTP 断流由 error 分支处理 */
    },
    onError: (error) => {
      state.value = 'error';
      errorMessage.value = error.message;
      if (channelTimer !== null) { clearTimeout(channelTimer); channelTimer = null; }
      emit('timeout', props.url ?? '');
    },
  };
}

// 与点播 AC-53 同口径：连接中/播放中保屏，暂停、失败、未选台交还系统超时
watch(state, (s) => {
  void deviceService.keepAwake(s === 'loading' || s === 'playing');
});

/**
 * 原生引擎事件 → 直播状态机。
 * NativeEngine 不发 onPlay/onPause/onPlaying，暂停态由 togglePlay 自己维护。
 */
function nativeEvents(): NativeEngineEvents {
  const { onWaiting, onEnded, onError } = engineEvents();
  return {
    onLoadedMetadata: () => {
      if (state.value !== 'error') state.value = 'playing';
      // 原生没有 playing 事件，淡入信号在这里发，否则切台后停在半透明
      emit('canplay');
    },
    onTimeUpdate: () => undefined,
    onWaiting,
    onEnded,
    onError,
  };
}

function createEngine(format: PlaybackSource['format'], useNative: boolean): LiveEngine {
  if (useNative) return new NativeEngine(nativeEvents());
  return format === 'hls'
    ? new HlsEngine({ ...engineEvents(), onQualityChange: () => undefined })
    : new VideoEngine(engineEvents());
}

function destroyEngine(): void {
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
  next: LiveEngine,
  source: PlaybackSource,
  container: HTMLElement,
  seq: number,
  useNative: boolean,
): Promise<string | null> {
  nativeActive.value = useNative;
  engine = next;
  next.attach(container);
  try {
    await next.load(source);
    if (seq !== loadSeq || engine !== next) return '已切换';
    await next.play();
    if (seq !== loadSeq || engine !== next) return '已切换';
    if (channelTimer !== null) {
      clearTimeout(channelTimer);
      channelTimer = null;
    }
    return null;
  } catch (e) {
    if (seq !== loadSeq || engine !== next) return '已切换';
    logger.warn(useNative ? '直播原生引擎加载失败' : '直播频道加载失败', source.url, e);
    next.destroy();
    engine = null;
    return e instanceof Error ? e.message : '频道加载失败';
  }
}

async function loadChannel(url: string): Promise<void> {
  const seq = ++loadSeq;
  destroyEngine();
  errorMessage.value = null;
  state.value = 'loading';
  const container = containerRef.value;
  if (!container) return;
  fullscreenController.setElement(container);

  if (url.startsWith('rtmp://')) {
    state.value = 'error';
    errorMessage.value = '当前环境不支持 RTMP 协议';
    emit('timeout', url);
    return;
  }

  // v1.7/CHG-21：起播超时 → 通知外层切同组下一路（FR-55）
  if (channelTimer !== null) clearTimeout(channelTimer);
  channelTimer = setTimeout(() => {
    channelTimer = null;
    if (state.value === 'playing') return;
    emit('timeout', url);
  }, TIMEOUT_LIVE_CHANNEL_MS);

  // FIX-L3: 直播场景下 URL 无法识别格式时默认按 HLS 尝试（IPTV 主流协议）
  const detected = guessFormatFromUrl(url);
  const format = detected ?? (normalizeFormat(url, 'mp4') === 'mp4' ? 'hls' : normalizeFormat(url, 'mp4'));
  const source: PlaybackSource = {
    url,
    format,
    headers: { 'User-Agent': IPTV_USER_AGENT },
    subtitles: [],
    lineId: 'live',
    quality: null,
    expiresAt: null,
    isLocal: false,
    isLive: true,
  };

  /*
   * IPTV 源站普遍不发 CORS 头，hls.js 的 XHR 在 WebView 里必被拦（清单都拉不到）；
   * 原生 ExoPlayer 走 OkHttp，没有跨域限制，还能带 UA。故 HLS 一律优先原生。
   */
  const useNative = format === 'hls' && (await isExoPlayerAvailable());
  if (seq !== loadSeq) return;

  let failure = await tryEngine(createEngine(format, useNative), source, container, seq, useNative);
  if (failure === null || seq !== loadSeq) return;
  if (useNative) {
    // 原生失败（插件异常/该流原生解不了）静默回退 WebView 再试一次，不计频道失效
    failure = await tryEngine(createEngine(format, false), source, container, seq, false);
    if (failure === null || seq !== loadSeq) return;
  }

  state.value = 'error';
  errorMessage.value = failure;
  if (channelTimer !== null) { clearTimeout(channelTimer); channelTimer = null; }
  emit('timeout', url);
}

watch(
  () => props.url,
  (url) => {
    if (!url) {
      loadSeq++;
      destroyEngine();
      state.value = 'idle';
      errorMessage.value = null;
      return;
    }
    void loadChannel(url);
  },
);

function togglePlay(): void {
  if (!engine) return;
  // 原生引擎不上报 play/pause 事件，状态在这里直接落（WebView 引擎重复落同值无副作用）
  if (state.value === 'playing') {
    engine.pause();
    state.value = 'paused';
  } else {
    void engine.play();
    state.value = 'playing';
  }
}

async function toggleFullscreen(): Promise<void> {
  await fullscreenController.toggle();
}

onBeforeUnmount(() => {
  if (channelTimer !== null) clearTimeout(channelTimer);
  channelTimer = null;
  loadSeq++;
  destroyEngine();
  releaseUnderlay?.();
  releaseUnderlay = null;
  // 卸载时 state 仍可能是 playing（watcher 不会再跑），显式释放避免常亮泄漏到其它页面
  void deviceService.keepAwake(false);
  fullscreenController.destroy();
  void orientationController.lock('portrait');
});
</script>

<template>
  <section
    class="live-player"
    :class="{ 'live-player--fullscreen': fullscreen, 'live-player--native': nativeActive }"
  >
    <div class="live-player-wrapper" :class="{ 'live-player-wrapper--loading': loading }">
      <div ref="containerRef" class="live-player__stage" />

      <div v-if="state === 'idle'" class="live-player__placeholder">
        <p>选择一个频道开始观看</p>
      </div>
      <div v-else-if="state === 'loading'" class="live-player__placeholder" role="status">
        <span class="live-player__spinner" aria-hidden="true" />
        <p>正在连接 {{ title }}…</p>
      </div>
      <div v-else-if="state === 'error'" class="live-player__placeholder">
        <p>「{{ title }}」播放失败</p>
        <p class="live-player__error-detail">{{ errorMessage ?? '频道可能已失效，换一个试试' }}</p>
      </div>

      <button
        v-if="state === 'playing' || state === 'paused'"
        class="live-player__tap"
        type="button"
        :aria-label="state === 'playing' ? '暂停' : '播放'"
        @click="togglePlay"
      />

      <div class="live-player__bar">
        <ChannelLogo v-if="title" :src="logo ?? null" :name="title" :size="22" />
        <span class="live-player__title truncate-1">{{ title || '直播' }}</span>
        <button
          class="live-player__btn"
          type="button"
          :aria-label="state === 'playing' ? '暂停' : '播放'"
          @click="togglePlay"
        >
          {{ state === 'playing' ? '⏸' : '▶' }}
        </button>
        <button
          class="live-player__btn"
          type="button"
          aria-label="全屏"
          @click="toggleFullscreen"
        >
          {{ fullscreen ? '⤡' : '⤢' }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.live-player {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background-color: #000;
  overflow: hidden;
}

.live-player--fullscreen {
  position: fixed;
  inset: 0;
  z-index: var(--z-dialog);
  aspect-ratio: auto;
}

/* 原生引擎的画面叠在 WebView 之下：舞台不透明就只剩黑屏有声（同点播 --native 口径） */
.live-player--native {
  background-color: transparent;
}

.live-player__stage {
  position: absolute;
  inset: 0;
}

.live-player__stage :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.live-player__placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  color: rgba(255, 255, 255, 0.72);
  font: var(--text-caption);
  text-align: center;
  padding: 0 var(--space-4);
  pointer-events: none;
}

.live-player__error-detail {
  color: rgba(255, 255, 255, 0.48);
}

.live-player__spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.24);
  border-top-color: var(--color-brand);
  animation: live-spin 800ms linear infinite;
}

@keyframes live-spin {
  to {
    transform: rotate(360deg);
  }
}

.live-player__tap {
  position: absolute;
  inset: 0 0 40px 0;
  background: transparent;
}

.live-player__bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 40px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0 var(--space-2);
  background: linear-gradient(to top, rgba(0, 0, 0, 0.72), transparent);
}

.live-player__title {
  flex: 1 1 auto;
  min-width: 0;
  color: #fff;
  font: var(--text-caption);
}

.live-player__btn {
  width: 40px;
  height: 36px;
  color: #fff;
  font-size: 16px;
}

/* OPT-12: 频道切换淡出/淡入 */
.live-player-wrapper {
  position: absolute;
  inset: 0;
  opacity: 1;
  transition: opacity 0.2s var(--ease-standard);
}

.live-player-wrapper--loading {
  opacity: 0.3;
}
</style>
