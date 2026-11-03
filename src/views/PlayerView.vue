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
  SubtitleSettings,
} from '@/types';
import type { PlayerLoadOptions } from '@/player/types';
import { shouldIgnoreShortcut } from '@/player/shortcutGuard';
import { formatClock } from '@/shared/time';
import { toErrorShape } from '@/shared/errors';
import { guidanceOf, magnetUrlOf } from '@/shared/sourceFailure';

import PlayerSurface from '@/components/player/PlayerSurface.vue';
import PlayerControls from '@/components/player/PlayerControls.vue';
import GestureLayer from '@/components/player/GestureLayer.vue';
import PlayerHud from '@/components/player/PlayerHud.vue';
import SpeedSheet from '@/components/player/SpeedSheet.vue';
import SubtitleSheet from '@/components/player/SubtitleSheet.vue';
import QualitySheet from '@/components/player/QualitySheet.vue';
import PlayerErrorPanel from '@/components/player/PlayerErrorPanel.vue';
import NextEpisodePrompt from '@/components/player/NextEpisodePrompt.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
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
import { castService } from '@/services/castService';
import { useBackButton } from '@/composables/useBackButton';
import { usePlayerController } from '@/composables/usePlayerController';
import { offlineEpisodeMessage, resolveTargetEpisode } from '@/player/episodeFallback';
import { DanmakuOverlay } from '@/player/DanmakuOverlay';
import { danmakuService } from '@/services/danmakuService';
import DanmakuSettingsSheet from '@/components/player/DanmakuSettingsSheet.vue';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { DIM_MAX_OPACITY, QUALITY_AUTO } from '@/player/constants';
import { PLAYER_FAILOVER_WINDOW_MS } from '@/shared/constants';
import { localProxyUrl } from '@/native/localProxy';
import { libraryService } from '@/services/libraryService';
import { sourceService } from '@/services/sourceService';
import { pickPlayCandidates } from '@/sources/douban/playMatch';
import { healthService } from '@/services/healthService';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const history = useHistoryStore();
const favorites = useFavoriteStore();
const downloads = useDownloadStore();
const settings = useSettingsStore();
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

const item = computed(() => library.detail?.item ?? null);
const lines = computed(() => library.detail?.lines ?? []);
const lineId = ref<string | null>(null);
const currentLineId = computed(() => lineId.value ?? lineIdParam.value ?? lines.value[0]?.id ?? null);

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
const subtitleSettings = computed<SubtitleSettings>(
  () => playerSettings.value.subtitle ?? PLAYER_FALLBACK.subtitle,
);

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
  subtitle: subtitleSettings.value,
  defaultRate: defaultRate.value,
  autoPlayNext: autoPlayNext.value,
  describe: () => {
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
    };
  },
});

const {
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
  onGesture,
  cancelAutoNext,
  resumeFromBackground,
} = playerCtl;

/* ---------- 面板 ---------- */
const speedOpen = ref(false);
const subtitleOpen = ref(false);
const qualityOpen = ref(false);
const episodeOpen = ref(false);
const moreOpen = ref(false);
const pickerOpen = ref(false);
const downloading = ref(false);

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
 * 起播等待分级提示（P1-9）：resolvePlay + 引擎加载超过 6s 时升级文案，
 * 让用户知道是「源慢」而不是 App 卡死。
 */
const loadingHint = ref('正在加载…');
let loadingHintTimer: ReturnType<typeof setTimeout> | null = null;

function startLoadingHint(): void {
  clearLoadingHint();
  loadingHint.value = '正在加载…';
  loadingHintTimer = setTimeout(() => {
    loadingHint.value = '源响应较慢，仍在连接…可稍候，或返回后换线路';
  }, 6000);
}

function clearLoadingHint(): void {
  if (loadingHintTimer !== null) {
    clearTimeout(loadingHintTimer);
    loadingHintTimer = null;
  }
}

onBeforeUnmount(clearLoadingHint);

/**
 * 直链带防盗链头时经本机回环代理注入（P1-6）。
 * HLS 由 hls.js 的 xhrSetup 注入头，不需要；代理失败沿用原地址（与旧行为一致）。
 */
async function preparePlayback(playback: PlaybackSource): Promise<PlaybackSource> {
  const proxied = await localProxyUrl(playback);
  return proxied ? { ...playback, url: proxied } : playback;
}

/**
 * 解析并加载当前集/线路。
 * 返回是否成功：`resolvePlay` 抛错 → `loadError`；引擎加载失败 → `player.error`。
 * 线路切换需要据此判断是否回退原线路（AC-55 / REV-05）。
 */
async function resolveAndLoad(): Promise<boolean> {
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
  startLoadingHint();
  // v1.7/CHG-21：记录起播时刻——失败自动兜底只在窗口期内触发
  failoverStartedAt.value = Date.now();
  try {
    const playback = await library.resolvePlay(it.id, ep.id, currentLineId.value);
    const prepared = await preparePlayback(playback);
    currentPlayback.value = prepared;
    const rec = history.progressOf(it.sourceId, it.id);
    let start = 0;
    if (!restart.value && rec && rec.episodeId === ep.id) {
      const duration = rec.durationSec > 0 ? rec.durationSec : (ep.durationSec ?? 0);
      const ratio = duration > 0 ? rec.positionSec / duration : 0;
      if (ratio > 0.05 && ratio < 0.95) start = rec.positionSec;
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
    // 「本地文件不可用，已切换网络源」时在页面给出「重新下载」入口（AC-78②）
    detectLocalMissing();
    // `load()` 内部把失败写入 player.error 而不抛出，这里显式判定
    const ok = loadError.value === null && player.error === null;
    if (ok) {
      // 起播成功：重置自动兜底状态（CHG-21），下次失败重新各试一次
      failoverLineTried.value = false;
      failoverSourceTried.value = false;
    }
    return ok;
  } catch (e) {
    const shape = toErrorShape(e, 'E_NO_PLAY_URL');
    // 失败换线时并发解析会双跑：先成功者已在播，后失败者（嗅探 15s 超时）若把
    // 错误面板盖上去，用户看到的是「有声音却报无播放地址」。播放中一律不覆盖。
    if (player.playing) return false;
    loadErrorShape.value = shape;
    loadError.value = shape.message;
    return false;
  } finally {
    pageLoading.value = false;
    clearLoadingHint();
  }
}

onMounted(async () => {
  void detectCastSupport();
  await Promise.all([settings.load(), history.load(), favorites.load(), downloads.load()]);
  await library.loadDetail(mediaId.value);
  detailReady.value = true;
  if (library.detailState === 'error') {
    loadError.value = library.error?.message ?? '详情加载失败';
    pageLoading.value = false;
    return;
  }
  if (stageRef.value) createController(stageRef.value);
  await resolveAndLoad();
  // AC-68：记录集号已下线时明确提示，而不是静默从第 1 集起播
  announceOfflineEpisode();
});

/* ---------- 关闭时写回进度 ---------- */
onBeforeUnmount(() => {
  cancelAutoNext();
});

/* ---------- 标题/集标签 ---------- */
const titleText = computed(() => item.value?.title ?? '播放');
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

/* ---------- 切换线路（AC-31 保持集号 / AC-55 失败回退原线路） ---------- */

/**
 * 线路切换内部改路由时，`episodeId` watcher 会跟着触发第二次加载。
 * 这里用"待加载目标集"标记让 watcher 跳过——比布尔开关更精确（只吞自己发起的那一次）。
 */
let pendingLineSwitchEpisode: string | null = null;

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

  switchingLine.value = true;
  try {
    lineId.value = targetLineId;
    pendingLineSwitchEpisode = targetEpisode?.id ?? previousEpisodeId;
    await replaceRoute(targetEpisode?.id ?? previousEpisodeId, targetLineId);
    if (await resolveAndLoad()) return;

    // ---- 回退原线路 ----
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

/** 在其它启用源里找同名同年的可播条目，返回其 mediaId 与源名 */
async function findAlternateSource(): Promise<{ mediaId: string; sourceName: string } | null> {
  const it = item.value;
  if (!it || !isOnlineNow()) return null;
  try {
    const [result, allSources] = await Promise.all([libraryService.search({ keyword: it.title }), sourceService.list()]);
    const sourceById = new Map(allSources.map((s) => [s.id, s]));
    const candidates = pickPlayCandidates(it.title, it.year, result.items, sourceById, (id) =>
      healthService.latencyOf(id),
    ).filter((candidate) => candidate.source.id !== it.sourceId);
    for (const candidate of candidates) {
      try {
        const detail = await libraryService.getDetail(candidate.item.id);
        const target = detail.episodes.find((ep) => ep.number === (currentEpisode.value?.number ?? 1)) ?? detail.episodes[0];
        if (!target) continue;
        await router.replace({
          name: 'player',
          params: { mediaId: candidate.item.id, episodeId: target.id },
        });
        // mediaId 变化不会自动触发重载：显式加载新详情与新集
        await library.loadDetail(candidate.item.id);
        return { mediaId: candidate.item.id, sourceName: candidate.source.name };
      } catch {
        continue; // 候选源也失败 → 顺延下一个
      }
    }
  } catch {
    /* 搜索失败：按无候选处理 */
  }
  return null;
}

function isOnlineNow(): boolean {
  return navigator.onLine !== false;
}

/** 起播窗口内失败：自动换线（一次）→ 自动换源（一次）→ 才落到错误面板 */
watch(
  () => player.error,
  async (error) => {
    if (!error || failoverRunning.value) return;
    if (!FAILOVER_ERROR_CODES.has(error.code) || !withinFailoverWindow()) return;
    failoverRunning.value = true;
    try {
      // ① 换线路
      if (!failoverLineTried.value && lines.value.length > 1) {
        failoverLineTried.value = true;
        const other = lines.value.find((l) => l.id !== currentLineId.value);
        if (other) {
          toast.info('起播失败，自动切换到其它线路…');
          await switchLine(other.id);
          if (player.error === null && loadError.value === null) return; // 换线成功
        }
      }
      // ② 换源（同名同年在其它源重找片源；进度按集号延续）
      if (!failoverSourceTried.value) {
        failoverSourceTried.value = true;
        player.patch({ error: null });
        toast.info('当前源无法播放，正在尝试其它来源…');
        const target = await findAlternateSource();
        if (target) {
          toast.info(`已切换到「${target.sourceName}」继续播放`);
          await resolveAndLoad();
          if (player.error === null && loadError.value === null) return;
        }
      }
      // 兜底失败：恢复错误面板（清掉的错误重新呈现）
      if (player.error === null && loadError.value === null) {
        player.patch({ error });
      }
    } finally {
      failoverRunning.value = false;
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
    const target = await findAlternateSource();
    if (target) {
      toast.info(`已切换到「${target.sourceName}」继续播放`);
      await resolveAndLoad();
      if (player.error === null && loadError.value === null) return;
    }
  } finally {
    failoverRunning.value = false;
  }
  // 手动也失败：恢复错误面板（清掉的错误重新呈现）
  if (player.error === null && loadError.value === null && lastError) {
    player.patch({ error: lastError });
  }
}

/** v1.8/CHG-26：跳源管理页体检（一键禁用失效源入口所在页） */
function goHealthCheck(): void {
  void router.push('/settings/sources');
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

function chooseEpisode(ep: Episode): void {
  episodeOpen.value = false;
  if (ep.id === currentEpisode.value?.id) return;
  void router.replace({
    name: 'player',
    params: { mediaId: mediaId.value, episodeId: ep.id },
    query: currentLineId.value ? { lineId: currentLineId.value } : {},
  });
  void resolveAndLoad();
}

function retryPanel(): void {
  reload();
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
const danmakuOverlay = shallowRef<DanmakuOverlay | null>(null);

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
  toast.info(loaded ? '弹幕已开启' : '当前集没有匹配到弹幕（可换弹幕源或稍后再试）', loaded ? 1800 : 2800);
}

/** v1.8 修复：原生引擎 surface 移到 WebView 之下，DOM 层（弹幕/字幕）可见，无需互斥 */

/** v1.8 修复：字幕面板入口——原生引擎下 DOM 层可见，无需互斥 */
function openSubtitlePanel(): void {
  subtitleOpen.value = true;
}

/** 设置开启/关闭 → 挂载或卸载渲染层 */
watch(danmakuReady, (ready) => {
  if (ready && stageRef.value && danmakuOverlay.value === null) {
    const overlay = new DanmakuOverlay({
      settings: danmakuSettings.value,
      getTime: () => player.currentTime,
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

/* ---------- 沉浸态 ---------- */
const immersive = computed(() => player.fullscreen);

/* ---------- 键盘快捷键（桌面浏览器） ---------- */
/**
 * 焦点落在输入区或弹层内时让出键盘控制（REV-18，判定见 `player/shortcutGuard`）。
 */
function onKeydown(ev: KeyboardEvent): void {
  if (shouldIgnoreShortcut(ev.target)) return;
  switch (ev.key) {
    case ' ':
      ev.preventDefault();
      void togglePlay();
      break;
    case 'ArrowLeft':
      seek(player.currentTime - 10);
      break;
    case 'ArrowRight':
      seek(player.currentTime + 10);
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
const brightnessPercent = computed(() => Math.round(100 - (player.dim / DIM_MAX_OPACITY) * 100));
</script>

<template>
  <main
    class="player-root"
    :class="{ 'player-root--landscape': immersive, 'player-root--native': player.engineKind === 'native' }"
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
          />

          <!-- v1.7/CHG-22：弹幕 HUD（开关 + 设置入口） -->
          <div v-if="!pageLoading && !loadError && !player.error" class="danmaku-hud">
            <button
              class="danmaku-hud__btn"
              :class="{ 'danmaku-hud__btn--on': danmakuSettings.enabled }"
              type="button"
              :aria-label="danmakuSettings.enabled ? '关闭弹幕' : '开启弹幕'"
              @click.stop="toggleDanmaku"
            >
              弹
            </button>
            <button
              class="danmaku-hud__btn"
              type="button"
              aria-label="弹幕设置"
              @click.stop="danmakuOpen = true"
            >
              ⚙
            </button>
          </div>

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
            @back="goBack"
            @toggle-play="togglePlay"
            @prev="prevEpisode"
            @next="nextEpisode"
            @seek="seek"
            @seeking="player.patch({ currentTime: $event })"
            @open-speed="speedOpen = true"
            @open-subtitle="openSubtitlePanel"
            @open-quality="qualityOpen = true"
            @toggle-fullscreen="toggleFullscreen"
            @download="onDownloadCurrent"
            @cast="onCast"
          />

          <!-- loading -->
          <div v-if="pageLoading && !loadError" class="player-loading" role="status" aria-live="polite">
            <LoadingSpinner :size="32" />
            <p class="player-loading__text">{{ loadingHint }}</p>
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
            <p class="player-loading__text">{{ loadError }}</p>
            <!-- P0-1：给出可行动原因（源站死 / 超时 / 磁力 / 规则脚本异常） -->
            <p v-if="loadErrorGuidance" class="player-loading__hint">{{ loadErrorGuidance.hint }}</p>
            <div class="player-loading__actions">
              <!-- P1-4：磁力链接只能外部打开，重试无意义 -->
              <button
                v-if="loadErrorMagnet"
                class="btn btn--primary btn--sm"
                type="button"
                @click="openExternalUrl(loadErrorMagnet)"
              >
                用外部应用打开
              </button>
              <button
                v-if="!loadErrorMagnet"
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
            @confirm="nextEpisode"
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
        </div>

        <section v-if="episodes.length > 0" class="player-info__section">
          <div class="player-info__head">
            <h2 class="section-title">选集 <span class="player-info__count">共 {{ episodes.length }} 集</span></h2>
            <LineSelector
              v-if="lines.length > 1"
              :lines="lines"
              :model-value="currentLineId"
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
  </main>
</template>

<style scoped>
/* v1.7/CHG-22：弹幕 HUD（播放区内右上角，pointer 事件不透传） */
.danmaku-hud {
  position: absolute;
  top: calc(var(--safe-top) + var(--space-8));
  right: var(--space-2);
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.danmaku-hud__btn {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background-color: rgba(0, 0, 0, 0.45);
  color: rgba(255, 255, 255, 0.6);
  font: var(--text-caption);
}

.danmaku-hud__btn--on {
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.7);
}
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
  gap: var(--space-2);
  margin-top: var(--space-4);
}

.player-info__action {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 40px;
  padding: 0 var(--space-4);
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
