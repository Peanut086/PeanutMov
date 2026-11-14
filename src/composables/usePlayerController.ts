/**
 * 播放器组合式函数（PlayerView 的唯一状态入口）
 *
 * 把 `PlayerController` 的命令式 API 适配成 Vue 响应式状态：
 * - 控制器生命周期（创建/挂载/销毁）
 * - 事件 → playerStore 同步
 * - 手势 intent → 控制器动作 + HUD 状态
 * - 控制条自动隐藏、切集、后台暂停、进度写回
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';

import type { PlaybackRate, ResizeMode, SaveProgressInput, SubtitleSettings } from '@/types';
import type { PlayerLoadOptions } from '@/player/types';
import { PlayerController } from '@/player/PlayerController';
import type { GestureIntent } from '@/player/GestureRecognizer';
import { ProgressReporter } from '@/player/ProgressReporter';
import { AUTO_NEXT_COUNTDOWN_SEC, CONTROLS_HIDE_DELAY_MS } from '@/player/constants';
import { clampBrightness } from '@/player/brightness';
import { isCanceled, toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';
import { usePlayerStore } from '@/stores/playerStore';
import { useUiStore } from '@/stores/uiStore';
import { useSleepTimer } from '@/composables/useSleepTimer';

/**
 * 亮度/音量的系统落点（由 View 注入 `deviceService` 能力——播放器层不直接 import Service，
 * 见 `PlayerController` 头部约定）。
 *
 * 整组可选：Web、测试、原生插件缺失时不注入，播放器退回「黑色遮罩 + 播放器倍率」。
 */
export interface PlayerLevelsPort {
  /** 写本窗口背光 0~100；false = 原生没接住 */
  setBrightness: (percent: number) => Promise<boolean>;
  /** 离开播放页交还背光 */
  releaseBrightness: () => Promise<void>;
  /** 写系统媒体音量 0~100，返回离散档位量化后的实际百分比；null = 没接住 */
  setVolume: (percent: number) => Promise<number | null>;
  /** 读系统媒体音量，用于手势按下时校准基准 */
  readVolume: () => Promise<number | null>;
}

export interface UsePlayerControllerOptions {
  /** 进度写回（由 View 注入历史 Store） */
  saveProgress: (input: SaveProgressInput) => Promise<unknown>;
  /**
   * 全屏时状态栏显隐（AC-52）：由 View 注入 `deviceService.setStatusBarVisible`。
   * 不传时播放器不做任何状态栏操作（Web/测试环境天然 no-op）。
   */
  setStatusBarVisible?: (visible: boolean) => void | Promise<void>;
  /**
   * 全屏沉浸模式（edge-to-edge）：由 View 注入原生插件代理。
   * 不传时 no-op（Web/测试环境）。
   */
  setImmersive?: (on: boolean) => void | Promise<void>;
  /**
   * 播放时保持屏幕常亮（AC-53）：由 View 注入 `deviceService.keepAwake`。
   * 不传时 no-op（Web/测试环境）。
   */
  setKeepAwake?: (on: boolean) => void | Promise<void>;
  /** 亮度/音量落到系统能力；不传（Web/测试/插件缺失）时用遮罩与播放器倍率 */
  levels?: PlayerLevelsPort;
  /** 初始字幕设置 */
  subtitle: SubtitleSettings;
  /** 默认倍速 */
  defaultRate: PlaybackRate;
  /** 自动连播 */
  autoPlayNext: boolean;
  /** B2：切后台继续播放（仅原生引擎生效，由 View 从设置注入） */
  backgroundPlayback: boolean;
  /** 初始画面比例 */
  resizeMode: ResizeMode;
  /** P1-4：长按倍速 */
  longPressRate: PlaybackRate;
  /** 获取当前加载参数的上下文（用于写回 title/poster 等） */
  describe: () => {
    sourceId: string;
    mediaId: string;
    episodeId: string | null;
    episodeNumber: number | null;
    title: string;
    posterUrl: string | null;
    totalEpisodes: number | null;
    /** REV-24：媒体快照 */
    mediaSnapshot?: SaveProgressInput['mediaSnapshot'];
  } | null;
}

export interface HudState {
  kind: 'seek' | 'volume' | 'brightness' | 'rate' | 'play' | 'pause' | null;
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
  /** B2：纯音频模式（本次会话有效，不写设置） */
  const audioOnly = ref(false);
  /** B2：后台播放（初值来自设置，播放页内可临时改，由 View 决定是否写回设置） */
  const backgroundPlayback = ref(options.backgroundPlayback);
  /** B1：通知栏/锁屏请求切换到的剧集 id（与 autoNextTarget 同一消费方式） */
  const remoteEpisodeTarget = ref<string | null>(null);
  /** B3：睡眠定时——到点暂停，或播完本集就停住不连播 */
  const sleepTimer = useSleepTimer({
    onExpire: (choice) => {
      controller.value?.pause();
      cancelAutoNext();
      ui.toast(choice === 'episode' ? '本集播完，睡眠定时已停止播放' : '睡眠定时已到，已暂停播放', 'info', 2600);
    },
  });
  const localSubtitles = ref(options.subtitle);
  const resolvedQuality = ref<'auto' | string>('auto');
  /** 黑屏检测结果（码流在播但一帧画面都没解出来）；null = 正常 */
  const noVideo = ref<{ videoWidth: number; videoHeight: number; elapsedSec: number } | null>(null);

  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let hudTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  let restoreRate: PlaybackRate | null = null;
  /** P1-5：记录暂停时刻，用于长时间暂停后回退 3 秒 */
  let pausedAt: number | null = null;

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

  /** P1-3：暂停自动隐藏（面板打开时调用） */
  function pauseAutoHide(): void {
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  /* ---------- 事件绑定 ---------- */

  /** timeupdate 节流：原生 ~4Hz(250ms)，但 patch 触发响应式更新过多会掉帧 */
  let lastTimePatchAt = 0;
  const TIME_PATCH_MIN_GAP_MS = 200;

  function bindController(c: PlayerController): void {
    c.on('ready', ({ duration }) => {
      player.patch({ duration, loading: false });
    });

    // 每次加载成功（含切集/自动连播）同步当前集 id，
    // 让 canPrev/canNext 这类依赖 player.episodeId 的派生状态实时重算
    c.on('loaded', ({ episodeId }) => {
      player.patch({ episodeId });
    });

    c.on('timeupdate', ({ currentTime, duration, buffered }) => {
      // 节流：seek 时立即更新（拖动进度条需要即时响应），播放中 200ms 一次足够
      const now = performance.now();
      if (now - lastTimePatchAt < TIME_PATCH_MIN_GAP_MS) return;
      lastTimePatchAt = now;
      player.patch({ currentTime, duration, buffered });
    });

    c.on('statechange', ({ playing, waiting }) => {
      player.patch({ playing, waiting });
      if (playing) {
        scheduleHide();
        pausedAt = null;
      } else {
        setControlsVisible(true);
        pausedAt = Date.now();
      }
    });

    c.on('ratechange', ({ rate }) => {
      player.patch({ rate });
    });

    c.on('ended', () => {
      player.patch({ playing: false });
      setControlsVisible(true);
      if (sleepTimer.consumeEpisodeEnd()) return;
      scheduleAutoNext();
    });

    c.on('error', (error) => {
      player.patch({ error, loading: false, playing: false });
      setControlsVisible(true);
    });

    c.on('novideo', (info) => {
      // 不当作 error：声音还在播，用户可能想继续听，或换线路/换引擎
      noVideo.value = info;
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

    // v1.8/CHG-25：引擎变化（含原生→WebView 回退）与非致命提示
    c.on('enginechange', ({ kind }) => {
      player.patch({ engineKind: kind });
    });

    c.on('notice', ({ message }) => {
      ui.toast(message, 'info');
    });

    // B1：通知栏/锁屏/线控指令。切集仍走 View 的路由入口（与自动连播同一条路径），
    // 这里只把目标集 id 抛出去，避免绕过 describe()/进度写回
    c.on('remotecommand', ({ command }) => {
      if (command === 'stop') {
        controller.value?.pause();
        return;
      }
      const target = command === 'next' ? nextEpisodeId.value : prevEpisodeId.value;
      if (target) remoteEpisodeTarget.value = target;
    });
  }

  /* ---------- 屏幕常亮（AC-53） ---------- */

  /** 记录当前 keep-awake 状态，避免重复调用 */
  let awakeActive = false;

  /**
   * 同步常亮锁。`force` 用于回前台：本地缓存可能还记着「亮着」，
   * 而窗口 flag 已在后台被清掉，此时必须重新落到原生而不是提前返回。
   */
  function syncKeepAwake(force = false): void {
    const shouldAwake = player.playing || player.waiting;
    if (!force && shouldAwake === awakeActive) return;
    awakeActive = shouldAwake;
    options.setKeepAwake?.(shouldAwake);
  }

  // 播放/缓冲状态变化时同步 keep-awake
  watch(
    () => player.playing || player.waiting,
    () => syncKeepAwake(),
  );

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
            // REV-24：媒体快照，用于缓存清理后自愈
            mediaSnapshot: desc.mediaSnapshot,
          });
        } catch (e) {
          // 写库失败只记录，不打断播放（下次采样会重试）
          ui.toast(toErrorShape(e, 'E_DB').message, 'error');
        }
      },
      // AC-52：全屏隐藏状态栏 / 退出恢复（Web 下 Service 自身 no-op）
      setStatusBarVisible: (visible) => options.setStatusBarVisible?.(visible),
      setImmersive: (on) => options.setImmersive?.(on),
    });
    bindController(c);
    c.mount(container);
    controller.value = c;
    c.setRate(options.defaultRate);
    // app 模式：引擎倍率跟随记忆值；system 模式音量归系统，倍率必须留在满量，
    // 否则两层衰减叠加（HUD 显示 60%，实际听到的是「系统 60% × 0.6」）。
    c.setVolume(player.levelSource === 'system' ? 100 : player.volume);
    c.setResizeMode(options.resizeMode);
    c.setSubtitleOffset(options.subtitle.offsetSec);
    syncBackgroundPlayback();
    return c;
  }

  /* ---------- B2：后台播放 / 纯音频 ---------- */

  /**
   * 纯音频模式隐含后台播放：只藏画面却仍在切后台时暂停，这个开关就等于没用。
   * 不回写用户的 backgroundPlayback 设置，只在本次会话内叠加。
   */
  function syncBackgroundPlayback(): void {
    controller.value?.setBackgroundPlayback(backgroundPlayback.value || audioOnly.value);
  }

  function setBackgroundPlayback(enabled: boolean): void {
    backgroundPlayback.value = enabled;
    syncBackgroundPlayback();
  }

  function setAudioOnly(enabled: boolean): void {
    audioOnly.value = enabled;
    controller.value?.setAudioOnly(enabled);
    syncBackgroundPlayback();
    ui.toast(enabled ? '已切到纯音频，画面已收起' : '已恢复画面', 'info', 1500);
  }

  /* ---------- 加载 ---------- */

  const currentOptions = shallowRef<PlayerLoadOptions | null>(null);
  /** 页面存活标记：卸载后异步续体不再写 player store，避免死实例污染新页面 */
  let alive = true;

  async function load(opts: PlayerLoadOptions): Promise<void> {
    const c = controller.value;
    if (!c) return;
    noVideo.value = null;
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
      // 加载期间页面卸载：不再继续 play，避免僵尸播放
      if (!alive || controller.value !== c) return;
      await c.play();
      if (!alive || controller.value !== c) return;
      // 成功路径显式清空错误：旧一轮（已被取代）的失败不得残留在画面上
      if (player.error) player.patch({ error: null });
    } catch (e) {
      // REV-28：切集/切线路会作废旧加载，旧加载抛 E_ABORTED 属正常竞态，
      // 不能把取消当失败写到 player.error 上（会盖住正在播放的新画面）。
      if (isCanceled(e)) return;
      // 页面已卸载：不再写错误状态
      if (!alive || controller.value !== c) return;
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

  /**
   * 双击触发的播放/暂停：与按钮 `togglePlay` 的差异在于——
   * - ended 态下双击 = 从头重播（HTMLMediaElement.play 在 ended 会自动回 0，但原生引擎不一定）
   * - 加载/错误态下双击静默忽略（避免误触）
   * - waiting 态下双击 = 直接暂停（P1-5 边界）
   * - 暂停超过 10 分钟：恢复时回退 3 秒（P1-5 边界）
   * - 暂停时显示控制条；复播时 HUD 闪 450ms 后自动隐藏
   */
  async function togglePlayByTap(): Promise<void> {
    const c = controller.value;
    if (!c || player.error || player.loading) return;
    
    // P1-5：waiting 中双击直接暂停
    if (player.waiting) {
      c.pause();
      setControlsVisible(true);
      showHud({ kind: 'pause', value: 0, deltaSec: 0 }, 450);
      return;
    }
    
    if (player.playing) {
      c.pause();
      setControlsVisible(true);
      showHud({ kind: 'pause', value: 0, deltaSec: 0 }, 450);
    } else {
      if (c.getPlayerState() === 'ended') {
        cancelAutoNext();
        c.seek(0);
      }
      // P1-5：暂停超过 10 分钟，恢复时回退 3 秒
      if (pausedAt !== null) {
        const pausedDuration = Date.now() - pausedAt;
        if (pausedDuration > 10 * 60 * 1000) {
          const seekTarget = Math.max(0, player.currentTime - 3);
          c.seek(seekTarget);
        }
        pausedAt = null;
      }
      await c.play();
      showHud({ kind: 'play', value: 0, deltaSec: 0 }, 450);
      scheduleHide();
    }
  }

  async function seek(sec: number): Promise<void> {
    // 先重置节流，确保 seek 触发的 timeupdate 不被跳过
    lastTimePatchAt = 0;
    controller.value?.seek(sec);
    nudgeControls();
  }

  function setRate(rate: PlaybackRate): void {
    controller.value?.setRate(rate);
    player.patch({ rate });
    ui.toast(`已切换到 ${rate}x`, 'info', 1500);
  }

  /**
   * P0-1：下一集/上一集的目标 ID（响应式）。
   *
   * 由 PlayerView 读取后走路由更新（`chooseEpisode`），保证 `describe()` / 进度写回 /
   * 弹幕匹配与路由上的 `episodeId` 一致——之前直接调 `controller.switchTo` 会绕过路由，
   * 导致自动连播/上下集按钮切完后历史记录与弹幕仍锚在旧集。
   */
  const nextEpisodeId = computed(() => {
    const opts = currentOptions.value;
    const idx = episodeIndex.value;
    if (!opts || idx < 0 || idx >= opts.episodes.length - 1) return null;
    return opts.episodes[idx + 1]?.episodeId ?? null;
  });
  const prevEpisodeId = computed(() => {
    const opts = currentOptions.value;
    const idx = episodeIndex.value;
    if (!opts || idx <= 0) return null;
    return opts.episodes[idx - 1]?.episodeId ?? null;
  });

  /** P0-1：仅取消倒计时，实际切集由 PlayerView 走路由完成 */
  function nextEpisode(): void {
    cancelAutoNext();
  }

  function prevEpisode(): void {
    cancelAutoNext();
  }

  async function switchQuality(quality: string): Promise<void> {
    controller.value?.setQuality(quality);
    resolvedQuality.value = quality;
    ui.toast(quality === 'auto' ? '已切换到自动清晰度' : `已切换到 ${quality}`, 'info', 1500);
  }

  function setResizeMode(mode: ResizeMode): void {
    controller.value?.setResizeMode(mode);
  }

  async function selectSubtitle(id: string | null): Promise<void> {
    const c = controller.value;
    if (!c) return;
    try {
      await c.setSubtitle(id);
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

  /** 原生落点写不进去（旧包/ROM 拒绝）：整体退回遮罩 + 倍率，手势不能变成「拖了没反应」 */
  function degradeToAppLevels(): void {
    if (player.levelSource !== 'system') return;
    logger.warn('系统亮度/音量写入失败，退回画面遮罩与播放器倍率');
    player.patch({ levelSource: 'app' });
    // 系统模式下引擎倍率钉在 100；不补这一刀，本次手势会出现 HUD 显示小、实际听着响
    controller.value?.setVolume(player.volume);
  }

  /**
   * 手指按下：校准音量基准。
   *
   * 实体音量键改的是系统档位，本页无从感知；识别器要到第一次能判定方向的
   * move 才取基准，所以这里异步刷一次，通常赶在那之前落地。刷晚了只是这一次
   * 滑动沿用旧基准，下一次按下即自愈——不值得为它挂一个 ContentObserver。
   */
  function onGesturePointerDown(): void {
    const levels = options.levels;
    if (player.levelSource !== 'system' || !levels) return;
    void levels.readVolume().then((percent) => {
      if (percent !== null && player.levelSource === 'system') player.patch({ volume: percent });
    });
  }

  function onGesture(intent: GestureIntent): void {
    const c = controller.value;
    if (!c) return;
    switch (intent.type) {
      case 'single-tap':
        toggleControls();
        break;
      case 'double-tap':
        void togglePlayByTap();
        break;
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
      case 'volume': {
        const value = Math.min(100, Math.max(0, Math.round(intent.value)));
        player.patch({ volume: value });
        showHud({ kind: 'volume', value, deltaSec: 0 });
        const levels = options.levels;
        if (player.levelSource === 'system' && levels) {
          void levels.setVolume(value).then((applied) => {
            if (applied === null) {
              degradeToAppLevels();
              return;
            }
            // 档位是离散的（常见 25 档，一档 4%）：以真实生效值当下一次滑动的基准
            if (player.levelSource === 'system') player.patch({ volume: applied });
          });
        } else {
          c.setVolume(value);
        }
        break;
      }
      case 'brightness': {
        const value = clampBrightness(intent.value);
        c.setBrightness(value);
        player.patch({ brightness: value });
        showHud({ kind: 'brightness', value, deltaSec: 0 });
        const levels = options.levels;
        if (player.levelSource === 'system' && levels) {
          void levels.setBrightness(value).then((ok) => {
            if (!ok) degradeToAppLevels();
          });
        }
        break;
      }
      case 'long-press-start':
        if (restoreRate === null) {
          restoreRate = player.rate;
          const rate = options.longPressRate;
          c.setRate(rate);
          showHud({ kind: 'rate', value: rate, deltaSec: 0 }, 3_600_000);
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

  /**
   * P0-1：自动连播目标集 ID。倒计时归零时写入，由 PlayerView watch 后走路由更新。
   * null = 无待处理的自动连播。
   */
  const autoNextTarget = ref<string | null>(null);

  function scheduleAutoNext(): void {
    cancelAutoNext();
    if (!options.autoPlayNext) return;
    if (!nextEpisodeId.value) return;
    countdown.value = AUTO_NEXT_COUNTDOWN_SEC;
    countdownTimer = setInterval(() => {
      if (countdown.value === null) return;
      countdown.value -= 1;
      if (countdown.value <= 0) {
        cancelAutoNext();
        autoNextTarget.value = nextEpisodeId.value;
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

  /** PlayerView 处理完自动连播后调用，清除目标 */
  function acknowledgeAutoNext(): void {
    autoNextTarget.value = null;
  }

  /** PlayerView 处理完远端切集后调用，清除目标（否则同一集连按两次不触发） */
  function acknowledgeRemoteEpisode(): void {
    remoteEpisodeTarget.value = null;
  }

  /* ---------- 后台/可见性 ---------- */

  function handleVisibility(): void {
    const c = controller.value;
    if (!c) return;
    if (document.visibilityState === 'hidden') {
      // B2：只有原生引擎能真的在后台播——WebView 的 video 会被系统挂起，
      // 开了开关也播不动，所以这里必须同时判引擎
      const keepPlaying =
        (backgroundPlayback.value || audioOnly.value) && player.engineKind === 'native';
      if (player.playing && !keepPlaying) {
        c.pause();
        backgroundPaused.value = true;
      }
      // 后台播放时用户没在看画面，继续持常亮锁只会耗电
      if (awakeActive) {
        awakeActive = false;
        options.setKeepAwake?.(false);
      }
      void c.flushProgress();
    } else {
      syncKeepAwake(true);
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
    alive = false;
    logger.info('播放器卸载：销毁 controller', { hasController: controller.value != null });
    document.removeEventListener('visibilitychange', handleVisibility);
    if (hideTimer !== null) clearTimeout(hideTimer);
    if (hudTimer !== null) clearTimeout(hudTimer);
    cancelAutoNext();
    void controller.value?.destroy();
    controller.value = null;
    // 窗口背光覆盖只该在播放页生效：离开即交还系统（须在 reset 把 levelSource 改回 'app' 前判）
    // 音量不恢复——它是全局状态，按产品决策保留。
    if (player.levelSource === 'system') void options.levels?.releaseBrightness();
    player.reset();
    // AC-53：离开播放页释放屏幕常亮
    if (awakeActive) {
      awakeActive = false;
      options.setKeepAwake?.(false);
    }
  });

  /* ---------- 派生状态 ---------- */

  // 依赖响应式的 currentOptions.episodes + player.episodeId：
  // 控制器内部 this.options 非响应式，切集后若调命令式 canNext() 不会触发重算（按钮态冻结）
  const episodeIndex = computed(() => {
    const opts = currentOptions.value;
    if (!opts) return -1;
    return opts.episodes.findIndex((e) => e.episodeId === player.episodeId);
  });
  const canNext = computed(() => {
    const opts = currentOptions.value;
    const idx = episodeIndex.value;
    return !!opts && idx >= 0 && idx < opts.episodes.length - 1;
  });
  const canPrev = computed(() => episodeIndex.value > 0);
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
    audioOnly,
    backgroundPlayback,
    remoteEpisodeTarget,
    sleepTimer,
    localSubtitles,
    resolvedQuality,
    noVideo,
    currentOptions,
    canNext,
    canPrev,
    hasEpisodeNav,
    isEnded,
    nextEpisodeId,
    prevEpisodeId,
    createController,
    load,
    reload,
    togglePlay,
    togglePlayByTap,
    seek,
    setRate,
    nextEpisode,
    prevEpisode,
    switchQuality,
    setResizeMode,
    selectSubtitle,
    retrySubtitle,
    addLocalSubtitle,
    setSubtitleOffset,
    toggleFullscreen,
    exitFullscreen,
    toggleControls,
    setControlsVisible,
    nudgeControls,
    pauseAutoHide,
    onGesture,
    onGesturePointerDown,
    cancelAutoNext,
    resumeFromBackground,
    showHud,
    clearHud,
    scheduleAutoNext,
    autoNextTarget,
    acknowledgeAutoNext,
    acknowledgeRemoteEpisode,
    setAudioOnly,
    setBackgroundPlayback,
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
