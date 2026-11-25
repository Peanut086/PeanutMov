<script setup lang="ts">
/**
 * 详情页（页面蓝图 §5）
 *
 * 结构：顶部背景（poster 模糊铺满 + gradient-hero）+ 海报/标题/元信息 + 主操作按钮
 * + 简介（4 行截断可展开）+ 选集（多线路）+ 相关。
 * 主按钮文案随进度变化：播放 / 继续观看 · 第 N 集 / 重新播放（AC-36/37）。
 * 记录集号已超出当前源范围时显示「看到第 N 集（已下线）」并从第 1 集开始（AC-68）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';

import type { Episode, HistoryRecord, MediaItem, PlayLine } from '@/types';
import { formatClock } from '@/shared/time';
import { IMG_W_BLUR, IMG_W_POSTER, sizedImage } from '@/shared/imageSize';

import PosterImage from '@/components/common/PosterImage.vue';
import MediaMeta from '@/components/media/MediaMeta.vue';
import EpisodeList from '@/components/media/EpisodeList.vue';
import LineSelector from '@/components/media/LineSelector.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import OfflineBanner from '@/components/common/OfflineBanner.vue';
import EpisodePickerSheet from '@/components/download/EpisodePickerSheet.vue';
import IconBack from '@/components/icons/IconBack.vue';
import IconHeart from '@/components/icons/IconHeart.vue';
import IconDownload from '@/components/icons/IconDownload.vue';
import IconPlay from '@/components/icons/IconPlay.vue';
import IconCast from '@/components/icons/IconCast.vue';
import IconChevron from '@/components/icons/IconChevron.vue';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useCacheStore } from '@/stores/cacheStore';
import { useUiStore } from '@/stores/uiStore';
import { castService } from '@/services/castService';
import { finalFilePathOf } from '@/services/downloadService';
// G-B07 选集胶片墙：本页只提供"可抽的集"，抽帧与缓存在服务里
import {
  episodeFilmOf,
  episodeFilmSupported,
  episodeFilmWaiting,
  requestEpisodeFilms,
  type EpisodeFilmTarget,
} from '@/services/episodeFilmService';
import { libraryService } from '@/services/libraryService';
import { playabilityService } from '@/services/playabilityService';
import { lineHealthService, lineKey } from '@/services/lineHealthService';
import { pickBestLine } from '@/services/lineRanking';
import { probeLines } from '@/services/lineProbeService';
import { useToast } from '@/composables/useToast';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useSmartPreload } from '@/composables/useSmartPreload';
import { useScopedPalette } from '@/composables/useScopedPalette';
import { useScrollNarrative } from '@/composables/useScrollNarrative';
import { accentFor, pageBackground } from '@/services/paletteService';
import { beginSharedCover, cancelSharedCover, finishSharedCover, rewindSharedCover } from '@/composables/useSharedElement';
import { useHaptic } from '@/composables/useHaptic';
import { animateSpring, prefersReducedMotion, SPRING_DEFAULT } from '@/composables/useSpring';
import { toErrorShape } from '@/shared/errors';
import { logger } from '@/shared/logger';
// P3-3：换线路重复下载校验（与播放页同一个闸门）
import { useDownloadGuards } from '@/composables/useDownloadGuards';
import { hasAllFilesAccess, readCookieFile } from '@/native/netdiskPlugin';
import { offlineEpisodeMessage, resolveTargetEpisode } from '@/player/episodeFallback';
import { formatBytes } from '@/components/common/format';
// 来源切换弹层
import SourceSwitchSheet from '@/components/media/SourceSwitchSheet.vue';
import { buildSourceCandidates } from '@/components/media/sourceCandidates';

const route = useRoute();
const router = useRouter();
const library = useLibraryStore();
const sources = useSourceStore();
const settings = useSettingsStore();
const history = useHistoryStore();
const favorites = useFavoriteStore();
const downloads = useDownloadStore();
// P3-3：换线路重复下载校验闸门（与播放页同一个入口）
const guards = useDownloadGuards();
const cache = useCacheStore();
const ui = useUiStore();
const toast = useToast();
const { isOffline } = useOnlineStatus();
const { isWifi, canPreload, preloadItem } = useSmartPreload();

/** OPT-15: 预加载提示条状态 */
const showPreloadHint = ref(false);
const preloadHintDismissed = ref(false);
const preloading = ref(false);

const mediaId = computed(() => (typeof route.params.mediaId === 'string' ? route.params.mediaId : ''));
const detail = computed(() => library.detail);
const item = computed<MediaItem | null>(
  () => detail.value?.item ?? library.searchResultsAll.find((entry) => entry.id === mediaId.value) ?? null,
);

/**
 * 顶部背景就是海报本身，但它最终被 `blur(14~28px)` 糊成一层色带——按原图请求
 * 等于把整页最贵的一张图花在看不见的细节上。取色（`useScopedPalette`）仍走原图，
 * 那条链路要把图画进 canvas，换 URL 会换缓存键并可能触发跨源预检。
 */
const backdropSrc = computed(() => sizedImage(item.value?.posterUrl ?? null, IMG_W_BLUR));

/** 染色作用域根节点（只染本页子树，TabBar 与首页保持默认品牌色） */
const rootRef = ref<HTMLElement | null>(null);
/** 共享元素转场的封面源 */
const posterRef = ref<HTMLElement | null>(null);
const { seed: paletteSeed } = useScopedPalette(rootRef, computed(() => item.value?.posterUrl ?? null));

/** C-10 滚动叙事：真正的滚动容器与头部区块 */
const scrollEl = ref<HTMLElement | null>(null);
const heroEl = ref<HTMLElement | null>(null);
const { activeSection, refresh: refreshNarrative } = useScrollNarrative({
  root: rootRef,
  scroller: scrollEl,
  hero: heroEl,
});
/**
 * 分段主色：在海报主色上按段偏一点色相（简介→原色、选集→偏暖、声明→偏冷）。
 * 取不到海报主色就不切换——硬凑一个 hue 会把品牌色染成和影片无关的颜色。
 */
const SECTION_HUE_SHIFTS = [0, 26, -22] as const;
watch([activeSection, paletteSeed], () => {
  const el = rootRef.value;
  if (!el) return;
  const seed = paletteSeed.value;
  const shift = SECTION_HUE_SHIFTS[activeSection.value];
  if (!seed || shift === undefined) {
    el.style.removeProperty('--dn-accent');
    return;
  }
  el.style.setProperty('--dn-accent', accentFor(seed, shift, pageBackground(el)));
});
watch(item, () => void nextTick(refreshNarrative));

const descExpanded = ref(false);
const pickerOpen = ref(false);
const moreOpen = ref(false);
const lineId = ref<string | null>(null);
const manualLineId = ref<string | null>(null); // 用户手动选择的线路（会话内不再自动覆盖）
/** 收藏写库在飞：双击会让「读存在性 → 写/删」交错，按钮期间禁用 */
const favoritePending = ref(false);

/* M1 爆米花追剧：弹簧 + 粒子 + 计数滚动 + 触感 */
const { haptic } = useHaptic();
const favBtnRef = ref<HTMLButtonElement | null>(null);
const favCount = computed(() => favorites.items.length);
const countDir = ref<'up' | 'down'>('up');
let stopFavSpring: (() => void) | null = null;

function spawnPopcorn(btn: HTMLElement): void {
  const layer = document.createElement('span');
  layer.className = 'fav-burst';
  layer.setAttribute('aria-hidden', 'true');
  const n = 8 + Math.floor(Math.random() * 5); // 8–12 颗
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'fav-burst__p' + (Math.random() < 0.5 ? ' fav-burst__p--cream' : '');
    const angle = (Math.PI * 2 * i) / n + Math.random() * 0.5;
    const dist = 28 + Math.random() * 28; // 28–56px
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    p.style.setProperty('--rot', `${(Math.random() * 2 - 1) * 160}deg`);
    p.addEventListener('animationend', () => p.remove(), { once: true });
    layer.appendChild(p);
  }
  btn.appendChild(layer);
  setTimeout(() => layer.remove(), 800); // 兜底清理，防泄漏
}

function playFavoriteSpring(): void {
  const btn = favBtnRef.value;
  if (!btn) return;
  stopFavSpring?.();
  if (prefersReducedMotion()) {
    btn.style.transform = '';
    return;
  }
  btn.style.transition = 'none';
  btn.style.transform = 'scale(0.92)';
  stopFavSpring = animateSpring({
    from: 0.92,
    target: 1,
    config: SPRING_DEFAULT,
    onFrame: (v) => {
      btn.style.transform = `scale(${v})`;
    },
    onSettle: () => {
      btn.style.transform = '';
      btn.style.transition = '';
      stopFavSpring = null;
    },
  });
}

const loading = computed(() => library.detailState === 'loading' || library.detailState === 'idle');
const isError = computed(() => library.detailState === 'error');

const lines = computed<PlayLine[]>(() => detail.value?.lines ?? []);
const currentLineId = computed<string | null>(() => lineId.value ?? lines.value[0]?.id ?? null);
const currentLine = computed<PlayLine | null>(
  () => lines.value.find((l) => l.id === currentLineId.value) ?? lines.value[0] ?? null,
);
const episodes = computed<Episode[]>(() => {
  if (!detail.value) return [];
  const id = currentLineId.value;
  const filtered = id ? detail.value.episodes.filter((ep) => ep.lineId === id) : detail.value.episodes;
  return filtered.sort((a, b) => a.number - b.number);
});
const isSeries = computed(() => episodes.value.length > 1 || (item.value?.type !== 'movie' && episodes.value.length > 0));
/** 当前线路是否有可播剧集：无剧集时展示空态并禁用播放/下载/投屏（源本身没返回播放数据） */
const hasEpisodes = computed(() => episodes.value.length > 0);
/**
 * 是否需要「选集下载」抽屉。
 *
 * 单集电影直接创建任务（一次点击即可下载）；多集或多线路时打开抽屉，
 * 让用户勾选（抽屉内含「全选」「开始下载」）。
 * 注意：多线路各 1 集的电影（如演示 Sintel）也必须走抽屉，否则用户无法选择线路。
 */
const needsEpisodePicker = computed(() => episodes.value.length > 1 || lines.value.length > 1);

/** 当前来源名称 */
const currentSourceName = computed(() => {
  const it = item.value;
  if (!it) return '未知来源';
  return sources.sources.find((s) => s.id === it.sourceId)?.name ?? '未知来源';
});

/** 已知来源数量（候选列表长度） */
const knownSourceCount = computed(() => sourceCandidates.value.length);

const progressRecord = ref<HistoryRecord | null>(null);
let progressResolveSeq = 0;
watch(
  [() => item.value, () => history.items],
  async ([it]) => {
    const seq = ++progressResolveSeq;
    if (!it) {
      progressRecord.value = null;
      return;
    }
    const match = await history.resolveLatestProgress({
      sourceId: it.sourceId,
      mediaId: it.id,
      title: it.title,
      year: it.year,
    });
    if (seq === progressResolveSeq && item.value === it) {
      progressRecord.value = match?.record ?? null;
    }
  },
  { immediate: true },
);

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

/** P1-4：线路最近一次探测耗时（ms）；未探测过的线路不给数字，不编造 */
const lineLatencies = computed(() => {
  const it = item.value;
  const map = new Map<string, number | null>();
  if (!it) return map;
  for (const line of lines.value) {
    const key = lineKey(it.sourceId, it.sourceItemId, line.name);
    const known = lineHealthService.statusOf(key) !== 'unknown';
    map.set(line.id, known ? (lineHealthService.entryOf(key)?.lastResolveMs ?? null) : null);
  }
  return map;
});

/** 批次1：推荐的线路 ID（评分最高） */
const recommendedLineId = computed(() => {
  const it = item.value;
  if (!it || lines.value.length === 0) return null;
  const best = pickBestLine({
    lines: lines.value,
    historyEpisodeId: progressRecord.value?.episodeId ?? null,
    episodes: detail.value?.episodes ?? [],
    buildKey: (line) => lineKey(it.sourceId, it.sourceItemId, line.name),
  });
  return best?.id ?? null;
});

const isFavorite = computed(() => {
  const it = item.value;
  return it ? favorites.isFavorite(it.sourceId, it.id) : false;
});

const isFinished = computed(() => {
  const rec = progressRecord.value;
  return rec !== null && (rec.finished || rec.progress >= 0.95);
});

/**
 * 记录集号超出当前源范围（剧集已下线，AC-68）。
 * 只有「记录集号 > 当前最大集号」才判定下线；同集号换 id 属正常重映射。
 */
const offlineEpisodeNumber = computed<number | null>(() => {
  const rec = progressRecord.value;
  if (!rec || episodes.value.length === 0) return null;
  if (rec.episodeId !== null && episodes.value.some((ep) => ep.id === rec.episodeId)) return null;
  return resolveTargetEpisode({
    recordedEpisodeId: rec.episodeId,
    recordedNumber: rec.episodeNumber,
    episodes: episodes.value,
  }).offlineNumber;
});

const primaryLabel = computed(() => {
  if (!hasEpisodes.value) return '暂无可播放';
  const rec = progressRecord.value;
  if (!rec || isFinished.value) {
    return rec && isFinished.value ? '重新播放' : '播放';
  }
  if (offlineEpisodeNumber.value !== null) return `看到第 ${offlineEpisodeNumber.value} 集（已下线）`;
  if (rec.progress > 0.05 && rec.progress < 0.95) {
    return rec.episodeNumber !== null ? `继续观看 · 第 ${rec.episodeNumber} 集` : '继续观看';
  }
  return '播放';
});

const targetEpisode = computed<Episode | null>(() => {
  const rec = progressRecord.value;
  if (!rec) return episodes.value[0] ?? null;
  return resolveTargetEpisode({
    recordedEpisodeId: rec.episodeId,
    recordedNumber: rec.episodeNumber,
    episodes: episodes.value,
  }).episode;
});

const watchedNumbers = computed(() => {
  const rec = progressRecord.value;
  if (!rec || rec.episodeNumber === null) return [];
  return [rec.episodeNumber];
});

const downloadedIds = computed(() => {
  const it = item.value;
  if (!it) return [];
  return downloads.tasks
    .filter((t) => t.mediaId === it.id && t.status === 'completed')
    .map((t) => t.episodeId);
});

/* ---------- 选集「胶片墙」（G-B07） ----------
 * 排布开关在本页，抽帧在 `episodeFilmService`：本页只负责说"哪些集可以抽"，
 * 不决定抽不抽、也不决定什么时候抽完。
 */

/** 只记这一个开关，不塞进 `AppSettings`（持久化结构改动牵连升级与设置页，代价不对等） */
const FILM_MODE_KEY = 'detail.episodeFilm';

function readFilmMode(): boolean {
  try {
    return localStorage.getItem(FILM_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

const filmMode = ref(readFilmMode());

/**
 * 能上墙的集：下载完成 + 落盘成文件 + 时长已知，三者缺一不可。
 *
 * blob sink 没有可随机读的文件；时长不知道就不知道该取哪一帧；
 * 而"抽一帧画面"只对本机文件成立（在线源要靠雪碧图，本批次不做）。
 * 所以没下载的集在胶片墙里一定是空格子——这是事实，不是缺陷。
 */
const filmTargets = computed<EpisodeFilmTarget[]>(() => {
  const it = item.value;
  if (!it) return [];
  // 时长从整部剧（所有线路）里查：下载任务可能属于另一条线路
  const all = detail.value?.episodes ?? [];
  const out: EpisodeFilmTarget[] = [];
  for (const task of downloads.tasks) {
    if (task.mediaId !== it.id || task.status !== 'completed' || task.sink !== 'filesystem') continue;
    const seconds = all.find((ep) => ep.id === task.episodeId)?.durationSec ?? 0;
    if (!(seconds > 0)) continue;
    const path = finalFilePathOf(task);
    if (path) out.push({ episodeId: task.episodeId, path, durationSec: seconds });
  }
  return out;
});

/** 至少两集才值得切换排布：单集切过去只有一格，比数字芯片更空 */
const filmEligible = computed(() => filmTargets.value.length > 1 && episodeFilmSupported());

/** 集 → 画面。缓存写入时 `strips` 自身会触发这里重算，不需要额外的版本信号 */
const filmFrames = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const target of filmTargets.value) {
    const frame = episodeFilmOf(target.path)[0];
    if (frame) map[target.episodeId] = frame;
  }
  return map;
});

const filmWaiting = computed<string[]>(() =>
  filmTargets.value.filter((target) => episodeFilmWaiting(target.path)).map((target) => target.episodeId),
);

/**
 * 开关打开、或下载状态变化时补排队（幂等：抽过的集直接跳过，一轮最多 24 格）。
 * 关掉开关就不抽——没人在看的画面不该占解码闸门。
 */
watch(
  () => `${filmMode.value}|${filmTargets.value.map((t) => `${t.episodeId}:${t.path}`).join('|')}`,
  () => {
    if (filmMode.value) requestEpisodeFilms(filmTargets.value);
  },
  { immediate: true },
);

function toggleFilmMode(): void {
  filmMode.value = !filmMode.value;
  try {
    localStorage.setItem(FILM_MODE_KEY, filmMode.value ? '1' : '0');
  } catch {
    /* 写不进去（隐私模式等）只是记不住选择，不影响本页 */
  }
}

const downloading = ref(false);
/** 播放前置预检进行中（AC-33①）：阻止重复点击 */
const prechecking = ref(false);
/** 预检中的集（EpisodeList 渲染解析中加载态，不再静默干等） */
const resolvingEpisodeId = ref<string | null>(null);
/** 已确认解析不到播放地址的集（REV-20）：EpisodeList 渲染禁用态 */
const unavailableIds = ref<string[]>([]);
/** 投屏能力探测结果（AC-84）：null=探测中，false=禁用投屏按钮 */
const castSupported = ref<boolean | null>(null);

async function detectCastSupport(): Promise<void> {
  try {
    castSupported.value = await castService.isSupported();
  } catch {
    castSupported.value = false;
  }
}

function markUnavailable(episodeId: string): void {
  if (unavailableIds.value.includes(episodeId)) return;
  unavailableIds.value = [...unavailableIds.value, episodeId];
}

/**
 * 播放前置预检（AC-33① / REV-20）。
 *
 * 跳转前先解析当前集：解析不到（抛 `E_NO_PLAY_URL` 或返回空 `url`）时
 * 留在详情页就地 Toast「该集暂无可播放地址」，并把该集标记为不可播（禁用态）。
 */
async function ensurePlayable(ep: Episode): Promise<boolean> {
  const it = item.value;
  if (!it || prechecking.value) return false;
  prechecking.value = true;
  resolvingEpisodeId.value = ep.id;
  const startTime = Date.now();
  try {
    const playback = await library.resolvePlay(it.id, ep.id, currentLineId.value);
    // 预检只判断"能否播"，随后播放页会重新解析；本地源在这里产生的 blob URL 立即释放，避免泄漏
    if (playback.isLocal && playback.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(playback.url);
      } catch {
        // 忽略
      }
    }
    if (!playback.url) {
      markUnavailable(ep.id);
      toast.error('该集暂无可播放地址');
      // 批次1：记录线路失败
      const line = currentLine.value;
      if (line) {
        lineHealthService.recordFail(lineKey(it.sourceId, it.sourceItemId, line.name), 'E_NO_PLAY_URL');
      }
      return false;
    }
    // 批次1：记录线路成功
    const line = currentLine.value;
    if (line) {
      lineHealthService.recordSuccess(lineKey(it.sourceId, it.sourceItemId, line.name), Date.now() - startTime);
    }
    return true;
  } catch (e) {
    const err = toErrorShape(e);
    // 批次1：记录线路失败（按错误分类）
    const line = currentLine.value;
    if (line) {
      lineHealthService.recordFail(lineKey(it.sourceId, it.sourceItemId, line.name), err.code);
    }
    if (err.code === 'E_NO_PLAY_URL') {
      // 唯一"前置拦截"场景：该集确实没有地址
      markUnavailable(ep.id);
      toast.error('该集暂无可播放地址');
      return false;
    }
    // P1: 源返回数据不一致（P0-3 触发）→ 提示用户切换源
    if (err.code === 'E_SOURCE_UNAVAILABLE') {
      markUnavailable(ep.id);
      toast.error('当前源数据异常，建议切换其他源');
      return false;
    }
    /*
     * OPT-26（P0-③-2）：源忙不再放行跳转。
     *
     * 旧口径把它归进「其它错误」直接 `return true`，于是这一次点击换来一趟页面跳转 +
     * 播放页再解析一次——撞的还是同一个还压着上一条请求的爬虫实例，等待被翻倍计，
     * 用户看到的是一个刚进来的错误页。留在详情页、按真实闸门给秒数，成本最低：
     * 秒数来自 `retryAfterMs`（探测被这次点击打断时是 0，那时说的是"稍等片刻"而不是"半分钟"）。
     */
    if (err.code === 'E_SOURCE_BUSY') {
      const remainSec = Math.ceil((err.retryAfterMs ?? 0) / 1000);
      toast.info(remainSec > 0 ? `该源正忙，约 ${remainSec} 秒后可重试` : '该源正忙，请稍候再点');
      return false;
    }
    if (err.code === 'E_NETDISK_LOGIN_REQUIRED') {
      // P3-2 + FIX-A：先本地自检，区分「权限缺失」「cookie 文件异常」「真未登录」
      try {
        const hasAccess = await hasAllFilesAccess();
        if (!hasAccess) {
          const ok = await ui.confirm({
            title: '存储权限缺失',
            message: 'App 没有「所有文件访问」权限，网盘 cookie 文件无法被爬虫源读取。是否前往系统设置授权？授权后需重新打开 App。',
            confirmText: '去授权',
            cancelText: '取消',
          });
          if (ok) {
            await router.push('/settings/netdisk');
          }
          return false;
        }
        const cookie = await readCookieFile('quark');
        if (!cookie.exists || !cookie.content) {
          const ok = await ui.confirm({
            title: '网盘未登录',
            message: '播放网盘资源需要先登录网盘账号，是否前往登录？',
            confirmText: '去登录',
            cancelText: '取消',
          });
          if (ok) {
            await router.push('/settings/netdisk');
          }
          return false;
        }
      } catch {
        // 自检失败时回退到通用提示
      }
      const ok = await ui.confirm({
        title: '网盘登录态异常',
        message: 'Cookie 文件存在但爬虫源无法读取，可能是登录态过期或文件损坏。是否前往重新登录？',
        confirmText: '去登录',
        cancelText: '取消',
      });
      if (ok) {
        await router.push('/settings/netdisk');
      }
      return false;
    }
    // 其它错误（网络/源不可用等）保持原行为：跳转后由播放页错误面板给出重试/切换线路
    return true;
  } finally {
    prechecking.value = false;
    resolvingEpisodeId.value = null;
  }
}


/*
 * 自动链路的身份校验。
 *
 * 后台探测（`probeLines` 15s 预算）和自动换源（`findAlternateByTitle`）都是
 * fire-and-forget：结果晚到时，用户可能已经翻到别的影片、甚至退出了详情页。
 * 不复核就写 `lineId`、弹 toast、`router.replace`，会把用户硬拽到一部无关的片子上。
 *
 * 令牌在「换媒体」和「离开页面」时各自增一次，所以 A→B→返回 A 这种
 * 「ID 又变回来了」的晚到结果同样会被判过期。
 */
let detailToken = 0;

function isStaleChain(startToken: number): boolean {
  return startToken !== detailToken;
}

async function load(refresh = false): Promise<void> {
  if (!mediaId.value) return;
  const token = detailToken;
  unavailableIds.value = [];
  await library.loadDetail(mediaId.value, refresh);
  if (isStaleChain(token)) return;
  
  // 批次2-4：消费 ep query 参数（换源时保留集号）
  const epQuery = route.query.ep;
  const epNumber = epQuery ? parseInt(String(epQuery), 10) : null;

  // 批次1：默认线路按评分选择（替代 lines[0]）
  if (!lineId.value && lines.value.length > 0) {
    const it = item.value;
    if (it) {
      // 如果有 ep query，优先找对应集号的线路
      let historyEpId: string | null = progressRecord.value?.episodeId ?? null;
      if (epNumber !== null && !Number.isNaN(epNumber)) {
        const epByNumber = detail.value?.episodes.find((ep) => ep.number === epNumber);
        if (epByNumber) {
          historyEpId = epByNumber.id;
        }
      }

      const best = pickBestLine({
        lines: lines.value,
        historyEpisodeId: historyEpId,
        episodes: detail.value?.episodes ?? [],
        buildKey: (line) => lineKey(it.sourceId, it.sourceItemId, line.name),
      });
      lineId.value = best?.id ?? lines.value[0]!.id;
    } else {
      lineId.value = lines.value[0].id;
    }
  }

  // 回填可播性缓存（真实加载结果）
  if (library.detail) {
    playabilityService.record(mediaId.value, library.detail.episodes.length, library.detail.lines.length);
  }

  // P0-2：详情加载后若 0 集且在线，自动尝试换源（只试一次，防循环）
  if (!refresh && episodes.value.length === 0 && !isOffline.value) {
    const currentId = mediaId.value;
    if (autoSwitchTried.has(currentId)) return;
    autoSwitchTried.add(currentId);
    void autoSwitchToPlayableSource();
  }

  // 批次2：后台探测线路（fire-and-forget，不阻塞 UI）
  if (!refresh && lines.value.length > 0 && !isOffline.value && !manualLineId.value && (settings.settings?.backgroundLineProbeEnabled ?? true)) {
    void backgroundProbeAndSwitch();
  }
}

/** 批次2：后台探测线路并自动切换到最优线路 */
let probeAbort: AbortController | null = null;

/**
 * P0-1：中止后台探测。用户点播放 / 换片 / 离开详情页时调用——
 * 后台探测与点播抢同一个爬虫串行闸门，不掐断就会把用户那一次点成「该源正忙」。
 */
function cancelLineProbe(): void {
  probeAbort?.abort();
  probeAbort = null;
}

async function backgroundProbeAndSwitch(): Promise<void> {
  const it = item.value;
  if (!it || lines.value.length === 0) return;

  const token = detailToken;

  // 选择目标集进行探测（优先历史集，否则第1集）
  const targetEp = targetEpisode.value ?? episodes.value[0];
  if (!targetEp) return;

  // 单飞：新一发起就先掐掉上一轮（换片 / 重复挂载不留并发探测）
  cancelLineProbe();
  const controller = new AbortController();
  probeAbort = controller;

  const result = await probeLines({
    item: it,
    lines: lines.value,
    targetEpisode: targetEp,
    historyEpisodeId: progressRecord.value?.episodeId ?? null,
    signal: controller.signal,
  });

  // 探测结果只服务于「发起时那部片子」：换了媒体/离开页面就作废；被主动中止同样作废
  if (isStaleChain(token) || controller.signal.aborted) {
    if (probeAbort === controller) probeAbort = null;
    return;
  }
  if (probeAbort === controller) probeAbort = null;

  // 探测完成后，如果用户已手动选择线路，不再自动切换
  if (manualLineId.value) return;

  if (result.successLineId && result.successLineId !== lineId.value) {
    // 找到更优线路，自动切换
    const newLine = lines.value.find((l) => l.id === result.successLineId);
    if (newLine) {
      toast.info(`已选到可播线路「${newLine.name}」`);
      lineId.value = newLine.id;
    }
  } else if (result.allFailed) {
    // 所有线路都失败，触发来源兜底（批次3）
    const currentId = mediaId.value;
    if (!autoSwitchTried.has(currentId)) {
      autoSwitchTried.add(currentId);
      void autoSwitchToPlayableSource();
    }
  }
}

/** P0-2：自动换源到可播的其它来源（静默，不弹 Toast 除非成功） */
async function autoSwitchToPlayableSource(): Promise<void> {
  const it = item.value;
  if (!it) return;

  const token = detailToken;

  // 批次3：传入目标集 ID 以便验证候选源的可播性
  const targetEpId = targetEpisode.value?.id ?? episodes.value[0]?.id;
  // 直接走 findAlternateByTitle（内部使用 listSourceCandidates）
  try {
    const alternate = await libraryService.findAlternateByTitle(it.title, it.year, it.sourceId, targetEpId);
    // 候选是按「发起时那部片子」的标题找的：晚到时用户可能已在看别的片子，
    // 此时 replace 会把他踢到一个毫不相关的详情页。
    if (isStaleChain(token)) return;
    if (alternate) {
      toast.success(`已自动切换到「${alternate.sourceName}」`);
      await router.replace({ name: 'detail', params: { mediaId: alternate.mediaId } });
    }
  } catch {
    // 静默失败，用户仍可手动换源
  }
}

/** 批次1：用户手动选择线路 → 设置 manualLineId（会话内不再自动覆盖） */
function onManualLineSelect(newLineId: string): void {
  lineId.value = newLineId;
  manualLineId.value = newLineId;
}

/** 本次详情页会话内已尝试过自动换源的 mediaId（防循环） */
const autoSwitchTried = new Set<string>();

let coverFinishStarted = false;

function finishCover(el: HTMLElement | null): void {
  if (!el || coverFinishStarted || isError.value) return;
  coverFinishStarted = true;
  void finishSharedCover(el);
}

watch(
  posterRef,
  (el) => {
    if (el) void nextTick(() => finishCover(el));
  },
  { flush: 'post' },
);

watch(
  isError,
  (failed) => {
    if (!failed) return;
    coverFinishStarted = true;
    cancelSharedCover();
  },
  { immediate: true },
);

onMounted(() => {
  void detectCastSupport();
  void Promise.all([history.load(), favorites.load(), downloads.load()]).catch((error) => {
    logger.warn('详情页辅助数据加载失败', error);
  });
  void load(false).catch((error) => {
    logger.warn('详情页内容加载失败', error);
  });
  finishCover(posterRef.value);
});

/**
 * E4：返程共享元素 key —— 与列表卡 `card:${sourceId}:${id}` 对齐。
 * 详情→列表时把 hero 封面收回到原卡片当前位置；查不到卡片则原地淡出。
 */
const listCoverKey = computed(() =>
  item.value ? `card:${item.value.sourceId}:${item.value.id}` : null,
);

onBeforeRouteLeave((to) => {
  // 去播放页：去程由 playEpisode 的 beginSharedCover 接管，这里不做返程
  if (to.name === 'player') return;
  // 离开到非播放页：先撤掉尚未接上的去程浮层（用户中途返回），再反向收回卡片
  cancelSharedCover();
  rewindSharedCover(posterRef.value, listCoverKey.value, item.value?.posterUrl ?? null);
});

watch(mediaId, () => {
  // 让上一部片子仍在飞的探测/换源链集体失效（含 A→B→返回 A 的同 ID 复发）
  detailToken += 1;
  // P0-1：换片同样掐掉上一轮的后台探测（令牌只作废结果，掐不断在途解析）
  cancelLineProbe();
  lineId.value = null;
  manualLineId.value = null;
  descExpanded.value = false;
  preloadHintDismissed.value = false;
  unavailableIds.value = [];
  autoSwitchTried.clear();
  void load(false);
});

onBeforeUnmount(() => {
  detailToken += 1;
  // P0-1：离开详情页（含去播放页）先掐掉后台探测
  cancelLineProbe();
  stopFavSpring?.();
  stopFavSpring = null;
});

// P1: 切换线路时重置不可用集列表，避免旧线路的失败状态污染新线路
watch(lineId, () => {
  unavailableIds.value = [];
});

/** OPT-15: WiFi 环境 + 未预加载 + 未关闭提示 → 显示预加载提示条 */
watch(
  [() => item.value, isWifi, canPreload],
  ([media, wifi, can]) => {
    if (media && wifi && can && !preloadHintDismissed.value) {
      // 检查是否已有下载任务（已预加载则不提示）
      const hasDownload = downloads.tasks.some(
        (t) => t.mediaId === media.id && (t.status === 'downloading' || t.status === 'completed' || t.status === 'queued'),
      );
      showPreloadHint.value = !hasDownload;
    } else {
      showPreloadHint.value = false;
    }
  },
);

/** OPT-15: 执行预加载（首集） */
async function onPreload(): Promise<void> {
  const it = item.value;
  if (!it || preloading.value) return;
  const ep = targetEpisode.value ?? episodes.value[0];
  if (!ep) {
    toast.error('暂无可预加载的剧集');
    return;
  }
  preloading.value = true;
  try {
    const result = await preloadItem(it.id, ep.id);
    showPreloadHint.value = false;
    if (result.ok) {
      toast.success(result.message);
    } else {
      toast.error(result.message);
    }
  } finally {
    preloading.value = false;
  }
}

/** OPT-15: 关闭预加载提示 */
function dismissPreloadHint(): void {
  showPreloadHint.value = false;
  preloadHintDismissed.value = true;
}

function goBack(): void {
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/');
}

/** CHG-28：源侧故障码时给「去源管理」行动入口（v1.8 只动作化了播放面板，详情错误态补齐） */
const SOURCE_FAULT_CODES = new Set([
  'E_SOURCE_DISABLED',
  'E_SOURCE_UNAVAILABLE',
  'E_AUTH',
  'E_HTTP_401',
  'E_HTTP_403',
  'E_HTTP_404',
  'E_HTTP_5XX',
  'E_PARSE',
]);

function isSourceFault(): boolean {
  const code = library.error?.code;
  return code !== undefined && code !== null && SOURCE_FAULT_CODES.has(code);
}

function openSourceManage(): void {
  void router.push({ name: 'settings', query: { sources: '1' } });
}

/** 来源切换弹层状态 */
const sourceSheetOpen = ref(false);
const sourceCandidates = ref<import('@/components/media/sourceCandidates').SourceCandidate[]>([]);
const sourceSheetLoading = ref(false);
const sourceSearching = ref(false);
const sheetCurrentItem = ref<MediaItem | null>(null);

async function openSourceSheet(autoSearch = false): Promise<void> {
  // 解析当前条目（错误态下 detail 为空，从缓存取）
  const currentItem = item.value ?? (await libraryService.getItem(mediaId.value));
  if (!currentItem) {
    toast.error('无法获取当前条目信息');
    return;
  }
  sheetCurrentItem.value = currentItem;
  sourceSheetOpen.value = true;
  sourceSheetLoading.value = true;

  try {
    // 确保源列表已加载
    if (sources.sources.length === 0) {
      await sources.load();
    }

    // 从缓存获取候选
    const candidates = await libraryService.listSourceCandidates(
      { title: currentItem.title, year: currentItem.year },
      { scope: 'cache', excludeMediaId: currentItem.id },
    );

    // 合并当前条目（固定第一行）
    const allItems = [currentItem, ...candidates.filter((c) => c.id !== currentItem.id)];
    sourceCandidates.value = buildSourceCandidates(allItems, {
      currentMediaId: currentItem.id,
      currentItem,
      sources: sources.sources,
      playabilityOf: (mediaId) => playabilityService.statusOf(mediaId),
      latencyOf: (sourceId) => sources.latencyOf(sourceId),
    });

    // 自动搜索条件：autoSearch 或候选数 ≤ 1 且在线
    const shouldAutoSearch = autoSearch || (sourceCandidates.value.length <= 1 && !isOffline.value);
    if (shouldAutoSearch) {
      await searchMoreSources();
    }
  } catch (e) {
    logger.warn('加载候选来源失败', e);
  } finally {
    sourceSheetLoading.value = false;
  }
}

async function searchMoreSources(): Promise<void> {
  if (sourceSearching.value || isOffline.value || !sheetCurrentItem.value) return;
  sourceSearching.value = true;
  try {
    const candidates = await libraryService.listSourceCandidates(
      { title: sheetCurrentItem.value.title, year: sheetCurrentItem.value.year },
      { scope: 'network', excludeMediaId: sheetCurrentItem.value.id },
    );

    // 合并当前条目
    const allItems = [sheetCurrentItem.value, ...candidates.filter((c) => c.id !== sheetCurrentItem.value!.id)];
    sourceCandidates.value = buildSourceCandidates(allItems, {
      currentMediaId: sheetCurrentItem.value.id,
      currentItem: sheetCurrentItem.value,
      sources: sources.sources,
      playabilityOf: (mediaId) => playabilityService.statusOf(mediaId),
      latencyOf: (sourceId) => sources.latencyOf(sourceId),
    });
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    sourceSearching.value = false;
  }
}

async function selectSource(candidate: import('@/components/media/sourceCandidates').SourceCandidate): Promise<void> {
  sourceSheetOpen.value = false;
  if (candidate.mediaId === mediaId.value) return;

  // 保留当前集号（可选增强）
  const epNumber = targetEpisode.value?.number ?? null;
  await router.replace({
    name: 'detail',
    params: { mediaId: candidate.mediaId },
    query: {
      sourceId: candidate.sourceId,
      ...(epNumber ? { ep: String(epNumber) } : {}),
    },
  });
}

async function playEpisode(ep: Episode | null, restart = false): Promise<void> {
  const it = item.value;
  if (!it || !ep) return;
  // P0-1：用户已决定点播——先掐掉后台探测，别让它和这一次解析抢爬虫闸门
  cancelLineProbe();
  if (isOffline.value && !downloadedIds.value.includes(ep.id)) {
    toast.error('离线不可播放，该集尚未下载');
    return;
  }
  // AC-33① / REV-20：解析不到可播放地址时不跳转，就地 Toast
  if (!(await ensurePlayable(ep))) return;
  beginSharedCover(posterRef.value);
  void router.push({
    name: 'player',
    params: { mediaId: it.id, episodeId: ep.id },
    query: {
      ...(currentLineId.value ? { lineId: currentLineId.value } : {}),
      ...(restart ? { restart: '1' } : {}),
    },
  });
}

/** 播放页面跳转进行中（AC-92）：避免用户误触多次 */
const playingNavigate = ref(false);

/** AC-92：剧集列表在跳转期间的重复点击 → 统一提示（由父级收敛文案） */
function onPlayingBlocked(): void {
  toast.info('正在打开播放页，请稍候');
}

async function onPrimary(): Promise<void> {
  const rec = progressRecord.value;
  const restart = isFinished.value;
  const ep = targetEpisode.value;
  if (!ep) {
    toast.error('暂无可播放剧集');
    return;
  }
  // AC-92：防止重复点击，显示加载状态
  if (playingNavigate.value) {
    toast.info('正在打开播放页，请稍候');
    return;
  }
  // AC-68：记录集号已下线时先给出明确提示，再从第 1 集开始，不静默跳集
  const offline = offlineEpisodeNumber.value;
  if (offline !== null) {
    toast.info(offlineEpisodeMessage(offline), 3600);
    playingNavigate.value = true;
    try {
      await playEpisode(ep, restart);
    } finally {
      playingNavigate.value = false;
    }
    return;
  }
  if (!isSeries.value && rec && !restart) {
    playingNavigate.value = true;
    try {
      await playEpisode(ep, false);
    } finally {
      playingNavigate.value = false;
    }
    return;
  }
  playingNavigate.value = true;
  try {
    await playEpisode(ep, restart);
  } finally {
    playingNavigate.value = false;
  }
}

async function onEpisodeSelect(ep: Episode): Promise<void> {
  await playEpisode(ep, false);
}

async function toggleFavorite(): Promise<void> {
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
    if (added) {
      countDir.value = 'up';
      haptic('light');
      playFavoriteSpring();
      if (!prefersReducedMotion() && favBtnRef.value) spawnPopcorn(favBtnRef.value);
    } else {
      countDir.value = 'down';
    }
    toast.success(added ? '已收藏' : '已取消收藏');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    favoritePending.value = false;
  }
}

function onDownload(): void {
  if (!item.value) return;
  if (episodes.value.length === 0) {
    toast.error('暂无可下载的剧集');
    return;
  }
  if (needsEpisodePicker.value) {
    pickerOpen.value = true;
    return;
  }
  // 单集电影：直接创建任务，不打断用户
  void downloadEpisodes(episodes.value.slice(0, 1).map((e) => e.id));
}

async function downloadEpisodes(episodeIds: string[]): Promise<void> {
  const it = item.value;
  if (!it || episodeIds.length === 0) return;
  downloading.value = true;
  try {
    // CreateDownloadInput 统一由 libraryStore.toDownloadInputs 生成（sourceId/mediaId/episodeId/url/format/title…）
    const inputs = await library.toDownloadInputs(it.id, episodeIds, currentLineId.value);
    if (inputs.length === 0) {
      toast.error('所选剧集暂无可用的播放地址');
      return;
    }
    // REV-15 / FR-30：重复下载必须提示，不能静默忽略（AC-70 的 skipped 分支）
    // P3-3：上面那条只认字面 `mediaId+episodeId`——换一条线路（不同源、不同 id）就判不出重复，
    // 真机上同一集能攒下好几份；判定与文案都在闸门里，播放页走的是同一个入口。
    if (!(await guards.confirmCrossLineDuplicates(inputs, downloads.tasks))) return;
    // REV-07 / AC-76：先做 HEAD 体积预检，Web 端 >1GB 在下单前提示改用 App；确认后仍可继续
    const largeFileHint = await downloads.checkLargeFile(inputs);
    if (largeFileHint !== null) {
      const goOn = await ui.confirm({
        title: '文件较大',
        message: largeFileHint,
        confirmText: '仍要下载',
      });
      if (!goOn) return;
    }
    const { created, skipped } = await downloads.createMany(inputs);
    pickerOpen.value = false;
    if (created.length === 0 && skipped.length > 0) {
      toast.info(skipped.length === 1 ? '该集已在下载列表中' : `所选 ${skipped.length} 集已在下载列表中`);
      return;
    }
    if (created.length > 0 && skipped.length > 0) {
      toast.action(
        `已加入 ${created.length} 集，${skipped.length} 集已在下载列表中`,
        { label: '查看下载', onClick: () => router.push('/downloads') },
        'success',
      );
      return;
    }
    if (created.length === 0) {
      toast.info('已在下载列表中');
      return;
    }
    toast.action(
      `已加入下载队列（${created.length} 集）`,
      { label: '查看下载', onClick: () => router.push('/downloads') },
      'success',
    );
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    downloading.value = false;
  }
}

async function castPlay(): Promise<void> {
  // 投屏入口：首版仅系统分享（API-11）；能力不支持时给出降级提示（AC-82）
  try {
    const supported = await castService.isSupported();
    if (!supported) {
      toast.info('当前平台不支持投屏，请在 Android App 内使用');
      return;
    }
    const it = item.value;
    const ep = targetEpisode.value;
    if (!it || !ep) {
      toast.info('暂无可投屏的内容');
      return;
    }
    const playback = await library.resolvePlay(it.id, ep.id, currentLineId.value);
    const result = await castService.cast({
      kind: 'url',
      url: playback.url,
      mime: playback.format === 'hls' ? 'application/x-mpegURL' : 'video/*',
      title: it.title,
      linkedUrl: playback.url,
    });
    if (!result.started) {
      toast.info(result.reason === 'canceled' ? '已取消投屏' : '未找到可用的投屏目标');
    }
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function copyTitle(): Promise<void> {
  const it = item.value;
  if (!it) return;
  moreOpen.value = false;
  try {
    await navigator.clipboard?.writeText(it.title);
    toast.success('已复制标题');
  } catch {
    toast.error('复制失败，请长按标题手动复制');
  }
}

/**
 * 删除本地缓存（REV-13）：真实删除该媒体的 `media` 行与 `lines`/`episodes`。
 * 收藏、历史与已下载文件不受影响；删除后返回媒体库（条目会按需回源重新拉取）。
 */
async function clearCache(): Promise<void> {
  const it = item.value;
  moreOpen.value = false;
  if (!it) return;
  const ok = await ui.confirm({
    title: '删除本地缓存？',
    message: '将删除该条目的详情、线路与剧集缓存，收藏、历史与已下载内容不受影响。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const result = await cache.removeMediaCache(it.id);
    if (result.total === 0) {
      toast.info('该条目没有本地缓存');
      return;
    }
    const freed = result.freedBytes !== null ? `，释放约 ${formatBytes(result.freedBytes)}` : '';
    toast.success(`已删除 ${result.total} 条缓存${freed}`);
    void router.replace('/library');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

function openCompliance(): void {
  void router.push('/legal/compliance');
}
</script>

<template>
  <main ref="rootRef" class="detail" data-route="detail">
    <!-- 顶部背景 -->
    <div class="detail__backdrop" aria-hidden="true">
      <img
        v-if="backdropSrc"
        class="detail__backdrop-img"
        :src="backdropSrc"
        alt=""
        loading="lazy"
        decoding="async"
      />
      <div class="detail__backdrop-fade" />
    </div>

    <header class="detail__nav">
      <button class="detail__nav-btn" type="button" aria-label="返回" @click="goBack">
        <IconBack :size="24" />
      </button>
      <!-- C-10：大标题滚过头部后收进顶栏，横坐标由 --dn-nav-x 对齐到大标题 -->
      <p class="detail__nav-title" data-narrative-nav-title aria-hidden="true">
        {{ item?.title ?? '' }}
      </p>
      <span class="detail__nav-spacer" aria-hidden="true" />
      <button
        class="detail__nav-btn"
        type="button"
        aria-label="更多操作"
        @click="moreOpen = true"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5.5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18.5" cy="12" r="1.7" />
        </svg>
      </button>
    </header>

    <OfflineBanner v-if="isOffline" />

    <div ref="scrollEl" class="detail__scroll">
      <section v-if="item && !isError" ref="heroEl" class="detail-hero">
        <div ref="posterRef" class="detail-hero__poster">
          <PosterImage
            :src="item.posterUrl"
            :alt="item.title"
            :fallback-title="item.title"
            :cover-key="item.id"
            :width-px="IMG_W_POSTER"
          />
        </div>
        <div class="detail-hero__meta">
          <h1 class="detail-hero__title" data-narrative-title>{{ item.title }}</h1>
          <p v-if="item.originalTitle" class="detail-hero__original">{{ item.originalTitle }}</p>
          <MediaMeta :item="item" />
          <p v-if="progressRecord" class="detail-hero__progress">
            看到 {{ formatClock(progressRecord.positionSec) }}
            <span aria-hidden="true"> · </span>
            {{ Math.round(progressRecord.progress * 100) }}%
            <template v-if="isFinished"> · 已看完</template>
          </p>
        </div>
      </section>

      <!-- loading -->
      <template v-if="loading">
        <div v-if="!item" class="detail-skeleton">
          <div class="skeleton detail-skeleton__poster" />
          <div class="detail-skeleton__meta">
            <div class="skeleton detail-skeleton__title" />
            <div class="skeleton detail-skeleton__line" />
            <div class="skeleton detail-skeleton__line detail-skeleton__line--short" />
          </div>
        </div>
        <div class="detail-skeleton__body">
          <div class="skeleton detail-skeleton__line" />
          <div class="skeleton detail-skeleton__line" />
          <div class="skeleton detail-skeleton__line detail-skeleton__line--short" />
        </div>
        <div class="detail-loading-hint" role="status">
          <LoadingSpinner :size="20" />
          <span>正在读取详情…</span>
        </div>
      </template>

      <!-- error -->
      <ErrorState
        v-else-if="isError"
        :error="library.error"
        back-text="返回"
        @retry="load(true)"
        @back="goBack"
      >
        <template #extra>
          <button
            v-if="isSourceFault() && !isOffline"
            class="btn btn--primary btn--md"
            type="button"
            :disabled="sourceSearching"
            @click="openSourceSheet(true)"
          >
            {{ sourceSearching ? '查找中…' : '切换来源' }}
          </button>
          <button v-if="isSourceFault()" class="btn btn--ghost btn--md" type="button" @click="openSourceManage">
            去源管理
          </button>
        </template>
      </ErrorState>

      <!-- success -->
      <template v-else-if="item">
        <section data-narrative class="detail-section">
          <h2 class="section-title">简介</h2>
          <p
            class="detail-desc prose"
            :class="{ 'detail-desc--clamped': !descExpanded }"
          >
            {{ item.description || '暂无简介。' }}
          </p>
          <button
            v-if="item.description && item.description.length > 80"
            class="detail-desc__toggle"
            type="button"
            @click="descExpanded = !descExpanded"
          >
            {{ descExpanded ? '收起' : '展开' }}
          </button>
        </section>

        <section data-narrative class="detail-section">
          <div class="detail-section__head">
            <h2 class="section-title">
              选集
              <span v-if="hasEpisodes" class="detail-section__count">共 {{ episodes.length }} 集</span>
            </h2>
            <LineSelector
              v-if="lines.length > 1"
              :lines="lines"
              :model-value="currentLineId"
              :line-statuses="lineStatuses"
              :line-latencies="lineLatencies"
              :recommended-line-id="recommendedLineId"
              @update:model-value="onManualLineSelect"
            />
          </div>

          <!-- 常驻来源切换入口（右侧是选集排布开关，只在能出胶片时出现） -->
          <div class="detail-source-row row row--between">
            <button class="detail-source-btn" type="button" @click="openSourceSheet(false)">
              <span class="detail-source-btn__name">
                来源：{{ currentSourceName }}
              </span>
              <span v-if="knownSourceCount > 1" class="detail-source-btn__count">
                {{ knownSourceCount }} 个
              </span>
              <span v-else class="detail-source-btn__hint">切换</span>
              <IconChevron :size="14" />
            </button>
            <button
              v-if="filmEligible"
              class="film-switch"
              type="button"
              :aria-pressed="filmMode"
              @click="toggleFilmMode"
            >
              {{ filmMode ? '数字' : '胶片墙' }}
            </button>
          </div>

          <template v-if="hasEpisodes">
            <p v-if="currentLine?.quality" class="detail-section__quality">
              线路：{{ currentLine.name }} · {{ currentLine.quality }}
            </p>

            <EpisodeList
              :episodes="episodes"
              :current-id="progressRecord?.episodeId ?? null"
              :watched-numbers="watchedNumbers"
              :downloaded-ids="downloadedIds"
              :unavailable-ids="unavailableIds"
              :playing-navigate="prechecking || playingNavigate"
              :resolving-id="resolvingEpisodeId"
              :film="filmMode && filmEligible"
              :film-frames="filmFrames"
              :film-waiting="filmWaiting"
              @select="onEpisodeSelect"
              @unavailable="toast.error('该集暂无可播放地址')"
              @playing="onPlayingBlocked"
            />
          </template>

          <!-- 源侧没有返回可播放线路（网盘/盘搜源常见）：给出换源出口，而不是留一个空壳 -->
          <div v-else class="detail-empty" role="status">
            <p class="detail-empty__title">当前来源暂无可播放线路</p>
            <p class="detail-empty__desc">换一个来源通常会找到可播的剧集。</p>
            <div class="detail-empty__actions">
              <button
                class="btn btn--primary btn--md"
                type="button"
                :disabled="sourceSearching"
                @click="openSourceSheet(true)"
              >
                {{ sourceSearching ? '查找中…' : '切换来源' }}
              </button>
              <button class="btn btn--ghost btn--md" type="button" @click="openSourceManage">
                去源管理
              </button>
            </div>
          </div>
        </section>

        <section data-narrative class="detail-section">
          <div class="compliance-note">
            本 App 不提供任何影视片源。你添加的源与播放内容由你自行负责，仅可用于播放你拥有版权或已获授权的内容。
            <button class="detail-compliance-link" type="button" @click="openCompliance">查看声明</button>
          </div>
        </section>
      </template>
    </div>

    <!-- OPT-15: WiFi 预加载提示条 -->
    <Transition name="preload-hint">
      <div v-if="showPreloadHint && item && !loading && !isError" class="detail-preload-hint" role="status">
        <span class="detail-preload-hint__text">当前为 WiFi 环境，是否预加载到本地？</span>
        <button
          class="detail-preload-hint__action btn btn--primary btn--sm"
          type="button"
          :disabled="preloading"
          aria-label="预加载当前内容到本地"
          @click="onPreload"
        >
          {{ preloading ? '预加载中…' : '预加载' }}
        </button>
        <button
          class="detail-preload-hint__close"
          type="button"
          aria-label="关闭预加载提示"
          @click="dismissPreloadHint"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" width="16" height="16">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
    </Transition>

    <!-- OPT-08：固定底部操作栏 -->
    <section v-if="item && !loading && !isError" class="detail-actions-bar">
      <div class="detail-actions-bar__inner">
        <button
          class="btn btn--primary btn--lg detail-actions__main"
          type="button"
          :disabled="!hasEpisodes"
          :aria-busy="prechecking || playingNavigate ? 'true' : undefined"
          @click="onPrimary"
        >
          <IconPlay :size="20" />
          {{ playingNavigate ? '正在打开播放页…' : primaryLabel }}
        </button>
        <button
          ref="favBtnRef"
          class="detail-actions__icon detail-actions__fav"
          :class="{ 'detail-actions__icon--on': isFavorite }"
          type="button"
          :disabled="favoritePending"
          :aria-label="isFavorite ? '取消收藏' : '收藏'"
          :aria-pressed="isFavorite"
          @click="toggleFavorite"
        >
          <IconHeart :size="22" :filled="isFavorite" />
          <span class="pm-count" :class="`pm-count--${countDir}`" aria-hidden="true">
            <span :key="favCount" class="pm-count__val">{{ favCount }}</span>
          </span>
        </button>
        <button
          class="detail-actions__icon"
          type="button"
          :aria-label="needsEpisodePicker ? '选择集数下载' : '下载'"
          :disabled="downloading || !hasEpisodes"
          @click="onDownload"
        >
          <IconDownload :size="20" />
        </button>
        <button
          class="detail-actions__icon"
          :class="{ 'detail-actions__icon--disabled': castSupported === false || !hasEpisodes }"
          type="button"
          :aria-label="castSupported === false ? '投屏（当前平台不支持投屏）' : '投屏'"
          :aria-disabled="castSupported === false || !hasEpisodes ? 'true' : undefined"
          :disabled="castSupported === false || !hasEpisodes"
          :title="castSupported === false ? '当前平台不支持投屏' : undefined"
          @click="castPlay"
        >
          <IconCast :size="20" />
        </button>
      </div>
    </section>

    <!-- 更多操作 -->
    <BottomSheet v-model="moreOpen" :title="item?.title ?? '操作'">
      <ul class="sheet-list">
        <li><button class="sheet-list__item" type="button" @click="copyTitle">复制标题</button></li>
        <li><button class="sheet-list__item" type="button" @click="moreOpen = false">在源中查看</button></li>
        <li><button class="sheet-list__item sheet-list__item--danger" type="button" @click="clearCache">删除本地缓存</button></li>
      </ul>
    </BottomSheet>

    <!-- 来源切换弹层 -->
    <SourceSwitchSheet
      v-model="sourceSheetOpen"
      :title="`切换来源 · ${sheetCurrentItem?.title ?? ''}`"
      :candidates="sourceCandidates"
      :loading="sourceSheetLoading"
      :searching="sourceSearching"
      :can-search-more="!isOffline"
      @select="selectSource"
      @search-more="searchMoreSources"
    />

    <!-- 集数下载选择 -->
    <EpisodePickerSheet
      v-model="pickerOpen"
      :episodes="episodes"
      :downloaded-ids="downloadedIds"
      :loading="downloading"
      :title="`下载 · ${item?.title ?? ''}`"
      @confirm="downloadEpisodes"
    />
  </main>
</template>

<style scoped>
.detail {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.detail__backdrop {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 300px;
  overflow: hidden;
  pointer-events: none;
  /* 背景必须留在内容下方：`.detail__scroll` 提升到 z-index 1，
     否则绝对定位的背景（含不透明的 gradient-hero 下缘）会盖住静态定位的操作按钮，
     表现为「详情页找不到下载/收藏/投屏按钮」（BUG-04 根因）。 */
  z-index: 0;
  transform: translate3d(0, var(--dn-shift, 0px), 0);
}

.detail__backdrop-img {
  /* 上下各留出 120px 余量：视差把整张图往下推时顶部不能露白 */
  position: absolute;
  top: -120px;
  left: 0;
  right: 0;
  height: calc(100% + 120px);
  object-fit: cover;
  transform: scale(calc(1.08 + var(--dn-p, 0) * 0.06));
  filter: blur(14px) brightness(0.5) saturate(1.15);
  /* 模糊按 5 档离散切换（见 data-blur 规则），这条过渡负责把台阶抹平成"渐渐虚掉" */
  transition: filter var(--duration-slow) var(--ease-standard);
  animation: backdrop-focus 500ms var(--ease-decelerate) both;
}

.detail[data-blur='1'] .detail__backdrop-img {
  filter: blur(17px) brightness(0.46) saturate(1.15);
}

.detail[data-blur='2'] .detail__backdrop-img {
  filter: blur(20px) brightness(0.42) saturate(1.15);
}

.detail[data-blur='3'] .detail__backdrop-img {
  filter: blur(23px) brightness(0.38) saturate(1.15);
}

.detail[data-blur='4'] .detail__backdrop-img {
  filter: blur(26px) brightness(0.34) saturate(1.15);
}

/* 入场只淡入：transform / filter 归滚动驱动管，动画再抢同一属性就会跳 */
@keyframes backdrop-focus {
  from {
    opacity: 0.35;
  }
  to {
    opacity: 1;
  }
}

/* will-change 只在滚动进行中挂上，停下来立刻还给主线程 */
.detail[data-narrative-live] .detail__backdrop {
  will-change: transform;
}

.detail[data-narrative-live] .detail__backdrop-img {
  will-change: transform, filter;
}

.detail__backdrop-fade {
  position: absolute;
  inset: 0;
  background: var(--gradient-hero);
}

.detail__nav {
  position: sticky;
  top: 0;
  z-index: var(--z-header);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: calc(var(--layout-header-height) + var(--safe-top));
  padding: var(--safe-top) var(--space-2) 0;
}

/* 玻璃底随标题一起浮现，否则滚到叙事段时顶栏还是全透的 */
.detail__nav::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background-color: var(--color-bg-base);
  opacity: calc(var(--dn-nav, 0) * 0.86);
  -webkit-backdrop-filter: blur(14px);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid var(--color-divider);
  pointer-events: none;
}

.detail__nav-btn {
  flex: 0 0 auto;
}

.detail__nav-title {
  flex: 0 1 auto;
  min-width: 0;
  /* 与大标题同一根竖线落位（--dn-nav-x 由滚动叙事量出来），收进去时不横跳 */
  margin-left: var(--dn-nav-x, 0px);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font: var(--font-weight-bold) 21px / 1.25 var(--font-family-base);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--dn-accent, var(--color-text-primary));
  opacity: var(--dn-nav, 0);
  transform: translateY(calc((1 - var(--dn-nav, 0)) * -6px));
  transition: color var(--duration-slow) var(--ease-standard);
  pointer-events: none;
}

.detail__nav-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.detail__nav-btn {
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: #ffffff;
  background-color: rgba(0, 0, 0, 0.34);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.detail__nav-btn svg {
  width: 20px;
  height: 20px;
}

.detail__scroll {
  position: relative;
  z-index: 1;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom) + 80px);
}

.detail-hero {
  display: flex;
  gap: var(--space-4);
  padding-top: var(--space-2);
  /* 标题收进顶栏：整块轻微上浮 + 缩小 + 淡出，与顶栏标题互补（不闪双标题） */
  opacity: var(--dn-hero, 1);
  transform: translate3d(0, calc(var(--dn-p, 0) * -18px), 0)
    scale(calc(1 - var(--dn-p, 0) * 0.05));
}

.detail[data-narrative-live] .detail-hero {
  will-change: transform, opacity;
}

.detail-hero__poster {
  flex: 0 0 auto;
  width: 96px;
  border-radius: var(--radius-md);
  overflow: hidden;
  box-shadow: var(--shadow-3);
}

.detail-hero__meta {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  flex: 1 1 auto;
  min-width: 0;
  padding-top: var(--space-1);
  animation: hero-rise 350ms var(--ease-decelerate) 120ms both;
}

@keyframes hero-rise {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.detail-hero__title {
  font: var(--font-weight-bold) 21px / 1.25 var(--font-family-base);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
  overflow-wrap: anywhere;
}

.detail-hero__original {
  font: var(--font-weight-regular) 11.5px / 1.4 var(--font-family-base);
  color: var(--color-text-secondary);
}

.detail-hero__progress {
  font: var(--font-weight-medium) 11.5px / 1.4 var(--font-family-number);
  color: var(--color-brand-text);
}

/* OPT-08：固定底部操作栏 */
.detail-actions-bar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: var(--z-header);
  padding: var(--space-3) var(--layout-page-padding-x) calc(var(--space-3) + var(--safe-bottom));
  background: linear-gradient(180deg, transparent 0%, var(--color-bg-base) 24%);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}

.detail-actions-bar__inner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.detail-actions__main {
  flex: 1 1 auto;
  width: auto;
}

.detail-actions__main[aria-busy="true"] {
  opacity: 0.75;
  cursor: wait;
  pointer-events: none;
}

.detail-actions__icon {
  flex: 0 0 auto;
  width: 48px;
  height: 48px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-card);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  color: var(--color-text-primary);
  transition: var(--transition-color), transform var(--duration-fast) var(--ease-standard);
}

.detail-actions__icon--on {
  color: var(--color-brand-text);
  border-color: var(--color-brand);
  background-color: var(--color-brand-soft);
}

/* 投屏不可用（AC-84）：设计规范禁用色，不做点击降级 Toast */
.detail-actions__icon:disabled,
.detail-actions__icon--disabled {
  color: var(--color-text-disabled);
  border-color: var(--color-border);
  background-color: transparent;
  cursor: not-allowed;
  pointer-events: none;
}

/* M1 爆米花追剧：弹簧由 JS 驱动 inline transform；粒子层与计数徽章 */
.detail-actions__fav {
  position: relative;
}

.fav-burst {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

.fav-burst__p {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: var(--color-brand-strong);
  animation: fav-pop 600ms var(--ease-decelerate) forwards;
}

.fav-burst__p--cream {
  background: #fff6e8;
}

@keyframes fav-pop {
  0% {
    transform: translate(0, 0) rotate(0deg);
    opacity: 1;
  }
  100% {
    transform: translate(var(--dx), var(--dy)) rotate(var(--rot));
    opacity: 0;
  }
}

.pm-count {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-brand-ink);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  overflow: hidden;
  pointer-events: none;
}

.pm-count__val {
  display: block;
}

.pm-count--up .pm-count__val {
  animation: count-up 240ms var(--ease-standard);
}

.pm-count--down .pm-count__val {
  animation: count-down 240ms var(--ease-standard);
}

@keyframes count-up {
  from {
    transform: translateY(100%);
  }
  to {
    transform: translateY(0);
  }
}

@keyframes count-down {
  from {
    transform: translateY(-100%);
  }
  to {
    transform: translateY(0);
  }
}

.detail-section {
  margin-top: var(--space-6);
}

/* 分段主色：当前段落标题随滚动换色。300ms 过渡是硬要求——
   没有它，滚过段落边界的那一帧会整排标题"啪"地跳色。 */
.detail-section .section-title {
  transition: color var(--duration-slow) var(--ease-standard);
}

.detail-section[data-narrative-active] .section-title {
  color: var(--dn-accent, var(--color-text-primary));
}

.detail-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.detail-section__count {
  margin-left: var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.detail-section__quality {
  margin-bottom: var(--space-2);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.detail-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-4);
  border-radius: var(--radius-lg);
  border: 1px dashed var(--color-border-strong);
  background-color: var(--color-bg-elevated);
  text-align: center;
}

.detail-empty__title {
  font: var(--text-body-strong);
  color: var(--color-text-primary);
}

.detail-empty__desc {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.detail-empty__actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

.detail-desc {
  margin-top: var(--space-2);
  color: var(--color-text-secondary);
}

.detail-desc--clamped {
  position: relative;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  /* OPT-08：底部渐隐遮罩，提示可展开 */
  mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 100%);
  -webkit-mask-image: linear-gradient(180deg, #000 0%, #000 60%, transparent 100%);
}

.detail-desc__toggle {
  position: relative;
  margin-top: var(--space-2);
  min-height: 32px;
  font: var(--text-label);
  color: var(--color-brand-text);
}

/* 视觉 32，命中区补到 44（规范 §12.1） */
.detail-desc__toggle::after {
  content: '';
  position: absolute;
  inset: -6px 0;
}

.detail-compliance-link {
  margin-left: var(--space-1);
  flex: 0 0 auto;
  white-space: nowrap;
  color: var(--color-brand-text);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.detail-skeleton {
  display: flex;
  gap: var(--space-4);
  padding-top: var(--space-2);
}

.detail-skeleton__poster {
  flex: 0 0 auto;
  width: 116px;
  height: 174px;
  border-radius: var(--radius-card);
}

.detail-skeleton__meta {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
}

.detail-skeleton__title {
  height: var(--line-height-24);
  width: 80%;
}

.detail-skeleton__line {
  height: var(--line-height-12);
  width: 100%;
}

.detail-skeleton__line--short {
  width: 55%;
}

.detail-skeleton__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-6);
}

.detail-loading-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-5);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
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

.sheet-list__item--danger {
  color: var(--color-danger);
}

/* OPT-15 / REV-14: WiFi 预加载提示条 — fixed 定位悬浮于操作栏上方 */
.detail-preload-hint {
  position: fixed;
  bottom: calc(80px + var(--safe-bottom));
  left: var(--layout-page-padding-x);
  right: var(--layout-page-padding-x);
  z-index: calc(var(--z-header) + 1);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background-color: var(--color-info-soft);
  border: 1px solid var(--color-info);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.detail-preload-hint__text {
  flex: 1 1 auto;
  min-width: 0;
  font: var(--text-caption);
  color: var(--color-text-primary);
}

.detail-preload-hint__action {
  flex: 0 0 auto;
}

.detail-preload-hint__close {
  position: relative;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-tertiary);
  transition: color 0.15s ease;
}

/* 视觉 28，命中区补到 44×44 */
.detail-preload-hint__close::after {
  content: '';
  position: absolute;
  inset: -8px;
}

.detail-preload-hint__close:active {
  color: var(--color-text-primary);
}

/* 预加载提示条进出动画 */
.preload-hint-enter-active,
.preload-hint-leave-active {
  transition: opacity 0.2s var(--ease-standard), transform 0.2s var(--ease-standard);
}

.preload-hint-enter-from,
.preload-hint-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

/* 来源切换入口 */
.detail-source-row {
  margin-top: var(--space-3);
  margin-bottom: var(--space-2);
}

/* 胶片墙开关（G-B07）：小药丸，靠右，不与来源按钮抢宽度 */
.film-switch {
  position: relative;
  flex: 0 0 auto;
  margin-left: auto;
  min-height: 34px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  border: 1px solid var(--color-border-subtle);
  background-color: transparent;
  color: var(--color-text-secondary);
  font: var(--text-label);
  cursor: pointer;
  transition: var(--transition-color);
}

/* 视觉 34，命中区补到 44（规范 §12.1） */
.film-switch::after {
  content: '';
  position: absolute;
  inset: -5px;
}

.film-switch:active {
  background-color: var(--color-bg-pressed);
}

.film-switch[aria-pressed='true'] {
  color: var(--color-brand);
  border-color: var(--color-brand);
}

.detail-source-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background-color: var(--color-bg-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font: var(--text-label);
  cursor: pointer;
  transition: background-color var(--duration-fast);
}

.detail-source-btn:active {
  background-color: var(--color-bg-pressed);
}

.detail-source-btn__name {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-source-btn__count {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background-color: var(--color-brand-soft);
  color: var(--color-brand-text);
  font: var(--font-weight-semibold) 10px / 1.2 var(--font-family-base);
}

.detail-source-btn__hint {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font: var(--text-caption);
}

@media (prefers-reduced-motion: reduce) {
  .detail__backdrop-img,
  .detail-hero__meta {
    animation: none;
  }
  .fav-burst {
    display: none;
  }
  .pm-count__val {
    animation: none;
  }
}
</style>
