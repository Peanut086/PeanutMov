/**
 * 播放器瞬时状态 Store（PKG-A 自有）
 *
 * 高频更新（timeupdate 4~10Hz）只写内存，不落库；进度落库由
 * `ProgressReporter` → `PlayerController` 的 onProgress 回调完成。
 * 契约见技术方案 API-14 的 `playerStore`。
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type { AppErrorShape, PlaybackRate, SubtitleTrack } from '@/types';
import { DEFAULT_PLAYBACK_RATE } from '@/shared/constants';

export const usePlayerStore = defineStore('player', () => {
  const mediaId = ref<string | null>(null);
  const episodeId = ref<string | null>(null);
  const lineId = ref<string | null>(null);

  const playing = ref(false);
  const waiting = ref(false);
  const currentTime = ref(0);
  const duration = ref(0);
  const buffered = ref(0);
  const rate = ref<PlaybackRate>(DEFAULT_PLAYBACK_RATE);
  const volume = ref(100);
  /** 亮度遮罩不透明度 0~DIM_MAX_OPACITY（不是亮度 0~100，换算见 player/brightness） */
  const dim = ref(0);
  const fullscreen = ref(false);
  const controlsVisible = ref(true);

  const subtitles = ref<SubtitleTrack[]>([]);
  const activeSubtitleId = ref<string | null>(null);
  const subtitleText = ref<string>('');
  /** 加载失败的字幕轨 id（AC-46：面板标记「不可用」） */
  const failedSubtitleIds = ref<string[]>([]);

  const quality = ref('auto');
  const qualities = ref<string[]>([]);
  const error = ref<AppErrorShape | null>(null);
  const loading = ref(false);
  /** v1.8/CHG-25：当前引擎类型（native/hls/video）；null = 尚未加载 */
  const engineKind = ref<'native' | 'hls' | 'video' | null>(null);

  const progress = computed(() => (duration.value > 0 ? currentTime.value / duration.value : 0));

  function reset(): void {
    mediaId.value = null;
    episodeId.value = null;
    lineId.value = null;
    playing.value = false;
    waiting.value = false;
    currentTime.value = 0;
    duration.value = 0;
    buffered.value = 0;
    rate.value = DEFAULT_PLAYBACK_RATE;
    volume.value = 100;
    dim.value = 0;
    fullscreen.value = false;
    controlsVisible.value = true;
    subtitles.value = [];
    activeSubtitleId.value = null;
    subtitleText.value = '';
    failedSubtitleIds.value = [];
    quality.value = 'auto';
    qualities.value = [];
    error.value = null;
    loading.value = false;
    engineKind.value = null;
  }

  /** 批量补丁：只更新传入的字段（避免整对象替换导致响应式抖动） */
  function patch(p: Partial<{
    mediaId: string | null;
    episodeId: string | null;
    lineId: string | null;
    playing: boolean;
    waiting: boolean;
    currentTime: number;
    duration: number;
    buffered: number;
    rate: PlaybackRate;
    volume: number;
    dim: number;
    fullscreen: boolean;
    controlsVisible: boolean;
    subtitles: SubtitleTrack[];
    activeSubtitleId: string | null;
    subtitleText: string;
    failedSubtitleIds: string[];
    quality: string;
    qualities: string[];
    error: AppErrorShape | null;
    loading: boolean;
    engineKind: 'native' | 'hls' | 'video' | null;
  }>): void {
    if (p.mediaId !== undefined) mediaId.value = p.mediaId;
    if (p.episodeId !== undefined) episodeId.value = p.episodeId;
    if (p.lineId !== undefined) lineId.value = p.lineId;
    if (p.playing !== undefined) playing.value = p.playing;
    if (p.waiting !== undefined) waiting.value = p.waiting;
    if (p.currentTime !== undefined) currentTime.value = p.currentTime;
    if (p.duration !== undefined) duration.value = p.duration;
    if (p.buffered !== undefined) buffered.value = p.buffered;
    if (p.rate !== undefined) rate.value = p.rate;
    if (p.volume !== undefined) volume.value = p.volume;
    if (p.dim !== undefined) dim.value = p.dim;
    if (p.fullscreen !== undefined) fullscreen.value = p.fullscreen;
    if (p.controlsVisible !== undefined) controlsVisible.value = p.controlsVisible;
    if (p.subtitles !== undefined) subtitles.value = p.subtitles;
    if (p.activeSubtitleId !== undefined) activeSubtitleId.value = p.activeSubtitleId;
    if (p.subtitleText !== undefined) subtitleText.value = p.subtitleText;
    if (p.failedSubtitleIds !== undefined) failedSubtitleIds.value = p.failedSubtitleIds;
    if (p.quality !== undefined) quality.value = p.quality;
    if (p.qualities !== undefined) qualities.value = p.qualities;
    if (p.error !== undefined) error.value = p.error;
    if (p.loading !== undefined) loading.value = p.loading;
    if (p.engineKind !== undefined) engineKind.value = p.engineKind;
  }

  return {
    mediaId,
    episodeId,
    lineId,
    playing,
    waiting,
    currentTime,
    duration,
    buffered,
    rate,
    volume,
    dim,
    fullscreen,
    controlsVisible,
    subtitles,
    activeSubtitleId,
    subtitleText,
    failedSubtitleIds,
    quality,
    qualities,
    error,
    loading,
    engineKind,
    progress,
    reset,
    patch,
  };
});
