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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
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
import { logger } from '@/shared/logger';
import { guidanceOf, magnetUrlOf } from '@/shared/sourceFailure';
import { IMG_W_BLUR, sizedImage } from '@/shared/imageSize';

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
import SkipIntroPrompt from '@/components/player/SkipIntroPrompt.vue';
import SkipMarkSheet from '@/components/player/SkipMarkSheet.vue';
import SleepTimerSheet from '@/components/player/SleepTimerSheet.vue';
import PlayerErrorPanel from '@/components/player/PlayerErrorPanel.vue';
import PlayerScreenLock from '@/components/player/PlayerScreenLock.vue';
import NextEpisodePrompt from '@/components/player/NextEpisodePrompt.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import ToggleSwitch from '@/components/common/ToggleSwitch.vue';
import PosterImage from '@/components/common/PosterImage.vue';
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
import { skipMarkService } from '@/services/skipMarkService';
import { useBackButton } from '@/composables/useBackButton';
import { useDebounce } from '@/composables/useDebounce';
import { usePlayerController } from '@/composables/usePlayerController';
import { useSeekThumbnails } from '@/composables/useSeekThumbnails';
import { useSkipIntro } from '@/composables/useSkipIntro';
import { useDanmakuPick } from '@/composables/useDanmakuPick';
import { prefersReducedMotion } from '@/composables/useSpring';
import type { AmbilightBlockReason } from '@/composables/useAmbilight';
import { findEpisodeOwnerLineId, offlineEpisodeMessage, resolveTargetEpisode } from '@/player/episodeFallback';
import { DanmakuOverlay } from '@/player/DanmakuOverlay';
import type { GestureIntent } from '@/player/GestureRecognizer';
import { canShowGestureHelp, markGestureHelpShown } from '@/player/gestureHelpPolicy';
import { danmakuService } from '@/services/danmakuService';
import DanmakuSettingsSheet from '@/components/player/DanmakuSettingsSheet.vue';
import DanmakuStylePanel from '@/components/player/DanmakuStylePanel.vue';
import DanmakuActions from '@/components/player/DanmakuActions.vue';
import { useToast } from '@/composables/useToast';
import { useScopedPalette } from '@/composables/useScopedPalette';
import { finishSharedCover, rewindSharedCover } from '@/composables/useSharedElement';
import { useUiStore } from '@/stores/uiStore';
import { QUALITY_AUTO, VOLUME_STEP } from '@/player/constants';
import { BRIGHTNESS_MAX } from '@/player/brightness';
import { PLAYER_FAILOVER_WINDOW_MS } from '@/shared/constants';
import { localProxyUrl } from '@/native/localProxy';
import { pipService } from '@/native/pipService';
import { onAppStateChange } from '@/native/appLifecycle';
import { libraryService } from '@/services/libraryService';
import { sourceService } from '@/services/sourceService';
import { downloadService, selectCompletedTask } from '@/services/downloadService';
import { pickPlayCandidates } from '@/sources/douban/playMatch';
import { healthService } from '@/services/healthService';
import { appEvents } from '@/services/events';
import PlayLoadingBar from '@/components/player/PlayLoadingBar.vue';
import BingeCelebration from '@/components/player/BingeCelebration.vue';
import { useAchievementStore } from '@/stores/achievementStore';
import { useHaptic } from '@/composables/useHaptic';
import { playDing } from '@/services/sfxService';

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
const achievements = useAchievementStore();
const { haptic } = useHaptic();

const mediaId = computed(() => (typeof route.params.mediaId === 'string' ? route.params.mediaId : ''));
const episodeIdParam = computed(() =>
  typeof route.params.episodeId === 'string' ? route.params.episodeId : null,
);
const lineIdParam = computed(() => (typeof route.query.lineId === 'string' ? route.query.lineId : null));
const restart = computed(() => route.query.restart === '1');

/**
 * 本地优先起播（`?local=1`）时锁定的真实播放身份，来自匹配上的那条下载任务。
 *
 * 之后详情才在后台加载完，`currentEpisode` 会随网络剧集列表变化；画面放的仍是本地这一集，
 * 标题、选集高亮、片头标记与进度写回都必须以这里为准，否则会把第 2 集记成第 1 集。
 * null = 当前播放内容来自在线解析。
 */
const localIdentity = ref<{ episodeId: string; episodeNumber: number | null } | null>(null);

/** 常亮锁持锁者令牌（本页实例唯一，交给 deviceService 判归属） */
const keepAwakeOwner = {};

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
/** 染色作用域根节点：与详情页共用同一份取色缓存 */
const rootRef = ref<HTMLElement | null>(null);
useScopedPalette(rootRef, computed(() => item.value?.posterUrl ?? null));
const lines = computed(() => library.detail?.lines ?? []);
const lineId = ref<string | null>(null);

/**
 * 线路优先级：用户显式切换 > 路由里这一集真正所属的线路 > 路由 query 带的线路 > 首条。
 *
 * 第二条是关键——不同线路的剧集 id 各不相同，默认落到首条线路时路由里的 id 往往不在
 * 该线路的选集列表内，于是解析不到目标集并回退第 1 集（"下载的第 2 集播成了第 1 集"）。
 */
const currentLineId = computed(() => {
  if (lineId.value) return lineId.value;
  const ownerLineId = findEpisodeOwnerLineId(
    library.detail?.episodes ?? [],
    lines.value.map((line) => line.id),
    episodeIdParam.value,
  );
  if (ownerLineId) return ownerLineId;
  return lineIdParam.value ?? lines.value[0]?.id ?? null;
});
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
  if (list.length === 0) return null;
  const wanted = episodeIdParam.value;
  if (!wanted) return list[0] ?? null;
  // 精确匹配当前线路
  const byId = list.find((ep) => ep.id === wanted);
  if (byId) return byId;
  // 跨线路回退：只用**这一集自己**的历史记录按集号重映射。
  // 取该媒体的第一条记录会拿到别的集的集号，把用户送到完全不相干的一集。
  const rec = history.items.find((r) => r.mediaId === mediaId.value && r.episodeId === wanted);
  if (rec?.episodeNumber != null) {
    const resolved = resolveTargetEpisode({
      recordedEpisodeId: wanted,
      recordedNumber: rec.episodeNumber,
      episodes: list,
    });
    if (resolved.episode) return resolved.episode;
  }
  logger.warn('路由集号在当前线路无匹配，回退首集', {
    mediaId: mediaId.value,
    episodeId: wanted,
    lineId: currentLineId.value,
    episodeCount: list.length,
  });
  return list[0] ?? null;
});

/** 正在播放的真实身份：本地优先起播以本地任务为准，在线解析以解析出的当前集为准。 */
const playingIdentity = computed<{ episodeId: string; episodeNumber: number | null } | null>(() => {
  const local = localIdentity.value;
  if (local) return local;
  const ep = currentEpisode.value;
  return ep ? { episodeId: ep.id, episodeNumber: ep.number } : null;
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
  autoPlayNext: true,
  seekStepSec: 10,
  longPressRate: 2,
  subtitle: {
    size: 'medium',
    color: 'white',
    background: 'black',
    offsetSec: 0,
    preferredLang: null,
  },
  lastVolume: 100,
  resizeMode: 'contain',
  autoSkipIntro: true,
  ambilight: true,
  ambilightIntensity: 85,
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
/** C-09 氛围光：减少动效下整层不挂载（不是"变慢一点"，是不做持续变化的效果） */
const ambilightEnabled = computed(
  () => playerSettings.value.ambilight !== false && !prefersReducedMotion(),
);
const ambilightIntensity = computed(() => playerSettings.value.ambilightIntensity ?? 85);

const stageRef = ref<HTMLElement | null>(null);

/** 封面共享元素转场：把入口页带来的浮层封面形变到舞台，再淡出交回真实画面 */
onMounted(() => {
  // 不用 rAF：页面被节流时 rAF 不回调，浮层会一直盖在播放页上
  void nextTick(() => finishSharedCover(stageRef.value));
});

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
  // 带本页令牌：路由切换时新页先挂、旧页后卸，旧页的释放不该清掉新页的锁。
  setKeepAwake: (on) =>
    import('@/services/deviceService')
      .then((m) => m.deviceService.keepAwake(on, keepAwakeOwner))
      .catch(() => undefined),
  // API-12 二期：亮度写窗口背光、音量写媒体流档位。
  // 原生能力缺失时这些方法返回 false/null，播放器整体退回「遮罩 + 播放器倍率」。
  levels: {
    setBrightness: (percent) =>
      import('@/services/deviceService')
        .then((m) => m.deviceService.setBrightness(percent))
        .catch(() => false),
    releaseBrightness: () =>
      import('@/services/deviceService')
        .then((m) => m.deviceService.releaseBrightness())
        .catch(() => undefined),
    setVolume: (percent) =>
      import('@/services/deviceService')
        .then((m) => m.deviceService.setVolume(percent))
        .catch(() => null),
    readVolume: () =>
      import('@/services/deviceService')
        .then((m) => m.deviceService.readVolume())
        .catch(() => null),
  },
  subtitle: subtitleSettings.value,
  defaultRate: defaultRate.value,
  autoPlayNext: autoPlayNext.value,
  backgroundPlayback: playerSettings.value.backgroundPlayback === true,
  resizeMode: currentResizeMode.value,
  longPressRate: longPressRate.value,
  describe: () => {
    // 页面卸载后不再写回进度，避免死实例拿错上下文污染历史记录
    if (!pageAlive) return null;
    const it = item.value;
    // 用「正在播的这一集」而不是详情列表解析出的当前集：写错集号会让历史记录自增殖
    const identity = playingIdentity.value;
    if (!it) return null;
    return {
      sourceId: it.sourceId,
      mediaId: it.id,
      episodeId: identity?.episodeId ?? null,
      episodeNumber: identity?.episodeNumber ?? null,
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
  audioOnly,
  backgroundPlayback,
  remoteEpisodeTarget,
  acknowledgeRemoteEpisode,
  sleepTimer,
  setAudioOnly,
  setBackgroundPlayback,
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
  onGesturePointerDown,
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

/** B1：通知栏/锁屏/线控的上下集，与自动连播共用同一条路由入口 */
watch(remoteEpisodeTarget, (targetId) => {
  if (!targetId) return;
  const ep = episodes.value.find((e) => e.id === targetId);
  acknowledgeRemoteEpisode();
  if (ep) chooseEpisode(ep);
});

/* ---------- F2：连看里程碑爆米花桶 ----------
 * 计数在 achievementStore（跨逐集重建存活）。达到 3 集即落徽章 + 置 pending；
 * 仪式择「暂停」或「片尾倒计时」播放，绝不干扰正在播放的画面。
 * 片尾触发时先停自动连播，仪式结束再续播下一集，保留连播体验。
 */
const bingeShow = ref(false);
const bingeHasPlayed = ref(false);
let bingeSuspendedNext = false;

function fireBinge(atEnded: boolean): void {
  if (bingeShow.value || !settings.easterEggsEnabled) return;
  achievements.clearBingePending();
  if (atEnded) {
    cancelAutoNext();
    bingeSuspendedNext = true;
  }
  bingeShow.value = true;
  haptic('medium');
  playDing();
}

function dismissBinge(): void {
  bingeShow.value = false;
  if (bingeSuspendedNext) {
    bingeSuspendedNext = false;
    goToNextEpisode();
  }
}

watch(
  () => player.playing,
  (playing) => {
    if (playing) {
      bingeHasPlayed.value = true;
    } else if (achievements.bingePending && bingeHasPlayed.value) {
      fireBinge(false);
    }
  },
);

watch(countdown, (val) => {
  if (val !== null && achievements.bingePending) fireBinge(true);
});

/** B2：后台播放开关——立即生效并写回设置（纯音频模式隐含后台播放，见 composable） */
function toggleBackgroundPlayback(): void {
  const next = !backgroundPlayback.value;
  setBackgroundPlayback(next);
  settings.updateNonBlocking({ player: { ...playerSettings.value, backgroundPlayback: next } });
  ui.toast(next ? '切后台将继续播放' : '切后台将自动暂停', 'info', 1500);
}

/** B3：睡眠定时——分钟档按真实时间走，「播完本集」等自然结束 */
const {
  choice: sleepChoice,
  remainingSec: sleepRemainingSec,
  active: sleepActive,
  label: sleepLabel,
} = sleepTimer;

function armSleepMinutes(minutes: number): void {
  sleepTimer.setMinutes(minutes);
  ui.toast(`${minutes} 分钟后自动暂停`, 'info', 1800);
}

function armSleepEpisode(): void {
  sleepTimer.setFinishEpisode();
  ui.toast('本集播完后停止播放', 'info', 1800);
}

function cancelSleep(): void {
  sleepTimer.cancel();
  ui.toast('已关闭睡眠定时', 'info', 1500);
}

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
const sleepOpen = ref(false);
const pickerOpen = ref(false);
const downloading = ref(false);
// OPT-10：手势帮助浮层
const gestureHelpVisible = ref(false);

/**
 * 长按升级成帮助的资格：播放中的长按归倍速手势，只有非播放态才允许按住不动呼出帮助。
 * 是否真的弹出还要过 `gestureHelpPolicy` 的会话/冷却判定（见 `maybeShowGestureHelp`）。
 */
const gestureHelpEnabled = computed(() => !player.playing);

/** 长按自动触发：受策略约束，同一个会话内不重复弹。 */
function maybeShowGestureHelp(): void {
  if (!canShowGestureHelp()) return;
  markGestureHelpShown();
  gestureHelpVisible.value = true;
}

/** 主动触发（「更多 → 手势说明」）：用户要找它，就不设门槛。 */
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

/* ---------- A-03 进度条胶片预览 ---------- */

/**
 * 松手后主画面预览的最长保持时间。
 *
 * 引擎定位通常远快于这个值，到位即撤（见下方 watch）；上限只是兜底——
 * 万一 seek 失败或被更长的加载挡住，不能让一张静态帧永远盖在画面上。
 */
const SEEK_PREVIEW_MAX_HOLD_MS = 1200;

const seekThumbs = useSeekThumbnails(
  () => currentPlayback.value,
  () => player.duration,
);

/** 叠在主画面上的目标画面：拖动中跟随手指，松手后留到引擎真的到位再撤 */
const seekPreviewUrl = ref<string | null>(null);
/** 进度条上的胶片（模板里直接用，顶层 ref 会自动解包） */
const seekFilm = seekThumbs.slots;
/** 松手后的收口锚点：null 表示当前还在拖，不做到位判断 */
let previewHoldSec: number | null = null;
let previewHoldTimer: ReturnType<typeof setTimeout> | null = null;

function clearSeekPreview(): void {
  if (previewHoldTimer !== null) {
    clearTimeout(previewHoldTimer);
    previewHoldTimer = null;
  }
  previewHoldSec = null;
  seekPreviewUrl.value = null;
}

/** 拖动过程中：整条胶片后台补齐，主画面切到手指所在格 */
function onSeekPreview(sec: number): void {
  seekThumbs.prepare();
  player.patch({ currentTime: sec });
  const url = seekThumbs.frameAt(sec);
  // 取不到就不动：留旧帧只是稍晚一点，撤掉图层会直接露出正在定位的黑画面
  if (url !== null) {
    if (previewHoldTimer !== null) {
      clearTimeout(previewHoldTimer);
      previewHoldTimer = null;
    }
    previewHoldSec = null;
    seekPreviewUrl.value = url;
  }
}

/** 松手提交：真正 seek，并把预览层多留一会儿，避免"闪一下黑" */
function onSeekCommit(sec: number): void {
  void seek(sec);
  if (seekPreviewUrl.value === null) return;
  previewHoldSec = sec;
  if (previewHoldTimer !== null) clearTimeout(previewHoldTimer);
  previewHoldTimer = setTimeout(clearSeekPreview, SEEK_PREVIEW_MAX_HOLD_MS);
}

watch(
  () => player.currentTime,
  (sec) => {
    if (previewHoldSec === null) return;
    // 引擎报回的位置进入目标 ±2s，说明画面已经对了
    if (Math.abs(sec - previewHoldSec) <= 2) clearSeekPreview();
  },
);

/* ---------- 跳过片头 / 片尾（B-06） ---------- */

const skipMarkOpen = ref(false);
/** 片头/片尾标记按「正在播的这一集」存取；本地起播时不能被详情列表带偏 */
const playingEpisodeId = computed(() => playingIdentity.value?.episodeId ?? episodeIdParam.value ?? '');

const skipIntro = useSkipIntro({
  mediaId,
  episodeId: playingEpisodeId,
  currentTime: computed(() => player.currentTime),
  duration: computed(() => player.duration),
  autoSkip: computed(() => playerSettings.value.autoSkipIntro),
  seek: (sec) => void seek(sec),
});
// 嵌套 ref 在模板里不会自动解包，摊平成顶层绑定再喂给控件
const skipMarks = skipIntro.marks;
const skipZone = skipIntro.zone;
const skipCountdown = skipIntro.countdown;
const skipAuto = skipIntro.auto;

/**
 * 手动标记一次。
 * 源站返回体里没有章节载体（TVBox/爬虫都没有），所以现阶段只吃手动标记；
 * 将来有源站数据时在这里合并优先级，手动标记仍然最可信赖。
 */
async function onSkipMark(side: 'intro' | 'credits', sec: number): Promise<void> {
  const label = side === 'intro' ? '片头结束于' : '片尾开始于';
  const ok =
    side === 'intro'
      ? await skipMarkService.markIntroEnd(mediaId.value, sec, player.duration)
      : await skipMarkService.markCreditsStart(mediaId.value, sec, player.duration);
  if (ok) toast.success(`${label} ${formatClock(sec)}，整季生效`);
  else toast.error('这个位置离片头/片尾太近，标了也不会跳');
}

async function onSkipClear(side: 'intro' | 'credits'): Promise<void> {
  await skipMarkService.clearSide(mediaId.value, side);
}

function onAutoSkipChange(value: boolean): void {
  settings.updateNonBlocking({
    player: { ...playerSettings.value, autoSkipIntro: value },
  });
}

/** 线路切换进行中（防连点造成两次并发加载，REV-05） */
const switchingLine = ref(false);/**
 * 「本地文件不可用」任务（AC-78 / REV-23）。
 *
 * `resolvePlay` 优先本地播放；若该集已有 `completed` 任务但解析结果仍是网络源，
 * 说明本地文件/Blob 已丢失（服务层同时发出 `local:missing` 事件弹全局 Toast）。
 * 这里记下 taskId，在页面上常驻一条提示条并给出「重新下载」按钮。
 */
const localMissingTaskId = ref<string | null>(null);
/**
 * P0-2：离线文件时间轴异常（`E_LOCAL_STALL`）的任务。
 *
 * 文件在、能打开、能出首帧，但位置永远不动——这类产物重试/换线都救不回来，
 * 页面上唯一有意义的出口是重新下载（重下会走新的转封装 + 自检链路）。
 */
const localStallTaskId = ref<string | null>(null);
const redownloading = ref(false);

/** 投屏能力探测（AC-84）：`isSupported()===false` 时按钮渲染为禁用态 */
async function detectCastSupport(): Promise<void> {
  try {
    castSupported.value = await castService.isSupported();
  } catch {
    castSupported.value = false;
  }
}

async function detectLocalMissing(): Promise<void> {
  const it = item.value;
  const ep = currentEpisode.value;
  const playback = currentPlayback.value;
  if (!it || !ep || !playback || playback.isLocal) {
    localMissingTaskId.value = null;
    return;
  }
  // 判定直接复用服务层的 localMissingForMedia：它与 resolvePlay 用同一个匹配口径
  // （selectCompletedTask），页面里再抄一份"唯一完成任务兜底"会把别的集误指认为本集。
  const missing = await downloadService.localMissingForMedia(it.id, {
    episodeId: ep.id,
    episodeNumber: ep.number,
  });
  if (currentPlayback.value !== playback) return; // 期间已切集/切线，结果作废
  localMissingTaskId.value = missing?.id ?? null;
}

/**
 * P0-2：把停滞的本地产物指回它自己的下载任务（与 `tryPlayLocalFirst` 同一匹配口径）。
 *
 * 只认"已完成"任务：暂停中/失败的任务不该出现在"重新下载"入口里。
 */
function armLocalStallRedownload(): void {
  const ep = currentEpisode.value;
  if (!ep) {
    localStallTaskId.value = null;
    return;
  }
  const record = history.items.find((r) => r.mediaId === mediaId.value && r.episodeId === ep.id);
  const completed = downloads.tasks.filter(
    (t) => t.mediaId === mediaId.value && t.status === 'completed',
  );
  const task = selectCompletedTask(completed, {
    episodeId: ep.id,
    episodeNumber: record?.episodeNumber ?? ep.number,
  });
  localStallTaskId.value = task?.id ?? null;
}

/**
 * 重新下载（AC-78②）。
 *
 * 不直接 import `@/services/downloadService`（不在 UI 白名单），
 * 走白名单内的 `downloadStore.retry()`——已完成任务在 Service 内部即转入
 * `redownload()`（复用原记录：清空 blobKey/filePath、进度归零、重新入队）。
 */
async function onRedownload(): Promise<void> {
  const id = localStallTaskId.value ?? localMissingTaskId.value;
  if (!id || redownloading.value) return;
  redownloading.value = true;
  try {
    await downloads.retry(id);
    // 任务已回到 queued（blobKey=null），提示条随状态变化消失
    localMissingTaskId.value = null;
    localStallTaskId.value = null;
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
  identity: { episodeId: string; episodeNumber: number | null },
): Promise<void> {
  const episodeId = identity.episodeId;
  // 起播即锁定身份：后台详情加载完成后 currentEpisode 会跟着网络列表变化，这里不跟着漂
  localIdentity.value = identity;
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
    // P0-3：与 resolveAndLoad 走同一个组合式 load——自动起播（await c.play()）
    // 与错误落点（player.error）都在那条链里，直连 controller.load 会两者都错过。
    await load({
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
 * P1-4：本地优先起播（下载列表 `local=1` 入口与 REV-24 详情失败兜底共用）。
 *
 * 常规链路必然 `await library.loadDetail()`——离线/慢源时它要等满 HTTP 超时，
 * 从下载列表点进来的已下载内容因此"一直卡住"。这里只查本机任务与本文件，
 * 一行网络请求都不发。返回 false 表示本机没有这一集（或文件已丢），
 * 由调用方回落到常规（网络）链路。
 */
async function tryPlayLocalFirst(episodeId: string): Promise<boolean> {
  const record = history.items.find((r) => r.mediaId === mediaId.value && r.episodeId === episodeId);
  const completed = downloads.tasks.filter(
    (t) => t.mediaId === mediaId.value && t.status === 'completed',
  );
  // 与 resolvePlay 同一套匹配口径（P0-2）：宁可不起播，也不播成别的集
  const localTask = selectCompletedTask(completed, {
    episodeId,
    episodeNumber: record?.episodeNumber ?? null,
  });
  if (!localTask) return false;

  const playback = await downloadService.taskToPlayback(localTask);
  if (!playback || !pageAlive) return false;
  await loadLocalPlay(playback, localTask.title, localTask.posterUrl, {
    episodeId,
    episodeNumber: localTask.episodeNumber ?? record?.episodeNumber ?? null,
  });
  bindEmbeddedTracks();
  return true;
}

/**
 * 解析并加载当前集/线路。
 * 返回是否成功：`resolvePlay` 抛错 → `loadError`；引擎加载失败 → `player.error`。
 * 线路切换需要据此判断是否回退原线路（AC-55 / REV-05）。
 */
async function resolveAndLoad(): Promise<boolean> {
  const epoch = ++loadEpoch;
  // 一旦走在线解析，画面就不再是本地下载任务那一集——身份必须交还给 currentEpisode
  localIdentity.value = null;
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
    void detectLocalMissing();
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

/**
 * deviceService 延迟加载：与状态栏/常亮同一处理方式，避免把 Capacitor 插件拉进首屏模块图
 * （会让路由级测试的模块加载变慢）。
 */
function deviceApi(): Promise<typeof import('@/services/deviceService').deviceService> {
  return import('@/services/deviceService').then((m) => m.deviceService);
}

/**
 * 进入播放页：确定亮度/音量的落点与起点（API-12 二期 + P1-4 音量记忆）。
 *
 * - 原生可用：亮度起点取系统当前背光（不写窗口覆盖，画面本来就停在系统亮度上），
 *   音量取系统当前档位（系统本身就记忆音量，回填 `lastVolume` 反而会覆盖
 *   用户在其它 App 里的调整）。
 * - 原生不可用（Web / 旧包 / 插件缺失）：落点退回「黑色遮罩 + 播放器倍率」，
 *   亮度满档即遮罩不生效（视觉上仍等同于系统亮度），音量按记忆值恢复。
 */
async function initPlaybackLevels(): Promise<void> {
  const levels = await deviceApi()
    .then((d) => d.readSystemLevels())
    .catch(() => null);

  if (!levels) {
    player.patch({
      levelSource: 'app',
      brightness: BRIGHTNESS_MAX,
      volume: settings.player?.lastVolume ?? 100,
    });
    return;
  }

  player.patch({
    levelSource: 'system',
    brightness: levels.brightness,
    volume: levels.volume,
  });
}

onMounted(async () => {
  void detectCastSupport();
  // REV-24：sources 用于详情失败时判断源是否存在
  await Promise.all([settings.load(), history.load(), favorites.load(), downloads.load(), sources.load(), achievements.load()]);
  // F2：连看计数（彩蛋开关 gate）。播放页逐集重建，计数落在 store 才能跨集累积。
  if (settings.easterEggsEnabled) {
    achievements.noteEpisodeEntry(mediaId.value, episodeIdParam.value, item.value?.title ?? null);
  }
  // P1-4 + API-12：亮度/音量起点（必须在 createController 之前，决定引擎倍率的初值）
  await initPlaybackLevels();

  const episodeParam = typeof route.params.episodeId === 'string' ? route.params.episodeId : '';
  // P1-4：下载列表入口（`?local=1`）先本地起播，详情后台补——离线时不再被网络解析吊住
  if (route.query.local === '1' && episodeParam && (await tryPlayLocalFirst(episodeParam))) {
    detailReady.value = true;
    void library.loadDetail(mediaId.value);
    return;
  }

  await library.loadDetail(mediaId.value);
  detailReady.value = true;
  if (library.detailState === 'error') {
    // REV-24：详情失败但本地有下载完成的任务时，允许直接本地播放
    if (episodeParam && (await tryPlayLocalFirst(episodeParam))) return;
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

/**
 * P1-4 音量写回值。
 *
 * `usePlayerController` 的卸载钩子先跑（`player.reset()` 把音量打回 100），
 * 本钩子后跑，直接读 store 拿到的永远是默认值——这正是旧版「记忆音量/亮度」
 * 存下 100/100 的原因。这里同步留一份最后一次生效的值。
 */
let lastVolumeForMemory = 100;
watch(
  () => player.volume,
  (volume) => {
    lastVolumeForMemory = Math.round(volume);
  },
  { flush: 'sync' },
);

onBeforeUnmount(() => {
  cancelAutoNext();
  clearSeekPreview();
  // 起播进度 rAF 自续不受 finally 守卫保护：卸载会置反 pageAlive/epoch，
  // 不在这里显式取消就会留下常驻循环。
  cancelLoadingProgress();
  // 页面存活守卫：卸载后作废所有在飞异步链，防止后台链路劫持路由/覆盖全局状态
  pageAlive = false;
  ++loadEpoch;
  pageAbort.abort();
  // P1-4：音量记忆写回。音量在原生下由系统自己记住，这里存的值只在退回倍率路径时使用。
  settings.updateNonBlocking({
    player: {
      ...settings.player,
      lastVolume: lastVolumeForMemory,
    },
  });
});

/** 换源（切集/切线路）等于换了一部片子：预览层与保持计时都不该留在新画面上 */
watch(() => currentPlayback.value, clearSeekPreview);

/* ---------- 标题/集标签 ---------- */
const titleText = computed(() => fallbackTitle.value);

/** 音频模式的背景层只是 `blur(28px)` 的色底，按原图请求纯属浪费 */
const audioBlurSrc = computed(() => sizedImage(item.value?.posterUrl ?? null, IMG_W_BLUR));
const episodeLabel = computed(() => {
  const identity = playingIdentity.value;
  if (!identity) return '';
  const ep = currentEpisode.value;
  const number = identity.episodeNumber ?? (ep?.id === identity.episodeId ? ep.number : null);
  if (number === null) return '';
  if (!hasEpisodeNav.value && episodes.value.length <= 1) return '';
  // 副标题只有当详情里的这一集正是正在播的这一集时才可信
  const sub = ep && ep.number === number && ep.title && ep.title !== `第 ${number} 集` ? ` · ${ep.title}` : '';
  return `第 ${number} 集${sub}`;
});
const qualityLabel = computed(() => (resolvedQuality.value === QUALITY_AUTO ? '自动' : resolvedQuality.value));

/* ---------- 操作 ---------- */

/**
 * 返回键 / 顶栏返回（AC-52 返回键分层）：
 * - 第 1 次：帮助浮层打开 → 只关浮层；
 * - 第 1 次：全屏中 → 只退全屏，保持播放页与播放状态；
 * - 第 2 次：退出播放页 → 先 `flushProgress()` 写回进度，再回详情。
 *
 * 同时注册到 `useBackButton`（Android 硬件返回键），使物理返回键与 UI 返回
 * 走完全相同的分支。
 */
function goBack(): void {
  // 帮助浮层打开时，返回键先撤浮层（与全屏同一套分层，AC-52）
  if (gestureHelpVisible.value) {
    closeGestureHelp();
    return;
  }
  if (player.fullscreen) {
    void exitFullscreen();
    return;
  }
  void playerCtl.controller.value?.flushProgress();
  // 封面飞回入口卡片：必须在导航发起前立浮层，App.vue 才会把滑入换成淡入
  rewindSharedCover(stageRef.value, mediaId.value, item.value?.posterUrl ?? null);
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
 * 引擎错误与解析错误共用同一条链（解析失败过去只落错误面板，不自动兜底）。
 * 离线时直接落错误面板——换线/换源都要网络，徒增等待。 */
async function runFailover(error: AppErrorShape, origin: 'player' | 'resolve'): Promise<void> {
  if (failoverRunning.value) return;
  if (!FAILOVER_ERROR_CODES.has(error.code) || !withinFailoverWindow()) return;
  // 离线短路：换线/换源均需网络，直接落错误面板
  if (!isOnlineNow()) {
    if (!pageAlive) return;
    if (origin === 'player') player.patch({ error });
    else {
      loadErrorShape.value = error;
      loadError.value = error.message;
    }
    return;
  }
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
      // P0-2：离线文件自身的问题与线路/源无关——不记线路失败、不作废播放地址缓存，
      // 只挂出"重新下载"出口（E_LOCAL_STALL 不在 FAILOVER_ERROR_CODES 内，不会走换线/换源）
      if (error.code === 'E_LOCAL_STALL') {
        armLocalStallRedownload();
        return;
      }
      // P0-3：播放出错时失效缓存，避免重试/换线复用已过期的坏 URL
      library.invalidatePlayCache(mediaId.value);
      // 批次1：记录线路失败（按错误分类）
      const line = currentLine.value;
      const it = item.value;
      if (line && it) {
        lineHealthService.recordFail(lineKey(it.sourceId, it.sourceItemId, line.name), error.code);
      }
      void runFailover(error, 'player');
    } else {
      // 错误清除（重试/换集成功）：停滞出口跟着撤
      localStallTaskId.value = null;
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

/** 收藏写库在飞：双击会让「读存在性 → 写/删」交错，期间只处理第一次点击 */
const favoritePending = ref(false);

async function onToggleFavorite(): Promise<void> {
  const it = item.value;
  if (!it || favoritePending.value) return;
  favoritePending.value = true;
  try {
    const added = await favorites.toggle({
      sourceId: it.sourceId,
      mediaId: it.id,
      title: it.title,
      posterUrl: it.posterUrl,
      type: it.type,
      year: it.year,
    });
    toast.success(added ? '已收藏' : '已取消收藏');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    favoritePending.value = false;
  }
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

/**
 * 字幕设置的持久化：字号/描边/偏移都是滑块，拖动一帧触发一次 `@input`，
 * 直接写存储会把 IDB 写打成一片。本地值保持即时（画面跟着动），落盘收敛成一次。
 */
const persistSubtitles = useDebounce(() => {
  settings.updateNonBlocking({ player: { ...playerSettings.value, subtitle: { ...localSubtitles.value } } });
}, 300);
// 卸载时挂起的最后一次不能丢：useDebounce 自己的 onBeforeUnmount 只做 cancel，这里补 flush
onBeforeUnmount(() => persistSubtitles.flush());

function onSubtitleSettings(patch: Partial<SubtitleSettings>): void {
  localSubtitles.value = { ...localSubtitles.value, ...patch };
  if (patch.offsetSec !== undefined) setSubtitleOffset(patch.offsetSec);
  persistSubtitles();
}

function onDisplayModeSelect(mode: ResizeMode): void {
  setResizeMode(mode);
  settings.updateNonBlocking({ player: { ...playerSettings.value, resizeMode: mode } });
}

function setAmbilight(on: boolean): void {
  settings.updateNonBlocking({ player: { ...playerSettings.value, ambilight: on } });
}

function setAmbilightIntensity(value: number): void {
  settings.updateNonBlocking({ player: { ...playerSettings.value, ambilightIntensity: value } });
}

/**
 * 取不到画面帧时把开关落回关闭并说明原因。
 * 这是**能力**问题（原生引擎没有 DOM 视频元素 / 画布被跨域污染），不是抖动，
 * 所以直接持久化，避免每次进播放页都白跑一遍取样定时器。
 */
function onAmbilightBlocked(reason: AmbilightBlockReason): void {
  if (reason === 'reduced-motion') return;
  setAmbilight(false);
  toast.info(
    reason === 'no-video'
      ? '原生引擎取不到画面像素，氛围光已自动关闭'
      : '画面像素不可读取（源站未开放跨域），氛围光已自动关闭',
    2600,
  );
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
      interactive: true,
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
    const base = danmakuSettings.value.merge ? danmakuService.dedupe(match.comments) : match.comments;
    // 弹弹play 的 `shift`：缓存里存原始时间轴，偏移只在渲染时叠加（换源/重进不回写缓存）
    const offset = Number.isFinite(match.offsetSec) ? match.offsetSec : 0;
    danmakuOverlay.value?.load(
      offset === 0 ? base : base.map((comment) => ({ ...comment, time: Math.max(0, comment.time + offset) })),
    );
    return true;
  } catch {
    /* 弹幕失败静默：不影响播放 */
    return false;
  }
}

/**
 * 「弹幕设置 → 导入本地弹幕 XML」的落点：解析成功后直接写本集缓存再重载。
 * 导入即代表用户想用这份文件，所以顺带打开弹幕总开关（否则缓存写了也看不见）。
 */
async function importLocalDanmaku(file: File): Promise<void> {
  const it = item.value;
  const ep = currentEpisode.value;
  if (!it || !ep) return;
  let count = 0;
  try {
    count = await danmakuService.importLocalXml(it.title, it.year, ep.number, file);
  } catch {
    toast.info('本地弹幕文件读取失败', 2400);
    return;
  }
  if (count === 0) {
    toast.info('这个文件没有解析出弹幕（需要 B 站格式 xml）', 2800);
    return;
  }
  if (!danmakuSettings.value.enabled) {
    await settings.update({ danmaku: { ...danmakuSettings.value, enabled: true } });
  }
  const loaded = await loadDanmaku();
  toast.info(loaded ? `已导入本地弹幕 ${count} 条` : '导入成功，重进本集后生效', loaded ? 1800 : 2600);
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

/* ---------- B-04：点中弹幕 → 冻结它 + 头顶出操作条 ---------- */

const danmakuInteractive = computed(() => danmakuSettings.value.enabled && danmakuSettings.value.interactive);

const danmakuPick = useDanmakuPick({
  overlay: danmakuOverlay,
  enabled: danmakuInteractive,
  mediaId,
  episodeNumber: computed(() => currentEpisode.value?.number ?? null),
  seek: (sec) => void seek(sec),
  copy: (text) => void copyDanmakuText(text),
});

// 模板只自动解包顶层 ref，嵌套在对象里的要摊平出来
const danmakuPicked = danmakuPick.pick;
const danmakuLiked = danmakuPick.liked;
const danmakuLikeCount = danmakuPick.likeCount;

async function copyDanmakuText(text: string): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
    toast.success('已复制弹幕');
  } catch {
    toast.info(text);
  }
}

function onDanmakuLike(): void {
  void danmakuPick.toggleLike();
}

/**
 * 单击先问弹幕：点中了就吞掉这次单击（不再开关控制条，否则 HUD 会盖在操作条上），
 * 没点中则一切照旧——互动开关关掉时 `tapAt` 直接返回 false，链路与升级前完全一致。
 */
function onStageIntent(intent: GestureIntent): void {
  // 长按帮助不进 onGesture：它不是播放控制，且要过弹出策略
  if (intent.type === 'long-press-help') {
    maybeShowGestureHelp();
    return;
  }
  if (intent.type === 'single-tap' && danmakuPick.tapAt(intent.x, intent.y)) return;
  onGesture(intent);
}

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

/* ---------- B4：横屏屏幕锁（防误触） ---------- */
const screenLocked = ref(false);
const lockRevealed = ref(false);
let lockRevealTimer: ReturnType<typeof setTimeout> | null = null;

/** 锁定态胶囊只在轻触后短暂露出；未锁定态跟随控件栏一起显隐 */
const lockPillVisible = computed(() =>
  screenLocked.value ? lockRevealed.value : controlsVisible.value,
);

function revealLockPill(): void {
  lockRevealed.value = true;
  if (lockRevealTimer !== null) clearTimeout(lockRevealTimer);
  lockRevealTimer = setTimeout(() => {
    lockRevealed.value = false;
    lockRevealTimer = null;
  }, 3000);
}

function clearLockReveal(): void {
  if (lockRevealTimer !== null) {
    clearTimeout(lockRevealTimer);
    lockRevealTimer = null;
  }
  lockRevealed.value = false;
}

function toggleScreenLock(): void {
  screenLocked.value = !screenLocked.value;
  if (screenLocked.value) {
    // 锁屏会吃掉画面上的所有交互层，浮层必须真关掉而不是被隐藏，否则解锁后它又冒出来
    closeGestureHelp();
    setControlsVisible(false);
    revealLockPill();
    ui.toast('已锁定屏幕，轻触画面可解锁', 'info', 2000);
  } else {
    clearLockReveal();
    setControlsVisible(true);
  }
}

// 退出全屏必须自动解锁，否则竖屏下控件全被吃掉，页面等于废了
watch(immersive, (on) => {
  if (!on && screenLocked.value) {
    screenLocked.value = false;
    clearLockReveal();
    setControlsVisible(true);
  }
});

onBeforeUnmount(clearLockReveal);

/* ---------- 键盘快捷键（桌面浏览器） ---------- */
/**
 * 焦点落在输入区或弹层内时让出键盘控制（REV-18，判定见 `player/shortcutGuard`）。
 */
function onKeydown(ev: KeyboardEvent): void {
  if (shouldIgnoreShortcut(ev.target)) return;
  // 锁屏时只留 Escape 作为退出全屏的逃生口（退出会自动解锁）
  if (screenLocked.value && ev.key !== 'Escape') return;
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
    case 'ArrowUp': {
      // 与手势同一条落点：原生下这是系统音量档位，Web 下是播放器倍率
      const next = Math.min(100, player.volume + VOLUME_STEP);
      onGesture({ type: 'volume', value: next, delta: next - player.volume });
      break;
    }
    case 'ArrowDown': {
      const next = Math.max(0, player.volume - VOLUME_STEP);
      onGesture({ type: 'volume', value: next, delta: next - player.volume });
      break;
    }
    case 'f':
    case 'F':
      void toggleFullscreen();
      break;
    case 'Escape':
      if (gestureHelpVisible.value) closeGestureHelp();
      else if (player.fullscreen) void exitFullscreen();
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
    ref="rootRef"
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
          :brightness="player.brightness"
          :mask="player.levelSource === 'app'"
          :immersive="immersive"
          :ambilight-enabled="ambilightEnabled && !engineIsNative && !pipActive"
          :ambilight-intensity="ambilightIntensity"
          @ambilight-blocked="onAmbilightBlocked"
        >
          <!-- B2：纯音频模式原生画面层已隐藏，用海报 + 声波把「还在播」表达出来 -->
          <div v-if="audioOnly && !pipActive" class="audio-stage">
            <img
              v-if="audioBlurSrc"
              class="audio-stage__blur"
              :src="audioBlurSrc"
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              draggable="false"
            />
            <div class="audio-stage__scrim" aria-hidden="true" />
            <div class="audio-stage__body">
              <div class="audio-stage__cover">
                <PosterImage :src="item?.posterUrl ?? null" :alt="titleText" eager />
              </div>
              <div class="audio-stage__meta">
                <span class="audio-stage__badge">纯音频</span>
                <p class="audio-stage__title">{{ titleText }}</p>
                <p v-if="episodeLabel" class="audio-stage__sub">{{ episodeLabel }}</p>
                <div
                  class="audio-stage__bars"
                  :class="{ 'audio-stage__bars--still': !player.playing }"
                  aria-hidden="true"
                >
                  <i v-for="n in 5" :key="n" />
                </div>
              </div>
            </div>
          </div>

          <!-- A-03：拖动进度时把目标帧垫在主画面位置，引擎到位后撤掉 -->
          <div v-if="seekPreviewUrl && !pipActive" class="seek-preview" aria-hidden="true">
            <img :src="seekPreviewUrl" alt="" draggable="false" />
          </div>

          <!-- B-06：播放头进入片头/片尾区时出胶囊；右下角让给连播提示时不出 -->
          <SkipIntroPrompt
            v-if="skipZone && !pipActive && countdown === null"
            :zone="skipZone"
            :countdown="skipCountdown"
            :total="skipIntro.total"
            :auto="skipAuto"
            @skip="skipIntro.skip"
            @dismiss="skipIntro.dismiss"
          />

          <!-- B-04：点中弹幕后浮在它头顶的操作条（canvas 不吃指针，靠手势层递坐标） -->
          <DanmakuActions
            v-if="danmakuPicked"
            :pick="danmakuPicked"
            :liked="danmakuLiked"
            :like-count="danmakuLikeCount"
            @like="onDanmakuLike"
            @copy="danmakuPick.copyText"
            @locate="danmakuPick.locate"
            @close="danmakuPick.close"
          />

          <GestureLayer
            v-if="!pageLoading && !loadError && !player.error && !screenLocked"
            :seek-max-sec="gestureSettings.seekMaxSec"
            :sensitivity="gestureSettings.sensitivity"
            :long-press-help-enabled="gestureHelpEnabled"
            @intent="onStageIntent"
            @pointer-down="onGesturePointerDown"
          />

          <!-- P1-1：手势引导（首次进入自动显示） -->
          <GestureGuide v-if="!pageLoading && !loadError && !player.error && !screenLocked" />

          <!-- OPT-10：手势帮助浮层（暂停态长按 3 秒 / 「更多 → 手势说明」） -->
          <GestureHelpOverlay :visible="gestureHelpVisible" @close="closeGestureHelp" />

          <PlayerHud
            :kind="hud.kind"
            :value="hud.value"
            :delta-sec="hud.deltaSec"
            :rate="player.rate"
          />

          <PlayerControls
            v-if="!loadError"
            :visible="controlsVisible && !screenLocked"
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
            :film="seekFilm"
            :marks="skipMarks"
            @back="goBack"
            @toggle-play="togglePlay"
            @prev="goToPrevEpisode"
            @next="goToNextEpisode"
            @seek="onSeekCommit"
            @seeking="onSeekPreview"
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
            v-if="engineIsNative && immersive && !pipActive && !screenLocked && embeddedTracks.audio.length > 0"
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

          <!-- B4：横屏屏幕锁（放在最后，锁定态拦截片要盖住上面所有交互层） -->
          <PlayerScreenLock
            v-if="immersive && !pipActive && !loadError && !player.error"
            :locked="screenLocked"
            :revealed="lockPillVisible"
            @toggle="toggleScreenLock"
            @reveal="revealLockPill"
          />
        </PlayerSurface>

        <!-- 弹幕样式实时调节面板（非模态，叠在 player-stage 内） -->
        <DanmakuStylePanel :open="danmakuStylePanelOpen && !screenLocked" />
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

        <!-- P0-2：离线文件时间轴异常（能打开但永不推进）：只给「重新下载」出口 -->
        <div
          v-if="localStallTaskId && !localMissingTaskId"
          class="player-local-missing"
          role="status"
          data-test="local-stall"
        >
          <span class="player-local-missing__text">离线文件时间轴异常，本机播放器无法续读</span>
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
            :disabled="favoritePending"
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
            :current-id="playingIdentity?.episodeId ?? null"
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
    <DanmakuSettingsSheet v-model:open="danmakuOpen" :import-xml="importLocalDanmaku" />
    <SkipMarkSheet
      v-model="skipMarkOpen"
      :marks="skipMarks"
      :current-time="player.currentTime"
      :duration="player.duration"
      :auto-skip="skipAuto"
      @mark="onSkipMark"
      @clear="onSkipClear"
      @update:auto-skip="onAutoSkipChange"
    />
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
      :ambilight="playerSettings.ambilight !== false"
      :ambilight-intensity="ambilightIntensity"
      @select="onDisplayModeSelect"
      @set-ambilight="setAmbilight"
      @set-ambilight-intensity="setAmbilightIntensity"
    />

    <BottomSheet v-model="episodeOpen" title="选集">
      <EpisodeList
        :episodes="episodes"
        :current-id="playingIdentity?.episodeId ?? null"
        @select="chooseEpisode"
      />
    </BottomSheet>

    <BottomSheet v-model="moreOpen" title="更多">
      <ul class="sheet-list">
        <li><button class="sheet-list__item" type="button" @click="openDetail">查看详情</button></li>
        <li><button class="sheet-list__item" type="button" @click="pickerOpen = true">下载本集</button></li>
        <li><button class="sheet-list__item" type="button" @click="skipMarkOpen = true">片头 / 片尾标记</button></li>
        <li>
          <button class="sheet-list__item" type="button" @click="moreOpen = false; sleepOpen = true">
            <span>睡眠定时</span>
            <span class="sheet-list__value" :class="{ 'sheet-list__value--on': sleepActive }">
              {{ sleepLabel }}
            </span>
          </button>
        </li>
        <li class="sheet-list__row">
          <span class="sheet-list__label">
            后台播放
            <small class="sheet-list__note">
              {{ engineIsNative ? '切到后台或锁屏后继续播放' : '仅原生播放器支持' }}
            </small>
          </span>
          <ToggleSwitch
            :model-value="backgroundPlayback"
            :disabled="!engineIsNative"
            label="后台播放"
            @change="toggleBackgroundPlayback"
          />
        </li>
        <li class="sheet-list__row">
          <span class="sheet-list__label">
            纯音频
            <small class="sheet-list__note">
              {{ engineIsNative ? '收起画面只听声音，省电省流量' : '仅原生播放器支持' }}
            </small>
          </span>
          <ToggleSwitch
            :model-value="audioOnly"
            :disabled="!engineIsNative"
            label="纯音频模式"
            @change="setAudioOnly"
          />
        </li>
        <li>
          <button class="sheet-list__item" type="button" @click="moreOpen = false; showGestureHelp()">
            手势说明
          </button>
        </li>
      </ul>
    </BottomSheet>

    <SleepTimerSheet
      v-model="sleepOpen"
      :choice="sleepChoice"
      :remaining-sec="sleepRemainingSec"
      @minutes="armSleepMinutes"
      @finish-episode="armSleepEpisode"
      @cancel="cancelSleep"
    />

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

    <!-- F2：连看里程碑爆米花桶仪式（暂停 / 片尾触发，不干扰播放） -->
    <BingeCelebration :show="bingeShow" :title="item ? item.title : null" @dismiss="dismissBinge" />
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

/*
 * A-03 拖动预览帧：铺在视频容器的位置上，用同样的 contain 留黑边，
 * 这样松手撤层时画面尺寸和位置都不变，只有一次内容替换。
 */
.seek-preview {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #000;
  pointer-events: none;
}

.seek-preview img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* B2：纯音频舞台——海报虚化铺底 + 前景封面 + 声波，指针穿透交给手势层 */
.audio-stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background-color: var(--color-bg-base);
  pointer-events: none;
}

.audio-stage__blur {
  position: absolute;
  inset: -12%;
  width: 124%;
  height: 124%;
  object-fit: cover;
  filter: blur(28px) saturate(1.4);
  opacity: 0.5;
  transform: scale(1.05);
}

.audio-stage__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    115deg,
    color-mix(in srgb, var(--color-bg-base) 88%, transparent) 0%,
    color-mix(in srgb, var(--color-brand) 22%, transparent) 55%,
    color-mix(in srgb, var(--color-bg-base) 78%, transparent) 100%
  );
}

.audio-stage__body {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: 0 var(--space-5);
}

.audio-stage__cover {
  flex: 0 0 auto;
  height: 62%;
  aspect-ratio: 2 / 3;
  border-radius: var(--radius-card);
  overflow: hidden;
  box-shadow: var(--shadow-3);
}

.audio-stage__meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.audio-stage__badge {
  align-self: flex-start;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  background-color: color-mix(in srgb, var(--color-brand) 26%, transparent);
  color: var(--color-brand);
  font: var(--text-caption);
}

.audio-stage__title {
  overflow: hidden;
  color: var(--color-text-primary);
  font: var(--text-title-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-stage__sub {
  color: var(--color-text-secondary);
  font: var(--text-label);
}

.audio-stage__bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 20px;
  margin-top: var(--space-2);
}

.audio-stage__bars i {
  width: 3px;
  height: 100%;
  border-radius: var(--radius-full);
  background-color: var(--color-brand);
  transform-origin: bottom;
  animation: audio-bar 900ms var(--ease-standard) infinite alternate;
}

.audio-stage__bars i:nth-child(2) { animation-duration: 620ms; }
.audio-stage__bars i:nth-child(3) { animation-duration: 1080ms; }
.audio-stage__bars i:nth-child(4) { animation-duration: 760ms; }
.audio-stage__bars i:nth-child(5) { animation-duration: 940ms; }

.audio-stage__bars--still i {
  animation-play-state: paused;
  transform: scaleY(0.22);
  opacity: 0.5;
}

@keyframes audio-bar {
  from { transform: scaleY(0.2); }
  to { transform: scaleY(1); }
}

@media (prefers-reduced-motion: reduce) {
  .audio-stage__bars i {
    animation: none;
    transform: scaleY(0.6);
  }

  .audio-stage__bars i:nth-child(2) { transform: scaleY(0.9); }
  .audio-stage__bars i:nth-child(4) { transform: scaleY(0.4); }
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

.sheet-list__value {
  margin-left: auto;
  color: var(--color-text-tertiary);
  font: var(--text-label);
  font-variant-numeric: tabular-nums;
}

.sheet-list__value--on {
  color: var(--color-brand-text);
}

.sheet-list__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: 60px;
  padding: var(--space-2);
  border-bottom: 1px solid var(--color-divider);
}

.sheet-list__label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--color-text-primary);
  font: var(--text-body-strong);
}

.sheet-list__note {
  color: var(--color-text-secondary);
  font: var(--text-caption);
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
