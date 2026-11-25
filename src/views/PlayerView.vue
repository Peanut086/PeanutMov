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
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";

import type {
  AppErrorShape,
  DownloadTask,
  Episode,
  GestureSettings,
  PlaybackRate,
  PlaybackSource,
  PlayerSettings,
  ResizeMode,
  SubtitleSettings,
} from "@/types";
import type { DrawerTab, PlayerLoadOptions } from "@/player/types";
import {
  emptyEmbeddedTracks,
  type EmbeddedTrackState,
} from "@/player/PlayerController";
import { shouldIgnoreShortcut } from "@/player/shortcutGuard";
import { formatPlayerClock } from "@/shared/time";
import { toErrorShape, isCanceled } from "@/shared/errors";
import { logger } from "@/shared/logger";
import { guidanceOf, magnetUrlOf } from "@/shared/sourceFailure";
import { IMG_W_BLUR, sizedImage } from "@/shared/imageSize";

import PlayerSurface from "@/components/player/PlayerSurface.vue";
import PlayerControls from "@/components/player/PlayerControls.vue";
import PlayerDrawer from "@/components/player/PlayerDrawer.vue";
import GestureLayer from "@/components/player/GestureLayer.vue";
import PinchResizeHud from "@/components/player/PinchResizeHud.vue";
import GestureGuide from "@/components/player/GestureGuide.vue";
import GestureHelpOverlay from "@/components/player/GestureHelpOverlay.vue";
import PlayerHud from "@/components/player/PlayerHud.vue";
import SpeedSheet from "@/components/player/SpeedSheet.vue";
import SubtitleSheet from "@/components/player/SubtitleSheet.vue";
import SubtitleTrackMenu from "@/components/player/SubtitleTrackMenu.vue";
import AudioTrackMenu from "@/components/player/AudioTrackMenu.vue";
import QualitySheet from "@/components/player/QualitySheet.vue";
import DisplayModeSheet from "@/components/player/DisplayModeSheet.vue";
import SkipMarkSheet from "@/components/player/SkipMarkSheet.vue";
import PostcardSheet from "@/components/player/PostcardSheet.vue";
import ShareCodeSheet from "@/components/player/ShareCodeSheet.vue";
import SleepTimerSheet from "@/components/player/SleepTimerSheet.vue";
import PlayerErrorPanel from "@/components/player/PlayerErrorPanel.vue";
import PlayerScreenLock from "@/components/player/PlayerScreenLock.vue";
import NextEpisodePrompt from "@/components/player/NextEpisodePrompt.vue";
import BottomSheet from "@/components/common/BottomSheet.vue";
import ToggleSwitch from "@/components/common/ToggleSwitch.vue";
import PosterImage from "@/components/common/PosterImage.vue";
import EpisodeList from "@/components/media/EpisodeList.vue";
import LineSelector from "@/components/media/LineSelector.vue";
import { useDownloadStore } from "@/stores/downloadStore";
import { useFavoriteStore } from "@/stores/favoriteStore";
import { useHistoryStore } from "@/stores/historyStore";
import { useLibraryStore } from "@/stores/libraryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSourceStore } from "@/stores/sourceStore";
import { castService } from "@/services/castService";
import { lineHealthService, lineKey } from "@/services/lineHealthService";
import { rankLines } from "@/services/lineRanking";
import {
  formatPlayTraceText,
  playTraceService,
  sharePlayTraceText,
  type TraceValue,
} from "@/services/playTraceService";
import { playUrlLifetimeService } from "@/services/playUrlLifetimeService";
import { skipMarkService } from "@/services/skipMarkService";
import { useBackButton } from "@/composables/useBackButton";
import { useBusyRetryGate } from "@/composables/useBusyRetryGate";
import { useDebounce } from "@/composables/useDebounce";
import { usePlayerController } from "@/composables/usePlayerController";
import { useSeekThumbnails } from "@/composables/useSeekThumbnails";
import { playEpisodeLeader } from "@/composables/useEpisodeLeader";
import { usePinchResize } from "@/composables/usePinchResize";
import { useSkipIntro } from "@/composables/useSkipIntro";
import { useDanmakuPick } from "@/composables/useDanmakuPick";
import { useDanmakuContrast } from "@/composables/useDanmakuContrast";
import { useCutRhythm } from "@/composables/useCutRhythm";
import { prefersReducedMotion } from "@/composables/useSpring";
import type { AmbilightBlockReason } from "@/composables/useAmbilight";
import {
  offlineEpisodeMessage,
  resolvePlaybackEpisode,
  resolvePlaybackLineId,
  resolveTargetEpisode,
} from "@/player/episodeFallback";
import { DanmakuOverlay } from "@/player/DanmakuOverlay";
import { buildLocalEpisodeCatalog } from "@/player/localEpisodeCatalog";
import { buildLocalPlaybackOptions } from "@/player/localPlayback";
import {
  isSameDanmakuIdentity,
  resolveDanmakuIdentity,
  type DanmakuPlaybackIdentity,
} from "@/player/danmakuIdentity";
import type { GestureIntent } from "@/player/GestureRecognizer";
import {
  canShowGestureHelp,
  markGestureHelpShown,
} from "@/player/gestureHelpPolicy";
import {
  DANMAKU_CHIP_MISS,
  DANMAKU_MISS_GUIDANCE,
  danmakuService,
  type DanmakuMatchResult,
  type DanmakuMissReason,
} from "@/services/danmakuService";
import DanmakuSettingsSheet from "@/components/player/DanmakuSettingsSheet.vue";
import DanmakuStylePanel from "@/components/player/DanmakuStylePanel.vue";
import DanmakuActions from "@/components/player/DanmakuActions.vue";
import { useToast } from "@/composables/useToast";
import { useScopedPalette } from "@/composables/useScopedPalette";
import {
  finishSharedCover,
  rewindSharedCover,
} from "@/composables/useSharedElement";
import { useUiStore } from "@/stores/uiStore";
import { QUALITY_AUTO } from "@/player/constants";
import { BRIGHTNESS_MAX } from "@/player/brightness";
import { WHEEL_VOLUME_STEP, resolveKeyAction } from "@/player/keyboardActions";
import {
  activeFailoverRound,
  armFailoverNavigation,
  beginLoadAttempt,
  BUSY_WAIT_MAX_MS,
  busyFailoverPlan,
  cancelFailoverRound,
  failoverAttemptKey,
  hasPendingFailoverNavigation,
  type FailoverAnchor,
  type FailoverRound,
} from "@/player/failoverSession";
import { parseSeasonNumber } from "@/sources/mapping/TitleNormalizer";
import { localProxyUrl } from "@/native/localProxy";
import { pipService } from "@/native/pipService";
import {
  describeMediaVerify,
  describeTsScan,
  isMediaToolAvailable,
  scanTsFile,
  verifyRemuxedMedia,
} from "@/native/mediaToolPlugin";
import { onAppStateChange } from "@/native/appLifecycle";
import { libraryService } from "@/services/libraryService";
import { isSourceBlocked } from "@/services/sourceBlockState";
import {
  notePlayback,
  peekBlackbox,
  type BlackboxSnapshot,
} from "@/services/blackboxService";
import { buildShareText, type ShareCodePayload } from "@/services/shareCodeService";
import { sourceService } from "@/services/sourceService";
import {
  downloadService,
  selectCompletedTask,
} from "@/services/downloadService";
import { pickPlayCandidates } from "@/sources/douban/playMatch";
import { healthService } from "@/services/healthService";
import { appEvents } from "@/services/events";
import PlayLoadingBar from "@/components/player/PlayLoadingBar.vue";
import BingeCelebration from "@/components/player/BingeCelebration.vue";
import { useAchievementStore } from "@/stores/achievementStore";
import { useHaptic } from "@/composables/useHaptic";
import { playDing } from "@/services/sfxService";
// P3-3：换线路重复下载校验（与详情页同一个闸门）
import { useDownloadGuards } from "@/composables/useDownloadGuards";

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
// P3-3：换线路重复下载校验闸门（与详情页同一个入口）
const guards = useDownloadGuards();
const achievements = useAchievementStore();
const { haptic } = useHaptic();

const mediaId = computed(() =>
  typeof route.params.mediaId === "string" ? route.params.mediaId : "",
);
const episodeIdParam = computed(() =>
  typeof route.params.episodeId === "string" ? route.params.episodeId : null,
);
const lineIdParam = computed(() =>
  typeof route.query.lineId === "string" ? route.query.lineId : null,
);
const restart = computed(() => route.query.restart === "1");
/**
 * 口令深链参数：`?ep=<集号>` 直达某集、`?t=<秒>` 指定起播点。
 * 二者只在**进入播放页的首帧**生效（消费后从 URL 移除，见 consumeDeepLinkParams），
 * 后续换源/切集不应被口令残留值反复劫持。
 */
const epParam = computed(() => {
  const raw = typeof route.query.ep === "string" ? route.query.ep : null;
  const n = raw !== null ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n >= 1 ? n : null;
});
const tParamSec = computed(() => {
  const raw = typeof route.query.t === "string" ? route.query.t : null;
  const n = raw !== null ? Number.parseFloat(raw ?? "") : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
});

/**
 * 本地优先起播（`?local=1`）时锁定的真实播放身份，来自匹配上的那条下载任务。
 *
 * 之后详情才在后台加载完，`currentEpisode` 会随网络剧集列表变化；画面放的仍是本地这一集，
 * 标题、选集高亮、片头标记与进度写回都必须以这里为准，否则会把第 2 集记成第 1 集。
 * null = 当前播放内容来自在线解析。
 */
const localIdentity = ref<{
  episodeId: string;
  episodeNumber: number | null;
  episodeTitle?: string | null;
} | null>(null);

const completedLocalTasks = computed(() =>
  downloads.tasks.filter(
    (task) => task.mediaId === mediaId.value && task.status === "completed",
  ),
);
const localEpisodeCatalog = computed(() =>
  buildLocalEpisodeCatalog(
    completedLocalTasks.value,
    localIdentity.value?.episodeId ?? episodeIdParam.value,
  ),
);

/**
 * BB-01 黑匣子恢复点：进入播放页时读一次，为首帧提供「集号锚 + 线路 + 倍速」。
 * 首轮 `resolveAndLoad` 消费后即清空——它是"刚才那次中断"的上下文，
 * 不该继续参与本会话后续的手动切集/换线决策。
 */
const blackboxAnchor = ref<BlackboxSnapshot | null>(null);

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
const detailErrorKind = computed<
  "source-removed" | "cache-cleared" | "content-gone" | null
>(() => {
  if (library.detailState !== "error" || !library.error) return null;
  const code = library.error.code;
  if (code !== "E_NOT_FOUND" && code !== "E_SOURCE_UNAVAILABLE") return null;

  // 从历史记录中查找该 mediaId 对应的 sourceId
  const historyRecord = history.items.find((r) => r.mediaId === mediaId.value);
  if (!historyRecord) return "content-gone"; // 无历史记录 → 内容下线

  const source = sources.sources.find((s) => s.id === historyRecord.sourceId);
  if (!source) return "source-removed"; // 源不存在 → 源已移除

  return "cache-cleared"; // 源存在但 media 缺失 → 缓存已清理
});

/** REV-24：详情失败时的上下文文案（覆盖全局 E_NOT_FOUND 的 "资源不存在(404)"） */
const detailErrorMessage = computed(() => {
  const kind = detailErrorKind.value;
  if (kind === "source-removed") return "该源已被移除，无法继续播放";
  if (kind === "cache-cleared")
    return "本地缓存已清理，恢复失败（需要联网或内容已下线）";
  if (kind === "content-gone") return "该内容已从源中下线";
  return loadError.value;
});

/** REV-24：详情失败时的标题兜底（从历史记录取 title，不再显示"播放"） */
const fallbackTitle = computed(() => {
  if (item.value?.title) return item.value.title;
  const record = history.items.find((r) => r.mediaId === mediaId.value);
  return record?.title ?? "播放";
});

const item = computed(() => library.detail?.item ?? null);
const playingLocalTask = computed(() => {
  const episodeId = localIdentity.value?.episodeId;
  if (!episodeId) return null;
  return completedLocalTasks.value.find((task) => task.episodeId === episodeId) ?? null;
});
const mediaHistoryRecord = computed(
  () => history.items.find((record) => record.mediaId === mediaId.value) ?? null,
);
const mediaFavoriteRecord = computed(
  () => favorites.items.find((record) => record.mediaId === mediaId.value) ?? null,
);
const playbackMediaYear = computed<number | null | undefined>(() => {
  if (item.value) return item.value.year;
  if (mediaHistoryRecord.value?.mediaSnapshot) return mediaHistoryRecord.value.mediaSnapshot.year;
  return mediaFavoriteRecord.value?.year;
});
/** 染色作用域根节点：与详情页共用同一份取色缓存 */
const rootRef = ref<HTMLElement | null>(null);
useScopedPalette(
  rootRef,
  computed(() => item.value?.posterUrl ?? null),
);
const lines = computed(() => library.detail?.lines ?? []);
const lineId = ref<string | null>(null);

/* ---------- P0-2：换线 / 换源会话（跨路由存活的预算） ---------- */

/**
 * 为什么要搬到模块级会话：`App.vue` 用 `current.fullPath` 给路由组件打 key，播放页又会
 * 在每次 `router.replace` 时被重建。过去预算记在实例 ref 上（`failoverStartedAt` /
 * `failoverLineTried` / `failoverSourceTried`），重建即归零——真机表现就是集号在 ep1/ep2
 * 之间来回跳、线路一直自动切到全部失效：每一轮都以为自己是第一次，35 秒窗口和
 * 「最多再试几条线路」的上限从未真正生效。
 *
 * 现在实例只持有会话句柄（`failoverHandle()` 每次与模块里的当前会话对齐）：deadline、
 * 已试线路集、线路/换源额度与目标季/集锚定都在 `failoverSession` 里。目标相同即沿用同一轮，
 * 换线引起的路由重建因此拿不到新预算；换集 / 换片 / 用户明确重试才开新一轮。
 */
const failoverRound = shallowRef<FailoverRound | null>(null);
/** 兜底链并发锁（同一实例内不重入；真正的额度约束在会话里） */
const failoverRunning = ref(false);

/**
 * 线路优先级：用户显式切换 > 目标集所属线路 > 路由/历史线路 > 黑匣子锚点 > 首条。
 * 路由线路已消失时不能原样返回，否则当前线路为空，续播会直接卡在缺集披露态。
 */
const currentLineId = computed(() =>
  resolvePlaybackLineId({
    explicitLineId: lineId.value,
    episodes: library.detail?.episodes ?? [],
    lineIds: lines.value.map((line) => line.id),
    episodeId: episodeIdParam.value,
    requestedLineId: lineIdParam.value,
    anchorLineId: blackboxAnchor.value?.lineId ?? null,
  }),
);
const currentLine = computed(
  () => lines.value.find((l) => l.id === currentLineId.value) ?? null,
);

const episodes = computed<Episode[]>(() => {
  const det = library.detail;
  if (!det) return [];
  const id = currentLineId.value;
  const filtered = id
    ? det.episodes.filter((ep) => ep.lineId === id)
    : det.episodes;
  return filtered.sort((a, b) => a.number - b.number);
});

const navigationEpisodes = computed<Episode[]>(() => {
  if (!localIdentity.value) return episodes.value;
  return localEpisodeCatalog.value.map(({ episode, task }) => ({
    id: episode.episodeId,
    mediaId: mediaId.value,
    sourceId: task.sourceId,
    lineId: task.lineId ?? "local",
    number: episode.number,
    title: episode.title,
    durationSec: null,
    subtitles: [],
    updatedAt: task.updatedAt,
  }));
});

/**
 * 目标集定位（P1-1）：口径全部下沉到 `resolvePlaybackEpisode`，页面只负责披露。
 *
 * 过去"路由 id 在当前线路找不到就播首集"会让进度写回、弹幕匹配、下载入口一起
 * 记到第 1 集上，用户完全看不出来（真机日志 4 次「回退首集」都是这个形态）。
 * 现在定位失败即 `targetEpisodeMissing`，由 `resolveAndLoad` 拦在起播之前。
 */
const episodeResolution = computed(() =>
  resolvePlaybackEpisode({
    lineEpisodes: episodes.value,
    allEpisodes: library.detail?.episodes ?? [],
    routeEpisodeId: episodeIdParam.value,
    deepLinkNumber: epParam.value,
    historyNumber:
      episodeIdParam.value === null
        ? null
        : (history.items.find(
            (r) =>
              r.mediaId === mediaId.value &&
              r.episodeId === episodeIdParam.value,
          )?.episodeNumber ?? null),
    anchorNumber: blackboxAnchor.value?.episodeNumber ?? null,
    offlineNumber: offlineEpisodeNumber.value,
  }),
);

const currentEpisode = computed<Episode | null>(
  () => episodeResolution.value.episode,
);

/** 路由明确指向某一集，但当前线路里没有任何口径能定位到它 */
const targetEpisodeMissing = computed(
  () => !localIdentity.value && episodeResolution.value.missing,
);

/**
 * 正在播（或原本要播）的集号：当前集 > 路由 id 的历史集号 > 黑匣子集号锚。
 * 换线路/换源按它对齐——定位失败时不能拿"第 1 集"当代号，否则换出去的正是错集。
 */
const targetEpisodeNumber = computed<number | null>(() => {
  const ep = currentEpisode.value;
  if (ep) return ep.number;
  const wanted = episodeIdParam.value;
  if (wanted !== null) {
    const n = history.items.find(
      (r) => r.mediaId === mediaId.value && r.episodeId === wanted,
    )?.episodeNumber;
    if (n !== undefined && n !== null) return n;
  }
  return blackboxAnchor.value?.episodeNumber ?? null;
});

/**
 * 用户意图集号（P0-2 的会话锚定值）：只看路由与记录，不受本轮钉位影响。
 *
 * `targetEpisodeNumber` 会跟着 `pinnedNumber` 走，用它当锚会把"钉住"变成自我循环——
 * 用户真换了集也识别不出来。这里刻意从路由 id / `?ep` 反查，换季换片都能被看见。
 */
const routeEpisodeNumber = computed<number | null>(() => {
  const wanted = episodeIdParam.value;
  if (wanted !== null) {
    const byId = library.detail?.episodes.find(
      (ep) => ep.id === wanted,
    )?.number;
    if (byId !== undefined && byId !== null) return byId;
    const byHistory = history.items.find(
      (r) => r.mediaId === mediaId.value && r.episodeId === wanted,
    )?.episodeNumber;
    if (byHistory !== undefined && byHistory !== null) return byHistory;
  }
  return epParam.value ?? blackboxAnchor.value?.episodeNumber ?? null;
});

/** 正在播放的真实身份：本地优先起播以本地任务为准，在线解析以解析出的当前集为准。 */
const playingIdentity = computed<{
  episodeId: string;
  episodeNumber: number | null;
  episodeTitle?: string | null;
} | null>(() => {
  const local = localIdentity.value;
  if (local) return local;
  const ep = currentEpisode.value;
  return ep ? { episodeId: ep.id, episodeNumber: ep.number, episodeTitle: ep.title } : null;
});

const danmakuIdentity = computed(() => {
  const identity = playingIdentity.value;
  return resolveDanmakuIdentity({
    episodeId: identity?.episodeId ?? null,
    episodeNumber: identity?.episodeNumber ?? null,
    localTaskTitle: playingLocalTask.value?.title,
    detailTitle: item.value?.title,
    detailYear: item.value?.year,
    historyTitle: mediaHistoryRecord.value?.title,
    historyYear: mediaHistoryRecord.value?.mediaSnapshot?.year,
    favoriteYear: mediaFavoriteRecord.value?.year,
  });
});

/** 批次1：线路健康状态 Map（供 LineSelector 显示状态点） */
const lineStatuses = computed(() => {
  const it = item.value;
  if (!it)
    return new Map<
      string,
      import("@/services/lineHealthService").LineHealthStatus
    >();
  const map = new Map<
    string,
    import("@/services/lineHealthService").LineHealthStatus
  >();
  for (const line of lines.value) {
    const key = lineKey(it.sourceId, it.sourceItemId, line.name);
    map.set(line.id, lineHealthService.statusOf(key));
  }
  return map;
});

/** P1-4：线路最近一次探测耗时（ms）；未探测过的线路不给数字，不编造 */
const lineLatencies = computed(() => {
  const it = item.value;
  const map = new Map<string, number | null>();
  if (!it) return map;
  for (const line of lines.value) {
    const key = lineKey(it.sourceId, it.sourceItemId, line.name);
    const known = lineHealthService.statusOf(key) !== "unknown";
    map.set(
      line.id,
      known ? (lineHealthService.entryOf(key)?.lastResolveMs ?? null) : null,
    );
  }
  return map;
});

/** 批次1：推荐的线路 ID（评分最高） */
const recommendedLineId = computed(() => {
  const it = item.value;
  if (!it || lines.value.length === 0) return null;
  const ranked = rankLines({
    lines: lines.value,
    historyEpisodeId: null, // 评分推荐与续播线路解耦
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

const historyLineUnavailable = computed(() => {
  const requested = lineIdParam.value;
  const recorded = mediaHistoryRecord.value?.lineId;
  return detailReady.value
    && requested !== null
    && recorded === requested
    && lines.value.length > 0
    && !lines.value.some((line) => line.id === requested);
});

const announcedHistoryLineFallback = ref<string | null>(null);

function announceHistoryLineFallback(): void {
  const requested = lineIdParam.value;
  if (!historyLineUnavailable.value || requested === null) return;
  if (announcedHistoryLineFallback.value === requested) return;
  announcedHistoryLineFallback.value = requested;
  toast.info("历史线路已不可用，已切换到可用线路", 3600);
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
    size: "medium",
    color: "white",
    background: "black",
    offsetSec: 0,
    preferredLang: null,
  },
  lastVolume: 100,
  resizeMode: "contain",
  autoSkipIntro: true,
  seekDetent: 60,
  ambilight: true,
  ambilightIntensity: 85,
};
const GESTURE_FALLBACK: GestureSettings = {
  sensitivity: "medium",
  seekMaxSec: 90,
};

const playerSettings = computed<PlayerSettings>(
  () => settings.player ?? PLAYER_FALLBACK,
);
const gestureSettings = computed<GestureSettings>(
  () => settings.gesture ?? GESTURE_FALLBACK,
);

/** v1.8/CHG-25：实验性原生引擎（ExoPlayer）开关——注入 PlayerLoadOptions，控制器不读设置 */
const nativeEngineEnabled = computed(
  () => settings.settings?.experimentalNativePlayer === true,
);
/** 黑屏兜底：本次会话强制原生引擎（不改用户设置，仅本页有效） */
const forceNativeEngine = ref(false);
/** 黑屏提示是否已被用户关掉（换线路/继续听声音） */
const noVideoDismissed = ref(false);

const defaultRate = computed<PlaybackRate>(
  () => playerSettings.value.defaultRate ?? 1,
);
const autoPlayNext = computed(() => playerSettings.value.autoPlayNext);
const longPressRate = computed<PlaybackRate>(
  () => (playerSettings.value.longPressRate ?? 2) as PlaybackRate,
);
const subtitleSettings = computed<SubtitleSettings>(
  () => playerSettings.value.subtitle ?? PLAYER_FALLBACK.subtitle,
);
const currentResizeMode = computed(
  () => playerSettings.value.resizeMode ?? "contain",
);
/** C-09 氛围光：减少动效下整层不挂载（不是"变慢一点"，是不做持续变化的效果） */
const ambilightEnabled = computed(
  () => playerSettings.value.ambilight !== false && !prefersReducedMotion(),
);
const ambilightIntensity = computed(
  () => playerSettings.value.ambilightIntensity ?? 85,
);
/** G-A03：进度条磁吸强度（0 = 关闭，拖动行为与该功能上线前一致） */
const seekDetent = computed(() => playerSettings.value.seekDetent ?? 60);

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
    import("@/services/deviceService")
      .then((m) => m.deviceService.setStatusBarVisible(visible))
      .catch(() => undefined),
  // 横屏全屏切 edge-to-edge：消除刘海安全边内缩露出的白色竖条；退出恢复系统栏
  setImmersive: (on) =>
    import("@/native/playerUi")
      .then((m) => m.setPlayerImmersive(on))
      .catch(() => undefined),
  // AC-53：播放时保持屏幕常亮；Web 下 no-op。
  // 带本页令牌：路由切换时新页先挂、旧页后卸，旧页的释放不该清掉新页的锁。
  // 这里刻意不 catch：动态 import 失败要让上层控制器看见，它才会按 1s/3s/9s 补发。
  setKeepAwake: (on) =>
    import("@/services/deviceService").then((m) =>
      m.deviceService.keepAwake(on, keepAwakeOwner),
    ),
  // API-12 二期：亮度写窗口背光、音量写媒体流档位。
  // 原生能力缺失时这些方法返回 false/null，播放器整体退回「遮罩 + 播放器倍率」。
  levels: {
    setBrightness: (percent) =>
      import("@/services/deviceService")
        .then((m) => m.deviceService.setBrightness(percent))
        .catch(() => false),
    releaseBrightness: () =>
      import("@/services/deviceService")
        .then((m) => m.deviceService.releaseBrightness())
        .catch(() => undefined),
    setVolume: (percent) =>
      import("@/services/deviceService")
        .then((m) => m.deviceService.setVolume(percent))
        .catch(() => null),
    readVolume: () =>
      import("@/services/deviceService")
        .then((m) => m.deviceService.readVolume())
        .catch(() => null),
  },
  subtitle: subtitleSettings.value,
  defaultRate: defaultRate.value,
  autoPlayNext: autoPlayNext.value,
  backgroundPlayback: playerSettings.value.backgroundPlayback === true,
  resizeMode: currentResizeMode.value,
  longPressRate: longPressRate.value,
  // P0-2：兜底链在飞时不排自动连播——本轮到底播没播成还没定，
  // 迟到的 `ended` 若直接连播会把用户带到下一集去。
  canAutoNext: () => {
    const round = failoverHandle();
    return !round || round.hasAdvanced();
  },
  describe: () => {
    // 页面卸载后不再写回进度，避免死实例拿错上下文污染历史记录
    if (!pageAlive) return null;
    const it = item.value;
    // 用「正在播的这一集」而不是详情列表解析出的当前集：写错集号会让历史记录自增殖
    const identity = playingIdentity.value;
    const localTask = playingLocalTask.value;
    if (!it && !localTask) return null;
    return {
      sourceId: it?.sourceId ?? localTask?.sourceId ?? "",
      mediaId: it?.id ?? mediaId.value,
      episodeId: identity?.episodeId ?? null,
      episodeNumber: identity?.episodeNumber ?? null,
      episodeTitle: identity?.episodeTitle ?? null,
      lineId: currentPlayback.value?.lineId ?? currentLineId.value,
      title: it?.title ?? localTask?.title ?? "",
      posterUrl: it?.posterUrl ?? localTask?.posterUrl ?? null,
      totalEpisodes: navigationEpisodes.value.length > 0 ? navigationEpisodes.value.length : null,
      // REV-24：媒体快照，用于缓存清理后自愈；离线任务没有完整条目时不编造快照
      ...(it ? {
        mediaSnapshot: {
          sourceItemId: it.sourceItemId,
          type: it.type,
          year: it.year,
          episodeCount: it.episodeCount,
          originalTitle: it.originalTitle,
        },
      } : {}),
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
  stallSignal,
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
  nudgeControls,
  setControlsVisible,
} = playerCtl;

/**
 * P0-1：上下集按钮走路由更新，与选集/自动连播共用同一入口（episodeId watcher）。
 * 之前直接调 controller.switchTo 会导致 describe() / 进度写回 / 弹幕与路由不同步。
 */
function goToNextEpisode(): void {
  const id = nextEpisodeId.value;
  if (!id) return;
  const ep = navigationEpisodes.value.find((e) => e.id === id);
  if (ep) chooseEpisode(ep);
}

function goToPrevEpisode(): void {
  const id = prevEpisodeId.value;
  if (!id) return;
  const ep = navigationEpisodes.value.find((e) => e.id === id);
  if (ep) chooseEpisode(ep);
}

/** P0-1：自动连播倒计时结束后走路由更新 */
watch(autoNextTarget, (targetId) => {
  if (!targetId) return;
  const ep = navigationEpisodes.value.find((e) => e.id === targetId);
  acknowledgeAutoNext();
  if (ep) chooseEpisode(ep);
});

/** B1：通知栏/锁屏/线控的上下集，与自动连播共用同一条路由入口 */
watch(remoteEpisodeTarget, (targetId) => {
  if (!targetId) return;
  const ep = navigationEpisodes.value.find((e) => e.id === targetId);
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
  haptic("medium");
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
  settings.updateNonBlocking({
    player: { ...playerSettings.value, backgroundPlayback: next },
  });
  ui.toast(next ? "切后台将继续播放" : "切后台将自动暂停", "info", 1500);
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
  ui.toast(`${minutes} 分钟后自动暂停`, "info", 1800);
}

function armSleepEpisode(): void {
  sleepTimer.setFinishEpisode();
  ui.toast("本集播完后停止播放", "info", 1800);
}

function cancelSleep(): void {
  sleepTimer.cancel();
  ui.toast("已关闭睡眠定时", "info", 1500);
}

/* ---------- 面板 ---------- */
const speedOpen = ref(false);
const subtitleOpen = ref(false);
// EXT-07：内嵌字幕轨 / 音轨菜单（与原「字幕」面板相互独立）
const subtitleTrackOpen = ref(false);
const audioTrackOpen = ref(false);
const qualityOpen = ref(false);
const displayModeOpen = ref(false);
/**
 * ⑤' 播放面板抽屉：选集 / 线路 / 音画 / 更多四页签共用一个容器，
 * 取代原来四个各开各的 BottomSheet（关闭路径与遮罩只剩一份）。
 */
const drawerOpen = ref(false);
const drawerTab = ref<DrawerTab>("ep");
/** 同一页签再点一次即收起（顶栏 chip、底栏按钮与 fold 磁贴都走这里） */
function openDrawer(tab: DrawerTab): void {
  // 错误层(37)压在抽屉(30)上面，此时打开等于摆一个点不动的面板（连它的关闭键都在遮罩下）
  if (chromeState.value === "error") return;
  if (drawerOpen.value && drawerTab.value === tab) {
    drawerOpen.value = false;
    return;
  }
  drawerTab.value = tab;
  drawerOpen.value = true;
}
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
  () => [
    speedOpen.value,
    subtitleOpen.value,
    subtitleTrackOpen.value,
    audioTrackOpen.value,
    qualityOpen.value,
    displayModeOpen.value,
    drawerOpen.value,
    pickerOpen.value,
    gestureHelpVisible.value,
  ],
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
/**
 * G-A03：刻度格数就用胶片格数——同一套分段，画出来的齿和胶片对得上。
 * 在线源一帧都取不到，格数给 0 就是不画假刻度，只保留片头/片尾吸附。
 */
const seekCells = computed(() =>
  seekThumbs.enabled.value ? seekThumbs.count : 0,
);
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

/* ---------- G-C04 一帧明信片 ---------- */

const postcardOpen = ref(false);

/** 元信息一行：年份 · 地区 · 首个类型；缺项跳过，不留「· · 」这种空档 */
const postcardMeta = computed(() => {
  const it = item.value;
  if (!it) return null;
  const parts = [it.year ? String(it.year) : null, it.area || null, it.genres?.[0] || null];
  return parts.filter(Boolean).join(" · ") || null;
});

/** 只有一集（电影/正片）不写集号，票根上留空更干净 */
const postcardEpisodeLabel = computed(() => {
  if (episodes.value.length <= 1) return null;
  const n = playingIdentity.value?.episodeNumber ?? null;
  return n === null ? null : `第 ${n} 集`;
});

/** 抽帧只认本机成品文件，与 A-03 进度条胶片同一判断（blob sink 没有可随机读的容器） */
const postcardLocalPath = computed(() => {
  const source = currentPlayback.value;
  return source?.isLocal && source.localPath ? source.localPath : null;
});

/* ---------- 跳过片头 / 片尾（B-06） ---------- */

const skipMarkOpen = ref(false);
/** 片头/片尾标记按「正在播的这一集」存取；本地起播时不能被详情列表带偏 */
const playingEpisodeId = computed(
  () => playingIdentity.value?.episodeId ?? episodeIdParam.value ?? "",
);

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
const skipAuto = skipIntro.auto;

/**
 * 手动标记一次。
 * 源站返回体里没有章节载体（TVBox/爬虫都没有），所以现阶段只吃手动标记；
 * 将来有源站数据时在这里合并优先级，手动标记仍然最可信赖。
 */
async function onSkipMark(
  side: "intro" | "credits",
  sec: number,
): Promise<void> {
  const label = side === "intro" ? "片头结束于" : "片尾开始于";
  const ok =
    side === "intro"
      ? await skipMarkService.markIntroEnd(mediaId.value, sec, player.duration)
      : await skipMarkService.markCreditsStart(
          mediaId.value,
          sec,
          player.duration,
        );
  if (ok) toast.success(`${label} ${formatPlayerClock(sec)}，整季生效`);
  else toast.error("这个位置离片头/片尾太近，标了也不会跳");
}

async function onSkipClear(side: "intro" | "credits"): Promise<void> {
  await skipMarkService.clearSide(mediaId.value, side);
}

function onAutoSkipChange(value: boolean): void {
  settings.updateNonBlocking({
    player: { ...playerSettings.value, autoSkipIntro: value },
  });
}

/** 线路切换进行中（防连点造成两次并发加载，REV-05） */
const switchingLine = ref(false); /**
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
  const record = history.items.find(
    (r) => r.mediaId === mediaId.value && r.episodeId === ep.id,
  );
  const completed = downloads.tasks.filter(
    (t) => t.mediaId === mediaId.value && t.status === "completed",
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
    toast.success("已重新加入下载队列", 3000);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    redownloading.value = false;
  }
}

/**
 * FIX-PLAY-C3：本地播放「文件自检」——按容器分工具诊断本机产物。
 *
 * 入口放在播放页「更多」菜单而不是下载列表：已完成任务点卡片是直接起播，
 * 详情弹层根本到不了；而怀疑文件坏掉的人本来就站在播放页里。
 *
 * P2-2：转封装交付的 `.mp4` 也进来——它要的正是轨道/时长/定位这三项，
 * 拿包级 TS 扫描去查它只会得到一句错的结论。
 */
const localScan = ref<{ running: boolean; text: string; path: string } | null>(
  null,
);
const canScanLocalFile = computed(() => {
  const pb = currentPlayback.value;
  return Boolean(
    pb?.isLocal &&
    /\.(ts|mp4)$/i.test(pb.localPath ?? "") &&
    isMediaToolAvailable(),
  );
});
/** 容器决定用哪把尺子：`.ts` 这个后缀在 fMP4 线路上不代表里面是 TS */
const localScanIsTs = computed(() => currentPlayback.value?.format === "ts");

async function runLocalFileScan(): Promise<void> {
  const playback = currentPlayback.value;
  const path = playback?.localPath;
  if (!path || localScan.value?.running) return;
  localScan.value = { running: true, text: "", path };
  try {
    /*
     * P0-4：自检工具跟着判定出来的容器走。`.ts` 这个名字在传输期与容器无关
     * （fMP4 线路的合并产物也叫 `.ts`），拿包级 TS 扫描去查一份 fMP4 只会得到
     * 「这个文件不是标准 TS 分片数据」这句错的结论。
     */
    if (!localScanIsTs.value) {
      const verdict = await verifyRemuxedMedia(path);
      localScan.value = {
        running: false,
        text: verdict ? describeMediaVerify(verdict) : "当前版本不支持文件自检",
        path,
      };
      return;
    }
    const result = await scanTsFile(path);
    localScan.value = {
      running: false,
      text: result ? describeTsScan(result) : "当前版本不支持文件自检",
      path,
    };
  } catch (e) {
    // 读文件/路径类失败是真实故障，不能伪装成结论
    localScan.value = null;
    toast.error(toErrorShape(e).message || "文件自检失败");
  }
}

/* ---------- OPT-26（P2-⑬）：一次播放决策链的一键导出诊断包 ---------- */

/** 地址在诊断包里只留 host：换 CDN 与换源一样是常见成因，token 不能跟着包走出去 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "无法解析";
  }
}

function secondsOf(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms / 1000);
}

function describeDanmakuOutcome(outcome: DanmakuLoadOutcome): Record<string, TraceValue> {
  if (outcome.kind === "shown") return { count: outcome.count };
  if (outcome.kind === "miss")
    return {
      reason: outcome.reason,
      guidance: DANMAKU_MISS_GUIDANCE[outcome.reason].text,
    };
  return {};
}

/** 引擎选定/回退是决策链上最容易「悄悄换了」的一环，切换必须留痕 */
watch(
  () => player.engineKind,
  (kind, prev) => {
    if (kind === null) return;
    playTraceService.note(
      "engine",
      prev === null || prev === undefined
        ? `引擎选定：${kind}`
        : `引擎切换：${prev} → ${kind}`,
      {
        preferNative: nativeEngineEnabled.value || forceNativeEngine.value,
        host: currentPlayback.value ? hostOf(currentPlayback.value.url) : null,
      },
    );
  },
);

const playTraceExporting = ref(false);

/**
 * 生成并交出诊断包。
 *
 * 读数在这一层组装是刻意的：引擎状态、地址年龄、寿命学习结果都只有播放页同时拿得到，
 * 而决策链里已经记下了每一步的判断依据，这里只补「此刻的现场」。
 */
async function exportPlayTrace(): Promise<void> {
  if (playTraceExporting.value) return;
  playTraceExporting.value = true;
  try {
    const playback = currentPlayback.value;
    const lifetime = playback ? playUrlLifetimeService.entryOf(playback.url) : null;
    const report = playTraceService.buildReport({
      readings: {
        引擎: player.engineKind ?? "未起播",
        控制器状态: playerCtl.controller.value?.getPlayerState() ?? null,
        位置: `${Math.round(player.currentTime)}s / ${Math.round(player.duration)}s`,
        线路: currentLine.value?.name ?? null,
        原生引擎偏好: nativeEngineEnabled.value || forceNativeEngine.value ? "开" : "关",
        地址: playback ? `${hostOf(playback.url)}（${playback.format}）` : "本轮未取到",
        地址已发出: playback
          ? `${Math.round((playUrlLifetimeService.addressAgeMs(playback.url) ?? 0) / 1000)}s`
          : "N/A",
        "该 host 的地址寿命": lifetime
          ? `样本 ${lifetime.staleSamples} 次，最短 ${Math.round(lifetime.staleAgeMs / 1000)}s 失效`
          : "样本不足，未参与判定",
        学到的缓存下界: secondsOf(playback ? playUrlLifetimeService.ttlOf(playback.url) : null),
        弹幕: danmakuChipReading.value,
      },
    });
    const result = await sharePlayTraceText(formatPlayTraceText(report));
    if (result === "shared") toast.success("诊断包已生成，可直接发送");
    else if (result === "copied") toast.success("诊断包已复制到剪贴板");
    else toast.error("诊断包生成失败：分享与剪贴板都不可用");
  } catch (e) {
    // 组装失败是真实故障（读数取用炸了），不能伪装成"已导出"
    toast.error(toErrorShape(e).message || "诊断包生成失败");
  } finally {
    playTraceExporting.value = false;
  }
}

watch(currentPlayback, () => {
  localScan.value = null;
});

/* ---------- 加载播放源 ---------- */
/**
 * 起播等待分级进度（问题一）：
 * resolvePlay → preparing → connecting → buffering → done，按阶段权重推进 progress。
 * 同一阶段内按已耗时秒数做对数渐进，避免视觉卡死。
 */
const loadingStageText = ref("正在加载…");
const loadingProgress = ref(0);
const loadingElapsed = ref(0);
let loadingStartTime = 0;
let loadingRafId = 0;
/** 当前所处阶段及其权重区间 [from, to] */
type StageKey = "resolving" | "preparing" | "connecting" | "buffering" | "done";
let currentStage: StageKey = "resolving";
const STAGE_RANGES: Record<StageKey, [number, number]> = {
  resolving: [0, 45],
  preparing: [45, 52],
  connecting: [52, 80],
  buffering: [80, 95],
  done: [95, 100],
};
const STAGE_TEXT: Record<StageKey, string> = {
  resolving: "正在解析播放地址…",
  preparing: "正在准备数据…",
  connecting: "正在连接播放器…",
  buffering: "正在缓冲首帧…",
  done: "即将播放",
};

function setStage(stage: StageKey, detail?: string): void {
  if (stage === currentStage && !detail) return;
  currentStage = stage;
  if (stage === "done") {
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
  currentStage = "resolving";
  loadingStageText.value = STAGE_TEXT.resolving;
  const tick = (): void => {
    const elapsedMs = Date.now() - loadingStartTime;
    loadingElapsed.value = Math.floor(elapsedMs / 1000);
    const [from, to] = STAGE_RANGES[currentStage];
    const span = to - from;
    // 对数渐进：阶段内按 sqrt(elapsed/预算) 逼近上限，避免卡死感
    const stageBudgetMs = currentStage === "resolving" ? 10000 : 5000;
    const ratio = Math.min(1, Math.sqrt(elapsedMs / stageBudgetMs));
    const target = from + span * ratio * 0.9; // 留 10% 给事件驱动跳变
    if (target > loadingProgress.value) loadingProgress.value = target;
    // 6s 后升级文案（保留旧逻辑的"源响应较慢"提示）
    if (elapsedMs > 6000 && currentStage === "resolving") {
      loadingStageText.value = "源响应较慢，仍在连接…";
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
const offPlayStage = appEvents.on("play:stage", (payload) => {
  if (payload.stage === "retrying") {
    setStage("resolving", "首次连接失败，正在重试…");
    loadingProgress.value = 20;
    loadingStartTime = Date.now(); // 重置已耗时
  }
});
onBeforeUnmount(offPlayStage);

/**
 * 直链带防盗链头时经本机回环代理注入（P1-6）。
 * HLS 由 hls.js 的 xhrSetup 注入头，不需要；代理失败沿用原地址（与旧行为一致）。
 */
async function preparePlayback(
  playback: PlaybackSource,
): Promise<PlaybackSource> {
  const proxied = await localProxyUrl(playback);
  return proxied ? { ...playback, url: proxied } : playback;
}

/**
 * 加载代次（REV-28）：切集/切线并发触发时，过期任务只允许静默退出——
 * 既不能把错误面板盖到新画面上，也不能让慢的旧任务反过来顶掉新任务。
 */
let loadEpoch = 0;

/**
 * P0-2：一次性标记——下一次 `resolveAndLoad` 由用户明确动作触发（面板上的「重试」），
 * 应作废上一轮并重新开始预算。换线引起的路由重建不会置位，因此拿不到新预算。
 */
let nextLoadIsUserIntent = false;

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
async function loadLocalPlay(task: DownloadTask): Promise<void> {
  const epoch = ++loadEpoch;
  const identity = {
    episodeId: task.episodeId,
    episodeNumber: task.episodeNumber,
    episodeTitle: task.episodeTitle,
  };
  pageLoading.value = true;
  loadError.value = null;
  loadErrorShape.value = null;
  // 先锁定本地意图，详情随后加载出不同选集时不能把它误报成在线目标集丢失
  localIdentity.value = identity;
  startLoadingProgress();
  try {
    const playback = await downloadService.taskToPlayback(task);
    if (!pageAlive || epoch !== loadEpoch) return;
    const prepared = await preparePlayback(playback);
    if (!pageAlive || epoch !== loadEpoch) return;
    // 当前源精确记录优先；换源后按同作品、同季、同集读取续播
    const progressMatch = await history.resolveProgress({
      sourceId: task.sourceId,
      mediaId: mediaId.value ?? "local",
      title: task.title,
      year: playbackMediaYear.value ?? null,
      episodeNumber: task.episodeNumber,
      episodeTitle: task.episodeTitle,
    });
    if (!pageAlive || epoch !== loadEpoch) return;
    const record = progressMatch?.record;
    const sameEpisode = record?.episodeId === task.episodeId
      || (progressMatch?.episodeNumber != null && progressMatch?.episodeNumber === task.episodeNumber);
    let start = 0;
    if (record && sameEpisode && !restart.value) {
      const ratio = record.durationSec > 0 ? record.positionSec / record.durationSec : 0;
      if (ratio > 0.05 && ratio < 0.95) start = record.positionSec;
    }
    if (stageRef.value && !controller.value) {
      createController(stageRef.value);
    }
    const opts = buildLocalPlaybackOptions({
      mediaId: mediaId.value ?? "local",
      task,
      tasks: completedLocalTasks.value,
      playback: prepared,
      startPositionSec: start,
      preferNativeEngine: nativeEngineEnabled.value || forceNativeEngine.value,
      loadTask: (candidate) => downloadService.taskToPlayback(candidate),
      preparePlayback,
    });
    currentPlayback.value = opts.playback;
    // P0-3：与 resolveAndLoad 走同一个组合式 load——自动起播与错误落点都在那条链里
    await load(opts);
  } catch (e) {
    if (isCanceled(e) || !pageAlive || epoch !== loadEpoch) return;
    loadError.value = toErrorShape(e, "E_NO_PLAY_URL").message;
  } finally {
    if (pageAlive && epoch === loadEpoch) {
      pageLoading.value = false;
      cancelLoadingProgress();
    }
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
  const requestedEpisode = episodes.value.find((ep) => ep.id === episodeId);
  const requestedNumber = requestedEpisode?.number
    ?? history.items.find(
      (record) => record.mediaId === mediaId.value && record.episodeId === episodeId,
    )?.episodeNumber
    ?? null;
  // 与 resolvePlay 同一套匹配口径（P0-2）：宁可不起播，也不播成别的集
  const localTask = selectCompletedTask(completedLocalTasks.value, {
    episodeId,
    episodeNumber: requestedNumber,
  });
  if (!localTask) return false;

  try {
    await loadLocalPlay(localTask);
    bindEmbeddedTracks();
    return true;
  } catch (e) {
    if (isCanceled(e)) return true;
    if (pageAlive) {
      pageLoading.value = false;
      cancelLoadingProgress();
      loadError.value = toErrorShape(e, "E_LOCAL_CORRUPT").message;
    }
    return true;
  }
}

/**
 * 解析并加载当前集/线路。
 * 返回是否成功：`resolvePlay` 抛错 → `loadError`；引擎加载失败 → `player.error`。
 * 线路切换需要据此判断是否回退原线路（AC-55 / REV-05）。
 */
async function resolveAndLoad(): Promise<boolean> {
  const epoch = ++loadEpoch;
  const userIntent = nextLoadIsUserIntent;
  nextLoadIsUserIntent = false;
  // 一旦走在线解析，画面就不再是本地下载任务那一集——身份必须交还给 currentEpisode
  localIdentity.value = null;
  const it = item.value;
  const ep = currentEpisode.value;
  /*
   * OPT-26（P2-⑬）：决策链窗口按「条目 + 集号」归并。兜底换线、停滞重取址都会再跑一遍
   * 这里，但那是同一次决策；换集/换条目才是新的一轮，前面的事件必须清空。
   */
  if (it) {
    playTraceService.beginAttempt({
      mediaId: it.id,
      title: it.title,
      episodeNumber: ep?.number ?? null,
      episodeId: ep?.id ?? null,
      lineId: currentLineId.value,
      lineName: currentLine.value?.name ?? null,
    });
  }
  if (targetEpisodeMissing.value) {
    // P1-1：目标集在当前线路定位不到——不起播，把选择权交回用户
    logger.warn("目标集在当前线路无法定位，已拦在起播前", {
      mediaId: mediaId.value,
      episodeId: episodeIdParam.value,
      lineId: currentLineId.value,
      episodeCount: episodes.value.length,
    });
    playTraceService.note("attempt", "目标集在当前线路定位不到，已拦在起播前", {
      episodeId: episodeIdParam.value,
      lineId: currentLineId.value,
      episodeCount: episodes.value.length,
    });
    loadError.value = "要播的这一集在当前线路里已经找不到了";
    loadErrorShape.value = null;
    pageLoading.value = false;
    return false;
  }
  if (!it || !ep) {
    loadError.value = "找不到要播放的内容";
    pageLoading.value = false;
    return false;
  }
  pageLoading.value = true;
  loadError.value = null;
  loadErrorShape.value = null;
  noVideoDismissed.value = false;
  startLoadingProgress();
  // P0-2：起播时刻即本轮预算的起算点；预算住在跨路由存活的会话里，重建不再归零
  noteFailoverLoad(
    failoverAttemptKey(it?.sourceId ?? "", currentLineId.value, ep.id),
    "resolveAndLoad",
    userIntent,
  );
  playTraceService.note("attempt", userIntent ? "用户点播本集" : "自动起播本集", {
    line: currentLine.value?.name ?? null,
    episode: ep.number,
    restart: restart.value,
    deepLinkSec: tParamSec.value,
    preferNative: nativeEngineEnabled.value || forceNativeEngine.value,
  });
  const resolveStartTime = Date.now();
  try {
    const playback = await library.resolvePlay(
      it.id,
      ep.id,
      currentLineId.value,
    );
    if (!pageAlive || epoch !== loadEpoch) return false;
    setStage("preparing");
    const prepared = await preparePlayback(playback);
    if (!pageAlive || epoch !== loadEpoch) return false;
    setStage("connecting");
    currentPlayback.value = prepared;
    // OPT-26（P2-⑫）：从这一刻起计地址年龄——寿命学习判的是「这一条直链发给播放器后能撑多久」
    playUrlLifetimeService.noteAddressIssued(prepared.url);
    playTraceService.note("resolve", "地址已交给播放器", {
      elapsedMs: Date.now() - resolveStartTime,
      host: hostOf(prepared.url),
      format: prepared.format,
      isLocal: prepared.isLocal,
      expiresAt: prepared.expiresAt === null ? "源侧未报" : null,
      learnedTtlSec: secondsOf(playUrlLifetimeService.ttlOf(prepared.url)),
    });
    const progressMatch = await history.resolveProgress({
      sourceId: it.sourceId,
      mediaId: it.id,
      title: it.title,
      year: it.year,
      episodeNumber: ep.number,
      episodeTitle: ep.title,
    });
    const rec = progressMatch?.record;
    const sameEpisode = rec?.episodeId === ep.id
      || (progressMatch?.episodeNumber != null && progressMatch.episodeNumber === ep.number);
    let start = 0;
    if (!restart.value) {
      // 口令深链 `?t=` 是显式意图，优先于一切记忆（切线路/换集后 query 会被重建，天然只生效一次）
      if (tParamSec.value !== null) {
        start = tParamSec.value;
      } else if (rec && sameEpisode) {
        const duration =
          rec.durationSec > 0 ? rec.durationSec : (ep.durationSec ?? 0);
        const ratio = duration > 0 ? rec.positionSec / duration : 0;
        if (ratio > 0.05 && ratio < 0.95) start = rec.positionSec;
      }
      // BB-01：历史没接上（换线路后 episodeId 漂移、记录缺失）时按黑匣子集号锚兜底，
      // 口径与 history 相同的首尾闸门；`?ep=` 深链带显式 t 之外的一切首轮起播都适用
      if (start === 0 && tParamSec.value === null) {
        const bb = blackboxAnchor.value;
        if (
          bb &&
          (bb.episodeNumber === null || bb.episodeNumber === ep.number)
        ) {
          const ratio =
            bb.durationSec > 0 ? bb.positionSec / bb.durationSec : 0;
          if (ratio > 0.05 && ratio < 0.95) start = bb.positionSec;
        }
      }
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
        if (!target) throw new Error("剧集不存在");
        const nextPlayback = await library.resolvePlay(
          it.id,
          target.id,
          currentLineId.value,
        );
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
          preferNativeEngine:
            nativeEngineEnabled.value || forceNativeEngine.value,
        };
      },
    };

    await load(opts);
    if (!pageAlive || epoch !== loadEpoch) return false;
    setStage("done");
    // 「本地文件不可用，已切换网络源」时在页面给出「重新下载」入口（AC-78②）
    void detectLocalMissing();
    // `load()` 内部把失败写入 player.error 而不抛出，这里显式判定
    const ok = loadError.value === null && player.error === null;
    if (ok) {
      // P0-2：这里**不**算本轮成功——`load()` 返回 true 只表示引擎接单，画面可能一秒都没走。
      // 兜底额度的释放改由 `player.currentTime` 实际推进触发（见黑匣子那个 watcher）。
      // 批次1：记录线路成功
      const line = currentLine.value;
      if (line && it) {
        lineHealthService.recordSuccess(
          lineKey(it.sourceId, it.sourceItemId, line.name),
          Date.now() - resolveStartTime,
        );
      }
    }
    return ok;
  } catch (e) {
    if (!pageAlive || epoch !== loadEpoch) return false;
    // P0-3：解析失败也失效缓存，避免重试复用坏 URL
    library.invalidatePlayCache(mediaId.value);
    const shape = toErrorShape(e, "E_NO_PLAY_URL");
    // 批次1：记录线路失败（按错误分类）
    const line = currentLine.value;
    if (line && it) {
      lineHealthService.recordFail(
        lineKey(it.sourceId, it.sourceItemId, line.name),
        shape.code,
      );
    }
    // 失败换线时并发解析会双跑：先成功者已在播，后失败者（嗅探 15s 超时）若把
    // 错误面板盖上去，用户看到的是「有声音却报无播放地址」。播放中一律不覆盖。
    if (player.playing) return false;
    loadErrorShape.value = shape;
    loadError.value = shape.message;
    void runFailover(shape, "resolve");
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
function deviceApi(): Promise<
  typeof import("@/services/deviceService").deviceService
> {
  return import("@/services/deviceService").then((m) => m.deviceService);
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
      levelSource: "app",
      brightness: BRIGHTNESS_MAX,
      volume: settings.player?.lastVolume ?? 100,
    });
    return;
  }

  player.patch({
    levelSource: "system",
    brightness: levels.brightness,
    volume: levels.volume,
  });
}

onMounted(async () => {
  void detectCastSupport();
  // REV-24：sources 用于详情失败时判断源是否存在
  await Promise.all([
    settings.load(),
    history.load(),
    favorites.load(),
    downloads.load(),
    sources.load(),
    achievements.load(),
  ]);
  // F2：连看计数（彩蛋开关 gate）。播放页逐集重建，计数落在 store 才能跨集累积。
  if (settings.easterEggsEnabled) {
    achievements.noteEpisodeEntry(
      mediaId.value,
      episodeIdParam.value,
      item.value?.title ?? null,
    );
  }
  // P1-4 + API-12：亮度/音量起点（必须在 createController 之前，决定引擎倍率的初值）
  await initPlaybackLevels();

  // BB-01：详情加载前读黑匣子——首帧选集/线路的集号锚要用它
  if (!restart.value) {
    const resume = await peekBlackbox(mediaId.value);
    if (resume && pageAlive) blackboxAnchor.value = resume;
  }

  const episodeParam =
    typeof route.params.episodeId === "string" ? route.params.episodeId : "";
  // P1-4：下载列表入口（`?local=1`）先本地起播，详情后台补——离线时不再被网络解析吊住
  if (
    route.query.local === "1" &&
    episodeParam &&
    (await tryPlayLocalFirst(episodeParam))
  ) {
    detailReady.value = true;
    void library.loadDetail(mediaId.value);
    return;
  }

  await library.loadDetail(mediaId.value);
  detailReady.value = true;
  if (library.detailState === "error") {
    // REV-24：详情失败但本地有下载完成的任务时，允许直接本地播放
    if (episodeParam && (await tryPlayLocalFirst(episodeParam))) return;
    loadError.value = library.error?.message ?? "详情加载失败";
    pageLoading.value = false;
    return;
  }
  if (stageRef.value) createController(stageRef.value);
  // EXT-07：控制器建好后订阅内嵌轨道状态（切集由控制器自己重置）
  bindEmbeddedTracks();
  await resolveAndLoad();
  announceHistoryLineFallback();
  // BB-01：倍速记忆——只在进入页面这一次生效，之后用户手动调整不再被覆盖
  if (blackboxAnchor.value && blackboxAnchor.value.rate !== player.rate) {
    setRate(blackboxAnchor.value.rate);
  }
  // AC-68：记录集号已下线时明确提示，而不是静默从第 1 集起播
  announceOfflineEpisode();
});

/* ---------- 关闭时写回进度 ---------- */

/**
 * BB-01 黑匣子写入。
 *
 * `usePlayerController` 的卸载钩子先跑并 reset 播放器（音量同理），届时 `player.currentTime`
 * 已归零——所以播放中持续留一份最近快照，卸载时用 `force` 补写这份，而不是现场读引擎。
 * 落盘由服务内部 30s 节流，这里 10s 一拍只为缩短卸载瞬间的陈旧度。
 */
let blackboxLive: Omit<BlackboxSnapshot, "at"> | null = null;
function captureBlackbox(): void {
  const identity = playingIdentity.value;
  const durationSec = Math.floor(player.duration || 0);
  const positionSec = Math.floor(player.currentTime || 0);
  if (
    !identity ||
    !mediaId.value ||
    durationSec <= 0 ||
    positionSec > durationSec
  )
    return;
  blackboxLive = {
    mediaId: mediaId.value,
    episodeNumber: identity.episodeNumber,
    lineId: currentLineId.value,
    positionSec,
    durationSec,
    rate: player.rate,
  };
}
watch(
  () => player.currentTime,
  () => {
    if (!player.playing) return;
    captureBlackbox();
    // P0-2：本轮成功的唯一口径 = 画面真的在走（`load()` 返回 true 不算）
    notePlaybackAdvanced();
  },
);
// 换集/换线路的瞬间旧位置不再可信：置空，等新一集的第一个 timeupdate 再填
watch(currentPlayback, () => {
  blackboxLive = null;
});
const blackboxTimer = window.setInterval(() => {
  captureBlackbox();
  if (blackboxLive) void notePlayback(blackboxLive);
}, 10_000);

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
  { flush: "sync" },
);

onBeforeUnmount(() => {
  cancelAutoNext();
  clearSeekPreview();
  // BB-01：退出瞬间补写一次（此刻引擎已被 composable 复位，只能用播放期间留存的快照）
  window.clearInterval(blackboxTimer);
  if (blackboxLive) void notePlayback(blackboxLive, { force: true });
  // 起播进度 rAF 自续不受 finally 守卫保护：卸载会置反 pageAlive/epoch，
  // 不在这里显式取消就会留下常驻循环。
  cancelLoadingProgress();
  // 页面存活守卫：卸载后作废所有在飞异步链，防止后台链路劫持路由/覆盖全局状态
  pageAlive = false;
  ++loadEpoch;
  pageAbort.abort();
  // P0-2：换源搜索的超时器与在飞请求随实例收口；本轮预算只有在"不是自己引起的导航"
  // 时才收回——换线引起的重建必须把 deadline 与已试线路带过去，否则又回到无限重试。
  cancelAlternateSourceSearch();
  if (!hasPendingFailoverNavigation()) cancelFailoverRound("cancelled");
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
const audioBlurSrc = computed(() =>
  sizedImage(item.value?.posterUrl ?? null, IMG_W_BLUR),
);
const episodeLabel = computed(() => {
  const identity = playingIdentity.value;
  if (!identity) return "";
  const ep = navigationEpisodes.value.find((entry) => entry.id === identity.episodeId);
  const number =
    identity.episodeNumber ??
    (ep?.id === identity.episodeId ? ep.number : null);
  if (number === null) return "";
  if (!hasEpisodeNav.value && navigationEpisodes.value.length <= 1) return "";
  // 副标题只有当目录里的这一集正是正在播的这一集时才可信
  const sub =
    ep && ep.number === number && ep.title && ep.title !== `第 ${number} 集`
      ? ` · ${ep.title}`
      : "";
  return `第 ${number} 集${sub}`;
});
/** chrome 摘要用的集号/总集数（1 起；单集影片不给集号） */
const epTotal = computed(() =>
  hasEpisodeNav.value ? navigationEpisodes.value.length : 0,
);
const epIndex = computed(() => {
  const identity = playingIdentity.value;
  if (!identity) return 0;
  const index = navigationEpisodes.value.findIndex((entry) => entry.id === identity.episodeId);
  return index >= 0 ? index + 1 : (identity.episodeNumber ?? 0);
});
/** 跳过条右侧的数字：片头给结束时刻，片尾给片尾长度 */
const skipTargetSec = computed(() => {
  const marks = skipMarks.value;
  if (!marks) return 0;
  if (skipZone.value === "credits") {
    return marks.creditsStartSec === null
      ? 0
      : Math.max(0, player.duration - marks.creditsStartSec);
  }
  return marks.introEndSec ?? 0;
});

/** 精细倍速滑杆会给出预设档之外的值（0.5~2，步进 0.05），引擎按浮点接受 */
function onSetRate(value: number): void {
  setRate(value as PlaybackRate);
}

/** 弹层滑杆与手势走同一条路：HUD、落点（app/system）、记忆都由 onGesture 统一处理 */
function onSetVolume(value: number): void {
  onGesture({ type: "volume", value, delta: value - player.volume });
}

function onSetBrightness(value: number): void {
  onGesture({ type: "brightness", value, delta: value - player.brightness });
}

/** ⑥ fold 常驻滑杆：input 给的是字符串，转数值后与手势走同一条路 */
function onFoldVolume(ev: Event): void {
  onSetVolume(Number((ev.target as HTMLInputElement).value));
}

function onFoldBrightness(ev: Event): void {
  onSetBrightness(Number((ev.target as HTMLInputElement).value));
}

/** 缓冲水位：player.buffered 是「已缓冲到的秒数」，换算成百分比才读得懂 */
const foldBufferPercent = computed(() =>
  player.duration > 0
    ? Math.round(
        Math.min(100, Math.max(0, (player.buffered / player.duration) * 100)),
      )
    : 0,
);

const qualityLabel = computed(() =>
  resolvedQuality.value === QUALITY_AUTO ? "自动" : resolvedQuality.value,
);

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
  rewindSharedCover(
    stageRef.value,
    mediaId.value,
    item.value?.posterUrl ?? null,
  );
  if (globalThis.history.length > 1) router.back();
  else
    void router.replace({ name: "detail", params: { mediaId: mediaId.value } });
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
  void router.replace({ name: "detail", params: { mediaId: mediaId.value } });
}

/** REV-24：源已移除时，删除该历史记录并返回首页 */
async function removeHistoryAndGoBack(): Promise<void> {
  const record = history.items.find((r) => r.mediaId === mediaId.value);
  if (record) {
    await history.remove(record.id);
  }
  void router.replace({ name: "home" });
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

/**
 * 切换线路时只认同一集（保持集号，AC-31）。
 * 目标线路没有这一集返回 null，由调用方决定——不再拿首集冒充切线成功。
 */
function episodeOnLine(lineIdValue: string, number: number): Episode | null {
  const all = library.detail?.episodes ?? [];
  const list = all
    .filter((ep) => ep.lineId === lineIdValue)
    .sort((a, b) => a.number - b.number);
  return list.find((ep) => ep.number === number) ?? null;
}

/** 只更新路由（集号 / 线路 query），加载由调用方统一负责 */
async function replaceRoute(
  episodeId: string | null,
  targetLineId: string | null,
): Promise<void> {
  if (episodeId === episodeIdParam.value && targetLineId === lineIdParam.value)
    return;
  await router.replace({
    name: "player",
    params: { mediaId: mediaId.value, ...(episodeId ? { episodeId } : {}) },
    query: {
      ...(route.query.local === "1" || localIdentity.value ? { local: "1" } : {}),
      ...(targetLineId ? { lineId: targetLineId } : {}),
    },
  });
}

/**
 * P1-1 披露态的出口：目标集找不到时，由用户明确点「从第 1 集播放」。
 * 改路由后集号口径自然恢复；`episodeIdParam` watcher 用待加载标记吞掉，只加载一次。
 */
async function playFromFirstEpisode(): Promise<void> {
  const first = episodes.value[0];
  if (!first) return;
  pendingLineSwitchEpisode = first.id;
  try {
    await replaceRoute(first.id, lineIdParam.value);
    await resolveAndLoad();
  } finally {
    pendingLineSwitchEpisode = null;
  }
}

/**
 * 切换到目标线路；**手动**切换失败时恢复原线路与原集并提示（AC-55）。
 *
 * `resolveAndLoad()` 会重建引擎，因此"回退"是重新加载原线路（不是复用旧实例），
 * 对用户表现为"未切走"；原线路也失败时给出更明确的提示。
 *
 * P1-1：目标线路没有同一集号时直接不切——过去会切过去并播该线路的第 1 集，
 * 用户以为"换线路成功"，实际看的是完全不同的一集。
 *
 * P0-2：`auto: true`（自动兜底链发起）时**不回滚**——回滚等于重播上一条失败线路，
 * 正是"来回跳"的来源；自动链只在候选之间向前推进，收口交给会话与错误面板。
 */
async function switchLine(
  targetLineId: string,
  opts: { auto?: boolean } = {},
): Promise<boolean> {
  const it = item.value;
  const previousLineId = currentLineId.value;
  if (!it || targetLineId === previousLineId || switchingLine.value)
    return false;
  const current = currentEpisode.value;
  if (!current) return false;
  const previousEpisodeId = current.id;
  const targetEpisode = episodeOnLine(targetLineId, current.number);
  if (!targetEpisode) {
    const name =
      lines.value.find((l) => l.id === targetLineId)?.name ?? "该线路";
    toast.info(`${name} 没有第 ${current.number} 集，已保持原线路`);
    return false;
  }

  // P1-4: 记住当前播放位置，切线后续播
  const currentPositionSec =
    playerCtl.controller.value?.getState().currentTime ?? 0;

  switchingLine.value = true;
  try {
    lineId.value = targetLineId;
    pendingLineSwitchEpisode = targetEpisode.id;
    // P0-2：这一次路由变化属于本轮，重建后的实例沿用同一份预算
    // P0-5：`auto` 时它是兜底链的候选，不代表用户确认过这条线路
    armFailoverNavigation(opts.auto === true);
    await replaceRoute(targetEpisode.id, targetLineId);
    if (!pageAlive) return false;
    if (await resolveAndLoad()) {
      if (!pageAlive) return false;
      // P1-4: 切线成功后跳转到原位置（跳过前 5 秒的"从头开始"场景）
      if (currentPositionSec > 5) {
        playerCtl.controller.value?.seek(currentPositionSec);
      }
      return true;
    }

    // ---- 回退原线路（仅手动切换；自动兜底不回滚，见函数头 P0-2 说明）----
    if (opts.auto) return false;
    if (!pageAlive) return false;
    lineId.value = previousLineId;
    pendingLineSwitchEpisode = previousEpisodeId;
    const restored = await resolveAndLoad();
    toast.info(
      restored ? "切换失败，已保持原线路" : "切换失败，原线路也无法播放",
    );
    return false;
  } finally {
    pendingLineSwitchEpisode = null;
    switchingLine.value = false;
  }
}

async function onSwitchLine(): Promise<void> {
  if (lines.value.length <= 1) {
    toast.info("该内容只有一条线路");
    return;
  }
  const next = lines.value.find((l) => l.id !== currentLineId.value);
  if (!next) return;
  await switchLine(next.id);
}

/* ---------- v1.7/CHG-21 + P0-2：起播失败自动换线 → 换源（FR-53） ---------- */

/** 源侧故障码（与 17.6 口径一致 + 解码/无地址），命中才考虑自动兜底 */
const FAILOVER_ERROR_CODES = new Set([
  "E_NETWORK",
  "E_TIMEOUT",
  "E_DECODE",
  "E_SOURCE_UNAVAILABLE",
  "E_NO_PLAY_URL",
  "E_UNSUPPORTED_FORMAT",
  "E_PARSE",
  // P1-③-7：忙态也是「这条源此刻给不出地址」，值得兜底——但兜法与坏了不同，见 `runFailover`
  "E_SOURCE_BUSY",
]);

/** HLS 直链被源站拒绝时先刷新地址，不把同一坏 URL 再交给内置引擎重撞 */
function isExpiredHlsAddress(error: AppErrorShape): boolean {
  const playback = currentPlayback.value;
  return playback?.isLocal !== true
    && playback?.format === "hls"
    && (error.httpStatus === 402 || error.httpStatus === 403);
}

/** v1.8/CHG-26：错误码指向「源健康问题」时，错误面板给出去体检的入口 */
const HEALTH_CHECK_CODES = new Set([
  "E_SOURCE_UNAVAILABLE",
  "E_NETWORK",
  "E_TIMEOUT",
  "E_HTTP_401",
  "E_HTTP_403",
  "E_HTTP_429",
  "E_HTTP_5XX",
]);

const canHealthCheck = computed(() => {
  const err = player.error ?? null;
  return err !== null && HEALTH_CHECK_CODES.has(err.code);
});

/** v1.8/CHG-26：手动换源可用性——有详情且在线（跨源候选搜索需要网络） */
const canSwitchSourceManual = computed(
  () => item.value !== null && isOnlineNow(),
);

/* ---------- P0-1 / P1-4：解析失败的可行动引导 ---------- */

/** 解析失败的可行动原因（源站真死 / 解析超时 / 协议不支持 / 规则脚本异常） */
const loadErrorGuidance = computed(() =>
  loadErrorShape.value ? guidanceOf(loadErrorShape.value) : null,
);

/** 磁力地址：有值时给「用外部应用打开」，否则重试没有任何意义 */
const loadErrorMagnet = computed(() => magnetUrlOf(loadErrorShape.value));

/*
 * OPT-26（P0-③-2）：解析失败里「该源正忙」不是坏了，是上一个请求还压在这个爬虫实例上。
 * 页面级错误层的「重试」与 PlayerErrorPanel 共用同一个闸门口径（禁用 + 真实倒计时 +
 * 到点自动重试一次），两处面板不许各猜一套秒数。
 */
const { remainMs: loadErrorGateMs, retryLabel: loadErrorRetryLabel } = useBusyRetryGate(
  () => loadErrorShape.value,
  () => void resolveAndLoad(),
);

/**
 * 黑屏兜底：用原生引擎（ExoPlayer）重试当前集。
 * 不写设置——只在本次页面会话内强制，退出重进恢复默认。
 */
async function retryWithNativeEngine(): Promise<void> {
  forceNativeEngine.value = true;
  toast.info("已切换原生引擎重试");
  await resolveAndLoad();
  if (!pageAlive) return;
  if (player.error || loadError.value) {
    forceNativeEngine.value = false;
    toast.info("原生引擎也没能解码，建议换线路");
  }
}

function dismissNoVideo(): void {
  noVideoDismissed.value = true;
}

/**
 * OPT-26（P1-②-3）：错误面板给不给「用原生引擎重试」。
 *
 * 两个条件缺一不可：
 * 1. 结论得是"本机内核接不住"——`guidanceOf` 里只有 player_capability 这一档声明了
 *    `retry-native` 动作（网络断、鉴权失效、种子地址换成原生引擎都没有用）；
 * 2. 本轮确实没碰过原生引擎。口径取自 `PlayerController` 的引擎链：用户开着实验性原生、
 *    本地文件（一律原生）、或内置失败后已自动降级过原生，都已经试过，再摆一次只会让用户
 *    原地打转。黑屏兜底那个入口不判这条，是因为它出现在"还在播但没画面"的场景，
 *    与"加载就失败"不是同一条链。
 */
const canRetryNative = computed(() => {
  const err = player.error;
  if (!err || !guidanceOf(err).actions.includes("retry-native")) return false;
  return playerCtl.controller.value?.getNativeAttemptedInLastChain() !== true;
});

/** 外部应用打开（磁力交给下载器/播放器；失败给明确 Toast） */
async function openExternalUrl(url: string): Promise<void> {
  const result = await castService.openExternal(url);
  if (result.started) return;
  if (result.reason === "unsupported-platform") {
    toast.info("当前环境无法打开外部链接（仅 Android App 支持）");
    return;
  }
  toast.error(result.error?.message ?? "打开失败，请安装下载器后重试");
}

/**
 * P0-2：本轮会话是否还允许继续兜底。
 *
 * deadline、线路/换源额度、已试线路集都在 `failoverSession` 里，跨路由重建存活；
 * 这里只把"实例手里的句柄"和"模块里的当前会话"对齐一次。已收口或已到点（含定时器
 * 还没来得及跑的同一 tick）一律返回 null：调用方只保证错误面板在位，不再新开预算。
 */
function failoverHandle(): FailoverRound | null {
  const held = failoverRound.value ?? activeFailoverRound();
  const usable = held && held.acceptsAttempts() ? held : null;
  if (failoverRound.value !== usable) failoverRound.value = usable;
  return usable;
}

/**
 * 起播前登记一次尝试：起播时刻即本轮预算的起算点。
 *
 * 锚定值取「路由意图」集号（`routeEpisodeNumber`），不是被本轮影响过的解析结果——
 * 目标相同就沿用上一轮预算，所以换线引起的路由重建拿不到新预算；只有换集 / 换片 /
 * 用户明确重试（`userIntent`）才开新一轮。
 */
function noteFailoverLoad(
  key: string | null,
  trigger: string,
  userIntent = false,
): void {
  const anchor: FailoverAnchor = {
    seasonNumber: parseSeasonNumber(item.value?.title ?? ""),
    episodeNumber: routeEpisodeNumber.value,
  };
  failoverRound.value = beginLoadAttempt({ anchor, trigger, key, userIntent });
}

/**
 * 本轮是否已经推进过播放器（成功的唯一口径）。
 *
 * 以 `player.currentTime` 实际前进为准，不看 `load()` 的返回值——`load()` 在起播前就返回，
 * 过去"换线成功又立刻失败"的循环就是这么判成功的。
 */
function notePlaybackAdvanced(): void {
  failoverRound.value?.markAdvanced();
}

/**
 * P1-3：轻量换源——限制搜索范围与超时，避免用户等太久。
 *
 * 与详情页的完整跨源搜索不同，播放中换源只尝试「健康度最好的 5 个其它源」，
 * 整体超时 12s。找到第一个可播候选即返回，不再继续搜索。
 *
 * P0-2 收口：
 * - 自动兜底链传入本轮会话时，超时改成 `min(12s, 本轮剩余)`——候选搜索与后续解析
 *   共用同一个墙钟截止点，不再出现"搜索把预算续了一截"；
 * - 搜索请求走独立 AbortController，卸载 / 到点都真的取消（旧口径只 race 掉结果，
 *   请求仍在后台飞）；
 * - P0-1：隔离中的源不进候选（含「恢复」与自动换源两条路）。
 */
const ALTERNATE_SEARCH_TIMEOUT_MS = 12000;
const ALTERNATE_MAX_CANDIDATES = 5;

/** 在飞换源搜索的取消器与超时器（P0-2 ④：不留孤儿定时器/请求） */
let alternateSearchAbort: AbortController | null = null;
let alternateSearchTimer: ReturnType<typeof setTimeout> | null = null;

function cancelAlternateSourceSearch(): void {
  if (alternateSearchTimer !== null) {
    clearTimeout(alternateSearchTimer);
    alternateSearchTimer = null;
  }
  alternateSearchAbort?.abort();
  alternateSearchAbort = null;
}

async function lookupAlternateSource(round?: FailoverRound | null): Promise<{
  mediaId: string;
  episodeId: string;
  sourceName: string;
} | null> {
  const it = item.value;
  if (!it || !isOnlineNow() || pageAbort.signal.aborted) return null;
  const budgetMs = round
    ? Math.min(ALTERNATE_SEARCH_TIMEOUT_MS, round.remainingMs())
    : ALTERNATE_SEARCH_TIMEOUT_MS;
  if (budgetMs <= 0) return null;
  const abort = new AbortController();
  alternateSearchAbort = abort;
  alternateSearchTimer = setTimeout(() => abort.abort(), budgetMs);
  const onPageAbort = () => abort.abort();
  pageAbort.signal.addEventListener("abort", onPageAbort, { once: true });
  try {
    const [result, allSources] = await Promise.all([
      libraryService.search({ keyword: it.title, signal: abort.signal }),
      sourceService.list(),
    ]);
    if (!pageAlive) return null;
    const sourceById = new Map(allSources.map((s) => [s.id, s]));
    const candidates = pickPlayCandidates(
      it.title,
      it.year,
      result.items,
      sourceById,
      (id) => healthService.latencyOf(id),
    )
      .filter((candidate) => candidate.source.id !== it.sourceId)
      .filter((candidate) => !isSourceBlocked(candidate.source.id))
      .slice(0, ALTERNATE_MAX_CANDIDATES);
    // P0-2：集号以会话钉住的目标为准，路由抖动后的当前集不能代替用户意图
    const number = round?.anchor.episodeNumber ?? targetEpisodeNumber.value;
    for (const candidate of candidates) {
      if (!pageAlive || abort.signal.aborted) return null;
      try {
        const detail = await libraryService.getDetail(candidate.item.id);
        if (!pageAlive) return null;
        // P1-1：换源按集号对齐；候选源没有同号集就顺延下一个源，不拿它的首集冒充
        const target =
          number === null
            ? (detail.episodes[0] ?? null)
            : (detail.episodes.find((ep) => ep.number === number) ?? null);
        if (!target) continue;
        return {
          mediaId: candidate.item.id,
          episodeId: target.id,
          sourceName: candidate.source.name,
        };
      } catch {
        continue; // 候选源也失败 → 顺延下一个
      }
    }
  } catch {
    /* 搜索失败/超时/已取消：按无候选处理 */
  } finally {
    pageAbort.signal.removeEventListener("abort", onPageAbort);
    if (alternateSearchTimer !== null) {
      clearTimeout(alternateSearchTimer);
      alternateSearchTimer = null;
    }
    if (alternateSearchAbort === abort) alternateSearchAbort = null;
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
  // P0-2：这次导航属于本轮延续——重建后的实例必须沿用预算，而不是重开一轮
  // P0-5：换源同样是自动兜底链的候选，不该写进冷启动恢复目标
  armFailoverNavigation(true);
  try {
    // P0-2：显式清空 lineId query，避免旧线路 id 残留导致新源 0 集
    await router.replace({
      name: "player",
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

/**
 * 起播窗口内失败：自动换线（按评分排序，额度 `PLAYER_FAILOVER_MAX_LINES`）→ 自动换源
 * （额度 `PLAYER_FAILOVER_MAX_SOURCES`）→ 才落到错误面板。
 *
 * P0-2 收口点：
 * - 预算（deadline / 已试线路 / 线路与换源额度 / 钉住的集号）全在跨路由存活的会话里，
 *   路由重建不再归零，"来回跳 ep1/ep2"与"切到全部线路失效"都失去土壤；
 * - 同一次尝试（`attemptId`）的解析错误与引擎错误只推进一次状态机；
 * - 线路候选跳过已试过的、以及没有正在播的这一集的线路（AC-31 同集号口径）；
 * - 自动换线失败**不回滚**重播上一条失败线路；
 * - 本轮已收口（到点 / 额度用尽 / 被取代）时只保证错误面板在位，**不新开预算**。
 *
 * 离线时直接落错误面板——换线/换源都要网络，徒增等待。
 */
async function runFailover(
  error: AppErrorShape,
  origin: "player" | "resolve",
): Promise<void> {
  if (failoverRunning.value) return;
  if (!FAILOVER_ERROR_CODES.has(error.code) && !isExpiredHlsAddress(error)) return;
  const opened = failoverHandle();
  if (!opened) {
    publishFailoverError(error, origin);
    return;
  }
  // 解析错误与引擎错误按 attemptId 去重：同一次尝试只推进一条兜底链
  if (!opened.noteFailure(opened.attemptId)) return;
  // 离线短路：换线/换源均需网络，直接落错误面板
  if (!isOnlineNow()) {
    publishFailoverError(error, origin);
    return;
  }
  failoverRunning.value = true;
  try {
    if (isExpiredHlsAddress(error) && opened.claimAddressRefresh()) {
      logger.warn("兜底链：HLS 地址失效，刷新当前线路", {
        ...opened.snapshot(),
        httpStatus: error.httpStatus,
        fromLineId: currentLineId.value,
      });
      playTraceService.note("failover", "HLS 地址失效，刷新当前线路", {
        httpStatus: error.httpStatus,
        line: currentLine.value?.name ?? null,
      });
      player.patch({ error: null });
      toast.info("播放地址已失效，正在重新获取…");
      library.invalidatePlayCache(mediaId.value);
      await resolveAndLoad();
      if (!pageAlive) return;
      if (player.error === null && loadError.value === null) return;
    }
    // P1-③-7：「该源正忙」不是这条线路坏了——同一个源的其它线路共用那个还压着上一个请求的爬虫实例，
    // 换线只是白撞一次闸门。于是冷却在 `BUSY_WAIT_MAX_MS` 以内就原地等闸门（面板上的倒计时到点自动
    // 重试一次，P0-③-2 已做成），超过它才跳过换线直接换源。两种都不消耗换线额度，
    // 线路健康也不记 busy（`lineHealthService` 的 NON_LINE_FAILURE_CODES）。
    // 判定口径在 `busyFailoverPlan`（换线与换源都读它），这里只负责落地。
    const plan = busyFailoverPlan(error.code, error.retryAfterMs);
    playTraceService.note("failover", `兜底链启动（${origin}：${error.code}）`, {
      plan,
      retryAfterMs: error.retryAfterMs ?? 0,
      line: currentLine.value?.name ?? null,
    });
    if (plan === "wait") {
      publishFailoverError(error, origin);
      return;
    }
    const skipLines = plan === "switch-source";
    if (plan !== "not-busy") {
      // 忙态兜底是「等」还是「走」，决定这一集接下来 8 秒的行为，必须能在生产日志里复盘
      logger.info("兜底链：源正忙", {
        plan,
        retryAfterMs: error.retryAfterMs ?? 0,
        waitMaxMs: BUSY_WAIT_MAX_MS,
        ...opened.snapshot(),
      });
    }
    // P1-1 + P0-2：只试"确实有正在播的这一集"的线路——否则换线"成功"等于悄悄换了集。
    // 集号以会话钉住的目标为准（当前集定位失败时仍不能拿首集当代号）。
    const it = item.value;
    const number =
      opened.anchor.episodeNumber ?? currentEpisode.value?.number ?? null;
    const ranked = it
      ? rankLines({
          lines: lines.value,
          historyEpisodeId: null, // failover 不恢复历史
          episodes: episodes.value,
          buildKey: (line) => lineKey(it.sourceId, it.sourceItemId, line.name),
        })
      : lines.value;
    const candidates = (skipLines ? [] : ranked)
      .filter((l) => l.id !== currentLineId.value)
      .filter((l) => number === null || episodeOnLine(l.id, number) !== null);
    // 「这一轮到底有几条线可选」是判断空转与否的第一现场，生产日志必须看得见
    logger.info("兜底链：换线候选", {
      ...opened.snapshot(),
      origin,
      errorCode: error.code,
      skipLines,
      fromLineId: currentLineId.value,
      episodeNumber: number,
      candidateCount: candidates.length,
      candidateNames: candidates.map((l) => l.name),
    });

    // ① 换线：额度与去重都由会话判定，超限/到点自动停
    for (const candidate of candidates) {
      const round = failoverHandle();
      if (!round || !round.allowLine(candidate.id)) break;
      if (!pageAlive) return;
      const targetEpisode = episodeOnLine(candidate.id, number ?? 0);
      round.chargeLineAttempt(
        failoverAttemptKey(
          it?.sourceId ?? "",
          candidate.id,
          targetEpisode?.id ?? "",
        ),
      );
      logger.info("兜底链：换线尝试", {
        ...round.snapshot(),
        toLineId: candidate.id,
        toLineName: candidate.name,
        toEpisodeId: targetEpisode?.id ?? null,
      });
      playTraceService.note("failover", `换线尝试 → ${candidate.name}`, {
        from: currentLine.value?.name ?? null,
        episodeNumber: number,
      });
      toast.info(`起播失败，自动切换到线路「${candidate.name}」…`);
      await switchLine(candidate.id, { auto: true });
      if (!pageAlive) return;
      if (player.error === null && loadError.value === null) return; // 换线成功
    }

    // ② 换源（同名同年在其它源重找片源；进度按集号延续）
    const round = failoverHandle();
    if (round && round.allowSource()) {
      round.chargeSourceAttempt();
      logger.info("兜底链：换源尝试", {
        ...round.snapshot(),
        origin,
        errorCode: error.code,
        skipLines,
      });
      player.patch({ error: null });
      toast.info(
        skipLines
          ? "这个源还在忙（上一个请求没跑完），正在尝试其它来源…"
          : "当前源无法播放，正在尝试其它来源…",
      );
      const target = await lookupAlternateSource(round);
      if (!pageAlive) return;
      if (target) {
        toast.info(`已切换到「${target.sourceName}」继续播放`);
        const ok = await applyAlternateSource(target);
        if (!pageAlive) return;
        if (ok && player.error === null && loadError.value === null) return;
      }
    }
    // 兜底失败：恢复错误面板（清掉的错误重新呈现）
    publishFailoverError(error, origin);
  } finally {
    failoverRunning.value = false;
  }
}

/** 兜底链走完仍失败（或根本不该兜底）时，保证错误面板落在位且不重复覆盖画面 */
function publishFailoverError(
  error: AppErrorShape,
  origin: "player" | "resolve",
): void {
  if (!pageAlive) return;
  if (player.error === null && loadError.value === null) {
    if (origin === "player") player.patch({ error });
    else {
      loadErrorShape.value = error;
      loadError.value = error.message;
    }
  }
}

watch(
  () => player.error,
  (error) => {
    if (error) {
      // P0-2 / FIX-PLAY-C1：离线文件自身的问题（时间轴停滞、解码损坏）与线路/源无关——
      // 不记线路失败、不作废播放地址缓存，只挂出"重新下载"出口
      // （两者都不在 FAILOVER_ERROR_CODES 内，不会走换线/换源）
      if (error.code === "E_LOCAL_STALL" || error.code === "E_LOCAL_CORRUPT") {
        armLocalStallRedownload();
        return;
      }
      // P0-3：播放出错时失效缓存，避免重试/换线复用已过期的坏 URL
      library.invalidatePlayCache(mediaId.value);
      /*
       * OPT-26（P2-⑫）：播开过之后再断流/超时，这条地址当前的年龄就是一条寿命证据。
       * 只认这两种码：解不了格式、源正忙之类与地址放久了无关。
       */
      const played = currentPlayback.value;
      if (
        played &&
        !played.isLocal &&
        player.currentTime > 0 &&
        (error.code === "E_NETWORK" || error.code === "E_TIMEOUT")
      ) {
        playUrlLifetimeService.recordStale(played.url);
      }
      // 批次1：记录线路失败（按错误分类）
      const line = currentLine.value;
      const it = item.value;
      if (line && it && !isExpiredHlsAddress(error)) {
        lineHealthService.recordFail(
          lineKey(it.sourceId, it.sourceItemId, line.name),
          error.code,
        );
      }
      playTraceService.note("error", `引擎报错：${error.code}`, {
        message: error.message,
        engine: player.engineKind,
        positionSec: Math.round(player.currentTime),
        durationSec: Math.round(player.duration),
        url: hostOf(currentPlayback.value?.url ?? ""),
      });
      void runFailover(error, "player");
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
 * 预算由会话判定：上一轮已收口时，随后的 `resolveAndLoad` 自然开新一轮，
 * 这里不再手动复位任何计数（旧实现把 `failoverLineTried/SourceTried` 记在实例上，
 * 一次路由重建就归零，正是"切到全部线路失效"的成因）。
 */
async function onSwitchSource(): Promise<void> {
  if (failoverRunning.value) return;
  const lastError = player.error;
  failoverRunning.value = true;
  player.patch({ error: null });
  try {
    toast.info("正在尝试其它来源…");
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
  void router.push("/settings");
}

async function onCast(): Promise<void> {
  // 首版仅系统分享（API-11）；能力探测失败必须给出提示而不是抛错（AC-82）。
  try {
    const supported = await castService.isSupported();
    if (!supported) {
      castSupported.value = false;
      toast.info("当前平台不支持投屏，请在 Android App 内使用");
      return;
    }
    const playback = currentPlayback.value;
    if (!playback) {
      toast.info("暂无可投屏的内容");
      return;
    }
    playerCtl.controller.value?.pause();
    const result = await castService.cast({
      kind: "url",
      url: playback.url,
      mime: playback.format === "hls" ? "application/x-mpegURL" : "video/*",
      title: titleText.value,
      linkedUrl: playback.url,
    });
    if (!result.started) {
      toast.info(
        result.reason === "canceled" ? "已取消投屏" : "未找到可用的投屏目标",
      );
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
    // P3-3：换一条线路（不同源、不同 id）时，`createMany` 的字面判重认不出来，本地能攒下
    // 同一集的若干份；下单前把重复摊开说清楚，但只确认不拦截——换线路常正因为上一份下不动。
    if (!(await guards.confirmCrossLineDuplicates(inputs, downloads.tasks)))
      return;
    // REV-07 / AC-76：Web 端 >1GB 在下单前提示改用 App；确认后仍可继续
    const largeFileHint = await downloads.checkLargeFile(inputs);
    if (largeFileHint !== null) {
      const goOn = await ui.confirm({
        title: "文件较大",
        message: largeFileHint,
        confirmText: "仍要下载",
      });
      if (!goOn) return;
    }
    // REV-15 / FR-30：重复下载给出明确提示，而不是静默忽略
    const { created, skipped } = await downloads.createMany(inputs);
    pickerOpen.value = false;
    if (created.length === 0 && skipped.length > 0) {
      toast.info("该集已在下载列表中");
      return;
    }
    toast.success(
      skipped.length > 0 ? "已加入下载（该集已在列表中）" : "已加入下载",
    );
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
    toast.success(added ? "已收藏" : "已取消收藏");
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

const downloadedIds = computed(() =>
  completedLocalTasks.value.map((task) => task.episodeId),
);

async function copyError(): Promise<void> {
  const err = player.error;
  if (!err) return;
  // 带上解析出的地址与格式：区分"返回的是网页页/403 页面"还是"编码不受支持"全靠这两项
  const playback = currentPlayback.value;
  const lines = [
    `code=${err.code}`,
    `message=${err.message}`,
    `detail=${err.detail ?? ""}`,
    `http=${err.httpStatus ?? ""}`,
    `format=${playback?.format ?? ""}`,
    `url=${playback?.url ?? ""}`,
  ];
  const text = lines.join("\n");
  try {
    await navigator.clipboard?.writeText(text);
    toast.success("已复制错误信息");
  } catch {
    toast.info(text);
  }
}

/**
 * SHARE-CODE：生成观影口令（G-C10 起带票根卡）。
 * 纯元数据（片名/年份/集号/时间点），不含任何播放地址、源或订阅——
 * 对方能否看到取决于其自有订阅，分享的是「坐标」，不是「资源」。
 *
 * 弹层里的「保存票根」取代了原来的纯文字系统分享：同一个分享面板，现在多带一张卡，
 * 而复制与卡上印的那串文本同源于 `buildShareText`，协议没有为卡片改动过任何字节。
 */
const shareCodeOpen = ref(false);
/** 打开弹层那一刻拍下坐标：播放还在走，口令不该跟着漂 */
const shareCodePayload = ref<ShareCodePayload | null>(null);
const shareCodeText = computed(() =>
  shareCodePayload.value ? buildShareText(shareCodePayload.value) : "",
);

function openShareCode(): void {
  const it = item.value;
  if (!it) return;
  shareCodePayload.value = {
    title: it.title,
    year: it.year ?? null,
    // 单集内容（电影/正片）不带集号；多线路长剧才需要定位到集
    episodeNumber:
      episodes.value.length <= 1
        ? null
        : (playingIdentity.value?.episodeNumber ?? null),
    positionSec: Math.floor(player.currentTime || 0),
  };
  drawerOpen.value = false;
  shareCodeOpen.value = true;
}

async function copyShareCode(): Promise<void> {
  const text = shareCodeText.value;
  shareCodeOpen.value = false;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast.success("观影口令已复制，粘到对方的搜索框即可续上");
  } catch {
    // 剪贴板被系统拒了（无焦点/无权限）：把文本原样摊出来，用户还能手选
    toast.info(text, 8000);
  }
}

/**
 * 字幕设置的持久化：字号/描边/偏移都是滑块，拖动一帧触发一次 `@input`，
 * 直接写存储会把 IDB 写打成一片。本地值保持即时（画面跟着动），落盘收敛成一次。
 */
const persistSubtitles = useDebounce(() => {
  settings.updateNonBlocking({
    player: { ...playerSettings.value, subtitle: { ...localSubtitles.value } },
  });
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
  settings.updateNonBlocking({
    player: { ...playerSettings.value, resizeMode: mode },
  });
}

/**
 * G-A09：双指捏合切画幅。捏的过程中实时换档（只换档才发一次到引擎），
 * 抬手后弹簧吸附到最近一档并落盘；中途被打断则还原档位且不落盘。
 */
const pinchResizeEnabled = computed(
  () => playerSettings.value.pinchResizeEnabled !== false,
);
const {
  visible: pinchHudVisible,
  pos: pinchPos,
  mode: pinchMode,
  onSample: onPinchSample,
  onEnd: onPinchEnd,
} = usePinchResize({
  currentMode: () => currentResizeMode.value,
  apply: (mode) => setResizeMode(mode),
  commit: (mode) =>
    settings.updateNonBlocking({
      player: { ...playerSettings.value, resizeMode: mode },
    }),
  onShift: () => haptic("light"),
});

function setAmbilight(on: boolean): void {
  settings.updateNonBlocking({
    player: { ...playerSettings.value, ambilight: on },
  });
}

function setAmbilightIntensity(value: number): void {
  settings.updateNonBlocking({
    player: { ...playerSettings.value, ambilightIntensity: value },
  });
}

/**
 * 取不到画面帧时把开关落回关闭并说明原因。
 * 这是**能力**问题（原生引擎没有 DOM 视频元素 / 画布被跨域污染），不是抖动，
 * 所以直接持久化，避免每次进播放页都白跑一遍取样定时器。
 */
function onAmbilightBlocked(reason: AmbilightBlockReason): void {
  if (reason === "reduced-motion") return;
  setAmbilight(false);
  toast.info(
    reason === "no-video"
      ? "原生引擎取不到画面像素，氛围光已自动关闭"
      : "画面像素不可读取（源站未开放跨域），氛围光已自动关闭",
    2600,
  );
}

/**
 * 选集：只改路由，加载由 `episodeId` watcher 唯一入口负责（REV-28）。
 * 之前这里与 watcher 各调一次 `resolveAndLoad()`，一次切集会发两遍清单请求，
 * 且旧请求被取消后还会把 E_ABORTED 写进错误面板。
 */
function chooseEpisode(ep: Episode): void {
  drawerOpen.value = false;
  if (ep.id === playingIdentity.value?.episodeId) return;
  /*
   * G-A06：过片幕布在路由替换**前**触发。播放页整页重建，旧实例的 DOM 留不到新帧上，
   * 所以状态交给模块级（见 useEpisodeLeader），渲染层在 App 壳里。
   * 只演一次视觉：不换集音轨——连播时这声「啪」会盖住正在播的台词，代价大于惊喜。
   */
  if (settings.easterEggsEnabled) {
    playEpisodeLeader(ep.number);
    haptic("light");
  }
  void router.replace({
    name: "player",
    params: { mediaId: mediaId.value, episodeId: ep.id },
    query: {
      ...(route.query.local === "1" || localIdentity.value ? { local: "1" } : {}),
      ...(currentLineId.value ? { lineId: currentLineId.value } : {}),
    },
  });
}

function retryPanel(): void {
  // P0-3：重试时先失效缓存，避免复用导致失败的旧 URL
  library.invalidatePlayCache(mediaId.value);
  // P0-2：用户明确重试 = 新意图（上一轮作废，预算重新开始）
  nextLoadIsUserIntent = true;
  void resolveAndLoad();
}

/**
 * OPT-26（P2-⑫）：每集已用掉的自动恢复次数（换集归零）。
 *
 * 播放器层每次加载只报一次停滞，这里再叠一层上限：地址怎么换都救不了源侧真断流，
 * 不能把「重新取址」变成无限重连。
 */
const stallRecoverRounds = ref(0);

/**
 * 在线流停滞 → 自动重新取址续播。
 *
 * 症状是「画面停住但没有任何报错」：签名直链过期后 ExoPlayer 只会一直说 buffering，
 * WebView 连 waiting 都不发。用户此时唯一的办法是退出重进，而退出重进做的事正是
 * 重新取址——这里把它提前自动做掉。动作必须放在播放页：解析服务、线路、进度写回
 * 都在这一层，播放器层拿不到解析服务。
 *
 * 不抢兜底链：`failoverRunning` 或已有待跳转的换线/换源时让路，那时该由兜底决定。
 */
async function autoRecoverFromStall(positionSec: number): Promise<void> {
  const playback = currentPlayback.value;
  if (!playback || playback.isLocal || !pageAlive) return;
  if (failoverRunning.value || hasPendingFailoverNavigation()) return;
  if (stallRecoverRounds.value >= 2) {
    logger.warn("在线流停滞，自动恢复额度已用尽", {
      positionSec,
      url: playback.url,
    });
    return;
  }
  stallRecoverRounds.value += 1;
  playTraceService.note("stall", "在线流停滞，自动重新取址续播", {
    positionSec: Math.round(positionSec),
    round: stallRecoverRounds.value,
    engine: player.engineKind,
    addressAgeSec: Math.round(
      (playUrlLifetimeService.addressAgeMs(playback.url) ?? 0) / 1000,
    ),
    learnedTtlSec: secondsOf(playUrlLifetimeService.ttlOf(playback.url)),
  });
  // 顺手把这次断供记成该 host 的地址寿命样本：下次起播前就该重新取址，而不是等画面停住
  const addressAgeSec = playUrlLifetimeService.recordStale(playback.url);
  logger.warn("在线流停滞，自动重新取址续播", {
    positionSec,
    engine: player.engineKind,
    addressAgeSec,
    url: playback.url,
  });
  ui.toast("播放中断，正在重新获取地址", "info", 2200);
  // 先把位置写回历史：`resolveAndLoad` 的续播位取自历史记录，不 flush 就退回上一个写入点
  await playerCtl.controller.value?.flushProgress();
  library.invalidatePlayCache(mediaId.value);
  // 自动恢复不是用户新意图：兜底预算要继续，不能借停滞把上一轮额度重置
  const ok = await resolveAndLoad();
  if (!ok || !pageAlive) return;
  const ctl = playerCtl.controller.value;
  // 历史续播位可能比停滞位置旧几秒，差得多就直接定位回停滞点
  if (ctl && Math.abs(ctl.getState().currentTime - positionSec) > 2) ctl.seek(positionSec);
}

watch(stallSignal, (signal) => {
  if (signal) void autoRecoverFromStall(signal.positionSec);
});

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
      strokeStyle: "shadow" as const,
      density: "normal" as const,
      filterTop: false,
      filterBottom: false,
      interactive: true,
      autoContrast: true,
    },
);

/** 弹幕可用性：设置开启 + 正在播放 + 有当前集号 */
const danmakuReady = computed(
  () =>
    danmakuSettings.value.enabled &&
    danmakuIdentity.value !== null &&
    !pageLoading.value,
);

/**
 * 弹幕加载结局。
 *
 * OPT-26（P0-①-2）：这里原来返回 boolean，于是「弹幕不显示」的四种互不相干的原因
 * （没有任何可用源 / 源都没答上来 / 拦下了疑似串片 / 渲染层还没挂上）只能念同一句
 * 「当前集没有匹配到弹幕」；`miss.reason` 直接取自 `danmakuService` 的主因口径，
 * 提示语只在这一处拼，别再在模板里写第二套。
 */
type DanmakuLoadOutcome =
  | { kind: "shown"; count: number }
  | { kind: "skipped" }
  | { kind: "not-mounted" }
  | { kind: "error" }
  | { kind: "miss"; reason: DanmakuMissReason };

/** 自动链路（挂载/切集）的提示：一次进入本页只说一次，切集不再刷屏 */
const danmakuAutoHintShown = ref(false);

/**
 * 把结局念出来（提示语来自 `DANMAKU_MISS_GUIDANCE`，与主因词表同源）。
 *
 * `manual`（弹幕开关、导入本地 xml）每次都答——用户刚点了东西，没有回应比坏消息更糟；
 * 自动路径只在第一次未命中时说一次。
 */
function announceDanmaku(outcome: DanmakuLoadOutcome, manual: boolean): void {
  if (outcome.kind === "shown" || outcome.kind === "skipped") return;
  if (!manual) {
    if (danmakuAutoHintShown.value) return;
    danmakuAutoHintShown.value = true;
  }
  if (outcome.kind === "not-mounted") {
    toast.info("画面还没就绪，重进本集后弹幕才会显示", 2800);
    return;
  }
  if (outcome.kind === "error") {
    toast.info("弹幕加载出错了，可在弹幕设置里重试", 2800);
    return;
  }
  const hint = DANMAKU_MISS_GUIDANCE[outcome.reason];
  if (hint.openSettings) {
    toast.action(
      `${hint.text}，可在这里配置聚合弹幕源或导入本地 XML`,
      {
        label: "弹幕设置",
        onClick: () => {
          danmakuOpen.value = true;
        },
      },
      "info",
      5200,
    );
    return;
  }
  toast.info(hint.text, 3200);
}

/**
 * 挂载弹幕渲染层（幂等）。
 *
 * 以前只有 `watch(danmakuReady)` 会新建它：本集先就绪、画面区域后出现时，那一跳里
 * `stageRef` 还是 null，之后再没人补挂——弹幕永远不显示且毫无提示（P0-①-3 的挂载竞态）。
 * 现在「加载」与「挂载」都经过这里，`stageRef` 到位后自动补上。
 */
function ensureDanmakuOverlay(): DanmakuOverlay | null {
  if (!danmakuReady.value || stageRef.value === null) return null;
  if (danmakuOverlay.value !== null) return danmakuOverlay.value;
  const overlay = new DanmakuOverlay({
    settings: danmakuSettings.value,
    getTime: () => player.currentTime,
    // 原生引擎 1s 才轮询一次进度：帧内按播放状态/倍速在锚点上插值
    isPlaying: () => player.playing,
    getRate: () => player.rate,
  });
  overlay.attach(stageRef.value);
  danmakuOverlay.value = overlay;
  return overlay;
}

function releaseDanmakuOverlay(): void {
  const overlay = danmakuOverlay.value;
  if (overlay === null) return;
  overlay.detach();
  danmakuOverlay.value = null;
}

/**
 * 同一集只跑一条匹配链路。
 *
 * 挂载那一跳（`danmakuReady`/`stageRef` 到位）和切集那一跳可能先后触发同一个集号；
 * 未命中不会写缓存，于是两条链把整条回退打两遍——对正在限流的源等于白烧一倍请求。
 */
const danmakuInFlight = new Map<string, Promise<DanmakuLoadOutcome>>();

/** 本集弹幕的最新结局，顶栏那一格读数由它来（P1-①-4：命中要看得见条数） */
const danmakuOutcome = ref<DanmakuLoadOutcome | null>(null);

/** 顶栏弹幕格的读数：开着但还不知道结果时保持原来的「开」，不猜 */
const danmakuChipReading = computed(() => {
  if (!danmakuSettings.value.enabled) return "关";
  const outcome = danmakuOutcome.value;
  if (outcome === null) return "开";
  if (outcome.kind === "shown") return `${outcome.count} 条`;
  if (outcome.kind === "miss") return DANMAKU_CHIP_MISS[outcome.reason];
  if (outcome.kind === "error") return "出错";
  if (outcome.kind === "not-mounted") return "没挂上";
  return "开";
});

const canIgnoreDanmakuYear = computed(() => {
  const year = danmakuIdentity.value?.year;
  const outcome = danmakuOutcome.value;
  return (
    year !== null &&
    year !== undefined &&
    outcome?.kind === "miss" &&
    outcome.reason === "no_result"
  );
});

/**
 * 加载本集弹幕（缓存命中离线可用；关闭开关不发请求）。
 * 交回 `DanmakuLoadOutcome`：调用方据此决定念哪句提示，而不是「点了没反应」。
 *
 * `fetcher` 供「重新匹配本集弹幕」换用清缓存的那条链（P1-①-6）；默认的 `match` 会命中缓存。
 */
function loadDanmaku(
  fetcher: (
    title: string,
    year: number | null,
    episode: number,
  ) => Promise<DanmakuMatchResult> = (title, year, episode) =>
    danmakuService.match(title, year, episode),
): Promise<DanmakuLoadOutcome> {
  const identity = danmakuIdentity.value;
  if (!identity || !danmakuSettings.value.enabled) {
    danmakuOverlay.value?.clear();
    return Promise.resolve({ kind: "skipped" });
  }
  const key = `${identity.episodeId}|${identity.matchKey}`;
  const running = danmakuInFlight.get(key);
  if (running !== undefined) return running;
  // 新一轮判定开始：先收回上一集的读数，别让「2096 条」顶着正在加载的这一集
  danmakuOutcome.value = null;
  const promise = fetchDanmaku(identity, fetcher)
    .then((outcome) => {
      // 只报当前这一集的结局：切集之后上一集的判定不该顶着这一集的读数
      if (isSameDanmakuIdentity(danmakuIdentity.value, identity)) {
        danmakuOutcome.value = outcome;
        playTraceService.note("danmaku", `弹幕结局：${outcome.kind}`, describeDanmakuOutcome(outcome));
      }
      return outcome;
    })
    .finally(() => {
      // 只清自己：导入本地 xml 会把这一集的在途链路作废（见 `importLocalDanmaku`）
      if (danmakuInFlight.get(key) === promise) danmakuInFlight.delete(key);
    });
  danmakuInFlight.set(key, promise);
  return promise;
}

async function fetchDanmaku(
  identity: DanmakuPlaybackIdentity,
  fetcher: (
    title: string,
    year: number | null,
    episode: number,
  ) => Promise<DanmakuMatchResult>,
): Promise<DanmakuLoadOutcome> {
  const { title, year, episodeNumber: episode } = identity;
  const overlay = ensureDanmakuOverlay();
  if (overlay === null) {
    // 渲染层挂不上就谈不上「显示”：以前这里照样返回 true，界面念「弹幕已开启」而画面是空的
    logger.warn("弹幕渲染层未就绪，本集弹幕未加载", { title, episode });
    return { kind: "not-mounted" };
  }
  try {
    const { match, missReason } = await fetcher(title, year, episode);
    if (!isSameDanmakuIdentity(danmakuIdentity.value, identity)) return { kind: "skipped" };
    if (match === null || match.comments.length === 0) {
      // 上一集的弹幕不能留在这一集画面上：未命中先清空，界面才不会念「有弹幕」而飘着别集的字
      overlay.clear();
      return {
        kind: "miss",
        reason: missReason ?? (match === null ? "no_result" : "below_threshold"),
      };
    }
    const base = danmakuSettings.value.merge
      ? danmakuService.dedupe(match.comments)
      : match.comments;
    // 弹弹play 的 `shift`：缓存里存原始时间轴，偏移只在渲染时叠加（换源/重进不回写缓存）
    const offset = Number.isFinite(match.offsetSec) ? match.offsetSec : 0;
    overlay.load(
      offset === 0
        ? base
        : base.map((comment) => ({
            ...comment,
            time: Math.max(0, comment.time + offset),
          })),
    );
    return { kind: "shown", count: base.length };
  } catch (e) {
    /* 弹幕异常不打扰播放，但必须留痕：否则「弹幕不显示」在日志里是一片空白 */
    logger.warn('弹幕加载异常（不影响播放）', { title, episode }, e);
    return { kind: "error" };
  }
}

/**
 * 「弹幕设置 → 导入本地弹幕 XML」的落点：解析成功后直接写本集缓存再重载。
 * 导入即代表用户想用这份文件，所以顺带打开弹幕总开关（否则缓存写了也看不见）。
 */
async function importLocalDanmaku(file: File): Promise<void> {
  const identity = danmakuIdentity.value;
  if (!identity) return;
  let count = 0;
  try {
    count = await danmakuService.importLocalXml(
      identity.title,
      identity.year,
      identity.episodeNumber,
      file,
    );
  } catch (e) {
    logger.warn("本地弹幕文件读取失败", { title: identity.title, episode: identity.episodeNumber, name: file.name }, e);
    toast.info("本地弹幕文件读取失败", 2400);
    return;
  }
  if (count === 0) {
    toast.info("这个文件没有解析出弹幕（需要 B 站格式 xml）", 2800);
    return;
  }
  if (!danmakuSettings.value.enabled) {
    await settings.update({
      danmaku: { ...danmakuSettings.value, enabled: true },
    });
  }
  // 这一集可能正有一条链在途（它是导入前发起的，看不到刚写进缓存的 xml）：作废它，重新拉一次
  danmakuInFlight.clear();
  const outcome = await loadDanmaku();
  toast.info(
    outcome.kind === "shown" ? `已导入本地弹幕 ${count} 条` : "导入成功，重进本集后生效",
    outcome.kind === "shown" ? 1800 : 2600,
  );
}

/**
 * 「弹幕设置 → 重新匹配本集弹幕」（P1-①-6）：先作废本集缓存，再走一遍完整链路。
 *
 * 没有这个入口时，用户唯一的重试手段是退出重进（而缓存 30 天有效，退出重进也只会把同一条再端
 * 回来）；「命中了串片」「当时源正在限流」这两种情况在界面上就都没有第二次机会。
 */
async function runDanmakuRematch(ignoreYear: boolean): Promise<void> {
  const identity = danmakuIdentity.value;
  if (!identity) {
    logger.warn("重新匹配弹幕时当前集不存在", { title: item.value?.title ?? null });
    return;
  }
  if (!danmakuSettings.value.enabled) {
    await settings.update({ danmaku: { ...danmakuSettings.value, enabled: true } });
  }
  toast.info(ignoreYear ? "正在忽略年份重新匹配本集弹幕…" : "正在重新匹配本集弹幕…", 1600);
  // 上一轮可能还在途（它用的仍是旧缓存）：作废后按「清缓存 + 重跑」那条链再来一次
  danmakuInFlight.clear();
  const outcome = await loadDanmaku((title, year, episode) =>
    ignoreYear
      ? danmakuService.rematch(title, year, episode, { ignoreYear: true })
      : danmakuService.rematch(title, year, episode),
  );
  announceDanmaku(outcome, true);
}

async function rematchDanmaku(): Promise<void> {
  await runDanmakuRematch(false);
}

async function rematchDanmakuIgnoringYear(): Promise<void> {
  await runDanmakuRematch(true);
}

async function toggleDanmaku(): Promise<void> {
  const next = !danmakuSettings.value.enabled;
  await settings.update({
    danmaku: { ...danmakuSettings.value, enabled: next },
  });
  if (!next) {
    danmakuOverlay.value?.clear();
    toast.info("弹幕已关闭");
    return;
  }
  const outcome = await loadDanmaku();
  if (outcome.kind === "shown") {
    toast.info(`弹幕已开启（${outcome.count} 条）`, 1800);
    return;
  }
  announceDanmaku(outcome, true);
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
const AUDIO_LANG_STORAGE_KEY = "peanutmov.player.audio-language";

const embeddedTracks = ref<EmbeddedTrackState>(emptyEmbeddedTracks());
const tracksLoading = ref(false);
const tracksError = ref<string | null>(null);
/** 本集是否已应用过偏好（同一集内不再覆盖用户的手动选择） */
let trackPrefsAppliedFor: string | null = null;
let detachTrackSubscription: (() => void) | null = null;

const engineIsNative = computed(() => player.engineKind === "native");
/** 字幕是否生效：原生引擎看内嵌轨选中项，WebView 引擎看外挂字幕 id */
const subtitleOn = computed(() =>
  engineIsNative.value
    ? embeddedTracks.value.activeTextId !== null
    : player.activeSubtitleId !== null,
);
const activeAudioTrack = computed(
  () =>
    embeddedTracks.value.audio.find(
      (t) => t.id === embeddedTracks.value.activeAudioId,
    ) ?? null,
);
/** 沉浸态浮动音轨入口文案：有选中轨时带名称 */
const audioChipLabel = computed(() =>
  activeAudioTrack.value ? `音轨 · ${activeAudioTrack.value.label}` : "音轨",
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
  return `${mediaId.value}:${playingIdentity.value?.episodeId ?? ""}`;
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
    tracksError.value = toErrorShape(e, "E_NOT_IMPLEMENTED").message;
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
    const track =
      id === null
        ? null
        : (embeddedTracks.value.text.find((t) => t.id === id) ?? null);
    // 记住偏好：语言码；「关闭字幕」落 null，下次起播保持关闭
    void settings
      .update({
        player: {
          subtitle: {
            ...subtitleSettings.value,
            preferredLang: track?.language ?? null,
          },
        },
      })
      .catch(() => undefined);
    toast.info(track ? `已切换字幕：${track.label}` : "字幕已关闭", 1500);
  } catch (e) {
    toast.info(toErrorShape(e, "E_NOT_IMPLEMENTED").message);
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
    toast.info(toErrorShape(e, "E_NOT_IMPLEMENTED").message);
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

/**
 * 设置开启/关闭 → 挂载或卸载渲染层。
 *
 * `stageRef` 也在依赖里：本集就绪早于画面区域出现时，只盯 `danmakuReady` 的那一跳会看到
 * `stageRef === null` 然后不再回来（P0-①-3）；这里等画面到位后补挂并补拉一次弹幕。
 */
watch(
  [danmakuReady, stageRef],
  () => {
    if (danmakuReady.value) {
      const alreadyMounted = danmakuOverlay.value !== null;
      if (ensureDanmakuOverlay() === null) return;
      if (!alreadyMounted) void loadDanmaku().then((o) => announceDanmaku(o, false));
      return;
    }
    releaseDanmakuOverlay();
  },
  { immediate: true, flush: "post" },
);

// 设置变化（字号/速度等）即时生效
watch(danmakuSettings, (next) => danmakuOverlay.value?.setSettings(next), {
  deep: true,
});

/** 智能配色（11-17）：缺省开——老设置里没有这个键 */
const danmakuAutoContrast = computed(
  () => danmakuSettings.value.autoContrast !== false,
);

/** G-C05：节奏带的记账层（数据由下面 useDanmakuContrast 的 onField 递进来） */
const cutRhythm = useCutRhythm();

const { blocked: danmakuContrastBlocked } = useDanmakuContrast({
  overlay: danmakuOverlay,
  stage: stageRef,
  enabled: computed(() => danmakuReady.value && danmakuAutoContrast.value),
  native: engineIsNative,
  resizeMode: currentResizeMode,
  // 暂停时画面不会自己变，不必白取帧
  isPlaying: () => player.playing || player.waiting,
  // G-C05：节奏带蹭这一条取样路（自己再开一条等于给播放加一份过桥抓帧的负担）
  onField: (field) => cutRhythm.sample(field, player.currentTime, player.duration),
});

/**
 * G-C05：镜头节奏带。
 *
 * 原料是智能配色那张亮度场，所以取样路一关就必须连数据一起收掉——留着上一段的格子
 * 给这一集画一张"很平"的节奏，比不画更误导。
 */
const rhythmBandOn = computed(
  () => danmakuAutoContrast.value && danmakuSettings.value.rhythmBand !== false,
);
const rhythmBandData = computed(() => (rhythmBandOn.value ? cutRhythm.band.value : null));

watch(rhythmBandOn, (on) => {
  if (!on) cutRhythm.reset();
});

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
  () => {
    const identity = danmakuIdentity.value;
    return identity ? `${identity.episodeId}|${identity.matchKey}` : null;
  },
  () => {
    // 节奏属于这一集：不换集会拿上一集的格子给这一集画一条假曲线
    cutRhythm.reset();
    if (!danmakuReady.value) return;
    void loadDanmaku().then((outcome) => announceDanmaku(outcome, false));
  },
);

/* ---------- B-04：点中弹幕 → 冻结它 + 头顶出操作条 ---------- */

const danmakuInteractive = computed(
  () => danmakuSettings.value.enabled && danmakuSettings.value.interactive,
);

const danmakuPick = useDanmakuPick({
  overlay: danmakuOverlay,
  enabled: danmakuInteractive,
  mediaId,
  episodeNumber: computed(() => danmakuIdentity.value?.episodeNumber ?? null),
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
    toast.success("已复制弹幕");
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
  if (intent.type === "long-press-help") {
    maybeShowGestureHelp();
    return;
  }
  if (intent.type === "single-tap" && danmakuPick.tapAt(intent.x, intent.y))
    return;
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
  if (pendingLineSwitchEpisode !== null && next === pendingLineSwitchEpisode)
    return;
  // OPT-26（P2-⑫）：停滞恢复额度按集发放，换集重新开始
  stallRecoverRounds.value = 0;
  if (route.query.local === "1" || localIdentity.value) {
    if (next && (await tryPlayLocalFirst(next))) {
      announceOfflineEpisode();
      return;
    }
    loadError.value = "要播放的本地文件已不存在，请重新下载这一集";
    loadErrorShape.value = null;
    pageLoading.value = false;
    return;
  }
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
  announcedHistoryLineFallback.value = null;
  localMissingTaskId.value = null;
  // P0-2：换片属于新的用户意图——在飞的换源搜索作废，预算由随后的
  // `beginLoadAttempt` 判定为不同目标而自然取代上一轮
  cancelAlternateSourceSearch();
  // 外部导航改路由（如用户从相关列表点另一部片）：重新加载详情与播放
  await library.loadDetail(next);
  if (!pageAlive) return;
  await resolveAndLoad();
});

/* ---------- 沉浸态 ---------- */
const immersive = computed(() => player.fullscreen);

/* ---------- 非常态层的单一开关（设计规范 ⑦） ----------
 * 加载 / 缓冲 / 错误三层的显隐只看这一枚属性，各层不再自带背景与 z-index。
 * 判定顺序与原挂载条件保持一致，避免出现「面板挂着但压暗没铺上」的双口径。 */
const chromeState = computed<
  "idle" | "loading" | "buffering" | "playing" | "paused" | "error"
>(() => {
  if (player.error && !pageLoading.value) return "error";
  if (loadError.value) return "error";
  if (pageLoading.value) return "loading";
  if (player.loading || player.waiting) return "buffering";
  if (player.playing) return "playing";
  return "paused";
});

/* 进错误态先收掉抽屉：错误层挂在壳层且压在抽屉上面（37 > 30），留着抽屉就等于留一块
   看得见、点不动的死面板。与 toggleScreenLock 里那句「锁屏必须关抽屉」同理。 */
watch(
  () => chromeState.value === "error",
  (showing) => {
    if (showing) drawerOpen.value = false;
  },
);

/* ---------- B4：横屏屏幕锁（防误触） ---------- */
const screenLocked = ref(false);

function toggleScreenLock(): void {
  screenLocked.value = !screenLocked.value;
  if (screenLocked.value) {
    // 锁屏会吃掉画面上的所有交互层，浮层必须真关掉而不是被隐藏，否则解锁后它又冒出来
    closeGestureHelp();
    // 抽屉在层级上高于锁屏层（30 > 20），不关掉就等于「锁了但还能换集换线路」
    drawerOpen.value = false;
    setControlsVisible(false);
    // inert 只挡后续聚焦，已经落在信息区里的焦点要主动撤掉
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".pl-fold"))
      active.blur();
    ui.toast("已锁定屏幕，轻点画面显示解锁键", "info", 2600);
  } else {
    setControlsVisible(true);
  }
}

// 退出全屏必须自动解锁，否则竖屏下控件全被吃掉，页面等于废了
watch(immersive, (on) => {
  if (!on && screenLocked.value) {
    screenLocked.value = false;
    setControlsVisible(true);
  }
});

/**
 * 控制条的唯一可见口径：`data-chrome` 与 `PlayerControls :visible` 都只认它。
 * 只看 `controlsVisible` 会漏——播完/被远端暂停时自动隐藏不生效，锁屏下控制条又冒出来。
 */
const chromeVisible = computed(
  () => controlsVisible.value && !screenLocked.value,
);

/* ---------- 键盘与滚轮（设计规范 ⑨：14 档按键 + Shift 组合 + 数字键） ---------- */
const pictureRef = ref<HTMLElement | null>(null);
/**
 * 键盘驱动标记：置真时给进度条轨道补一层内描边焦点环（稿 `[data-keynav]`），
 * 鼠标点过画面后立刻收回去——键盘焦点环不该在触屏操作中常驻。
 */
const keyNav = ref(false);
/** `M` 静音前的音量档，再按一次用它还原（稿默认 60） */
let volumeBeforeMute = 0;

/**
 * 按键 → 动作的对照表在 `player/keyboardActions`（纯函数，可单测逐档覆盖），
 * 这里只负责把动作落到真实控制上；未命中的键不 preventDefault，还给浏览器与无障碍。
 */
function onKeydown(ev: KeyboardEvent): void {
  if (shouldIgnoreShortcut(ev.target)) return;
  const action = resolveKeyAction(ev, {
    seekStep: playerSettings.value.seekStepSec ?? 10,
    locked: screenLocked.value,
  });
  if (!action) return;
  keyNav.value = true;
  ev.preventDefault();
  // Escape 是锁屏时的唯一逃生口，且不接管自动隐藏计时，故先于其它动作返回
  if (action.kind === "escape") {
    if (gestureHelpVisible.value) closeGestureHelp();
    else if (drawerOpen.value) drawerOpen.value = false;
    else if (player.fullscreen) void exitFullscreen();
    return;
  }
  nudgeControls();
  switch (action.kind) {
    case "play":
      void togglePlay();
      return;
    case "seek":
    case "frame":
      // 方向键步长跟用户设置，j/l 是稿上固定的 10s，,/. 是一帧
      seek(player.currentTime + action.delta);
      return;
    case "volume": {
      // 与手势同一条落点（onGesture 统一处理 HUD、系统/应用音量、记忆）
      const next = Math.min(100, Math.max(0, player.volume + action.delta));
      onSetVolume(next);
      return;
    }
    case "brightness":
      onSetBrightness(
        Math.min(BRIGHTNESS_MAX, Math.max(0, player.brightness + action.delta)),
      );
      return;
    case "mute":
      toggleMute();
      return;
    case "percent":
      // 数字键 = 百分比定位（0→开头、9→九成处），比逐帧拖进度条快
      if (player.seekable) seek(player.duration * (action.tenths / 10));
      return;
    case "fullscreen":
      void toggleFullscreen();
      return;
    case "subtitle":
      void toggleSubtitle();
      return;
    case "danmaku":
      void toggleDanmaku();
      return;
    case "drawer":
      if (drawerOpen.value) drawerOpen.value = false;
      else openDrawer("ep");
      return;
    case "lock":
      toggleScreenLock();
      return;
    case "help":
      if (gestureHelpVisible.value) closeGestureHelp();
      else showGestureHelp();
      return;
  }
}

/** `M`：音量归零但记住原档，再按一次还原；没有原档（本来就是 0）时给稿上的 60 */
function toggleMute(): void {
  if (player.volume > 0) {
    volumeBeforeMute = player.volume;
    onSetVolume(0);
    return;
  }
  onSetVolume(volumeBeforeMute > 0 ? volumeBeforeMute : 60);
}

/**
 * `S`：有轨可切就直接切/关，一轨都没有时打开字幕面板——
 * 这键在没得切的情况下必须说句话，而不是什么都不发生。
 * 原生引擎切内嵌轨（id 是数字），WebView 引擎切外挂轨，与面板同一条落点；
 * `openSubtitlePanel()` 本身就按引擎分流（原生 = 内嵌字幕轨菜单），兜底不必再判一次。
 */
async function toggleSubtitle(): Promise<void> {
  if (engineIsNative.value) {
    if (subtitleOn.value) {
      await onSelectEmbeddedSubtitle(null);
      return;
    }
    const first = embeddedTracks.value.text[0]?.id;
    if (first === undefined) {
      openSubtitlePanel();
      return;
    }
    await onSelectEmbeddedSubtitle(first);
    return;
  }
  if (subtitleOn.value) {
    await selectSubtitle(null);
    return;
  }
  const first = player.subtitles[0]?.id;
  if (!first) {
    openSubtitlePanel();
    return;
  }
  await selectSubtitle(first);
}

/** 滚轮调音量（稿：画面上一格 ±4）；锁屏与 PiP 下不接，且必须非被动才能吃掉页面滚动 */
function onWheel(ev: WheelEvent): void {
  if (screenLocked.value || pipActive.value) return;
  if (shouldIgnoreShortcut(ev.target)) return;
  ev.preventDefault();
  const delta = ev.deltaY < 0 ? WHEEL_VOLUME_STEP : -WHEEL_VOLUME_STEP;
  onSetVolume(Math.min(100, Math.max(0, player.volume + delta)));
  nudgeControls();
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  pictureRef.value?.addEventListener("wheel", onWheel, { passive: false });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  pictureRef.value?.removeEventListener("wheel", onWheel);
  document.documentElement.classList.remove("native-underlay");
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
      const active =
        (await playerCtl.controller.value?.isNativePipActive()) ?? false;
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

  if (player.engineKind === "native") {
    pipNative.value = true;
    try {
      pipSupported.value =
        (await playerCtl.controller.value?.isNativePipSupported()) ?? false;
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
      toast.info("在画中画窗口里点关闭按钮或返回全屏即可退出", 2200);
      return;
    }
    try {
      await playerCtl.controller.value?.enterNativePip();
      syncNativePipActive(true);
      startPipPolling();
    } catch (e) {
      // PiP 失败不阻断播放，仅提示（部分 ROM/设置会拒绝）
      toast.info(toErrorShape(e, "E_NOT_IMPLEMENTED").message);
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
    toast.info(toErrorShape(e, "E_NOT_IMPLEMENTED").message);
    pipActive.value = false;
  }
}

/** OPT-06：页面可见性变化时自动进入 PiP（设置开启 + 正在播放 + 非全屏） */
function onVisibilityChangeForPip(): void {
  if (!pipSupported.value || !settings.settings?.pipAutoEnter) return;
  if (document.visibilityState !== "hidden") return;
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
  document.addEventListener("visibilitychange", onVisibilityChangeForPip);
  // 回前台时补一次原生 PiP 状态（用户在小窗里点回 App 时退出 PiP）
  detachAppState = onAppStateChange((state) => {
    if (state !== "active" || !pipNative.value) return;
    void (async () => {
      const active =
        (await playerCtl.controller.value?.isNativePipActive()) ?? false;
      syncNativePipActive(active);
      if (active) startPipPolling();
    })();
  });
});

onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibilityChangeForPip);
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
    class="player-root pl-frame"
    :class="{
      'player-root--landscape': immersive,
      'player-root--native': player.engineKind === 'native',
      'player-root--pip': pipActive,
    }"
    data-route="player"
  >
    <!-- 播放器外壳：竖屏＝画面带 + 下方信息区，横屏/全屏＝画面铺满、信息区收起 -->
    <div
      class="player-page pl-shell"
      :data-chrome="chromeVisible ? 'visible' : 'hidden'"
      :data-fit="currentResizeMode"
      :data-state="chromeState"
      :data-help="gestureHelpVisible ? '1' : '0'"
      :data-locked="screenLocked ? '1' : '0'"
      :data-danmaku="danmakuSettings.enabled ? '1' : '0'"
      :data-drawer="drawerOpen ? '1' : '0'"
      :data-keynav="keyNav ? '1' : '0'"
      @pointerdown="keyNav = false"
    >
      <div ref="stageRef" class="player-stage pl-stage">
        <!-- 视频矩形：所有 chrome 严格限制在这一层内，竖屏不再压住整块屏 -->
        <div ref="pictureRef" class="pl-picture">
          <PlayerSurface
            :subtitle-text="player.subtitleText"
            :subtitle="localSubtitles"
            :brightness="player.brightness"
            :mask="player.levelSource === 'app'"
            :immersive="immersive"
            :ambilight-enabled="
              ambilightEnabled && !engineIsNative && !pipActive
            "
            :ambilight-intensity="ambilightIntensity"
            :native-engine="engineIsNative"
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
                  <PosterImage
                    :src="item?.posterUrl ?? null"
                    :alt="titleText"
                    :fallback-title="titleText"
                    eager
                  />
                </div>
                <div class="audio-stage__meta">
                  <span class="audio-stage__badge">纯音频</span>
                  <p class="audio-stage__title">{{ titleText }}</p>
                  <p v-if="episodeLabel" class="audio-stage__sub">
                    {{ episodeLabel }}
                  </p>
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
            <div
              v-if="seekPreviewUrl && !pipActive"
              class="seek-preview"
              aria-hidden="true"
            >
              <img :src="seekPreviewUrl" alt="" draggable="false" />
            </div>

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
              v-if="
                !pageLoading && !loadError && !player.error && !screenLocked
              "
              :seek-max-sec="gestureSettings.seekMaxSec"
              :seek-enabled="player.seekReliable"
              :sensitivity="gestureSettings.sensitivity"
              :long-press-help-enabled="gestureHelpEnabled"
              :pinch="pinchResizeEnabled"
              :pinch-start-mode="currentResizeMode"
              @intent="onStageIntent"
              @pointer-down="onGesturePointerDown"
              @pinch-sample="onPinchSample"
              @pinch-end="onPinchEnd"
            />

            <!-- G-A09：捏合时的画幅尺（纯呈现，不吃指针） -->
            <PinchResizeHud
              v-if="pinchHudVisible"
              :pos="pinchPos"
              :mode="pinchMode"
            />

            <!-- P1-1：手势引导（首次进入自动显示） -->
            <GestureGuide
              v-if="
                !pageLoading && !loadError && !player.error && !screenLocked
              "
              :pinch-enabled="pinchResizeEnabled"
            />

            <PlayerHud
              :kind="hud.kind"
              :value="hud.value"
              :delta-sec="hud.deltaSec"
            />

            <PlayerControls
              v-if="!loadError"
              :visible="chromeVisible"
              :title="titleText"
              :ep-index="epIndex"
              :ep-total="epTotal"
              :playing="player.playing"
              :waiting="player.loading || player.waiting"
              :current-time="player.currentTime"
              :duration="player.duration"
              :seek-reliable="player.seekReliable"
              :buffered="player.buffered"
              :rate="player.rate"
              :can-prev="canPrev"
              :can-next="canNext"
              :show-episode-nav="hasEpisodeNav"
              :fullscreen="player.fullscreen"
              :subtitle-active="subtitleOn"
              :quality-label="qualityLabel"
              :line-name="currentLine?.name ?? ''"
              :danmaku-enabled="danmakuSettings.enabled"
              :danmaku-reading="danmakuChipReading"
              :seek-step="playerSettings.seekStepSec"
              :volume="player.volume"
              :brightness="player.brightness"
              :locked="screenLocked"
              :skip-zone="pipActive || countdown !== null ? null : skipZone"
              :skip-target-sec="skipTargetSec"
              :film="seekFilm"
              :marks="skipMarks"
              :seek-detent="seekDetent"
              :seek-cells="seekCells"
              :rhythm="rhythmBandData"
              @back="goBack"
              @toggle-play="togglePlay"
              @prev="goToPrevEpisode"
              @next="goToNextEpisode"
              @seek="onSeekCommit"
              @seeking="onSeekPreview"
              @set-rate="onSetRate"
              @set-volume="onSetVolume"
              @set-brightness="onSetBrightness"
              @open-quality="openDrawer('av')"
              @open-line="openDrawer('line')"
              @open-subtitle="openSubtitlePanel"
              @open-episodes="openDrawer('ep')"
              @open-more="openDrawer('more')"
              @toggle-danmaku="toggleDanmaku"
              @toggle-fullscreen="toggleFullscreen"
              @toggle-lock="toggleScreenLock"
              @skip="skipIntro.skip"
              @skip-dismiss="skipIntro.dismiss"
              @pause-auto-hide="pauseAutoHide"
              @nudge="nudgeControls"
            />

            <!-- EXT-07：沉浸态音轨入口（横屏控制条没有音轨位，用浮动胶囊补齐） -->
            <button
              v-if="
                engineIsNative &&
                immersive &&
                !pipActive &&
                !screenLocked &&
                embeddedTracks.audio.length > 0
              "
              class="player-audio-chip"
              :class="{ 'player-audio-chip--hidden': !controlsVisible }"
              type="button"
              :aria-label="`音轨：${audioChipLabel}`"
              data-test="player-audio-chip"
              @click="openEmbeddedAudioMenu"
            >
              {{ audioChipLabel }}
            </button>

            <!-- ⑦ 加载中 / 缓冲：同一层。加载交代「走到哪一步、等了多久」，
                 缓冲只交代在等——分阶段信息只在首次起播那条链上才有。 -->
            <div
              v-if="chromeState === 'loading' || chromeState === 'buffering'"
              class="pl-buf"
              role="status"
              aria-live="polite"
            >
              <PlayLoadingBar
                v-if="chromeState === 'loading'"
                :progress="loadingProgress"
                :stage-text="loadingStageText"
                :elapsed="loadingElapsed"
              />
              <template v-else>
                <span class="pl-buf__ring" aria-hidden="true" />
                <p class="pl-buf__text">正在缓冲…</p>
              </template>
              <div v-if="chromeState === 'loading'" class="pl-buf__acts">
                <button
                  class="pl-cta pl-cta--ghost"
                  type="button"
                  @click="goBack"
                >
                  取消
                </button>
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

            <!-- B4：屏幕锁（⑦）：拦截片常驻在 pl-lock 层，靠 --z-lock 压住上面各层，
                 不再依赖 DOM 顺序；抽屉/折叠区已在 toggleScreenLock() 里真关掉。
                 压暗与解锁键不常驻——轻点画面才唤回，3s 后自动收起。
                 竖屏也生效（稿 `K`）：锁屏层只铺画面矩形，信息区靠 inert 让位，
                 出口是唤回的解锁键（键盘还有 `K` / `Escape`）——退出全屏会自动解锁，但竖屏本来就没有全屏可退。 -->
            <PlayerScreenLock
              v-if="!pipActive && !loadError && !player.error"
              :locked="screenLocked"
              @toggle="toggleScreenLock"
            />
          </PlayerSurface>

          <!-- 弹幕样式实时调节面板（非模态，叠在视频矩形内） -->
          <DanmakuStylePanel
            :open="danmakuStylePanelOpen && !screenLocked"
            :contrast-blocked="danmakuContrastBlocked"
          />
        </div>
        <!-- /.pl-picture -->
      </div>

      <!-- ⑥ 竖屏下方信息区（横屏/全屏隐藏，入口由 chrome 与更多面板承载） -->
      <section
        v-if="!immersive"
        class="pl-fold"
        :inert="screenLocked || undefined"
        aria-label="播放信息与快捷控制"
      >
        <!-- 黑屏检测：零帧或已解码但画面持续近黑 -->
        <div
          v-if="noVideo && !noVideoDismissed && !pageLoading && !player.error"
          class="player-novideo"
          role="alert"
          data-test="player-novideo"
        >
          <p class="player-novideo__title">当前线路没有可见画面</p>
          <p v-if="noVideo.reason === 'zero-frame'" class="player-novideo__hint">
            该视频编码（常见 HEVC）WebView
            解不出来，换线路或改用原生引擎通常可解。
          </p>
          <p v-else class="player-novideo__hint">
            已连续检测到黑帧，可换线路或改用原生引擎重试。
          </p>
          <div class="player-novideo__actions">
            <button
              class="btn btn--primary btn--sm"
              type="button"
              @click="retryWithNativeEngine"
            >
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
            <button
              class="btn btn--ghost btn--sm"
              type="button"
              @click="dismissNoVideo"
            >
              继续听声音
            </button>
          </div>
        </div>

        <p
          v-if="offlineEpisodeNumber !== null"
          class="pl-fold__offline"
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
          <span class="player-local-missing__text"
            >本地文件不可用，已切换网络源</span
          >
          <button
            class="btn btn--secondary btn--sm player-local-missing__btn"
            type="button"
            data-test="redownload"
            :disabled="redownloading"
            @click="onRedownload"
          >
            {{ redownloading ? "重新下载中…" : "重新下载" }}
          </button>
        </div>

        <!-- P0-2：离线文件时间轴异常（能打开但永不推进）：只给「重新下载」出口 -->
        <div
          v-if="localStallTaskId && !localMissingTaskId"
          class="player-local-missing"
          role="status"
          data-test="local-stall"
        >
          <span class="player-local-missing__text"
            >离线文件异常（时间轴停滞或解码损坏），本机播放器无法续读</span
          >
          <button
            class="btn btn--secondary btn--sm player-local-missing__btn"
            type="button"
            data-test="redownload"
            :disabled="redownloading"
            @click="onRedownload"
          >
            {{ redownloading ? "重新下载中…" : "重新下载" }}
          </button>
        </div>

        <p class="pl-fold__stat">
          <span>
            已观看 <b>{{ formatPlayerClock(player.currentTime) }}</b> /
            <span class="pl-num">{{ player.duration > 0 ? formatPlayerClock(player.duration) : "--:--" }}</span>
          </span>
          <span class="sep">·</span>
          <span
            >缓冲 <b>{{ foldBufferPercent }}%</b></span
          >
          <span class="sep">·</span>
          <span>进度每 5 秒自动保存</span>
        </p>

        <!-- 常驻滑杆：手势之外的可见入口（画面上左半屏亮度 / 右半屏音量依旧可拖） -->
        <div class="pl-fold__sliders">
          <div class="pl-slider-cell">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4Z" />
              <path d="M15.4 9a4.2 4.2 0 0 1 0 6" />
            </svg>
            <input
              class="pl-rng"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="player.volume"
              :style="{ '--fill': `${player.volume}%` }"
              aria-label="音量"
              @input="onFoldVolume"
            />
            <span class="pl-num">{{ Math.round(player.volume) }}</span>
          </div>
          <div class="pl-slider-cell">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3.6" />
              <path
                d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5"
              />
            </svg>
            <input
              class="pl-rng"
              type="range"
              min="0"
              max="100"
              step="1"
              :value="player.brightness"
              :style="{ '--fill': `${player.brightness}%` }"
              aria-label="屏幕亮度"
              @input="onFoldBrightness"
            />
            <span class="pl-num">{{ Math.round(player.brightness) }}</span>
          </div>
        </div>

        <div class="pl-fold__acts">
          <button
            class="pl-act"
            type="button"
            :disabled="episodes.length < 2"
            @click="openDrawer('ep')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h11M4 12h11M4 17h7" />
              <path d="M18.5 9.5 21 12l-2.5 2.5" />
            </svg>
            选集
            <span v-if="epTotal > 1" class="pl-num"
              >{{ epIndex }}/{{ epTotal }}</span
            >
          </button>
          <button
            class="pl-act"
            type="button"
            :disabled="lines.length < 2"
            @click="openDrawer('line')"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M12 20v-8" />
              <path d="M7.8 8.2a6 6 0 1 1 8.4 0" />
              <path d="M9.6 11.6a3.4 3.4 0 1 1 4.8 0" />
            </svg>
            线路
          </button>
          <button class="pl-act" type="button" @click="openDrawer('av')">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M4 17V7M10 17v-6M16 17v-9M22 17v-4" />
            </svg>
            音画
          </button>
          <button
            class="pl-act"
            type="button"
            :aria-pressed="isFavorite"
            :disabled="favoritePending"
            @click="onToggleFavorite"
          >
            <svg
              viewBox="0 0 24 24"
              :fill="isFavorite ? 'currentColor' : 'none'"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M12 4.6 14.1 9l4.9.7-3.6 3.4.9 4.8-4.3-2.3-4.3 2.3.9-4.8L5 9.7 9.9 9Z"
              />
            </svg>
            {{ isFavorite ? "已收藏" : "收藏" }}
          </button>
          <button
            class="pl-act"
            type="button"
            :disabled="downloading || !currentEpisode"
            @click="pickerOpen = true"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M12 4v10M8 11l4 4 4-4M5 19h14" />
            </svg>
            {{ downloading ? "加入中…" : "下载本集" }}
          </button>
          <button
            class="pl-act"
            type="button"
            data-test="open-more-sheet"
            @click="openDrawer('more')"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="5" cy="12" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="19" cy="12" r="2" />
            </svg>
            更多
          </button>
        </div>
      </section>
      <!-- ⑤' 播放面板抽屉：选集/线路/音画/更多四页签共用一个容器，
         横屏＝画面让位的右侧栏，竖屏＝底部弹层（形态由容器查询选）。
         内容仍是原来的面板组件与行项，只是关闭路径与遮罩只剩一份。 -->
      <PlayerDrawer v-model:open="drawerOpen" v-model:tab="drawerTab">
        <template #ep>
          <p v-if="epTotal > 1" class="pl-pane__note">
            全 {{ epTotal }} 集 · 当前第 {{ epIndex }} 集 · 绿点＝已下载
          </p>
          <EpisodeList
            :episodes="navigationEpisodes"
            :current-id="playingIdentity?.episodeId ?? null"
            :downloaded-ids="downloadedIds"
            @select="chooseEpisode"
          />
        </template>

        <template #line>
          <LineSelector
            :lines="lines"
            :model-value="currentLineId"
            :line-statuses="lineStatuses"
            :line-latencies="lineLatencies"
            :recommended-line-id="recommendedLineId"
            @update:model-value="onSwitchLineById"
          />
        </template>

        <template #more>
          <ul class="sheet-list">
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="openDetail"
              >
                查看详情
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="openShareCode"
              >
                生成观影口令
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  postcardOpen = true;
                "
              >
                一帧明信片
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="pickerOpen = true"
              >
                下载本集
              </button>
            </li>
            <!-- FIX-PLAY-C3 / P2-2：自检只对本机文件产物有意义（blob 兜底没有文件可扫）；工具按容器分：TS 查包对齐，MP4 查轨道/时长/定位 -->
            <li v-if="canScanLocalFile">
              <button
                class="sheet-list__item local-scan__item"
                type="button"
                :disabled="localScan?.running"
                @click="runLocalFileScan"
              >
                <span>{{
                  localScan?.running ? "正在自检文件…" : "文件自检"
                }}</span>
                <span class="sheet-list__value">{{
                  localScanIsTs ? "TS 分片对齐诊断" : "MP4 轨道/时长/定位"
                }}</span>
              </button>
              <p
                v-if="localScan && !localScan.running"
                class="sheet-list__note local-scan__result"
              >
                {{ localScan.text }}
              </p>
            </li>
            <!-- OPT-26（P2-⑬）：决策链诊断包——排查"这一集为什么播不了"时不必连电脑捞日志 -->
            <li>
              <button
                class="sheet-list__item"
                type="button"
                :disabled="playTraceExporting"
                @click="exportPlayTrace"
              >
                <span>{{
                  playTraceExporting ? "正在整理决策链…" : "播放诊断包"
                }}</span>
                <span class="sheet-list__value">本轮起播的链路与日志</span>
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="skipMarkOpen = true"
              >
                片头 / 片尾标记
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  sleepOpen = true;
                "
              >
                <span>睡眠定时</span>
                <span
                  class="sheet-list__value"
                  :class="{ 'sheet-list__value--on': sleepActive }"
                >
                  {{ sleepLabel }}
                </span>
              </button>
            </li>
            <li class="sheet-list__row">
              <span class="sheet-list__label">
                后台播放
                <small class="sheet-list__note">
                  {{
                    engineIsNative
                      ? "切到后台或锁屏后继续播放"
                      : "仅原生播放器支持"
                  }}
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
                  {{
                    engineIsNative
                      ? "收起画面只听声音，省电省流量"
                      : "仅原生播放器支持"
                  }}
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
              <button
                class="sheet-list__item"
                type="button"
                :aria-pressed="isFavorite"
                :disabled="favoritePending"
                @click="onToggleFavorite"
              >
                <span>收藏</span>
                <span
                  class="sheet-list__value"
                  :class="{ 'sheet-list__value--on': isFavorite }"
                >
                  {{ isFavorite ? "已收藏" : "未收藏" }}
                </span>
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                :disabled="castSupported === false"
                @click="
                  drawerOpen = false;
                  onCast();
                "
              >
                投屏
              </button>
            </li>
            <li v-if="pipSupported">
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  togglePip();
                "
              >
                {{ pipActive ? "退出画中画" : "画中画" }}
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  showGestureHelp();
                "
              >
                手势说明
              </button>
            </li>
          </ul>
        </template>

        <!-- ⑥「音画」页签：倍速/画质/画面比例/字幕/音轨/弹幕参数收在一处 -->
        <template #av>
          <ul class="sheet-list">
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  qualityOpen = true;
                "
              >
                <span>画质</span>
                <span class="sheet-list__value">{{ qualityLabel }}</span>
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  displayModeOpen = true;
                "
              >
                画面比例
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                :data-test="engineIsNative ? 'open-subtitle-tracks' : undefined"
                @click="
                  drawerOpen = false;
                  openSubtitlePanel();
                "
              >
                <span>字幕</span>
                <span
                  class="sheet-list__value"
                  :class="{ 'sheet-list__value--on': subtitleOn }"
                >
                  {{ subtitleOn ? "已开启" : "未开启" }}
                </span>
              </button>
            </li>
            <!-- EXT-07：内嵌音轨仅原生引擎可切，WebView 引擎没有内嵌轨 -->
            <li v-if="engineIsNative">
              <button
                class="sheet-list__item"
                type="button"
                data-test="open-audio-tracks"
                @click="
                  drawerOpen = false;
                  openEmbeddedAudioMenu();
                "
              >
                <span>音轨</span>
                <span class="sheet-list__value">
                  {{
                    embeddedTracks.audio.length > 1
                      ? `${embeddedTracks.audio.length} 条`
                      : "默认"
                  }}
                </span>
              </button>
            </li>
            <li>
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  danmakuOpen = true;
                "
              >
                <span>弹幕设置</span>
                <span
                  class="sheet-list__value"
                  :class="{ 'sheet-list__value--on': danmakuSettings.enabled }"
                >
                  {{ danmakuSettings.enabled ? "已开启" : "已关闭" }}
                </span>
              </button>
            </li>
            <li v-if="danmakuSettings.enabled">
              <button
                class="sheet-list__item"
                type="button"
                @click="
                  drawerOpen = false;
                  danmakuStylePanelOpen = true;
                "
              >
                弹幕样式
              </button>
            </li>
          </ul>
        </template>
      </PlayerDrawer>

      <!-- OPT-10：手势帮助浮层（暂停态长按 3 秒 / 「更多 → 手势说明」）
           挂在壳层而不是画面矩形内（稿里 help 在 picture 下）：稿的竖屏没有信息区，
           picture 就是整屏；真实页 390 宽的 16:9 画面带只有 ~219px，21 行快捷键
           被压成 187px 的滚动卡。这里跟抽屉一样是「要给足高度的面板」，
           横屏/全屏时 picture 与壳等尺寸，位置变化不影响观感。 -->
      <GestureHelpOverlay
        :visible="gestureHelpVisible"
        @close="closeGestureHelp"
      />
      <!-- ⑦ 错误层（播放错误 + 页面级错误）：挂在壳层而不是画面矩形内，同帮助浮层的理由——
           稿的竖屏没有信息区，picture 就是整屏；真实页 390 宽的 16:9 画面带只有 ~219px，
           而卡片含标题/原因/失败步骤/三出口约 257px，留在岛内会被 .pl-picture 的
           overflow:hidden 上下各裁掉 19px（圆角丢失、标题贴上沿）。横屏/全屏/PiP 下
           picture 与壳等尺寸，观感不变。 -->
      <!-- 错误面板 -->
      <PlayerErrorPanel
        v-if="player.error && !pageLoading"
        :error="player.error"
        :can-switch-line="lines.length > 1 && currentPlayback?.isLocal !== true"
        :can-switch-source="canSwitchSourceManual"
        :can-health-check="canHealthCheck"
        :can-redownload="localStallTaskId !== null"
        :can-retry-native="canRetryNative"
        @retry="retryPanel"
        @retry-native="retryWithNativeEngine"
        @switch-line="onSwitchLine"
        @switch-source="onSwitchSource"
        @health-check="goHealthCheck"
        @redownload="onRedownload"
        @back="openDetail"
        @copy="copyError"
        @open-external="openExternalUrl"
      />

      <!-- ⑦ 页面级错误（详情/解析失败）：与 PlayerErrorPanel 同一个 pl-err 壳，只换内容 -->
      <div v-if="loadError && !player.error" class="pl-err" role="alert">
        <div class="pl-err__card">
          <!-- REV-24：详情失败时用上下文文案，否则用原始 loadError -->
          <h2 class="pl-err__title">
            {{ detailErrorMessage ?? loadError }}
          </h2>
          <!-- P0-1：给出可行动原因（源站死 / 超时 / 磁力 / 规则脚本异常） -->
          <p v-if="loadErrorGuidance" class="pl-err__desc">
            {{ loadErrorGuidance.hint }}
          </p>
          <!-- P1-1：目标集定位失败时说明原因，不假装"重试"能解决 -->
          <p
            v-if="targetEpisodeMissing"
            class="pl-err__desc"
            data-test="episode-missing-hint"
          >
            源可能更新过选集，这一集已经不在当前线路里了；可在下方选集或换线路
          </p>
          <div class="pl-err__acts">
            <!-- REV-24：源已移除时提供删除记录入口 -->
            <button
              v-if="detailErrorKind === 'source-removed'"
              class="pl-cta"
              type="button"
              @click="removeHistoryAndGoBack"
            >
              删除记录并返回
            </button>
            <!-- P1-4：磁力链接只能外部打开，重试无意义 -->
            <button
              v-else-if="loadErrorMagnet"
              class="pl-cta"
              type="button"
              @click="openExternalUrl(loadErrorMagnet)"
            >
              用外部应用打开
            </button>
            <!-- P1-1：定位不到目标集时，"从头开始"必须是用户明确选的，不是静默兜底 -->
            <button
              v-else-if="targetEpisodeMissing"
              class="pl-cta"
              type="button"
              data-test="play-first-episode"
              @click="playFromFirstEpisode"
            >
              从第 1 集播放
            </button>
            <button
              v-else-if="!loadErrorMagnet"
              class="pl-cta"
              type="button"
              :disabled="loadErrorGateMs > 0"
              data-test="page-retry"
              @click="resolveAndLoad"
            >
              {{ loadErrorRetryLabel }}
            </button>
            <!-- v1.8/CHG-26：解析失败常是源坏了，直接给换源路径 -->
            <button
              v-if="canSwitchSourceManual"
              class="pl-cta pl-cta--ghost"
              type="button"
              @click="onSwitchSource"
            >
              换源重播
            </button>
            <button
              class="pl-cta pl-cta--ghost"
              type="button"
              @click="openDetail"
            >
              返回详情
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 面板 -->
    <SpeedSheet v-model="speedOpen" :rate="player.rate" @select="setRate" />
    <DanmakuSettingsSheet
      v-model:open="danmakuOpen"
      :import-xml="importLocalDanmaku"
      :rematch="rematchDanmaku"
      :rematch-ignore-year="canIgnoreDanmakuYear ? rematchDanmakuIgnoringYear : null"
    />
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
    <PostcardSheet
      v-model="postcardOpen"
      :title="titleText"
      :meta="postcardMeta"
      :episode-label="postcardEpisodeLabel"
      :poster-url="item?.posterUrl ?? null"
      :position-sec="player.currentTime"
      :duration-sec="player.duration"
      :line="player.subtitleText"
      :local-path="postcardLocalPath"
    />
    <ShareCodeSheet
      v-model="shareCodeOpen"
      :payload="shareCodePayload"
      :meta="postcardMeta"
      :episode-label="postcardEpisodeLabel"
      :poster-url="item?.posterUrl ?? null"
      :duration-sec="player.duration"
      @copy="copyShareCode"
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
        <button
          class="btn btn--primary btn--md picker-btn"
          type="button"
          :disabled="downloading"
          @click="onDownloadCurrent"
        >
          {{ downloading ? "加入中…" : "开始下载" }}
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
    <BingeCelebration
      :show="bingeShow"
      :title="item ? item.title : null"
      @dismiss="dismissBinge"
    />
  </main>
</template>

<style scoped>
/* 骨架（frame/shell/stage/picture）的尺寸与背景由 player-chrome.css 的容器分档决定，
   这里不再重复声明：scoped 选择器特异性更高，重复写会压掉横屏档。 */

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

.audio-stage__bars i:nth-child(2) {
  animation-duration: 620ms;
}
.audio-stage__bars i:nth-child(3) {
  animation-duration: 1080ms;
}
.audio-stage__bars i:nth-child(4) {
  animation-duration: 760ms;
}
.audio-stage__bars i:nth-child(5) {
  animation-duration: 940ms;
}

.audio-stage__bars--still i {
  animation-play-state: paused;
  transform: scaleY(0.22);
  opacity: 0.5;
}

@keyframes audio-bar {
  from {
    transform: scaleY(0.2);
  }
  to {
    transform: scaleY(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .audio-stage__bars i {
    animation: none;
    transform: scaleY(0.6);
  }

  .audio-stage__bars i:nth-child(2) {
    transform: scaleY(0.9);
  }
  .audio-stage__bars i:nth-child(4) {
    transform: scaleY(0.4);
  }
}

/* v1.8 修复：原生引擎 surface 在 WebView 之下，播放器背景需透明让视频透出。
   frame/shell/stage/picture 四层的透明由 player-chrome.css 统一声明，这里只补子组件。 */
.player-root--native :deep(.player-surface) {
  background-color: transparent;
}

/* EXT-07：原生 PiP 小窗只留画面——信息区收起、画面铺满、浮动入口隐藏 */
.player-root--pip .pl-stage {
  flex: 1 1 auto;
}

.player-root--pip .pl-picture {
  height: 100%;
  aspect-ratio: auto;
}

.player-root--pip .pl-fold {
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
  transition:
    opacity var(--duration-slow) var(--ease-standard),
    var(--transition-color);
}

.player-audio-chip:active {
  background-color: var(--color-bg-glass-strong);
}

/* 随控制栏同显同隐：隐藏态淡出并放行手势，避免右侧胶囊常显 */
.player-audio-chip--hidden {
  opacity: 0;
  pointer-events: none;
}

/* 沉浸态（全屏）画面铺满：竖屏下全屏也不留 16:9 黑带，特异性压过容器分档 */
.player-root--landscape .pl-stage {
  flex: 1 1 auto;
}

.player-root--landscape .pl-picture {
  height: 100%;
  aspect-ratio: auto;
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

/* FIX-PLAY-C3：自检结果跟在按钮后，分隔线从按钮挪到结论下方 */
.local-scan__item {
  border-bottom: none;
}

.local-scan__result {
  display: block;
  padding: 0 var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-divider);
  line-height: 1.5;
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
