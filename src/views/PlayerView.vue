<script setup lang="ts">
/**
 * 播放页（页面蓝图 §6 / 技术方案第 9 章）
 *
 * 竖屏：16:9 画面 + 控制条 + 下方标题/操作/选集（可滚动）。
 * 横屏/全屏：画面铺满，控制条叠加；Android 返回键先退全屏。
 *
 * 主链路：
 * route → libraryStore.resolvePlay → PlayerController.load → 播放
 * 进度：ProgressReporter 每 5s / 暂停 / 切页 / 结束写回 historyStore
 * 自动连播：ended + autoPlayNext → 3s 倒计时 → nextEpisode
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type {
  AppErrorShape,
  Episode,
  GestureSettings,
  PlaybackRate,
  PlaybackSource,
  PlayerSettings,
  ResizeMode,
  SubtitleSettings,
} from '@/types';
import type { PlayerLoadOptions } from '@/player/types';
import { emptyEmbeddedTracks, type EmbeddedTrackState } from '@/player/PlayerController';
import { shouldIgnoreShortcut } from '@/player/shortcutGuard';
import { formatClock } from '@/shared/time';
import { toErrorShape, isCanceled, AppError } from '@/shared/errors';
import { guidanceOf, magnetUrlOf } from '@/shared/sourceFailure';

import PlayerSurface from '@/components/player/PlayerSurface.vue';
import PlayerControls from '@/components/player/PlayerControls.vue';
import GestureLayer from '@/components/player/GestureLayer.vue';
import GestureGuide from '@/components/player/GestureGuide.vue';
import GestureHelpOverlay from '@/components/player/GestureHelpOverlay.vue';
import PlayerHud from '@/components/player/PlayerHud.vue';
import SpeedSheet from '@/components/player/SpeedSheet.vue';
import SubtitleSheet from '@/components/player/SubtitleSheet.vue';
import SubtitleTrackMenu from '@/components/player/SubtitleTrackMenu.vue';
import AudioTrackMenu from '@/components/player/AudioTrackMenu.vue';
import QualitySheet from '@/components/player/QualitySheet.vue';
import DisplayModeSheet from '@/components/player/DisplayModeSheet.vue';
import PlayerErrorPanel from '@/components/player/PlayerErrorPanel.vue';
import NextEpisodePrompt from '@/components/player/NextEpisodePrompt.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import EpisodeList from '@/components/media/EpisodeList.vue';
import LineSelector from '@/components/media/LineSelector.vue';
import IconDownload from '@/components/icons/IconDownload.vue';
import IconHeart from '@/components/icons/IconHeart.vue';
import IconCast from '@/components/icons/IconCast.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSourceStore } from '@/stores/sourceStore';
import { castService } from '@/services/castService';
import { lineHealthService, lineKey } from '@/services/lineHealthService';
import { rankLines } from '@/services/lineRanking';
import { useBackButton } from '@/composables/useBackButton';
import { usePlayerController } from '@/composables/usePlayerController';
import { offlineEpisodeMessage, resolveTargetEpisode } from '@/player/episodeFallback';
import { DanmakuOverlay } from '@/player/DanmakuOverlay';
import { danmakuService } from '@/services/danmakuService';
import DanmakuSettingsSheet from '@/components/player/DanmakuSettingsSheet.vue';
import DanmakuStylePanel from '@/components/player/DanmakuStylePanel.vue';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { QUALITY_AUTO } from '@/player/constants';
import { brightnessToDimOpacity, dimOpacityToBrightness } from '@/player/brightness';
import { PLAYER_FAILOVER_WINDOW_MS } from '@/shared/constants';
import { localProxyUrl } from '@/native/localProxy';
import { pipService } from '@/native/pipService';
import { onAppStateChange } from '@/native/appLifecycle';
import { libraryService } from '@/services/libraryService';
import { sourceService } from '@/services/sourceService';
import { downloadService } from '@/services/downloadService';
import { pickPlayCandidates } from '@/sources/douban/playMatch';
import { healthService } from '@/services/healthService';
import { appEvents } from '@/services/events';
import PlayLoadingBar from '@/components/player/PlayLoadingBar.vue';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const history = useHistoryStore();
const favorites = useFavoriteStore();
const downloads = useDownloadStore();
const settings = useSettingsStore();
const sources = useSourceStore();
const ui = useUiStore();
const toast = useToast();

const mediaId = computed(() => (typeof route.params.mediaId === 'string' ? route.params.mediaId : ''));
const episodeIdParam = computed(() =>
  typeof route.params.episodeId === 'string' ? route.params.episodeId : null,
);
const lineIdParam = computed(() => (typeof route.query.lineId === 'string' ? route.query.lineId : null));
const restart = computed(() => route.query.restart === '1');

/* ---------- 页面数据 ---------- */
const detailReady = ref(false);
const loadError = ref<string | null>(null);
/** P0-1/P1-4：解析失败的结构化错误（分类 + 磁力地址需要 detail，字符串不够用） */
const loadErrorShape = ref<AppErrorShape | null>(null);
const pageLoading = ref(true);

/**
 * REV-24：详情加载失败时，区分三种场景并给出可恢复的提示：
 * - 源已移除：sourceRepo 找不到该 sourceId → 明确告知，提供删除记录入口
 * - 缓存已清理：media 缺失但源存在 → 提示需要联网或内容已下线
 * - 内容下线：源存在但 adapter 报 E_NOT_FOUND → 提示内容已从源中移除
 */
const detailErrorKind = computed<'source-removed' | 'cache-cleared' | 'content-gone' | null>(() => {
  if (library.detailState !== 'error' || !library.error) return null;
  const code = library.error.code;
  if (code !== 'E_NOT_FOUND' && code !== 'E_SOURCE_UNAVAILABLE') return null;

  // 从历史记录中查找该 mediaId 对应的 sourceId
  const historyRecord = history.items.find((r) => r.mediaId === mediaId.value);
  if (!historyRecord) return 'content-gone'; // 无历史记录 → 内容下线

  const source = sources.sources.find((s) => s.id === historyRecord.sourceId);
  if (!source) return 'source-removed'; // 源不存在 → 源已移除

  return 'cache-cleared'; // 源存在但 media 缺失 → 缓存已清理
});

/** REV-24：详情失败时的上下文文案（覆盖全局 E_NOT_FOUND 的 "资源不存在(404)"） */
const detailErrorMessage = computed(() => {
  const kind = detailErrorKind.value;
  if (kind === 'source-removed') return '该源已被移除，无法继续播放';
  if (kind === 'cache-cleared') return '本地缓存已清理，恢复失败（需要联网或内容已下线）';
  if (kind === 'content-gone') return '该内容已从源中下线';
  return loadError.value;
});

/** REV-24：详情失败时的标题兜底（从历史记录取 title，不再显示"播放"） */
const fallbackTitle = computed(() => {
  if (item.value?.title) return item.value.title;
  const record = history.items.find((r) => r.mediaId === mediaId.value);
  return record?.title ?? '播放';
});

const item = computed(() => library.detail?.item ?? null);
const lines = computed(() => library.detail?.lines ?? []);
const lineId = ref<string | null>(null);
const currentLineId = computed(() => lineId.value ?? lineIdParam.value ?? lines.value[0]?.id ?? null);
const currentLine = computed(() => lines.value.find((l) => l.id === currentLineId.value) ?? null);

const episodes = computed<Episode[]>(() => {
  const det = library.detail;
  if (!det) return [];
  const id = currentLineId.value;
  const filtered = id ? det.episodes.filter((ep) => ep.lineId === id) : det.episodes;
  return filtered.sort((a, b) => a.number - b.number);
});

const currentEpisode = computed<Episode | null>(() => {
  const list = episodes.value;
  if (episodeIdParam.value) return list.find((ep) => ep.id === episodeIdParam.value) ?? list[0] ?? null;
  return list[0] ?? null;
});

/** 批次1：线路健康状态 Map（供 LineSelector 显示状态点） */
const lineStatuses = computed(() => {
  const it = item.value;
  if (!it) return new Map<string, import('@/services/lineHealthService').LineHealthStatus>();
  const map = new Map<string, import('@/services/lineHealthService').LineHealthStatus>();
  for (const line of lines.value) {
    const key = lineKey(it.sourceId, it.sourceItemId, line.name);
    map.set(line.id, lineHealthService.statusOf(key));
  }
  return map;
});

/** 批次1：推荐的线路 ID（评分最高） */
const recommendedLineId = computed(() => {
  const it = item.value;
  if (!it || lines.value.length === 0) return null;
  const ranked = rankLines({
    lines: lines.value,
    historyEpisodeId: null, // 播放页不恢复历史线路
    episodes: episodes.value,
    buildKey: (line) => lineKey(it.sourceId, it.sourceItemId, line.name),
  });
  return ranked[0]?.id ?? null;
});

/**
 * 历史记录的集号已超出当前源范围（AC-68）。
 *
 * 路由里的 `episodeId` 在详情加载后可能已经不存在（剧集下线/换线路）。
 * 只有「记录集号 > 当前最大集号」才算已下线；同集号但 id 变了属于正常重映射，
 * 由 `resolveTargetEpisode` 按集号命中，不打扰用户。
 */
const offlineEpisodeNumber = computed<number | null>(() => {
  const it = item.value;
  const param = episodeIdParam.value;
  const list = episodes.value;
  if (!it || !param || list.length === 0) return null;
  if (list.some((ep) => ep.id === param)) return null;
  const rec = history.progressOf(it.sourceId, it.id);
  if (!rec) return null;
  return resolveTargetEpisode({
    recordedEpisodeId: rec.episodeId,
    recordedNumber: rec.episodeNumber,
    episodes: list,
  }).offlineNumber;
});

/** 同一集号只提示一次（避免切线路/重载时重复弹） */
const announcedOffline = ref<number | null>(null);

/** 已下线提示：Toast 文案「看到第 N 集（已下线），已从第 1 集开始」 */
function announceOfflineEpisode(): void {
  const n = offlineEpisodeNumber.value;
  if (n === null || announcedOffline.value === n) return;
  announcedOffline.value = n;
  toast.info(offlineEpisodeMessage(n), 3600);
}

/* ---------- 播放器 composable ---------- */
/**
 * 真实 `settingsStore` 在设置未就绪时 getter 返回 null（mock 返回默认值），
 * 因此这里显式兜底，避免首帧读 `.defaultRate` 抛错（契约字段不变，仅调用方适配）。
 */
const PLAYER_FALLBACK: PlayerSettings = {
  defaultRate: 1,
  defaultQuality: 'auto',
  autoPlayNext: true,
  seekStepSec: 10,
  longPressRate: 2,
  subtitle: {
    enabled: false,
    size: 'medium',
    color: 'white',
    background: 'black',
    offsetSec: 0,
    preferredLang: null,
  },
  rememberVolumeBrightness: true,
  lastVolume: 100,
  lastBrightness: 100,
  resizeMode: 'contain',
};
const GESTURE_FALLBACK: GestureSettings = { sensitivity: 'medium', seekMaxSec: 90 };

const playerSettings = computed<PlayerSettings>(() => settings.player ?? PLAYER_FALLBACK);
const gestureSettings = computed<GestureSettings>(() => settings.gesture ?? GESTURE_FALLBACK);

/** v1.8/CHG-25：实验性原生引擎（ExoPlayer）开关——注入 PlayerLoadOptions，控制器不读设置 */
const nativeEngineEnabled = computed(() => settings.settings?.experimentalNativePlayer === true);
/** 黑屏兜底：本次会话强制原生引擎（不改用户设置，仅本页有效） */
const forceNativeEngine = ref(false);
/** 黑屏提示是否已被用户关掉（换线路/继续听声音） */
const noVideoDismissed = ref(false);

const defaultRate = computed<PlaybackRate>(() => playerSettings.value.defaultRate ?? 1);
const autoPlayNext = computed(() => playerSettings.value.autoPlayNext);
const longPressRate = computed<PlaybackRate>(() => (playerSettings.value.longPressRate ?? 2) as PlaybackRate);
const subtitleSettings = computed<SubtitleSettings>(
  () => playerSettings.value.subtitle ?? PLAYER_FALLBACK.subtitle,
);
const currentResizeMode = computed(() => playerSettings.value.resizeMode ?? 'contain');

const stageRef = ref<HTMLElement | null>(null);

const playerCtl = usePlayerController({
  saveProgress: async (input) => {
    await history.save(input);
  },
  // AC-52：全屏隐藏状态栏、退出恢复；Web 下 deviceService 自身为 no-op，异常不阻断全屏。
  // 用动态 import 延迟到首次进入全屏：避免把 Capacitor status-bar 插件拉进首屏模块图
  // （会让路由级测试的模块加载变慢）。
  setStatusBarVisible: (visible) =>
    import('@/services/deviceService')
      .then((m) => m.deviceService.setStatusBarVisible(visible))
      .catch(() => undefined),
  // 横屏全屏切 edge-to-edge：消除刘海安全边内缩露出的白色竖条；退出恢复系统栏
  setImmersive: (on) =>
    import('@/native/playerUi')
      .then((m) => m.setPlayerImmersive(on))
      .catch(() => undefined),
  // AC-53：播放时保持屏幕常亮；Web 下 no-op。
  setKeepAwake: (on) =>
    import('@/services/deviceService')
      .then((m) => m.deviceService.keepAwake(on))
      .catch(() => undefined),
  subtitle: subtitleSettings.value,
  defaultRate: defaultRate.value,
  autoPlayNext: autoPlayNext.value,
  resizeMode: currentResizeMode.value,
  longPressRate: longPressRate.value,
  describe: () => {
    // 页面卸载后不再写回进度，避免死实例拿错上下文污染历史记录
    if (!pageAlive) return null;
    const it = item.value;
    const ep = currentEpisode.value;
    if (!it) return null;
    return {
      sourceId: it.sourceId,
      mediaId: it.id,
      episodeId: ep?.id ?? null,
      episodeNumber: ep?.number ?? null,
      title: it.title,
      posterUrl: it.posterUrl,
      totalEpisodes: episodes.value.length > 0 ? episodes.value.length : null,
      // REV-24：媒体快照，用于缓存清理后自愈
      mediaSnapshot: {
        sourceItemId: it.sourceItemId,
        type: it.type,
        year: it.year,
        episodeCount: it.episodeCount,
        originalTitle: it.originalTitle,
      },
    };
  },
});

const {
  controller,
  player,
  noVideo,
  hud,
  controlsVisible,
  countdown,
  backgroundPaused,
  localSubtitles,
  resolvedQuality,
  canNext,
  canPrev,
  hasEpisodeNav,
  nextEpisodeId,
  prevEpisodeId,
  autoNextTarget,
  acknowledgeAutoNext,
  createController,
  load,
  togglePlay,
  seek,
  setRate,
  switchQuality,
  setResizeMode,
  selectSubtitle,
  retrySubtitle,
  addLocalSubtitle,
  setSubtitleOffset,
  toggleFullscreen,
  exitFullscreen,
  onGesture,
  cancelAutoNext,
  resumeFromBackground,
  pauseAutoHide,
  setControlsVisible,
} = playerCtl;

/**
 * P0-1：上下集按钮走路由更新，与选集/自动连播共用同一入口（episodeId watcher）。
 * 之前直接调 controller.switchTo 会导致 describe() / 进度写回 / 弹幕与路由不同步。
 */
function goToNextEpisode(): void {
  const id = nextEpisodeId.value;
  if (!id) return;
  const ep = episodes.value.find((e) => e.id === id);
  if (ep) chooseEpisode(ep);
}

function goToPrevEpisode(): void {
  const id = prevEpisodeId.value;
  if (!id) return;
  const ep = episodes.value.find((e) => e.id === id);
  if (ep) chooseEpisode(ep);
}

/** P0-1：自动连播倒计时结束后走路由更新 */
watch(autoNextTarget, (targetId) => {
  if (!targetId) return;
  const ep = episodes.value.find((e) => e.id === targetId);
  acknowledgeAutoNext();
  if (ep) chooseEpisode(ep);
});

/* ---------- 面板 ---------- */
const speedOpen = ref(false);
const subtitleOpen = ref(false);
// EXT-07：内嵌字幕轨 / 音轨菜单（与原「字幕」面板相互独立）
const subtitleTrackOpen = ref(false);
const audioTrackOpen = ref(false);
const qualityOpen = ref(false);
const displayModeOpen = ref(false);
const episodeOpen = ref(false);
const moreOpen = ref(false);
const pickerOpen = ref(false);
const downloading = ref(false);
// OPT-10：手势帮助浮层
const gestureHelpVisible = ref(false);

function showGestureHelp(): void {
  gestureHelpVisible.value = true;
}

function closeGestureHelp(): void {
  gestureHelpVisible.value = false;
}

/** P1-3：任一面板打开时暂停控制条自动隐藏 */
watch(
  () => [speedOpen.value, subtitleOpen.value, subtitleTrackOpen.value, audioTrackOpen.value, qualityOpen.value, displayModeOpen.value, episodeOpen.value, moreOpen.value, pickerOpen.value, gestureHelpVisible.value],
  (states) => {
    if (states.some(Boolean)) {
      pauseAutoHide();
    }
  },
);

// 退出全屏时收起沉浸态轨道菜单，避免面板残留到竖屏
watch(
  () => player.fullscreen,
  (fullscreen) => {
    if (!fullscreen) {
      audioTrackOpen.value = false;
      subtitleTrackOpen.value = false;
    }
  },
);

const castSupported = ref<boolean | null>(null);
/** 最近一次解析出的播放源（投屏/分享用，避免再次解析触发网络请求） */
const currentPlayback = ref<PlaybackSource | null>(null);
/** 线路切换进行中（防连点造成两次并发加载，REV-05） */
const switchingLine = ref(false);

/**
 * 「本地文件不可用」任务（AC-78 / REV-23）。
 *
 * `resolvePlay` 优先本地播放；若该集已有 `completed` 任务但解析结果仍是网络源，
 * 说明本地文件/Blob 已丢失（服务层同时发出 `local:missing` 事件弹全局 Toast）。
 * 这里记下 taskId，在页面上常驻一条提示条并给出「重新下载」按钮。
 */
const localMissingTaskId = ref<string | null>(null);
const redownloading = ref(false);

/** 投屏能力探测（AC-84）：`isSupported()===false` 时按钮渲染为禁用态 */
async function detectCastSupport(): Promise<void> {
  try {
    castSupported.value = await castService.isSupported();
  } catch {
    castSupported.value = false;
  }
}

function detectLocalMissing(): void {
  const it = item.value;
  const ep = currentEpisode.value;
  const playback = currentPlayback.value;
  if (!it || !ep || !playback || playback.isLocal) {
    localMissingTaskId.value = null;
    return;
  }
  const task = downloads.tasks.find(
    (t) => t.mediaId === it.id && t.episodeId === ep.id && t.status === 'completed',
  );
  localMissingTaskId.value = task?.id ?? null;
}

/**
 * 重新下载（AC-78②）。
 *
 * 不直接 import `@/services/downloadService`（不在 UI 白名单），
 * 走白名单内的 `downloadStore.retry()`——已完成任务在 Service 内部即转入
 * `redownload()`（复用原记录：清空 blobKey/filePath、进度归零、重新入队）。
 */
async function onRedownload(): Promise<void> {
  const id = localMissingTaskId.value;
  if (!id || redownloading.value) return;
  redownloading.value = true;
  try {
    await downloads.retry(id);
    // 任务已回到 queued（blobKey=null），提示条随状态变化消失
    localMissingTaskId.value = null;
    toast.success('已重新加入下载队列', 3000);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    redownloading.value = false;
  }
}

/* ---------- 加载播放源 ---------- */
/**
 * 起播等待分级进度（问题一）：
 * resolvePlay → preparing → connecting → buffering → done，按阶段权重推进 progress。
 * 同一阶段内按已耗时秒数做对数渐进，避免视觉卡死。
 */
const loadingStageText = ref('正在加载…');
const loadingProgress = ref(0);
const loadingElapsed = ref(0);
let loadingStartTime = 0;
let loadingRafId = 0;
/** 当前所处阶段及其权重区间 [from, to] */
type StageKey = 'resolving' | 'preparing' | 'connecting' | 'buffering' | 'done';
let currentStage: StageKey = 'resolving';
const STAGE_RANGES: Record<StageKey, [number, number]> = {
  resolving: [0, 45],
  preparing: [45, 52],
  connecting: [52, 80],
  buffering: [80, 95],
  done: [95, 100],
};
const STAGE_TEXT: Record<StageKey, string> = {
  resolving: '正在解析播放地址…',
  preparing: '正在准备数据…',
  connecting: '正在连接播放器…',
  buffering: '正在缓冲首帧…',
  done: '即将播放',
};

function setStage(stage: StageKey, detail?: string): void {
  if (stage === currentStage && !detail) return;
  currentStage = stage;
  if (stage === 'done') {
    loadingProgress.value = 100;
    loadingStageText.value = STAGE_TEXT.done;
    return;
  }
  loadingStageText.value = detail
    ? `${STAGE_TEXT[stage]}（${detail}）`
    : STAGE_TEXT[stage];
  // 阶段切换时把 progress 拉到区间起点，避免回退
  const [from] = STAGE_RANGES[stage];
  if (loadingProgress.value < from) loadingProgress.value = from;
}

function startLoadingProgress(): void {
  cancelLoadingProgress();
  loadingStartTime = Date.now();
  loadingProgress.value = 0;
  loadingElapsed.value = 0;
  currentStage = 'resolving';
  loadingStageText.value = STAGE_TEXT.resolving;
  const tick = (): void => {
    const elapsedMs = Date.now() - loadingStartTime;
    loadingElapsed.value = Math.floor(elapsedMs / 1000);
    const [from, to] = STAGE_RANGES[currentStage];
    const span = to - from;
    // 对数渐进：阶段内按 sqrt(elapsed/预算) 逼近上限，避免卡死感
    const stageBudgetMs = currentStage === 'resolving' ? 10000 : 5000;
    const ratio = Math.min(1, Math.sqrt(elapsedMs / stageBudgetMs));
    const target = from + span * ratio * 0.9; // 留 10% 给事件驱动跳变
    if (target > loadingProgress.value) loadingProgress.value = target;
    // 6s 后升级文案（保留旧逻辑的"源响应较慢"提示）
    if (elapsedMs > 6000 && currentStage === 'resolving') {
      loadingStageText.value = '源响应较慢，仍在连接…';
    }
    loadingRafId = requestAnimationFrame(tick);
  };
  loadingRafId = requestAnimationFrame(tick);
}

function cancelLoadingProgress(): void {
  if (loadingRafId) {
    cancelAnimationFrame(loadingRafId);
    loadingRafId = 0;
  }
}

// 监听 play:stage 事件（来自 libraryService 重试上报等）
const offPlayStage = appEvents.on('play:stage', (payload) => {
  if (payload.stage === 'retrying') {
    setStage('resolving', '首次连接失败，正在重试…');
    loadingProgress.value = 20;
    loadingStartTime = Date.now(); // 重置已耗时
  }
});
onBeforeUnmount(offPlayStage);

/**
 * 直链带防盗链头时经本机回环代理注入（P1-6）。
 * HLS 由 hls.js 的 xhrSetup 注入头，不需要；代理失败沿用原地址（与旧行为一致）。
 */
async function preparePlayback(playback: PlaybackSource): Promise<PlaybackSource> {
  const proxied = await localProxyUrl(playback);
  return proxied ? { ...playback, url: proxied } : playback;
}

/**
 * 加载代次（REV-28）：切集/切线并发触发时，过期任务只允许静默退出——
 * 既不能把错误面板盖到新画面上，也不能让慢的旧任务反过来顶掉新任务。
 */
let loadEpoch = 0;

/**
 * 页面存活守卫：卸载后所有异步续体必须自行退出，避免后台链路劫持路由/覆盖全局状态。
 * 与 loadEpoch 配合——卸载时 ++loadEpoch 作废在飞任务的代次校验。
 */
let pageAlive = true;
const pageAbort = new AbortController();

/**
 * REV-24：详情加载失败但本地有下载完成的任务时，直接加载本地播放。
 * 不走 resolveAndLoad（它依赖 item/episodes），而是直接构造播放参数。
 */
async function loadLocalPlay(
  playback: PlaybackSource,
  title: string,
  posterUrl: string | null,
  episodeId: string,
): Promise<void> {
  pageLoading.value = true;
  loadError.value = null;
  startLoadingProgress();
  try {
    const prepared = await preparePlayback(playback);
    currentPlayback.value = prepared;
    // 从历史记录获取起播位置
    const record = history.items.find((r) => r.mediaId === mediaId.value && r.episodeId === episodeId);
    let start = 0;
    if (record && !restart.value) {
      start = record.positionSec;
    }
    if (stageRef.value && !controller.value) {
      createController(stageRef.value);
    }
    // REV-24：构造最小化的 PlayerLoadOptions 用于本地播放
    // 由于详情加载失败，我们只有 playback 和基本信息，需要构造占位符
    await controller.value?.load({
      mediaId: mediaId.value ?? 'local',
      episodeId,
      lineId: 'local',
      title,
      posterUrl,
      playback: prepared,
      startPositionSec: start,
      totalEpisodes: null,
      episodes: [],
      preferLocal: true,
    });
  } catch (e) {
    if (isCanceled(e)) return;
    loadError.value = toErrorShape(e, 'E_NO_PLAY_URL').message;
  } finally {
    pageLoading.value = false;
    cancelLoadingProgress();
  }
}

/**
 * 解析并加载当前集/线路。
 * 返回是否成功：`resolvePlay` 抛错 → `loadError`；引擎加载失败 → `player.error`。
 * 线路切换需要据此判断是否回退原线路（AC-55 / REV-05）。
 */
async function resolveAndLoad(): Promise<boolean> {
  const epoch = ++loadEpoch;
  const it = item.value;
  const ep = currentEpisode.value;
  if (!it || !ep) {
    loadError.value = '找不到要播放的内容';
    pageLoading.value = false;
    return false;
  }
  pageLoading.value = true;
  loadError.value = null;
  loadErrorShape.value = null;
  noVideoDismissed.value = false;
  startLoadingProgress();
  // v1.7/CHG-21：记录起播时刻——失败自动兜底只在窗口期内触发
  failoverStartedAt.value = Date.now();
  const resolveStartTime = Date.now();
  try {
    const playback = await library.resolvePlay(it.id, ep.id, currentLineId.value);
    if (!pageAlive || epoch !== loadEpoch) return false;
    setStage('preparing');
    const prepared = await preparePlayback(playback);
    if (!pageAlive || epoch !== loadEpoch) return false;
    setStage('connecting');
    currentPlayback.value = prepared;
    const rec = history.progressOf(it.sourceId, it.id);
    let start = 0;
    if (!restart.value && rec && rec.episodeId === ep.id) {
      const duration = rec.durationSec > 0 ? rec.durationSec : (ep.durationSec ?? 0);
      const ratio = duration > 0 ? rec.positionSec / duration : 0;
      if (ratio > 0.05 && ratio < 0.95) start = rec.positionSec;
    }
    // P0-7: 续播位置注入 PlaybackSource，原生引擎随 prepare 下发（省掉起播后 seek）
    if (start > 0) {
      prepared.startPositionMs = start * 1000;
    }

    const episodeRefs = episodes.value.map((e) => ({
      episodeId: e.id,
      number: e.number,
      title: e.title,
    }));

    const opts: PlayerLoadOptions = {
      mediaId: it.id,
      episodeId: ep.id,
      lineId: prepared.lineId,
      title: it.title,
      posterUrl: it.posterUrl,
      playback: prepared,
      startPositionSec: start,
      totalEpisodes: episodes.value.length > 0 ? episodes.value.length : null,
      episodes: episodeRefs,
      preferLocal: prepared.isLocal,
      preferNativeEngine: nativeEngineEnabled.value || forceNativeEngine.value,
      resolveEpisode: async (targetEpisodeId) => {
        const target = episodes.value.find((e) => e.id === targetEpisodeId);
        if (!target) throw new Error('剧集不存在');
        const nextPlayback = await library.resolvePlay(it.id, target.id, currentLineId.value);
        const nextPrepared = await preparePlayback(nextPlayback);
        return {
          mediaId: it.id,
          episodeId: target.id,
          lineId: nextPrepared.lineId,
          title: it.title,
          posterUrl: it.posterUrl,
          playback: nextPrepared,
          startPositionSec: 0,
          totalEpisodes: episodes.value.length,
          episodes: episodeRefs,
          preferLocal: nextPrepared.isLocal,
          preferNativeEngine: nativeEngineEnabled.value || forceNativeEngine.value,
        };
      },
    };

    await load(opts);
    if (!pageAlive || epoch !== loadEpoch) return false;
    setStage('done');
    // 「本地文件不可用，已切换网络源」时在页面给出「重新下载」入口（AC-78②）
    detectLocalMissing();
    // `load()` 内部把失败写入 player.error 而不抛出，这里显式判定
    const ok = loadError.value === null && player.error === null;
    if (ok) {
      // 起播成功：重置自动兜底状态（CHG-21），下次失败重新各试一次
      failoverLineTried.value = false;
      failoverSourceTried.value = false;
      // 批次1：记录线路成功
      const line = currentLine.value;
      if (line && it) {
        lineHealthService.recordSuccess(lineKey(it.sourceId, it.sourceItemId, line.name), Date.now() - resolveStartTime);
      }
    }
    return ok;
  } catch (e) {
    if (!pageAlive || epoch !== loadEpoch) return false;
    // P0-3：解析失败也失效缓存，避免重试复用坏 URL
    library.invalidatePlayCache(mediaId.value);
    const shape = toErrorShape(e, 'E_NO_PLAY_URL');
    // 批次1：记录线路失败（按错误分类）
    const line = currentLine.value;
    if (line && it) {
      lineHealthService.recordFail(lineKey(it.sourceId, it.sourceItemId, line.name), shape.code);
    }
    // 失败换线时并发解析会双跑：先成功者已在播，后失败者（嗅探 15s 超时）若把
    // 错误面板盖上去，用户看到的是「有声音却报无播放地址」。播放中一律不覆盖。
    if (player.playing) return false;
    loadErrorShape.value = shape;
    loadError.value = shape.message;
    void runFailover(shape, 'resolve');
    return false;
  } finally {
    // 只有最新一代负责收尾，避免旧任务把新任务的 loading 关掉
    if (pageAlive && epoch === loadEpoch) {
      pageLoading.value = false;
      cancelLoadingProgress();
    }
  }
}

onMounted(async () => {
  void detectCastSupport();
  // REV-24：sources 用于详情失败时判断源是否存在
  await Promise.all([settings.load(), history.load(), favorites.load(), downloads.load(), sources.load()]);
  // P1-4：记忆音量/亮度
  if (settings.player?.rememberVolumeBrightness) {
    player.patch({
      volume: settings.player.lastVolume ?? 100,
      dim: brightnessToDimOpacity(settings.player.lastBrightness ?? 100),
    });
  }
  await library.loadDetail(mediaId.value);
  detailReady.value = true;
  if (library.detailState === 'error') {
    // REV-24：详情失败但本地有下载完成的任务时，允许直接本地播放
    const episodeId = route.params.episodeId as string | undefined;
    if (episodeId) {
      const localPlay = await downloadService.findLocalPlay(mediaId.value, episodeId);
      if (localPlay) {
        // 本地播放可用，跳过详情加载错误，直接进入播放
        if (stageRef.value) createController(stageRef.value);
        // 构造一个最小化的 item 描述用于进度写回
        const record = history.items.find((r) => r.mediaId === mediaId.value);
        if (record) {
          // 直接调用 resolveAndLoad 会失败（因为 item 为 null），
          // 所以这里手动构造播放参数
          pageLoading.value = false;
          loadError.value = null;
          // 直接加载本地播放地址
          await loadLocalPlay(localPlay, record.title, record.posterUrl, episodeId);
          return;
        }
      }
    }
    loadError.value = library.error?.message ?? '详情加载失败';
    pageLoading.value = false;
    return;
  }
  if (stageRef.value) createController(stageRef.value);
  // EXT-07：控制器建好后订阅内嵌轨道状态（切集由控制器自己重置）
  bindEmbeddedTracks();
  await resolveAndLoad();
  // AC-68：记录集号已下线时明确提示，而不是静默从第 1 集起播
  announceOfflineEpisode();
});

/* ---------- 关闭时写回进度 ---------- */
onBeforeUnmount(() => {
  cancelAutoNext();
  // 页面存活守卫：卸载后作废所有在飞异步链，防止后台链路劫持路由/覆盖全局状态
  pageAlive = false;
  ++loadEpoch;
  pageAbort.abort();
  // P1-4：记忆音量/亮度写回
  if (settings.player?.rememberVolumeBrightness) {
    const brightness = Math.round(dimOpacityToBrightness(player.dim));
    void settings.update({
      player: {
        ...settings.player,
        lastVolume: Math.round(player.volume),
        lastBrightness: brightness,
      },
    });
  }
});

/* ---------- 标题/集标签 ---------- */
const titleText = computed(() => fallbackTitle.value);
const episodeLabel = computed(() => {
  const ep = currentEpisode.value;
  if (!ep) return '';
  if (!hasEpisodeNav.value && episodes.value.length <= 1) return '';
  return `第 ${ep.number} 集${ep.title && ep.title !== `第 ${ep.number} 集` ? ` · ${ep.title}` : ''}`;
});
const qualityLabel = computed(() => (resolvedQuality.value === QUALITY_AUTO ? '自动' : resolvedQuality.value));

/* ---------- 操作 ---------- */

/**
 * 返回键 / 顶栏返回（AC-52 返回键分层）：
 * - 第 1 次：全屏中 → 只退全屏，保持播放页与播放状态；
 * - 第 2 次：退出播放页 → 先 `flushProgress()` 写回进度，再回详情。
 *
 * 同时注册到 `useBackButton`（Android 硬件返回键），使物理返回键与 UI 返回
 * 走完全相同的分支。
 */
function goBack(): void {
  if (player.fullscreen) {
    void exitFullscreen();
    return;
  }
  void playerCtl.controller.value?.flushProgress();
  if (globalThis.history.length > 1) router.back();
  else void router.replace({ name: 'detail', params: { mediaId: mediaId.value } });
}

useBackButton({
  // 始终消费：与顶栏返回按钮完全同一套分支（全屏→退全屏；否则写回进度→回详情），
  // 避免 Android 返回键走 useBackButton 默认的 router.back() 而跳过进度写回。
  handler: () => {
    goBack();
    return true;
  },
});

function openDetail(): void {
  void router.replace({ name: 'detail', params: { mediaId: mediaId.value } });
}

/** REV-24：源已移除时，删除该历史记录并返回首页 */
async function removeHistoryAndGoBack(): Promise<void> {
  const record = history.items.find((r) => r.mediaId === mediaId.value);
  if (record) {
    await history.remove(record.id);
  }
  void router.replace({ name: 'home' });
}

/* ---------- 切换线路（AC-31 保持集号 / AC-55 失败回退原线路） ---------- */

/**
 * 线路切换内部改路由时，`episodeId` watcher 会跟着触发第二次加载。
 * 这里用"待加载目标集"标记让 watcher 跳过——比布尔开关更精确（只吞自己发起的那一次）。
 */
let pendingLineSwitchEpisode: string | null = null;

/**
 * 换源/外部导航改路由时，`mediaId` watcher 会触发重复加载。
 * 用"待加载目标媒体"标记让 watcher 跳过自己发起的那一次。
 */
let pendingMediaSwitch: string | null = null;

/** 当前线路下按集号取目标集（保持集号，AC-31）；找不到同集号时回退首集 */
function episodeOnLine(lineIdValue: string, number: number): Episode | null {
  const all = library.detail?.episodes ?? [];
  const list = all.filter((ep) => ep.lineId === lineIdValue).sort((a, b) => a.number - b.number);
  return list.find((ep) => ep.number === number) ?? list[0] ?? null;
}

/** 只更新路由（集号 / 线路 query），加载由调用方统一负责 */
async function replaceRoute(episodeId: string | null, targetLineId: string | null): Promise<void> {
  if (episodeId === episodeIdParam.value && targetLineId === lineIdParam.value) return;
  await router.replace({
    name: 'player',
    params: { mediaId: mediaId.value, ...(episodeId ? { episodeId } : {}) },
    query: targetLineId ? { lineId: targetLineId } : {},
  });
}

/**
 * 切换到目标线路；失败时恢复原线路与原集并提示（AC-55）。
 *
 * `resolveAndLoad()` 会重建引擎，因此"回退"是重新加载原线路（不是复用旧实例），
 * 对用户表现为"未切走"；原线路也失败时给出更明确的提示。
 */
async function switchLine(targetLineId: string): Promise<void> {
  const it = item.value;
  const previousLineId = currentLineId.value;
  if (!it || targetLineId === previousLineId || switchingLine.value) return;
  const previousEpisodeId = currentEpisode.value?.id ?? null;
  const currentNumber = currentEpisode.value?.number ?? 1;
  const targetEpisode = episodeOnLine(targetLineId, currentNumber);

  // P1-4: 记住当前播放位置，切线后续播
  const currentPositionSec = playerCtl.controller.value?.getState().currentTime ?? 0;

  switchingLine.value = true;
  try {
    lineId.value = targetLineId;
    pendingLineSwitchEpisode = targetEpisode?.id ?? previousEpisodeId;
    await replaceRoute(targetEpisode?.id ?? previousEpisodeId, targetLineId);
    if (!pageAlive) return;
    if (await resolveAndLoad()) {
      if (!pageAlive) return;
      // P1-4: 切线成功后跳转到原位置（跳过前 5 秒的"从头开始"场景）
      if (currentPositionSec > 5) {
        playerCtl.controller.value?.seek(currentPositionSec);
      }
      return;
    }

    // ---- 回退原线路 ----
    if (!pageAlive) return;
    lineId.value = previousLineId;
    pendingLineSwitchEpisode = previousEpisodeId;
    await replaceRoute(previousEpisodeId, previousLineId);
    const restored = await resolveAndLoad();
    toast.info(restored ? '切换失败，已保持原线路' : '切换失败，原线路也无法播放');
  } finally {
    pendingLineSwitchEpisode = null;
    switchingLine.value = false;
  }
}

async function onSwitchLine(): Promise<void> {
  if (lines.value.length <= 1) {
    toast.info('该内容只有一条线路');
    return;
  }
  const next = lines.value.find((l) => l.id !== currentLineId.value);
  if (!next) return;
  await switchLine(next.id);
}

/* ---------- v1.7/CHG-21：起播失败自动换线 → 换源（FR-53） ---------- */

const failoverStartedAt = ref(0);
const failoverLineTried = ref(false);
const failoverSourceTried = ref(false);
const failoverRunning = ref(false);

/** 源侧故障码（与 17.6 口径一致 + 解码/无地址），命中才考虑自动兜底 */
const FAILOVER_ERROR_CODES = new Set([
  'E_NETWORK',
  'E_TIMEOUT',
  'E_DECODE',
  'E_SOURCE_UNAVAILABLE',
  'E_NO_PLAY_URL',
  'E_UNSUPPORTED_FORMAT',
  'E_PARSE',
]);

/** v1.8/CHG-26：错误码指向「源健康问题」时，错误面板给出去体检的入口 */
const HEALTH_CHECK_CODES = new Set([
  'E_SOURCE_UNAVAILABLE',
  'E_NETWORK',
  'E_TIMEOUT',
  'E_HTTP_401',
  'E_HTTP_403',
  'E_HTTP_429',
  'E_HTTP_5XX',
]);

const canHealthCheck = computed(() => {
  const err = player.error ?? null;
  return err !== null && HEALTH_CHECK_CODES.has(err.code);
});

/** v1.8/CHG-26：手动换源可用性——有详情且在线（跨源候选搜索需要网络） */
const canSwitchSourceManual = computed(() => item.value !== null && isOnlineNow());

/* ---------- P0-1 / P1-4：解析失败的可行动引导 ---------- */

/** 解析失败的可行动原因（源站真死 / 解析超时 / 协议不支持 / 规则脚本异常） */
const loadErrorGuidance = computed(() => (loadErrorShape.value ? guidanceOf(loadErrorShape.value) : null));

/** 磁力地址：有值时给「用外部应用打开」，否则重试没有任何意义 */
const loadErrorMagnet = computed(() => magnetUrlOf(loadErrorShape.value));

/**
 * 黑屏兜底：用原生引擎（ExoPlayer）重试当前集。
 * 不写设置——只在本次页面会话内强制，退出重进恢复默认。
 */
async function retryWithNativeEngine(): Promise<void> {
  forceNativeEngine.value = true;
  toast.info('已切换原生引擎重试');
  await resolveAndLoad();
  if (!pageAlive) return;
  if (player.error || loadError.value) {
    forceNativeEngine.value = false;
    toast.info('原生引擎也没能解码，建议换线路');
  }
}

function dismissNoVideo(): void {
  noVideoDismissed.value = true;
}

/** 外部应用打开（磁力交给下载器/播放器；失败给明确 Toast） */
async function openExternalUrl(url: string): Promise<void> {
  const result = await castService.openExternal(url);
  if (result.started) return;
  if (result.reason === 'unsupported-platform') {
    toast.info('当前环境无法打开外部链接（仅 Android App 支持）');
    return;
  }
  toast.error(result.error?.message ?? '打开失败，请安装下载器后重试');
}

function withinFailoverWindow(): boolean {
  return failoverStartedAt.value > 0 && Date.now() - failoverStartedAt.value <= PLAYER_FAILOVER_WINDOW_MS;
}

/**
 * P1-3：轻量换源——限制搜索范围与超时，避免用户等太久。
 *
 * 与详情页的完整跨源搜索不同，播放中换源只尝试「健康度最好的 5 个其它源」，
 * 整体超时 12s。找到第一个可播候选即返回，不再继续搜索。
 */
const ALTERNATE_SEARCH_TIMEOUT_MS = 12000;
const ALTERNATE_MAX_CANDIDATES = 5;

async function lookupAlternateSource(): Promise<{
  mediaId: string;
  episodeId: string;
  sourceName: string;
} | null> {
  const it = item.value;
  if (!it || !isOnlineNow()) return null;
  try {
    // P1-3：给搜索加超时，避免慢源拖住整体换源速度
    const searchPromise = libraryService.search({ keyword: it.title, signal: pageAbort.signal });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new AppError('E_TIMEOUT', '换源搜索超时')), ALTERNATE_SEARCH_TIMEOUT_MS),
    );
    const [result, allSources] = await Promise.all([
      Promise.race([searchPromise, timeoutPromise]),
      sourceService.list(),
    ]);
    if (!pageAlive) return null;
    const sourceById = new Map(allSources.map((s) => [s.id, s]));
    const candidates = pickPlayCandidates(it.title, it.year, result.items, sourceById, (id) =>
      healthService.latencyOf(id),
    )
      .filter((candidate) => candidate.source.id !== it.sourceId)
      .slice(0, ALTERNATE_MAX_CANDIDATES);
    for (const candidate of candidates) {
      try {
        const detail = await libraryService.getDetail(candidate.item.id);
        if (!pageAlive) return null;
        const target =
          detail.episodes.find((ep) => ep.number === (currentEpisode.value?.number ?? 1)) ?? detail.episodes[0];
        if (!target) continue;
        return { mediaId: candidate.item.id, episodeId: target.id, sourceName: candidate.source.name };
      } catch {
        continue; // 候选源也失败 → 顺延下一个
      }
    }
  } catch {
    /* 搜索失败/超时：按无候选处理 */
  }
  return null;
}

/**
 * 应用换源结果：导航到目标 mediaId/episodeId、加载详情、复位线路、触发播放。
 * 每一步都检查 pageAlive，避免后台链路劫持路由。
 */
async function applyAlternateSource(target: {
  mediaId: string;
  episodeId: string;
  sourceName: string;
}): Promise<boolean> {
  if (!pageAlive) return false;
  // 复位线路（旧线路 id 对新片无效）
  lineId.value = null;
  // 抑制 episodeId / mediaId watcher 重复加载（与 switchLine 共用机制）
  pendingLineSwitchEpisode = target.episodeId;
  pendingMediaSwitch = target.mediaId;
  try {
    // P0-2：显式清空 lineId query，避免旧线路 id 残留导致新源 0 集
    await router.replace({
      name: 'player',
      params: { mediaId: target.mediaId, episodeId: target.episodeId },
      query: {},
    });
    if (!pageAlive) return false;
    await library.loadDetail(target.mediaId);
    if (!pageAlive) return false;
    return await resolveAndLoad();
  } finally {
    pendingLineSwitchEpisode = null;
    pendingMediaSwitch = null;
  }
}

function isOnlineNow(): boolean {
  return navigator.onLine !== false;
}

/** 起播窗口内失败：自动换线（最多3条按评分排序）→ 自动换源（一次）→ 才落到错误面板。
 * 引擎错误与解析错误共用同一条链（解析失败过去只落错误面板，不自动兜底）。 */
async function runFailover(error: AppErrorShape, origin: 'player' | 'resolve'): Promise<void> {
  if (failoverRunning.value) return;
  if (!FAILOVER_ERROR_CODES.has(error.code) || !withinFailoverWindow()) return;
  failoverRunning.value = true;
  try {
    // ① 换线路（批次1：按评分排序，最多试3条）
    if (!failoverLineTried.value && lines.value.length > 1) {
      failoverLineTried.value = true;
      const it = item.value;
      if (!it) {
        // 无 item 时回退到原逻辑（取第一条其它线路）
        const other = lines.value.find((l) => l.id !== currentLineId.value);
        if (other) {
          toast.info('起播失败，自动切换到其它线路…');
          await switchLine(other.id);
          if (!pageAlive) return;
          if (player.error === null && loadError.value === null) return;
        }
      } else {
        // 批次1：按评分排序取候选线路
        const ranked = rankLines({
          lines: lines.value,
          historyEpisodeId: null, // failover 不恢复历史
          episodes: episodes.value,
          buildKey: (line) => lineKey(it.sourceId, it.sourceItemId, line.name),
        });
        const candidates = ranked.filter((l) => l.id !== currentLineId.value).slice(0, 3);
        
        for (const candidate of candidates) {
          if (!pageAlive) return;
          toast.info(`起播失败，自动切换到线路「${candidate.name}」…`);
          await switchLine(candidate.id);
          if (!pageAlive) return;
          if (player.error === null && loadError.value === null) return; // 换线成功
        }
      }
    }
    // ② 换源（同名同年在其它源重找片源；进度按集号延续）
    if (!failoverSourceTried.value) {
      failoverSourceTried.value = true;
      player.patch({ error: null });
      toast.info('当前源无法播放，正在尝试其它来源…');
      const target = await lookupAlternateSource();
      if (!pageAlive) return;
      if (target) {
        toast.info(`已切换到「${target.sourceName}」继续播放`);
        const ok = await applyAlternateSource(target);
        if (!pageAlive) return;
        if (ok && player.error === null && loadError.value === null) return;
      }
    }
    // 兜底失败：恢复错误面板（清掉的错误重新呈现）
    if (!pageAlive) return;
    if (player.error === null && loadError.value === null) {
      if (origin === 'player') player.patch({ error });
      else {
        loadErrorShape.value = error;
        loadError.value = error.message;
      }
    }
  } finally {
    failoverRunning.value = false;
  }
}

watch(
  () => player.error,
  (error) => {
    if (error) {
      // P0-3：播放出错时失效缓存，避免重试/换线复用已过期的坏 URL
      library.invalidatePlayCache(mediaId.value);
      // 批次1：记录线路失败（按错误分类）
      const line = currentLine.value;
      const it = item.value;
      if (line && it) {
        lineHealthService.recordFail(lineKey(it.sourceId, it.sourceItemId, line.name), error.code);
      }
      void runFailover(error, 'player');
    }
  },
);

/** LineSelector 选择线路：保持当前集号（AC-31） */
async function onSwitchLineById(id: string): Promise<void> {
  await switchLine(id);
}

/**
 * v1.8/CHG-26：手动换源——复用自动链的 findAlternateSource（同名同年跨源）。
 * 自动兜底只各试一次；用户手动触发时复位标志，成功后 resolveAndLoad 会再次复位。
 */
async function onSwitchSource(): Promise<void> {
  if (failoverRunning.value) return;
  const lastError = player.error;
  failoverRunning.value = true;
  failoverLineTried.value = false;
  failoverSourceTried.value = false;
  player.patch({ error: null });
  try {
    toast.info('正在尝试其它来源…');
    const target = await lookupAlternateSource();
    if (!pageAlive) return;
    if (target) {
      toast.info(`已切换到「${target.sourceName}」继续播放`);
      const ok = await applyAlternateSource(target);
      if (!pageAlive) return;
      if (ok && player.error === null && loadError.value === null) return;
    }
  } finally {
    failoverRunning.value = false;
  }
  // 手动也失败：恢复错误面板（清掉的错误重新呈现）
  if (!pageAlive) return;
  if (player.error === null && loadError.value === null && lastError) {
    player.patch({ error: lastError });
  }
}

/** v1.8/CHG-26：跳设置页源管理区（一键禁用失效源入口） */
function goHealthCheck(): void {
  void router.push('/settings');
}

async function onCast(): Promise<void> {
  // 首版仅系统分享（API-11）；能力探测失败必须给出提示而不是抛错（AC-82）。
  try {
    const supported = await castService.isSupported();
    if (!supported) {
      castSupported.value = false;
      toast.info('当前平台不支持投屏，请在 Android App 内使用');
      return;
    }
    const playback = currentPlayback.value;
    if (!playback) {
      toast.info('暂无可投屏的内容');
      return;
    }
    playerCtl.controller.value?.pause();
    const result = await castService.cast({
      kind: 'url',
      url: playback.url,
      mime: playback.format === 'hls' ? 'application/x-mpegURL' : 'video/*',
      title: titleText.value,
      linkedUrl: playback.url,
    });
    if (!result.started) {
      toast.info(result.reason === 'canceled' ? '已取消投屏' : '未找到可用的投屏目标');
    }
  } catch (e) {
    toast.info(toErrorShape(e).message);
  }
}

async function onDownloadCurrent(): Promise<void> {
  const it = item.value;
  const ep = currentEpisode.value;
  if (!it || !ep) return;
  downloading.value = true;
  try {
    const inputs = await library.toDownloadInputs(it.id, [ep.id]);
    // REV-07 / AC-76：Web 端 >1GB 在下单前提示改用 App；确认后仍可继续
    const largeFileHint = await downloads.checkLargeFile(inputs);
    if (largeFileHint !== null) {
      const goOn = await ui.confirm({
        title: '文件较大',
        message: largeFileHint,
        confirmText: '仍要下载',
      });
      if (!goOn) return;
    }
    // REV-15 / FR-30：重复下载给出明确提示，而不是静默忽略
    const { created, skipped } = await downloads.createMany(inputs);
    pickerOpen.value = false;
    if (created.length === 0 && skipped.length > 0) {
      toast.info('该集已在下载列表中');
      return;
    }
    toast.success(skipped.length > 0 ? '已加入下载（该集已在列表中）' : '已加入下载');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    downloading.value = false;
  }
}

async function onToggleFavorite(): Promise<void> {
  const it = item.value;
  if (!it) return;
  const added = await favorites.toggle({
    sourceId: it.sourceId,
    mediaId: it.id,
    title: it.title,
    posterUrl: it.posterUrl,
    type: it.type,
    year: it.year,
  });
  toast.success(added ? '已收藏' : '已取消收藏');
}

const isFavorite = computed(() => {
  const it = item.value;
  return it ? favorites.isFavorite(it.sourceId, it.id) : false;
});

const downloadedIds = computed(() => {
  const it = item.value;
  if (!it) return [];
  return downloads.tasks.filter((t) => t.mediaId === it.id && t.status === 'completed').map((t) => t.episodeId);
});

async function copyError(): Promise<void> {
  const err = player.error;
  if (!err) return;
  // 带上解析出的地址与格式：区分"返回的是网页页/403 页面"还是"编码不受支持"全靠这两项
  const playback = currentPlayback.value;
  const lines = [
    `code=${err.code}`,
    `message=${err.message}`,
    `detail=${err.detail ?? ''}`,
    `http=${err.httpStatus ?? ''}`,
    `format=${playback?.format ?? ''}`,
    `url=${playback?.url ?? ''}`,
  ];
  const text = lines.join('\n');
  try {
    await navigator.clipboard?.writeText(text);
    toast.success('已复制错误信息');
  } catch {
    toast.info(text);
  }
}

function onSubtitleSettings(patch: Partial<SubtitleSettings>): void {
  localSubtitles.value = { ...localSubtitles.value, ...patch };
  if (patch.offsetSec !== undefined) setSubtitleOffset(patch.offsetSec);
  void settings.update({
    player: { ...playerSettings.value, subtitle: { ...localSubtitles.value, ...patch } },
  });
}

function onDisplayModeSelect(mode: ResizeMode): void {
  setResizeMode(mode);
  void settings.update({ player: { ...playerSettings.value, resizeMode: mode } });
}

/**
 * 选集：只改路由，加载由 `episodeId` watcher 唯一入口负责（REV-28）。
 * 之前这里与 watcher 各调一次 `resolveAndLoad()`，一次切集会发两遍清单请求，
 * 且旧请求被取消后还会把 E_ABORTED 写进错误面板。
 */
function chooseEpisode(ep: Episode): void {
  episodeOpen.value = false;
  if (ep.id === currentEpisode.value?.id) return;
  void router.replace({
    name: 'player',
    params: { mediaId: mediaId.value, episodeId: ep.id },
    query: currentLineId.value ? { lineId: currentLineId.value } : {},
  });
}

function retryPanel(): void {
  // P0-3：重试时先失效缓存，避免复用导致失败的旧 URL
  library.invalidatePlayCache(mediaId.value);
  void resolveAndLoad();
}

function onBackgroundContinue(): void {
  resumeFromBackground();
  void togglePlay();
}

function onBackgroundExit(): void {
  resumeFromBackground();
  goBack();
}

/* ---------- v1.7/CHG-22：弹幕（只读展示） ---------- */

const danmakuOpen = ref(false);
const danmakuStylePanelOpen = ref(false);
const danmakuOverlay = shallowRef<DanmakuOverlay | null>(null);

/** P1-3：弹幕设置面板打开时也暂停自动隐藏 */
watch(danmakuOpen, (open) => {
  if (open) pauseAutoHide();
});
watch(danmakuStylePanelOpen, (open) => {
  if (open) pauseAutoHide();
});

const danmakuSettings = computed(
  () =>
    settings.settings?.danmaku ?? {
      enabled: false,
      fontSize: 16,
      opacity: 0.8,
      speed: 1,
      areaPercent: 50,
      merge: true,
      safeBottomPercent: 15,
      bold: false,
      strokeStyle: 'shadow' as const,
      density: 'normal' as const,
      filterTop: false,
      filterBottom: false,
    },
);

/** 弹幕可用性：设置开启 + 正在播放 + 有当前集号 */
const danmakuReady = computed(() => danmakuSettings.value.enabled && currentEpisode.value !== null && !pageLoading.value);

/** 按当前媒体/集号拉取弹幕（缓存命中离线可用；关闭开关不发请求） */
/**
 * 加载本集弹幕。返回是否真的拿到了弹幕（0 条也算没拿到）——
 * 调用方据此给反馈，避免「点了弹幕按钮什么都不发生」。
 */
async function loadDanmaku(): Promise<boolean> {
  const it = item.value;
  const ep = currentEpisode.value;
  if (!it || !ep || !danmakuSettings.value.enabled) {
    danmakuOverlay.value?.clear();
    return false;
  }
  try {
    const match = await danmakuService.match(it.title, it.year, ep.number);
    if (match === null || match.comments.length === 0) return false;
    const comments = danmakuSettings.value.merge ? danmakuService.dedupe(match.comments) : match.comments;
    danmakuOverlay.value?.load(comments);
    return true;
  } catch {
    /* 弹幕失败静默：不影响播放 */
    return false;
  }
}

async function toggleDanmaku(): Promise<void> {
  const next = !danmakuSettings.value.enabled;
  await settings.update({ danmaku: { ...danmakuSettings.value, enabled: next } });
  if (!next) {
    danmakuOverlay.value?.clear();
    toast.info('弹幕已关闭');
    return;
  }
  const loaded = await loadDanmaku();
  toast.info(loaded ? '弹幕已开启' : '当前集没有匹配到弹幕（B 站/腾讯可能都没有该片）', loaded ? 1800 : 2800);
}

/** v1.8 修复：原生引擎 surface 移到 WebView 之下，DOM 层（弹幕/字幕）可见，无需互斥 */

/* ---------- EXT-07：内嵌字幕 / 音轨（原生引擎） ---------- */

/**
 * 音轨偏好的本地存储 key。
 *
 * `settings.player` 契约没有音频字段（不在本次可改范围），按仓库既有先例
 * （如 `shared/healthTier` 的排序偏好）先存 localStorage，并已在自测记录里
 * 列为「待协调：迁移到 settings schema」。字幕偏好走 settings 的 `preferredLang`。
 */
const AUDIO_LANG_STORAGE_KEY = 'peanutmov.player.audio-language';

const embeddedTracks = ref<EmbeddedTrackState>(emptyEmbeddedTracks());
const tracksLoading = ref(false);
const tracksError = ref<string | null>(null);
/** 本集是否已应用过偏好（同一集内不再覆盖用户的手动选择） */
let trackPrefsAppliedFor: string | null = null;
let detachTrackSubscription: (() => void) | null = null;

const engineIsNative = computed(() => player.engineKind === 'native');
const activeAudioTrack = computed(
  () => embeddedTracks.value.audio.find((t) => t.id === embeddedTracks.value.activeAudioId) ?? null,
);
/** 沉浸态浮动音轨入口文案：有选中轨时带名称 */
const audioChipLabel = computed(() =>
  activeAudioTrack.value ? `音轨 · ${activeAudioTrack.value.label}` : '音轨',
);

/** 订阅控制器轨道状态（控制器在 onMounted 里创建，创建后调用一次） */
function bindEmbeddedTracks(): void {
  const c = playerCtl.controller.value;
  if (!c || detachTrackSubscription) return;
  embeddedTracks.value = c.getEmbeddedTracks();
  detachTrackSubscription = c.onEmbeddedTracksChange((state) => {
    embeddedTracks.value = state;
    if (state.loaded) {
      tracksLoading.value = false;
      tracksError.value = null;
    }
  });
}

function readAudioLanguagePref(): string | null {
  try {
    return globalThis.localStorage?.getItem(AUDIO_LANG_STORAGE_KEY) ?? null;
  } catch {
    // localStorage 不可用（隐私模式/配额满）→ 无偏好
    return null;
  }
}

function writeAudioLanguagePref(value: string): void {
  try {
    globalThis.localStorage?.setItem(AUDIO_LANG_STORAGE_KEY, value);
  } catch {
    // 写失败不影响本次会话内已生效的切换
  }
}

/** 偏好作用域：按集（同一影片切集也重新应用一次） */
function trackPrefsKey(): string {
  return `${mediaId.value}:${currentEpisode.value?.id ?? ''}`;
}

/**
 * 起播后应用一次偏好：
 * - 字幕：`settings.player.subtitle.preferredLang`（语言码；null = 上次主动关闭）
 * - 音轨：localStorage 里的语言码（无语言码时按标签匹配）
 * 只在「本集尚未应用过」时执行，避免每次轨道回调都覆盖用户手动选择。
 */
async function applyTrackPreferencesOnce(): Promise<void> {
  const c = playerCtl.controller.value;
  if (!c || !engineIsNative.value || !embeddedTracks.value.loaded) return;
  const key = trackPrefsKey();
  if (trackPrefsAppliedFor === key) return;
  trackPrefsAppliedFor = key;

  const textLang = subtitleSettings.value.preferredLang;
  if (textLang && embeddedTracks.value.activeTextId === null) {
    const hit = embeddedTracks.value.text.find((t) => t.language === textLang);
    if (hit) {
      try {
        await c.setEmbeddedSubtitleTrack(hit.id);
      } catch {
        // 旧安装包无此能力：保持播放器默认字幕
      }
    }
  }

  const audioLang = readAudioLanguagePref();
  if (audioLang && embeddedTracks.value.audio.length > 0) {
    const hit =
      embeddedTracks.value.audio.find((t) => t.language === audioLang) ??
      embeddedTracks.value.audio.find((t) => t.label === audioLang);
    if (hit && hit.id !== embeddedTracks.value.activeAudioId) {
      try {
        await c.setAudioTrack(hit.id);
      } catch {
        // 同上：失败不打断播放
      }
    }
  }
}

watch(embeddedTracks, () => void applyTrackPreferencesOnce());

async function refreshEmbeddedTracks(): Promise<void> {
  const c = playerCtl.controller.value;
  if (!c) {
    tracksLoading.value = false;
    return;
  }
  try {
    await c.refreshEmbeddedTracks();
    embeddedTracks.value = c.getEmbeddedTracks();
    tracksError.value = null;
  } catch (e) {
    tracksError.value = toErrorShape(e, 'E_NOT_IMPLEMENTED').message;
  } finally {
    tracksLoading.value = false;
  }
}

async function openEmbeddedSubtitleMenu(): Promise<void> {
  subtitleTrackOpen.value = true;
  tracksError.value = null;
  if (!embeddedTracks.value.loaded) tracksLoading.value = true;
  await refreshEmbeddedTracks();
}

async function openEmbeddedAudioMenu(): Promise<void> {
  audioTrackOpen.value = true;
  tracksError.value = null;
  if (!embeddedTracks.value.loaded) tracksLoading.value = true;
  await refreshEmbeddedTracks();
}

async function onSelectEmbeddedSubtitle(id: number | null): Promise<void> {
  const c = playerCtl.controller.value;
  if (!c) return;
  try {
    await c.setEmbeddedSubtitleTrack(id);
    const track = id === null ? null : embeddedTracks.value.text.find((t) => t.id === id) ?? null;
    localSubtitles.value = { ...localSubtitles.value, enabled: id !== null };
    // 记住偏好：语言码；「关闭字幕」落 null，下次起播保持关闭
    void settings
      .update({ player: { subtitle: { ...subtitleSettings.value, preferredLang: track?.language ?? null } } })
      .catch(() => undefined);
    toast.info(track ? `已切换字幕：${track.label}` : '字幕已关闭', 1500);
  } catch (e) {
    toast.info(toErrorShape(e, 'E_NOT_IMPLEMENTED').message);
  }
}

async function onSelectAudioTrack(id: number): Promise<void> {
  const c = playerCtl.controller.value;
  if (!c) return;
  const track = embeddedTracks.value.audio.find((t) => t.id === id) ?? null;
  try {
    await c.setAudioTrack(id);
    if (track) {
      writeAudioLanguagePref(track.language ?? track.label);
      toast.info(`已切换音轨：${track.label}`, 1500);
    }
  } catch (e) {
    toast.info(toErrorShape(e, 'E_NOT_IMPLEMENTED').message);
  }
}

function openExternalSubtitleSheet(): void {
  subtitleOpen.value = true;
}

/**
 * 字幕入口（控制条图标）：
 * - 原生引擎：打开内嵌字幕轨菜单（菜单底部可跳转外挂字幕与样式）
 * - WebView 引擎：维持原有外挂字幕面板
 */
function openSubtitlePanel(): void {
  if (engineIsNative.value) {
    void openEmbeddedSubtitleMenu();
    return;
  }
  subtitleOpen.value = true;
}

/** 设置开启/关闭 → 挂载或卸载渲染层 */
watch(danmakuReady, (ready) => {
  if (ready && stageRef.value && danmakuOverlay.value === null) {
    const overlay = new DanmakuOverlay({
      settings: danmakuSettings.value,
      getTime: () => player.currentTime,
      // 原生引擎 1s 才轮询一次进度：帧内按播放状态/倍速在锚点上插值
      isPlaying: () => player.playing,
      getRate: () => player.rate,
    });
    overlay.attach(stageRef.value);
    danmakuOverlay.value = overlay;
    void loadDanmaku();
  } else if (!ready && danmakuOverlay.value !== null) {
    danmakuOverlay.value.detach();
    danmakuOverlay.value = null;
  }
});

// 设置变化（字号/速度等）即时生效
watch(danmakuSettings, (next) => danmakuOverlay.value?.setSettings(next), { deep: true });

// 播放进度驱动弹幕时间轴（store.currentTime 由 timeupdate 事件更新）
// 用 rAF 合并：多次 currentTime 变化合并为一帧 tick，避免高频 watch 开销
let danmakuRafId = 0;
watch(
  () => player.currentTime,
  (t) => {
    if (danmakuRafId) return; // 已有 pending rAF，跳过
    danmakuRafId = requestAnimationFrame(() => {
      danmakuRafId = 0;
      danmakuOverlay.value?.tick(t);
    });
  },
);

// 切集重新匹配弹幕
watch(
  () => currentEpisode.value?.id,
  () => void loadDanmaku(),
);

onBeforeUnmount(() => {
  if (danmakuRafId) {
    cancelAnimationFrame(danmakuRafId);
    danmakuRafId = 0;
  }
  danmakuOverlay.value?.detach();
  danmakuOverlay.value = null;
});

/* ---------- 监听 route 集号变化（选集/切集后重新加载） ---------- */
watch(episodeIdParam, async (next, prev) => {
  if (!detailReady.value || next === prev) return;
  // 线路切换内部改路由时由 `switchLine` 自己加载，这里跳过以免同一集加载两次
  if (pendingLineSwitchEpisode !== null && next === pendingLineSwitchEpisode) return;
  await resolveAndLoad();
  // 直接带旧集号进入（历史/继续观看）时同样提示已下线（AC-68）
  announceOfflineEpisode();
});

/* ---------- 监听 route 媒体变化（换源/外部导航时复位状态） ---------- */
watch(mediaId, async (next, prev) => {
  if (next === prev || !detailReady.value) return;
  // applyAlternateSource 自己发起的导航，跳过以避免重复加载
  if (pendingMediaSwitch !== null && next === pendingMediaSwitch) return;
  // 复位每媒体状态（旧线路 id 对新片无效、旧下线提示不跨片）
  lineId.value = null;
  announcedOffline.value = null;
  localMissingTaskId.value = null;
  failoverLineTried.value = false;
  failoverSourceTried.value = false;
  // 外部导航改路由（如用户从相关列表点另一部片）：重新加载详情与播放
  await library.loadDetail(next);
  if (!pageAlive) return;
  await resolveAndLoad();
});

/* ---------- 沉浸态 ---------- */
const immersive = computed(() => player.fullscreen);

/* ---------- 键盘快捷键（桌面浏览器） ---------- */
/**
 * 焦点落在输入区或弹层内时让出键盘控制（REV-18，判定见 `player/shortcutGuard`）。
 */
function onKeydown(ev: KeyboardEvent): void {
  if (shouldIgnoreShortcut(ev.target)) return;
  const step = playerSettings.value.seekStepSec ?? 10;
  switch (ev.key) {
    case ' ':
      ev.preventDefault();
      void togglePlay();
      break;
    case 'ArrowLeft':
      seek(player.currentTime - step);
      break;
    case 'ArrowRight':
      seek(player.currentTime + step);
      break;
    case 'ArrowUp':
      playerCtl.controller.value?.setVolume(Math.min(100, player.volume + 5));
      player.patch({ volume: Math.min(100, player.volume + 5) });
      break;
    case 'ArrowDown': {
      const next = Math.max(0, player.volume - 5);
      playerCtl.controller.value?.setVolume(next);
      player.patch({ volume: next });
      break;
    }
    case 'f':
    case 'F':
      void toggleFullscreen();
      break;
    case 'Escape':
      if (player.fullscreen) void exitFullscreen();
      break;
    default:
      break;
  }
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
});

/* 原生引擎（ExoPlayer）surface 在 WebView 之下：html/body/.app-root 任一不透明都会盖住画面 */
watch(
  () => player.engineKind,
  (kind) => {
    document.documentElement.classList.toggle('native-underlay', kind === 'native');
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.documentElement.classList.remove('native-underlay');
});

/* ---------- 亮度显示值 ---------- */
const brightnessPercent = computed(() => dimOpacityToBrightness(player.dim));

/* ---------- OPT-06 / EXT-07：画中画（PiP） ---------- */
const pipSupported = ref(false);
const pipActive = ref(false);
/** true = 原生 Activity PiP（ExoPlayer 引擎）；false = 浏览器 Web PiP（<video>） */
const pipNative = ref(false);
let pipCleanup: (() => void) | null = null;
let pipPollTimer: ReturnType<typeof setInterval> | null = null;
let detachAppState: (() => void) | null = null;
/**
 * 原生 PiP 状态轮询间隔。
 *
 * Activity 进出 PiP 没有事件桥可监听（MainActivity 不在本次可改范围），
 * 只能轮询插件 `isPipActive()`；1.5s 足够跟上用户操作且开销可忽略。
 */
const PIP_POLL_MS = 1500;

function stopPipPolling(): void {
  if (pipPollTimer !== null) clearInterval(pipPollTimer);
  pipPollTimer = null;
}

/** 同步原生 PiP 激活态：进入隐藏 DOM UI，退出恢复 UI 并停止轮询 */
function syncNativePipActive(active: boolean): void {
  if (active === pipActive.value) return;
  pipActive.value = active;
  if (active) {
    setControlsVisible(false);
    return;
  }
  setControlsVisible(true);
  stopPipPolling();
}

function startPipPolling(): void {
  if (pipPollTimer !== null) return;
  pipPollTimer = setInterval(() => {
    void (async () => {
      const active = (await playerCtl.controller.value?.isNativePipActive()) ?? false;
      syncNativePipActive(active);
    })();
  }, PIP_POLL_MS);
}

/** 探测 PiP 能力并注册事件监听（引擎切换后重新探测） */
async function initPip(): Promise<void> {
  // 引擎切换会重入：先拆上一轮监听/轮询
  pipCleanup?.();
  pipCleanup = null;
  pipActive.value = false;
  stopPipPolling();

  if (player.engineKind === 'native') {
    pipNative.value = true;
    try {
      pipSupported.value = (await playerCtl.controller.value?.isNativePipSupported()) ?? false;
    } catch {
      pipSupported.value = false;
    }
    return;
  }

  pipNative.value = false;
  try {
    pipSupported.value = await pipService.isSupported();
  } catch {
    pipSupported.value = false;
  }
  if (!pipSupported.value) return;
  pipCleanup = pipService.listen({
    onEnter: () => {
      pipActive.value = true;
      // 进入 PiP 时隐藏控制条，避免小窗内显示多余 UI
      if (controlsVisible.value) controlsVisible.value = false;
    },
    onLeave: () => {
      pipActive.value = false;
      // 退出 PiP 时恢复控制条可见性（让用户能继续操作）
      controlsVisible.value = true;
    },
    onError: () => {
      pipActive.value = false;
    },
  });
}

// 引擎切换（含原生→WebView 回退）时重新判定 PiP 通道
watch(
  () => player.engineKind,
  () => void initPip(),
);

/**
 * 原生 PiP 下 WebView 会收到 hidden → composable 会暂停播放并挂「回前台续播」提示。
 * 小窗里必须继续播：一旦发现「PiP 中 + 被后台暂停」立即恢复。
 */
watch(backgroundPaused, (paused) => {
  if (!paused || !pipActive.value) return;
  resumeFromBackground();
  void playerCtl.controller.value?.play();
  setControlsVisible(false);
});

async function togglePip(): Promise<void> {
  if (pipNative.value) {
    if (pipActive.value) {
      // Android 没有主动退出 PiP 的 API：引导用户操作小窗
      toast.info('在画中画窗口里点关闭按钮或返回全屏即可退出', 2200);
      return;
    }
    try {
      await playerCtl.controller.value?.enterNativePip();
      syncNativePipActive(true);
      startPipPolling();
    } catch (e) {
      // PiP 失败不阻断播放，仅提示（部分 ROM/设置会拒绝）
      toast.info(toErrorShape(e, 'E_NOT_IMPLEMENTED').message);
      syncNativePipActive(false);
    }
    return;
  }

  try {
    if (pipActive.value) {
      await pipService.exit();
    } else {
      await pipService.enter();
    }
  } catch (e) {
    // PiP 失败不阻断播放，仅提示
    toast.info(toErrorShape(e, 'E_NOT_IMPLEMENTED').message);
    pipActive.value = false;
  }
}

/** OPT-06：页面可见性变化时自动进入 PiP（设置开启 + 正在播放 + 非全屏） */
function onVisibilityChangeForPip(): void {
  if (!pipSupported.value || !settings.settings?.pipAutoEnter) return;
  if (document.visibilityState !== 'hidden') return;
  if (!player.playing) return;
  if (player.fullscreen) return;
  if (pipActive.value) return;
  if (pipNative.value) {
    void playerCtl.controller.value
      ?.enterNativePip()
      .then(() => {
        syncNativePipActive(true);
        startPipPolling();
      })
      .catch(() => undefined);
    return;
  }
  void pipService.enter().catch(() => {
    // 自动进入失败不打扰用户
  });
}

onMounted(() => {
  void initPip();
  document.addEventListener('visibilitychange', onVisibilityChangeForPip);
  // 回前台时补一次原生 PiP 状态（用户在小窗里点回 App 时退出 PiP）
  detachAppState = onAppStateChange((state) => {
    if (state !== 'active' || !pipNative.value) return;
    void (async () => {
      const active = (await playerCtl.controller.value?.isNativePipActive()) ?? false;
      syncNativePipActive(active);
      if (active) startPipPolling();
    })();
  });
});

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChangeForPip);
  detachAppState?.();
  detachAppState = null;
  stopPipPolling();
  pipCleanup?.();
  pipCleanup = null;
  // EXT-07：解除轨道订阅（控制器销毁时也会清订阅表，这里显式断开避免闭包留着 View）
  detachTrackSubscription?.();
  detachTrackSubscription = null;
  // 离开页面时退出 PiP（避免残留浮窗；原生 PiP 随 Activity 退出自动结束）
  if (pipActive.value && !pipNative.value) {
    void pipService.exit().catch(() => undefined);
  }
});
</script>

<template>
  <main
    class="player-root"
    :class="{
      'player-root--landscape': immersive,
      'player-root--native': player.engineKind === 'native',
      'player-root--pip': pipActive,
    }"
    data-route="player"
  >
    <!-- 竖屏顶部占位（保持返回按钮可见） -->
    <div class="player-page">
      <div ref="stageRef" class="player-stage">
        <PlayerSurface
          :subtitle-text="player.subtitleText"
          :subtitle="localSubtitles"
          :dim="brightnessPercent"
          :immersive="immersive"
        >
          <GestureLayer
            v-if="!pageLoading && !loadError && !player.error"
            :seek-max-sec="gestureSettings.seekMaxSec"
            :sensitivity="gestureSettings.sensitivity"
            @intent="onGesture"
            @long-press-help="showGestureHelp"
          />

          <!-- P1-1：手势引导（首次进入自动显示） -->
          <GestureGuide v-if="!pageLoading && !loadError && !player.error" />

          <!-- OPT-10：手势帮助浮层（长按触发） -->
          <GestureHelpOverlay :visible="gestureHelpVisible" @close="closeGestureHelp" />

          <PlayerHud
            :kind="hud.kind"
            :value="hud.value"
            :delta-sec="hud.deltaSec"
            :rate="player.rate"
          />

          <PlayerControls
            v-if="!loadError"
            :visible="controlsVisible"
            :title="titleText"
            :episode-label="episodeLabel"
            :playing="player.playing"
            :waiting="player.loading || player.waiting"
            :current-time="player.currentTime"
            :duration="player.duration"
            :buffered="player.buffered"
            :rate="player.rate"
            :can-prev="canPrev"
            :can-next="canNext"
            :show-episode-nav="hasEpisodeNav"
            :fullscreen="player.fullscreen"
            :subtitle-active="player.activeSubtitleId !== null"
            :quality-label="qualityLabel"
            :can-download="!!currentEpisode"
            :downloading="downloading"
            :cast-disabled="castSupported === false"
            :immersive="immersive"
            :compact="!immersive"
            :danmaku-enabled="danmakuSettings.enabled"
            :seek-step="playerSettings.seekStepSec"
            :pip-supported="pipSupported"
            :pip-active="pipActive"
            @back="goBack"
            @toggle-play="togglePlay"
            @prev="goToPrevEpisode"
            @next="goToNextEpisode"
            @seek="seek"
            @seeking="player.patch({ currentTime: $event })"
            @open-speed="speedOpen = true"
            @open-subtitle="openSubtitlePanel"
            @open-quality="qualityOpen = true"
            @open-display-mode="displayModeOpen = true"
            @toggle-fullscreen="toggleFullscreen"
            @download="onDownloadCurrent"
            @cast="onCast"
            @toggle-danmaku="toggleDanmaku"
            @open-danmaku-settings="danmakuOpen = true"
            @open-danmaku-style="danmakuStylePanelOpen = !danmakuStylePanelOpen"
            @toggle-pip="togglePip"
          />

          <!-- EXT-07：沉浸态音轨入口（横屏控制条没有音轨位，用浮动胶囊补齐） -->
          <button
            v-if="engineIsNative && immersive && !pipActive && embeddedTracks.audio.length > 0"
            class="player-audio-chip"
            :class="{ 'player-audio-chip--hidden': !controlsVisible }"
            type="button"
            :aria-label="`音轨：${audioChipLabel}`"
            data-test="player-audio-chip"
            @click="openEmbeddedAudioMenu"
          >
            {{ audioChipLabel }}
          </button>

          <!-- loading -->
          <div v-if="pageLoading && !loadError" class="player-loading" role="status" aria-live="polite">
            <PlayLoadingBar
              :progress="loadingProgress"
              :stage-text="loadingStageText"
              :elapsed="loadingElapsed"
            />
            <button class="btn btn--ghost btn--sm" type="button" @click="goBack">取消</button>
          </div>

          <!-- 错误面板 -->
          <PlayerErrorPanel
            v-if="player.error && !pageLoading"
            :error="player.error"
            :can-switch-line="lines.length > 1"
            :can-switch-source="canSwitchSourceManual"
            :can-health-check="canHealthCheck"
            @retry="retryPanel"
            @switch-line="onSwitchLine"
            @switch-source="onSwitchSource"
            @health-check="goHealthCheck"
            @back="openDetail"
            @copy="copyError"
            @open-external="openExternalUrl"
          />

          <!-- 页面级错误（详情/解析失败） -->
          <div v-if="loadError && !player.error" class="player-loading" role="alert">
            <!-- REV-24：详情失败时用上下文文案，否则用原始 loadError -->
            <p class="player-loading__text">{{ detailErrorMessage ?? loadError }}</p>
            <!-- P0-1：给出可行动原因（源站死 / 超时 / 磁力 / 规则脚本异常） -->
            <p v-if="loadErrorGuidance" class="player-loading__hint">{{ loadErrorGuidance.hint }}</p>
            <div class="player-loading__actions">
              <!-- REV-24：源已移除时提供删除记录入口 -->
              <button
                v-if="detailErrorKind === 'source-removed'"
                class="btn btn--primary btn--sm"
                type="button"
                @click="removeHistoryAndGoBack"
              >
                删除记录并返回
              </button>
              <!-- P1-4：磁力链接只能外部打开，重试无意义 -->
              <button
                v-else-if="loadErrorMagnet"
                class="btn btn--primary btn--sm"
                type="button"
                @click="openExternalUrl(loadErrorMagnet)"
              >
                用外部应用打开
              </button>
              <button
                v-else-if="!loadErrorMagnet"
                class="btn btn--primary btn--sm"
                type="button"
                @click="resolveAndLoad"
              >
                重试
              </button>
              <!-- v1.8/CHG-26：解析失败常是源坏了，直接给换源路径 -->
              <button
                v-if="canSwitchSourceManual"
                class="btn btn--secondary btn--sm"
                type="button"
                @click="onSwitchSource"
              >
                换源重播
              </button>
              <button class="btn btn--ghost btn--sm" type="button" @click="openDetail">返回详情</button>
            </div>
          </div>

          <!-- 自动连播 -->
          <NextEpisodePrompt
            v-if="countdown !== null"
            mode="auto-next"
            :countdown="countdown"
            :next-label="canNext ? '下一集' : ''"
            @confirm="goToNextEpisode"
            @cancel="cancelAutoNext"
          />

          <!-- 回前台续播 -->
          <NextEpisodePrompt
            v-if="backgroundPaused"
            mode="resume"
            @confirm="onBackgroundContinue"
            @cancel="onBackgroundExit"
          />
        </PlayerSurface>

        <!-- 弹幕样式实时调节面板（非模态，叠在 player-stage 内） -->
        <DanmakuStylePanel :open="danmakuStylePanelOpen" />
      </div>

      <!-- 竖屏下方信息区（全屏时隐藏） -->
      <div v-if="!immersive" class="player-info">
        <!-- 黑屏检测：声音在播但一帧画面都没解出来（多为 WebView 不支持该编码） -->
        <div
          v-if="noVideo && !noVideoDismissed && !pageLoading && !player.error"
          class="player-novideo"
          role="alert"
          data-test="player-novideo"
        >
          <p class="player-novideo__title">当前线路只有声音，没有画面</p>
          <p class="player-novideo__hint">
            该视频编码（常见 HEVC）WebView 解不出来，换线路或改用原生引擎通常可解。
          </p>
          <div class="player-novideo__actions">
            <button class="btn btn--primary btn--sm" type="button" @click="retryWithNativeEngine">
              用原生引擎重试
            </button>
            <button
              v-if="lines.length > 1"
              class="btn btn--secondary btn--sm"
              type="button"
              @click="onSwitchLine"
            >
              换线路
            </button>
            <button class="btn btn--ghost btn--sm" type="button" @click="dismissNoVideo">
              继续听声音
            </button>
          </div>
        </div>


        <h1 class="player-info__title">{{ titleText }}</h1>
        <p v-if="episodeLabel" class="player-info__episode">{{ episodeLabel }}</p>
        <p
          v-if="offlineEpisodeNumber !== null"
          class="player-info__offline"
          role="status"
          data-test="episode-offline"
        >
          {{ offlineEpisodeMessage(offlineEpisodeNumber) }}
        </p>

        <!-- 本地文件不可用（AC-78）：常驻提示条 + 「重新下载」入口 -->
        <div
          v-if="localMissingTaskId"
          class="player-local-missing"
          role="status"
          data-test="local-missing"
        >
          <span class="player-local-missing__text">本地文件不可用，已切换网络源</span>
          <button
            class="btn btn--secondary btn--sm player-local-missing__btn"
            type="button"
            data-test="redownload"
            :disabled="redownloading"
            @click="onRedownload"
          >
            {{ redownloading ? '重新下载中…' : '重新下载' }}
          </button>
        </div>

        <div class="player-info__actions">
          <button class="player-info__action" type="button" @click="pickerOpen = true">
            <IconDownload :size="18" />
            下载
          </button>
          <button
            class="player-info__action"
            :class="{ 'player-info__action--on': isFavorite }"
            type="button"
            @click="onToggleFavorite"
          >
            <IconHeart :size="18" :filled="isFavorite" />
            {{ isFavorite ? '已收藏' : '收藏' }}
          </button>
          <button
            class="player-info__action"
            :class="{
              'player-info__action--on': isFavorite,
              'player-info__action--disabled': castSupported === false,
            }"
            type="button"
            :aria-label="castSupported === false ? '投屏（当前平台不支持投屏）' : '投屏'"
            :aria-disabled="castSupported === false ? 'true' : undefined"
            :disabled="castSupported === false"
            :title="castSupported === false ? '当前平台不支持投屏' : undefined"
            @click="onCast"
          >
            <IconCast :size="18" />
            投屏
          </button>
          <!-- EXT-07：内嵌轨道入口（仅原生引擎；WebView 引擎没有内嵌轨可切） -->
          <template v-if="engineIsNative">
            <button
              class="player-info__action"
              :class="{ 'player-info__action--on': embeddedTracks.activeTextId !== null }"
              type="button"
              data-test="open-subtitle-tracks"
              @click="openEmbeddedSubtitleMenu"
            >
              字幕轨
            </button>
            <button
              class="player-info__action"
              :class="{ 'player-info__action--on': embeddedTracks.audio.length > 1 }"
              type="button"
              data-test="open-audio-tracks"
              @click="openEmbeddedAudioMenu"
            >
              音轨
            </button>
          </template>
        </div>

        <section v-if="episodes.length > 0" class="player-info__section">
          <div class="player-info__head">
            <h2 class="section-title">选集 <span class="player-info__count">共 {{ episodes.length }} 集</span></h2>
            <LineSelector
              v-if="lines.length > 1"
              :lines="lines"
              :model-value="currentLineId"
              :line-statuses="lineStatuses"
              :recommended-line-id="recommendedLineId"
              @update:model-value="onSwitchLineById"
            />
          </div>
          <EpisodeList
            :episodes="episodes"
            :current-id="currentEpisode?.id ?? null"
            :downloaded-ids="downloadedIds"
            @select="chooseEpisode"
          />
        </section>

        <p class="player-info__progress-note">
          已看到 {{ formatClock(player.currentTime) }} / {{ formatClock(player.duration) }}
          · 进度每 5 秒自动保存
        </p>
      </div>
    </div>

    <!-- 面板 -->
    <SpeedSheet v-model="speedOpen" :rate="player.rate" @select="setRate" />
    <DanmakuSettingsSheet v-model:open="danmakuOpen" />
    <SubtitleSheet
      v-model="subtitleOpen"
      :tracks="player.subtitles"
      :active-id="player.activeSubtitleId"
      :failed-ids="player.failedSubtitleIds"
      :settings="localSubtitles"
      @select="selectSubtitle"
      @retry="retrySubtitle"
      @local-file="addLocalSubtitle"
      @update-settings="onSubtitleSettings"
    />
    <QualitySheet
      v-model="qualityOpen"
      :quality="resolvedQuality"
      :levels="player.qualities"
      @select="switchQuality"
    />
    <DisplayModeSheet
      v-model="displayModeOpen"
      :mode="currentResizeMode"
      @select="onDisplayModeSelect"
    />

    <BottomSheet v-model="episodeOpen" title="选集">
      <EpisodeList
        :episodes="episodes"
        :current-id="currentEpisode?.id ?? null"
        @select="chooseEpisode"
      />
    </BottomSheet>

    <BottomSheet v-model="moreOpen" title="更多">
      <ul class="sheet-list">
        <li><button class="sheet-list__item" type="button" @click="openDetail">查看详情</button></li>
        <li><button class="sheet-list__item" type="button" @click="pickerOpen = true">下载本集</button></li>
      </ul>
    </BottomSheet>

    <BottomSheet v-model="pickerOpen" :title="`下载 · ${titleText}`">
      <p class="picker-desc">将当前集加入下载队列。</p>
      <template #footer>
        <button class="btn btn--primary btn--md picker-btn" type="button" :disabled="downloading" @click="onDownloadCurrent">
          {{ downloading ? '加入中…' : '开始下载' }}
        </button>
      </template>
    </BottomSheet>

    <!-- EXT-07：码流内嵌字幕轨 / 音轨（与外挂字幕面板相互独立） -->
    <SubtitleTrackMenu
      v-model="subtitleTrackOpen"
      :tracks="embeddedTracks.text"
      :active-id="embeddedTracks.activeTextId"
      :loading="tracksLoading"
      :error="tracksError"
      @select="onSelectEmbeddedSubtitle"
      @retry="refreshEmbeddedTracks"
      @open-external="openExternalSubtitleSheet"
    />
    <AudioTrackMenu
      v-model="audioTrackOpen"
      :tracks="embeddedTracks.audio"
      :active-id="embeddedTracks.activeAudioId"
      :loading="tracksLoading"
      :error="tracksError"
      @select="onSelectAudioTrack"
      @retry="refreshEmbeddedTracks"
    />
  </main>
</template>

<style scoped>
.player-root {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.player-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.player-stage {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  flex: 0 0 auto;
  background-color: #000;
}

.player-root--landscape {
  position: fixed;
  inset: 0;
  z-index: var(--z-player);
  background-color: #000;
}

/* v1.8 修复：原生引擎 surface 在 WebView 之下，播放器背景需透明让视频透出 */
.player-root--native {
  background-color: transparent;
}

.player-root--native .player-stage {
  background-color: transparent;
}

.player-root--native.player-root--landscape {
  background-color: transparent;
}

.player-root--native :deep(.player-surface) {
  background-color: transparent;
}

/* EXT-07：原生 PiP 小窗只留画面——信息区收起、画面铺满、浮动入口隐藏 */
.player-root--pip .player-page {
  height: 100%;
}

.player-root--pip .player-stage {
  flex: 1 1 auto;
  aspect-ratio: auto;
  height: 100%;
}

.player-root--pip .player-info {
  display: none;
}

.player-root--pip .player-audio-chip {
  display: none;
}

/* EXT-07：沉浸态音轨胶囊（右侧垂直居中，避开底部控制条与进度条） */
.player-audio-chip {
  position: absolute;
  top: 50%;
  right: var(--space-3);
  z-index: var(--z-content);
  max-width: 40vw;
  min-height: var(--touch-min);
  padding: 0 var(--space-3);
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border-glass);
  background-color: var(--color-bg-glass);
  backdrop-filter: var(--blur-player-hud);
  -webkit-backdrop-filter: var(--blur-player-hud);
  color: var(--color-text-primary);
  font: var(--text-button-sm);
  line-height: var(--touch-min);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transform: translateY(-50%);
  transition: opacity var(--duration-slow) var(--ease-standard), var(--transition-color);
}

.player-audio-chip:active {
  background-color: var(--color-bg-glass-strong);
}

/* 随控制栏同显同隐：隐藏态淡出并放行手势，避免右侧胶囊常显 */
.player-audio-chip--hidden {
  opacity: 0;
  pointer-events: none;
}

.player-root--landscape .player-page {
  height: 100%;
}

.player-root--landscape .player-stage {
  flex: 1 1 auto;
  aspect-ratio: auto;
  height: 100%;
}

.player-loading {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-4);
  background-color: rgba(0, 0, 0, 0.72);
  color: #ffffff;
  text-align: center;
}

.player-loading__text {
  font: var(--text-label);
  color: rgba(255, 255, 255, 0.86);
}

/* 黑屏检测提示条：放在竖屏信息区顶部（不覆盖画面，排版不受画面尺寸影响） */
.player-novideo {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-warning);
  text-align: left;
}

.player-novideo__title {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
  line-height: 1.5;
}

.player-novideo__hint {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.player-novideo__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-1);
}

/* P0-1：解析失败的可行动原因（分类建议），比错误标题低一级 */
.player-loading__hint {
  max-width: 260px;
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.6;
}

.player-loading__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.player-info {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
  /* 原生引擎模式下整页透明，信息区必须自带不透明底色，否则露出 Activity 白色窗口 */
  background-color: var(--color-bg-base);
}

.player-info__title {
  font: var(--text-title-2);
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.player-info__offline {
  margin-top: var(--space-1);
  font: var(--text-label);
  color: var(--color-warning);
}

/* 本地文件不可用提示条（AC-78②） */
.player-local-missing {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-warning-soft);
  border: 1px solid rgba(255, 176, 32, 0.36);
}

.player-local-missing__text {
  font: var(--text-caption);
  color: var(--color-warning);
}

.player-local-missing__btn {
  flex: 0 0 auto;
}

.player-info__episode {
  margin-top: var(--space-1);
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.player-info__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.player-info__action {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: var(--space-1);
  min-height: 40px;
  padding: 0 var(--space-4);
  white-space: nowrap;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-surface);
  border: var(--border-strong);
  color: var(--color-text-primary);
  font: var(--text-button-sm);
}

.player-info__action--on {
  color: var(--color-brand-text);
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
}

/* 投屏不可用（AC-84）：设计规范禁用色 + 不可点 */
.player-info__action:disabled,
.player-info__action--disabled {
  color: var(--color-text-disabled);
  border-color: var(--color-border);
  background-color: transparent;
  cursor: not-allowed;
  pointer-events: none;
}

.player-info__section {
  margin-top: var(--space-5);
}

.player-info__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.player-info__count {
  margin-left: var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.player-info__progress-note {
  margin-top: var(--space-4);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-align: center;
}

.sheet-list {
  display: flex;
  flex-direction: column;
}

.sheet-list__item {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.picker-desc {
  padding: var(--space-3) 0 var(--space-5);
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.picker-btn {
  width: 100%;
}
</style>
