/**
 * 播放器组合式函数（PlayerView 的唯一状态入口）
 *
 * 把 `PlayerController` 的命令式 API 适配成 Vue 响应式状态：
 * - 控制器生命周期（创建/挂载/销毁）
 * - 事件 → playerStore 同步
 * - 手势 intent → 控制器动作 + HUD 状态
 * - 控制条自动隐藏、切集、后台暂停、进度写回
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';

import type { PlaybackRate, SaveProgressInput, SubtitleSettings } from '@/types';
import type { PlayerLoadOptions } from '@/player/types';
import { PlayerController } from '@/player/PlayerController';
import type { GestureIntent } from '@/player/GestureRecognizer';
import { ProgressReporter } from '@/player/ProgressReporter';
import { AUTO_NEXT_COUNTDOWN_SEC, CONTROLS_HIDE_DELAY_MS } from '@/player/constants';
import { toErrorShape } from '@/shared/errors';
import { usePlayerStore } from '@/stores/playerStore';
import { useUiStore } from '@/stores/uiStore';

export interface UsePlayerControllerOptions {
  /** 进度写回（由 View 注入历史 Store） */
  saveProgress: (input: SaveProgressInput) => Promise<unknown>;
  /**
   * 全屏时状态栏显隐（AC-52）：由 View 注入 `deviceService.setStatusBarVisible`。
   * 不传时播放器不做任何状态栏操作（Web/测试环境天然 no-op）。
   */
  setStatusBarVisible?: (visible: boolean) => void | Promise<void>;
  /** 初始字幕设置 */
  subtitle: SubtitleSettings;
  /** 默认倍速 */
  defaultRate: PlaybackRate;
  /** 自动连播 */
  autoPlayNext: boolean;
  /** 获取当前加载参数的上下文（用于写回 title/poster 等） */
  describe: () => {
    sourceId: string;
    mediaId: string;
    episodeId: string | null;
    episodeNumber: number | null;
    title: string;
    posterUrl: string | null;
    totalEpisodes: number | null;
  } | null;
}

export interface HudState {
  kind: 'seek' | 'volume' | 'brightness' | 'rate' | null;
  value: number;
  deltaSec: number;
}

export function usePlayerController(options: UsePlayerControllerOptions) {
  const player = usePlayerStore();
  const ui = useUiStore();

  const controller = shallowRef<PlayerController | null>(null);
  const hud = ref<HudState>({ kind: null, value: 0, deltaSec: 0 });
  const controlsVisible = ref(true);
  const countdown = ref<number | null>(null);
  const backgroundPaused = ref(false);
  const localSubtitles = ref(options.subtitle);
  const resolvedQuality = ref<'auto' | string>('auto');

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let hudTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let restoreRate: PlaybackRate | null = null;

  /** 记录最近一次 HUD 内容，便于合并高频事件 */
  function showHud(next: Omit<HudState, 'kind'> & { kind: HudState['kind'] }, autoHideMs = 800): void {
    hud.value = next;
    if (hudTimer !== null) clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      hud.value = { kind: null, value: 0, deltaSec: 0 };
      hudTimer = null;
    }, autoHideMs);
  }

  function clearHud(): void {
    if (hudTimer !== null) clearTimeout(hudTimer);
    hudTimer = null;
    hud.value = { kind: null, value: 0, deltaSec: 0 };
  }

  /* ---------- 控制条显隐 ---------- */

  function scheduleHide(): void {
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hideTimer = null;
      // 暂停/结束/错误时不自动隐藏，保证用户能找到按钮
      if (player.playing) setControlsVisible(false);
    }, CONTROLS_HIDE_DELAY_MS);
  }

  function setControlsVisible(visible: boolean): void {
    controlsVisible.value = visible;
    player.patch({ controlsVisible: visible });
    if (visible) scheduleHide();
    else if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function toggleControls(): void {
    setControlsVisible(!controlsVisible.value);
  }

  function nudgeControls(): void {
    if (!controlsVisible.value) setControlsVisible(true);
    else scheduleHide();
  }

  /* ---------- 事件绑定 ---------- */

  function bindController(c: PlayerController): void {
    c.on('ready', ({ duration }) => {
      player.patch({ duration, loading: false });
    });

    c.on('timeupdate', ({ currentTime, duration, buffered }) => {
      player.patch({ currentTime, duration, buffered });
    });

    c.on('statechange', ({ playing, waiting }) => {
      player.patch({ playing, waiting });
      if (playing) scheduleHide();
      else setControlsVisible(true);
    });

    c.on('ratechange', ({ rate }) => {
      player.patch({ rate });
    });

    c.on('ended', () => {
      player.patch({ playing: false });
      setControlsVisible(true);
      scheduleAutoNext();
    });

    c.on('error', (error) => {
      player.patch({ error, loading: false, playing: false });
      setControlsVisible(true);
    });

    c.on('subtitlechange', ({ activeId, tracks, text, failedIds }) => {
      player.patch({
        activeSubtitleId: activeId,
        subtitles: tracks,
        subtitleText: text,
        failedSubtitleIds: failedIds,
      });
    });

    c.on('qualitychange', ({ quality, levels }) => {
      resolvedQuality.value = quality;
      player.patch({ quality, qualities: levels });
    });

    c.on('fullscreenchange', ({ fullscreen }) => {
      player.patch({ fullscreen });
      if (fullscreen) {
        setControlsVisible(true);
        scheduleHide();
      }
    });
  }

  /** 创建并挂载控制器 */
  function createController(container: HTMLElement): PlayerController {
    if (controller.value) return controller.value;
    const c = new PlayerController({
      onProgress: async (snapshot) => {
        const desc = options.describe();
        if (!desc) return;
        try {
          await options.saveProgress({
            sourceId: desc.sourceId,
            mediaId: desc.mediaId,
            episodeId: desc.episodeId,
            episodeNumber: desc.episodeNumber,
            title: desc.title,
            posterUrl: desc.posterUrl,
            positionSec: snapshot.positionSec,
            durationSec: snapshot.durationSec,
            totalEpisodes: desc.totalEpisodes,
          });
        } catch (e) {
          // 写库失败只记录，不打断播放（下次采样会重试）
          ui.toast(toErrorShape(e, 'E_DB').message, 'error');
        }
      },
      // AC-52：全屏隐藏状态栏 / 退出恢复（Web 下 Service 自身 no-op）
      setStatusBarVisible: (visible) => options.setStatusBarVisible?.(visible),
    });
    bindController(c);
    c.mount(container);
    controller.value = c;
    c.setRate(options.defaultRate);
    c.setSubtitleOffset(options.subtitle.offsetSec);
    return c;
  }

  /* ---------- 加载 ---------- */

  const currentOptions = shallowRef<PlayerLoadOptions | null>(null);

  async function load(opts: PlayerLoadOptions): Promise<void> {
    const c = controller.value;
    if (!c) return;
    currentOptions.value = opts;
    player.patch({
      mediaId: opts.mediaId,
      episodeId: opts.episodeId,
      lineId: opts.lineId,
      loading: true,
      error: null,
      playing: false,
      currentTime: opts.startPositionSec,
      subtitleText: '',
    });
    if (opts.startPositionSec > 0) {
      ui.toast(`已从 ${formatToastPosition(opts.startPositionSec)} 继续播放`, 'info');
    }
    try {
      await c.load(opts);
      await c.play();
    } catch (e) {
      player.patch({ error: toErrorShape(e), loading: false, playing: false });
    }
  }

  function reload(): void {
    const opts = currentOptions.value;
    if (!opts) return;
    void load(opts);
  }

  /* ---------- 播放控制封装 ---------- */

  async function togglePlay(): Promise<void> {
    const c = controller.value;
    if (!c) return;
    if (player.playing) {
      c.pause();
      setControlsVisible(true);
    } else {
      await c.play();
      scheduleHide();
    }
    nudgeControls();
  }

  async function seek(sec: number): Promise<void> {
    controller.value?.seek(sec);
    nudgeControls();
  }

  function setRate(rate: PlaybackRate): void {
    controller.value?.setRate(rate);
    player.patch({ rate });
    ui.toast(`已切换到 ${rate}x`, 'info', 1500);
  }

  async function nextEpisode(): Promise<void> {
    const c = controller.value;
    if (!c?.canNext()) return;
    try {
      cancelAutoNext();
      await c.nextEpisode();
      player.patch({ playing: true });
      ui.toast('已切到下一集', 'info', 1500);
    } catch (e) {
      ui.toast(toErrorShape(e).message, 'error');
    }
  }

  async function prevEpisode(): Promise<void> {
    const c = controller.value;
    if (!c?.canPrev()) return;
    try {
      cancelAutoNext();
      await c.prevEpisode();
      player.patch({ playing: true });
      ui.toast('已切到上一集', 'info', 1500);
    } catch (e) {
      ui.toast(toErrorShape(e).message, 'error');
    }
  }

  async function switchQuality(quality: string): Promise<void> {
    controller.value?.setQuality(quality);
    resolvedQuality.value = quality;
    ui.toast(quality === 'auto' ? '已切换到自动清晰度' : `已切换到 ${quality}`, 'info', 1500);
  }

  async function selectSubtitle(id: string | null): Promise<void> {
    const c = controller.value;
    if (!c) return;
    try {
      await c.setSubtitle(id);
      localSubtitles.value = { ...localSubtitles.value, enabled: id !== null };
    } catch (e) {
      // 播放不中断：失败轨已在面板标记「不可用」，这里只补一条 Toast（AC-46）
      ui.toast(toErrorShape(e).message, 'error');
    }
  }

  /** 重试失败字幕轨（AC-46）：成功则激活，失败再提示一次 */
  async function retrySubtitle(id: string): Promise<void> {
    const c = controller.value;
    if (!c) return;
    try {
      await c.retrySubtitle(id);
      localSubtitles.value = { ...localSubtitles.value, enabled: true };
      ui.toast('字幕已重新加载', 'success');
    } catch (e) {
      ui.toast(toErrorShape(e).message, 'error');
    }
  }

  async function addLocalSubtitle(file: File): Promise<void> {
    const c = controller.value;
    if (!c) return;
    try {
      const track = await c.addLocalSubtitle(file);
      localSubtitles.value = { ...localSubtitles.value, enabled: true };
      player.patch({ activeSubtitleId: track.id });
      ui.toast(`已加载字幕：${track.label}`, 'success');
    } catch (e) {
      ui.toast(toErrorShape(e).message, 'error');
    }
  }

  function setSubtitleOffset(offsetSec: number): void {
    localSubtitles.value = { ...localSubtitles.value, offsetSec };
    controller.value?.setSubtitleOffset(offsetSec);
  }

  /* ---------- 全屏 ---------- */

  async function toggleFullscreen(): Promise<void> {
    const c = controller.value;
    if (!c) return;
    await c.toggleFullscreen();
    player.patch({ fullscreen: c.fullscreen.isActive });
  }

  async function exitFullscreen(): Promise<void> {
    const c = controller.value;
    if (!c) return;
    await c.exitFullscreen();
    player.patch({ fullscreen: false });
  }

  /* ---------- 手势 ---------- */

  function onGesture(intent: GestureIntent): void {
    const c = controller.value;
    if (!c) return;
    switch (intent.type) {
      case 'single-tap':
        toggleControls();
        break;
      case 'double-tap': {
        const delta = 10;
        const target = player.currentTime + (intent.side === 'left' ? -delta : delta);
        c.seek(target);
        showHud({ kind: 'seek', value: Math.max(0, target), deltaSec: intent.side === 'left' ? -delta : delta });
        break;
      }
      case 'seek-preview':
        showHud({ kind: 'seek', value: intent.targetSec, deltaSec: intent.deltaSec }, 1200);
        break;
      case 'seek-commit':
        c.seek(intent.targetSec);
        clearHud();
        break;
      case 'seek-cancel':
        clearHud();
        break;
      case 'volume':
        c.setVolume(intent.value);
        player.patch({ volume: intent.value });
        showHud({ kind: 'volume', value: intent.value, deltaSec: 0 });
        break;
      case 'brightness': {
        c.setDim(intent.value);
        player.patch({ dim: (100 - intent.value) * 0.8 });
        showHud({ kind: 'brightness', value: intent.value, deltaSec: 0 });
        break;
      }
      case 'long-press-start':
        if (restoreRate === null) {
          restoreRate = player.rate;
          c.setRate(2);
          showHud({ kind: 'rate', value: 2, deltaSec: 0 }, 3_600_000);
        }
        break;
      case 'long-press-end':
        if (restoreRate !== null) {
          c.setRate(restoreRate);
          restoreRate = null;
        }
        clearHud();
        break;
      default:
        break;
    }
  }

  /* ---------- 自动连播 ---------- */

  function scheduleAutoNext(): void {
    cancelAutoNext();
    if (!options.autoPlayNext) return;
    const c = controller.value;
    if (!c?.canNext()) return;
    countdown.value = AUTO_NEXT_COUNTDOWN_SEC;
    countdownTimer = setInterval(() => {
      if (countdown.value === null) return;
      countdown.value -= 1;
      if (countdown.value <= 0) {
        cancelAutoNext();
        void nextEpisode();
      }
    }, 1000);
  }

  function cancelAutoNext(): void {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    countdown.value = null;
  }

  /* ---------- 后台/可见性 ---------- */

  function handleVisibility(): void {
    const c = controller.value;
    if (!c) return;
    if (document.visibilityState === 'hidden') {
      if (player.playing) {
        c.pause();
        backgroundPaused.value = true;
      }
      void c.flushProgress();
    }
  }

  function resumeFromBackground(): void {
    backgroundPaused.value = false;
    setControlsVisible(true);
  }

  /* ---------- 生命周期 ---------- */

  onMounted(() => {
    document.addEventListener('visibilitychange', handleVisibility);
  });

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', handleVisibility);
    if (hideTimer !== null) clearTimeout(hideTimer);
    if (hudTimer !== null) clearTimeout(hudTimer);
    cancelAutoNext();
    void controller.value?.destroy();
    controller.value = null;
    player.reset();
  });

  /* ---------- 派生状态 ---------- */

  const canNext = computed(() => controller.value?.canNext() ?? false);
  const canPrev = computed(() => controller.value?.canPrev() ?? false);
  const hasEpisodeNav = computed(() => {
    const opts = currentOptions.value;
    return (opts?.episodes.length ?? 0) > 1;
  });
  const isEnded = computed(() => controller.value?.getPlayerState() === 'ended');

  return {
    controller,
    player,
    hud,
    controlsVisible,
    countdown,
    backgroundPaused,
    localSubtitles,
    resolvedQuality,
    currentOptions,
    canNext,
    canPrev,
    hasEpisodeNav,
    isEnded,
    createController,
    load,
    reload,
    togglePlay,
    seek,
    setRate,
    nextEpisode,
    prevEpisode,
    switchQuality,
    selectSubtitle,
    retrySubtitle,
    addLocalSubtitle,
    setSubtitleOffset,
    toggleFullscreen,
    exitFullscreen,
    toggleControls,
    setControlsVisible,
    nudgeControls,
    onGesture,
    cancelAutoNext,
    resumeFromBackground,
    showHud,
    clearHud,
    scheduleAutoNext,
  };
}

function formatToastPosition(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 供测试/调试：计算起播位置的公共实现 */
export function startPositionFor(positionSec: number, durationSec: number): number {
  return ProgressReporter.resumePosition(positionSec, durationSec);
}
