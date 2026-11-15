<script setup lang="ts">
/**
 * 设置（我的）页（页面蓝图 §10）
 *
 * 数据概览 → 内容入口 → 播放偏好 → 外观 → 数据 → 关于。
 * 所有改动立即写设置并持久化；失败回滚 UI + Toast。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import type { GestureSettings, PlayerSettings, PlaybackRate, ResizeMode, Sensitivity, ThemeMode } from '@/types';
import { APP_VERSION, PLAYBACK_RATES, TIMEOUT_SEARCH_SITE_MS, TIMEOUT_SEARCH_SPIDER_MS } from '@/shared/constants';
import {
  SEARCH_BUDGET_DEFAULT,
  SEARCH_BUDGET_LABELS,
  SEARCH_BUDGET_PRESETS,
  resolveSearchTimeoutMs,
} from '@/shared/searchBudget';
import type { SearchBudgetPreset } from '@/shared/searchBudget';

import AppHeader from '@/components/layout/AppHeader.vue';
import SafeArea from '@/components/layout/SafeArea.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import DanmakuSettingsSheet from '@/components/player/DanmakuSettingsSheet.vue';
import SettingsGroup from '@/components/settings/SettingsGroup.vue';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import SourceManageSection from '@/components/source/SourceManageSection.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import { formatBytes } from '@/components/common/format';
import { useDownloadStore } from '@/stores/downloadStore';
import { useFavoriteStore } from '@/stores/favoriteStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useCacheStore } from '@/stores/cacheStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useSourceStore } from '@/stores/sourceStore';
import { useTheme } from '@/composables/useTheme';
import { useToast } from '@/composables/useToast';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';
import { logApi, type DebugLogStatus } from '@/native/logs';
import { Share } from '@capacitor/share';

const router = useRouter();
const route = useRoute();
const settings = useSettingsStore();
const sources = useSourceStore();
const favorites = useFavoriteStore();
const history = useHistoryStore();
const downloads = useDownloadStore();
const cache = useCacheStore();
const toast = useToast();
const ui = useUiStore();
const theme = useTheme();

const speedOpen = ref(false);
const themeOpen = ref(false);
const sensitivityOpen = ref(false);
const displayModeOpen = ref(false);
const seekStepOpen = ref(false);
const longPressRateOpen = ref(false);
const clearDataOpen = ref(false);
const keepDemo = ref(true);
const clearing = ref(false);
const cacheCleared = ref(false);
const sourceSectionOpen = ref(false);

// EXT-04：下载设置
const speedLimitOpen = ref(false);
const attachSubtitlesOpen = ref(false);
const hlsQualityOpen = ref(false);
const maxQueueOpen = ref(false);
const concurrencyOpen = ref(false);
const segmentConcurrencyOpen = ref(false);

// v1.8: 调试日志管理
const debugLogEnabled = ref(false);
const debugLogStatus = ref<DebugLogStatus>({
  enabled: false,
  fileCount: 0,
  totalBytes: 0,
  retentionDays: 3,
});
const cleanLogsLoading = ref(false);
const exportLogsLoading = ref(false);

const loading = computed(() => !settings.ready && settings.settings === null);
const loadError = ref<string | null>(null);

/**
 * 真实 `settingsStore` 的 `player` / `gesture` getter 在设置未就绪时为 null
 * （mock 返回默认值）。契约不变，调用方加本地兜底，避免读属性抛错。
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
};
const GESTURE_FALLBACK: GestureSettings = { sensitivity: 'medium', seekMaxSec: 90 };

const playerSettings = computed<PlayerSettings>(() => settings.player ?? PLAYER_FALLBACK);
const gestureSettings = computed<GestureSettings>(() => settings.gesture ?? GESTURE_FALLBACK);

const themeLabel = computed(() => {
  switch (settings.settings?.theme ?? 'system') {
    case 'light':
      return '浅色';
    case 'dark':
      return '深色';
    default:
      return '跟随系统';
  }
});

const sensitivityLabel = computed(() => {
  switch (settings.settings?.gesture.sensitivity ?? 'medium') {
    case 'low':
      return '低';
    case 'high':
      return '高';
    default:
      return '中';
  }
});

const rateLabel = computed(() => `${(settings.settings?.player.defaultRate ?? 1).toFixed(2).replace(/0$/, '')}x`);
const autoPlayNext = computed(() => settings.settings?.player.autoPlayNext ?? true);
const backgroundPlayback = computed(() => playerSettings.value.backgroundPlayback === true);
const autoSkipIntro = computed(() => playerSettings.value.autoSkipIntro);
const displayModeLabel = computed(() => {
  const mode = settings.settings?.player.resizeMode ?? 'contain';
  switch (mode) {
    case 'cover':
      return '铺满';
    case 'fill':
      return '拉伸';
    case 'contain':
    default:
      return '适应';
  }
});

const seekStepSecLabel = computed(() => String(settings.settings?.player.seekStepSec ?? 10));
const longPressRateLabel = computed(() => String(settings.settings?.player.longPressRate ?? 2));
const hapticEnabled = computed(() => settings.settings?.hapticEnabled ?? true);
const easterEggsEnabled = computed(() => settings.settings?.easterEggsEnabled ?? true);
const pipAutoEnter = computed(() => settings.settings?.pipAutoEnter ?? false);

// EXT-04：下载设置标签
const speedLimitLabel = computed(() => {
  const limit = settings.settings?.download.speedLimit ?? 'unlimited';
  switch (limit) {
    case 'low':
      return '慢速（512 KB/s）';
    case 'medium':
      return '中速（2 MB/s）';
    case 'high':
      return '快速（5 MB/s）';
    default:
      return '不限速';
  }
});

const attachSubtitlesLabel = computed(() => {
  const policy = settings.settings?.download.attachSubtitles ?? 'preferred';
  switch (policy) {
    case 'all':
      return '全部字幕';
    case 'none':
      return '不下载';
    default:
      return '仅首选语言';
  }
});

const hlsQualityLabel = computed(() => {
  const quality = settings.settings?.download.hlsQuality ?? 'max';
  switch (quality) {
    case '1080p':
      return '1080p';
    case '720p':
      return '720p';
    default:
      return '最高可用';
  }
});

onMounted(async () => {
  try {
    await Promise.all([settings.load(), sources.load(), favorites.load(), history.load(), downloads.load()]);
    if (settings.error) loadError.value = settings.error.message;
    theme.setMode(settings.settings?.theme ?? 'system');
  } catch (e) {
    loadError.value = toErrorShape(e, 'E_DB').message;
  }
  
  // v1.8: 获取日志状态
  await refreshLogStatus();
});

/** 外部入口（详情/搜索的「去源管理」）带 ?sources=1 进来时直接展开并滚动到源管理区 */
watch(
  () => route.query.sources,
  async (value) => {
    if (value !== '1') return;
    sourceSectionOpen.value = true;
    await nextTick();
    document.getElementById('settings-sources-section')?.scrollIntoView({ block: 'start' });
  },
  { immediate: true },
);

async function update(patch: Parameters<typeof settings.update>[0], successText?: string): Promise<void> {
  try {
    await settings.update(patch);
    if (successText) toast.success(successText);
  } catch (e) {
    toast.error(toErrorShape(e, 'E_DB').message);
  }
}

async function setRate(rate: PlaybackRate): Promise<void> {
  speedOpen.value = false;
  await update({ player: { ...playerSettings.value, defaultRate: rate } }, `默认倍速已设为 ${rate}x`);
}

async function setTheme(mode: ThemeMode): Promise<void> {
  themeOpen.value = false;
  theme.setMode(mode);
  await update({ theme: mode }, '主题已更新');
}

async function setSensitivity(value: Sensitivity): Promise<void> {
  sensitivityOpen.value = false;
  await update({ gesture: { ...gestureSettings.value, sensitivity: value } }, '手势灵敏度已更新');
}

function showGestureGuide(): void {
  try {
    localStorage.removeItem('player-gesture-guide-shown');
  } catch {
    // localStorage 不可用不影响功能
  }
  toast.info('进入播放页即可看到手势说明', 2800);
}

async function setDisplayMode(mode: ResizeMode): Promise<void> {
  displayModeOpen.value = false;
  const labels: Record<ResizeMode, string> = { contain: '适应', cover: '铺满', fill: '拉伸' };
  await update({ player: { ...playerSettings.value, resizeMode: mode } }, `画面比例已设为${labels[mode]}`);
}

async function setAutoPlayNext(value: boolean): Promise<void> {
  await update({ player: { ...playerSettings.value, autoPlayNext: value } });
}

async function setBackgroundPlayback(value: boolean): Promise<void> {
  await update({ player: { ...playerSettings.value, backgroundPlayback: value } });
}

async function setAutoSkipIntro(value: boolean): Promise<void> {
  await update({ player: { ...playerSettings.value, autoSkipIntro: value } });
}

async function setSeekStepSec(value: number): Promise<void> {
  seekStepOpen.value = false;
  await update({ player: { ...playerSettings.value, seekStepSec: value } }, `快进退步长已设为 ${value} 秒`);
}

async function setLongPressRate(value: number): Promise<void> {
  longPressRateOpen.value = false;
  await update({ player: { ...playerSettings.value, longPressRate: value } }, `长按倍速已设为 ${value}x`);
}

async function setHapticEnabled(value: boolean): Promise<void> {
  await update({ hapticEnabled: value }, value ? '触觉反馈已开启' : '触觉反馈已关闭');
}

// 彩蛋池：趣味彩蛋总开关
async function setEasterEggsEnabled(value: boolean): Promise<void> {
  await update({ easterEggsEnabled: value }, value ? '趣味彩蛋已开启' : '趣味彩蛋已关闭');
}

// OPT-06：自动进入画中画
async function setPipAutoEnter(value: boolean): Promise<void> {
  await update({ pipAutoEnter: value }, value ? '已开启自动画中画' : '已关闭自动画中画');
}

/* ---------- EXT-04：下载设置 ---------- */
async function setSpeedLimit(limit: 'low' | 'medium' | 'high' | 'unlimited'): Promise<void> {
  speedLimitOpen.value = false;
  await update({ download: { speedLimit: limit } }, `已设置限速：${speedLimitLabel.value}`);
  // 通知 downloadService 更新限速
  const { downloadService } = await import('@/services/downloadService');
  downloadService.setSpeedLimit(limit);
}

async function setAttachSubtitles(policy: 'preferred' | 'all' | 'none'): Promise<void> {
  attachSubtitlesOpen.value = false;
  await update({ download: { attachSubtitles: policy } }, `字幕下载策略：${attachSubtitlesLabel.value}`);
}

async function setHlsQuality(quality: 'max' | '1080p' | '720p'): Promise<void> {
  hlsQualityOpen.value = false;
  await update({ download: { hlsQuality: quality } }, `默认清晰度：${hlsQualityLabel.value}`);
}

async function setMaxQueueTasks(max: 50 | 100 | 200 | 500): Promise<void> {
  maxQueueOpen.value = false;
  await update({ download: { maxQueueTasks: max } }, `队列上限：${max} 个任务`);
}

async function setRemuxToMp4(value: boolean): Promise<void> {
  await update({ download: { remuxToMp4: value } }, value ? '已开启转封装为 MP4' : '已关闭转封装');
}

/** 同时下载的任务数（后端 downloadQueue 已实现，此前无入口） */
async function setConcurrency(value: 1 | 2 | 3): Promise<void> {
  concurrencyOpen.value = false;
  await update({ download: { concurrency: value } }, `同时下载：${value} 个任务`);
}

/** HLS 分片并发数（downloadEngine 已实现，此前无入口） */
async function setSegmentConcurrency(value: 3 | 6 | 8): Promise<void> {
  segmentConcurrencyOpen.value = false;
  await update({ download: { segmentConcurrency: value } }, `分片并发：${value}`);
}

async function setWifiOnly(value: boolean): Promise<void> {
  await update(
    { download: { wifiOnly: value } },
    value ? '仅 Wi-Fi 下载：新建需确认，切到移动网络会暂停在飞任务' : '已允许移动网络直接下载',
  );
}

async function setAutoResume(value: boolean): Promise<void> {
  await update({ download: { autoResume: value } }, value ? '已开启启动时自动续传' : '已关闭自动续传');
}

/* ---------- OPT-04：搜索超时预算（档位缩放单源超时） ---------- */
const searchBudgetOpen = ref(false);

const searchBudget = computed<SearchBudgetPreset>(() => settings.settings?.searchBudget ?? SEARCH_BUDGET_DEFAULT);

/** 档位 → 实际单源上限（秒），让用户所见即所得，不用猜「耐心」到底等多久 */
function budgetHint(preset: SearchBudgetPreset): string {
  const site = resolveSearchTimeoutMs(TIMEOUT_SEARCH_SITE_MS, preset) / 1000;
  const spider = resolveSearchTimeoutMs(TIMEOUT_SEARCH_SPIDER_MS, preset) / 1000;
  return `站点 ${site}s · 爬虫 ${spider}s`;
}

const searchBudgetLabel = computed(() => SEARCH_BUDGET_LABELS[searchBudget.value]);

const searchBudgetDesc = computed(
  () => `单源上限 ${budgetHint(searchBudget.value)}，超时源可在搜索结果页单独重试`,
);

const searchBudgetOptions = computed(() =>
  SEARCH_BUDGET_PRESETS.map((preset) => ({
    v: preset,
    label: SEARCH_BUDGET_LABELS[preset],
    hint: budgetHint(preset),
  })),
);

async function setSearchBudget(preset: SearchBudgetPreset): Promise<void> {
  searchBudgetOpen.value = false;
  await update({ searchBudget: preset }, `搜索超时预算已设为${SEARCH_BUDGET_LABELS[preset]}`);
}

// OPT-15：智能预加载
const preloadLimitOpen = ref(false);

async function setSmartPreloadEnabled(value: boolean): Promise<void> {
  await update({ smartPreloadEnabled: value }, value ? '已开启智能预加载' : '已关闭智能预加载');
}

// 批次2-6：后台探测线路
async function setBackgroundLineProbeEnabled(value: boolean): Promise<void> {
  await update({ backgroundLineProbeEnabled: value }, value ? '已开启后台线路探测' : '已关闭后台线路探测');
}

async function setPreloadStorageLimitMb(value: number): Promise<void> {
  preloadLimitOpen.value = false;
  const label = value === 0 ? '无限制' : value >= 1024 ? `${value / 1024} GB` : `${value} MB`;
  await update({ preloadStorageLimitMb: value }, `预加载上限已设为 ${label}`);
}

const preloadLimitLabel = computed(() => {
  const mb = settings.settings?.preloadStorageLimitMb ?? 1024;
  if (mb === 0) return '无限制';
  return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
});

async function setHideDemo(value: boolean): Promise<void> {
  await update({ hideDemoContent: value });
}

// 功能扩展-9：暂停历史记录
async function setPauseHistory(value: boolean): Promise<void> {
  await update({ pauseHistoryRecording: value });
  toast.info(value ? '已暂停历史记录' : '已恢复历史记录');
}

/* ---------- v1.7（CHG-22/24/21 PoC） ---------- */

const danmakuOpen = ref(false);

async function setShowRecommended(value: boolean): Promise<void> {
  await update({ showRecommendedSubscriptions: value });
}

async function setExperimentalNativePlayer(value: boolean): Promise<void> {
  if (!value) {
    toast.info('已切回内置引擎（WebView 软解），部分源可能因 CORS 限制无法播放', 2800);
  }
  await update({ experimentalNativePlayer: value });
}

async function clearCache(): Promise<void> {
  const ok = await ui.confirm({
    title: '清理缓存？',
    message: '将清理媒体元数据与分类缓存，不影响收藏、历史与已下载内容。',
    confirmText: '清理',
  });
  if (!ok) return;
  try {
    // REV-12：真实清空 media/lines/episodes/categories（AC-91），保留历史/收藏/下载
    const result = await cache.clearMetadataCache();
    cacheCleared.value = true;
    // 元数据已删 → 重新进入媒体库时由 LibraryView 回源拉取（AC-91 后半段）
    if (result.total === 0) {
      toast.info('没有可清理的缓存');
      return;
    }
    const freed = result.freedBytes !== null ? `，释放约 ${formatBytes(result.freedBytes)}` : '';
    toast.success(`已清理 ${result.total} 条缓存${freed}`);
  } catch (e) {
    toast.error(toErrorShape(e).message);
  }
}

async function resetAll(): Promise<void> {
  const ok = await ui.confirm({
    title: '清空全部数据？',
    message: `将停止全部下载并删除已下载的视频文件，同时清空源、收藏、历史、下载记录与弹幕/EPG 缓存、节目提醒${keepDemo.value ? '（保留演示源）' : ''}。此操作不可恢复。`,
    confirmText: '清空',
    danger: true,
  });
  if (!ok) return;
  clearing.value = true;
  try {
    // OPT-02：先停队列 + 删真实文件，再清表——否则在飞下载会把已删任务写回，且磁盘遗留孤儿大文件
    const { filesLeftBehind } = await downloads.stopAndDeleteFiles();
    await settings.resetAllData(keepDemo.value);
    await Promise.all([sources.load(), favorites.load(), history.load(), downloads.load()]);
    clearDataOpen.value = false;
    toast.success(
      filesLeftBehind > 0
        ? `已清空全部数据（${filesLeftBehind} 个文件未能删除，请手动清理下载目录）`
        : '已清空全部数据',
    );
    await router.replace('/');
  } catch (e) {
    toast.error(toErrorShape(e).message);
  } finally {
    clearing.value = false;
  }
}

function go(path: string): void {
  void router.push(path);
}

/* ---------- v1.8：调试日志管理（CHG-29）---------- */

async function refreshLogStatus(): Promise<void> {
  const status = await logApi.getStatus();
  debugLogStatus.value = status;
  debugLogEnabled.value = status.enabled;
}

async function toggleDebugLog(enabled: boolean): Promise<void> {
  try {
    await logApi.setEnabled(enabled);
    await refreshLogStatus();
    if (enabled) {
      toast.success('详细日志已启用（W/E 始终记录）');
    } else {
      toast.info('详细日志已关闭（仅记录警告与错误）');
    }
  } catch (e) {
    toast.error('设置日志失败：' + toErrorShape(e).message);
  }
}

async function manualCleanLogs(): Promise<void> {
  if (cleanLogsLoading.value) return;
  
  const ok = await ui.confirm({
    title: '清理过期日志？',
    message: '将删除超过 24 小时的调试日志文件',
    confirmText: '清理',
  });
  if (!ok) return;
  
  cleanLogsLoading.value = true;
  try {
    const result = await logApi.clean();
    await refreshLogStatus();
    const freed = result.freedBytes > 0 ? `，释放 ${formatBytes(result.freedBytes)}` : '';
    toast.success(`已清理 ${result.cleanedCount} 个日志文件${freed}`);
  } catch (e) {
    toast.error('清理日志失败：' + toErrorShape(e).message);
  } finally {
    cleanLogsLoading.value = false;
  }
}

async function exportLogs(): Promise<void> {
  if (exportLogsLoading.value) return;
  exportLogsLoading.value = true;
  try {
    const result = await logApi.export();
    if (!result.uri) {
      toast.error('导出失败：未生成日志文件');
      return;
    }
    await Share.share({
      title: 'PeanutMov 日志导出',
      text: `日志文件（${formatBytes(result.size)}）`,
      url: result.uri,
      dialogTitle: '分享日志文件',
    });
    toast.success('日志已导出');
  } catch (e) {
    const err = toErrorShape(e);
    // 用户在分享面板取消不算错误
    if (err.message?.includes('dismiss') || err.message?.includes('cancel')) return;
    toast.error('导出日志失败：' + err.message);
  } finally {
    exportLogsLoading.value = false;
  }
}
</script>

<template>
  <SafeArea tabbar data-route="settings">
    <AppHeader title="我的" />

    <div class="settings-body" data-scroll="page">
      <div v-if="loading" class="settings-loading" role="status">
        <LoadingSpinner :size="24" />
        <span>正在读取设置…</span>
      </div>

      <ErrorState
        v-else-if="loadError"
        :error="{ code: 'E_DB', message: loadError, detail: null, retryable: true, httpStatus: null }"
        @retry="$router.go(0)"
      />

      <template v-else>
        <!-- 数据概览：品牌渐变卡，一屏看清规模 -->
        <section class="overview">
          <div class="overview__head">
            <div class="overview__logo" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="M8 4v16M16 4v16M3 12h18" />
              </svg>
            </div>
            <div class="overview__id">
              <span class="overview__name">PeanutMov</span>
              <span class="overview__version">v{{ APP_VERSION }} · 本地优先</span>
            </div>
          </div>
          <div class="overview__stats">
            <div class="overview__stat">
              <span class="overview__num">{{ sources.sources.length }}</span>
              <span class="overview__label">片源</span>
            </div>
            <div class="overview__stat">
              <span class="overview__num">{{ favorites.items.length }}</span>
              <span class="overview__label">收藏</span>
            </div>
            <div class="overview__stat">
              <span class="overview__num">{{ history.items.length }}</span>
              <span class="overview__label">历史</span>
            </div>
          </div>
          <p class="overview__sub">下载占用 {{ formatBytes(downloads.summary.downloadedBytes) }}</p>
        </section>

        <SettingsGroup title="内容">
          <SettingsRow
            label="片源管理"
            :value="`${sources.sources.length} 个`"
            :chevron="!sourceSectionOpen"
            @click="sourceSectionOpen = !sourceSectionOpen"
          />
          <!-- OPT-09: 内联源管理区（不再跳转独立路由） -->
          <div v-if="sourceSectionOpen" id="settings-sources-section" class="settings-inline-section">
            <SourceManageSection />
          </div>
          <SettingsRow label="观看历史" :value="`${history.items.length} 条`" chevron @click="go('/history')" />
          <SettingsRow
            label="观影报告"
            description="时长、口味、节奏，全部本地统计"
            :value="`${history.items.length} 部`"
            chevron
            @click="go('/report')"
          />
          <SettingsRow label="我的收藏" :value="`${favorites.items.length} 个`" chevron @click="go('/favorites')" />
          <SettingsRow label="网盘账号" description="夸克支持账号校验，其余平台 Cookie 直填" chevron @click="go('/settings/netdisk')" />
          <SettingsRow
            label="搜索超时预算"
            :value="searchBudgetLabel"
            :description="searchBudgetDesc"
            chevron
            @click="searchBudgetOpen = true"
          />
        </SettingsGroup>

        <SettingsGroup title="播放">
          <SettingsRow label="默认倍速" :value="rateLabel" chevron @click="speedOpen = true" />
          <SettingsRow label="画面比例" :value="displayModeLabel" chevron @click="displayModeOpen = true" />
          <SettingsRow
            label="自动连播下一集"
            :switch-value="autoPlayNext"
            @update:switch-value="setAutoPlayNext"
          />
          <SettingsRow
            label="自动跳过片头/片尾"
            description="关掉后只出提示胶囊，点了才跳"
            :switch-value="autoSkipIntro"
            @update:switch-value="setAutoSkipIntro"
          />
          <SettingsRow label="手势灵敏度" :value="sensitivityLabel" chevron @click="sensitivityOpen = true" />
          <SettingsRow label="手势说明" description="查看播放页手势操作指引" chevron @click="showGestureGuide" />
          <SettingsRow label="快进退秒数" :value="`${seekStepSecLabel}s`" chevron @click="seekStepOpen = true" />
          <SettingsRow label="长按倍速" :value="`${longPressRateLabel}x`" chevron @click="longPressRateOpen = true" />
          <SettingsRow
            label="触觉反馈"
            description="操作时振动确认（播放/长按/Tab 切换/错误提示）"
            :switch-value="hapticEnabled"
            @update:switch-value="setHapticEnabled"
          />
          <SettingsRow
            label="后台播放"
            description="切到后台或锁屏后继续播放（仅原生播放器）"
            :switch-value="backgroundPlayback"
            @update:switch-value="setBackgroundPlayback"
          />
          <SettingsRow
            label="自动进入画中画"
            description="切到后台且正在播放时自动悬浮小窗"
            :switch-value="pipAutoEnter"
            @update:switch-value="setPipAutoEnter"
          />
          <SettingsRow label="字幕设置" description="在播放页内调整字号/颜色/偏移" chevron @click="toast.info('请在播放页的字幕面板中调整')" />
          <SettingsRow label="弹幕设置" description="字号/透明度/速度/显示区域（播放页内开关）" chevron @click="danmakuOpen = true" />
        </SettingsGroup>

        <!-- EXT-04：下载设置 -->
        <SettingsGroup title="下载">
          <SettingsRow label="下载限速" :value="speedLimitLabel" chevron @click="speedLimitOpen = true" />
          <SettingsRow
            label="仅 Wi-Fi 下载"
            description="移动网络下新建下载时二次确认，避免误耗流量"
            :switch-value="settings.settings?.download.wifiOnly ?? false"
            @update:switch-value="setWifiOnly"
          />
          <SettingsRow
            label="启动时自动续传"
            description="打开 App 后自动恢复未完成的下载"
            :switch-value="settings.settings?.download.autoResume ?? true"
            @update:switch-value="setAutoResume"
          />
          <SettingsRow
            label="同时下载数"
            :value="`${settings.settings?.download.concurrency ?? 2} 个任务`"
            chevron
            @click="concurrencyOpen = true"
          />
          <SettingsRow
            label="分片并发数"
            :value="`${settings.settings?.download.segmentConcurrency ?? 6} 线程`"
            description="单个 HLS 任务内部的分片下载并发"
            chevron
            @click="segmentConcurrencyOpen = true"
          />
          <SettingsRow label="字幕随片下载" :value="attachSubtitlesLabel" chevron @click="attachSubtitlesOpen = true" />
          <SettingsRow label="默认清晰度" :value="hlsQualityLabel" chevron @click="hlsQualityOpen = true" />
          <SettingsRow label="队列上限" :value="`${settings.settings?.download.maxQueueTasks ?? 200} 个任务`" chevron @click="maxQueueOpen = true" />
          <SettingsRow
            label="转封装为 MP4"
            description="下载完成后自动转换格式（仅 Android）"
            :switch-value="settings.settings?.download.remuxToMp4 ?? true"
            @update:switch-value="setRemuxToMp4"
          />
        </SettingsGroup>

        <SettingsGroup title="外观">
          <SettingsRow label="主题" :value="themeLabel" chevron @click="themeOpen = true" />
          <SettingsRow
            label="隐藏演示内容"
            description="隐藏内置公开版权样片"
            :switch-value="settings.settings?.hideDemoContent ?? false"
            @update:switch-value="setHideDemo"
          />
          <SettingsRow
            label="趣味彩蛋"
            description="关于页连点版本号、连看里程碑等隐藏小惊喜"
            :switch-value="easterEggsEnabled"
            @update:switch-value="setEasterEggsEnabled"
          />
        </SettingsGroup>

        <SettingsGroup title="数据">
          <SettingsRow label="数据备份与恢复" chevron @click="go('/settings/backup')" />
          <SettingsRow
            label="智能预加载"
            description="WiFi 环境下提示预加载内容到本地"
            :switch-value="settings.settings?.smartPreloadEnabled ?? false"
            @update:switch-value="setSmartPreloadEnabled"
          />
          <SettingsRow
            label="后台线路探测"
            description="进详情页后自动探测可播线路（提升首次播放成功率）"
            :switch-value="settings.settings?.backgroundLineProbeEnabled ?? true"
            @update:switch-value="setBackgroundLineProbeEnabled"
          />
          <SettingsRow
            label="预加载存储上限"
            :value="preloadLimitLabel"
            chevron
            @click="preloadLimitOpen = true"
          />
          <SettingsRow
            label="清理缓存"
            :value="cacheCleared ? '已清理' : '元数据与图片'"
            chevron
            @click="clearCache"
          />
          <SettingsRow
            label="暂停历史记录"
            description="开启后不再 观看内容不会被记录到历史"
            :switch-value="settings.settings?.pauseHistoryRecording ?? false"
            @update:switch-value="setPauseHistory"
          />
          <SettingsRow label="清空全部数据" danger chevron @click="clearDataOpen = true" />
          <!-- v1.8 新增：调试日志管理 -->
          <SettingsRow
            label="详细日志"
            :description="`记录 D/I/W/E 到本地文件，保留 ${debugLogStatus.retentionDays} 天；关闭后仅记录 W/E`"
            :switch-value="debugLogEnabled"
            @update:switch-value="toggleDebugLog"
          />
          <SettingsRow
            label="运行日志"
            :value="`${debugLogStatus.fileCount} 个 · ${formatBytes(debugLogStatus.totalBytes)}`"
            chevron
            @click="go('/settings/logs')"
          />
          <SettingsRow
            label="导出日志"
            description="合并所有日志为单文件并分享"
            :chevron="true"
            @click="exportLogs"
          />
          <SettingsRow
            label="立即清理过期日志"
            description="删除超过 24 小时的调试日志"
            @click="manualCleanLogs"
          />
        </SettingsGroup>

        <!-- v1.7（CHG-24 / CHG-21 PoC） -->
        <SettingsGroup title="推荐与实验性">
          <SettingsRow
            label="显示推荐订阅"
            description="随版本内置的人工筛选清单，导入仍需逐项确认"
            :switch-value="settings.settings?.showRecommendedSubscriptions ?? true"
            @update:switch-value="setShowRecommended"
          />
          <SettingsRow
            label="原生播放引擎"
            description="Media3 ExoPlayer 硬解（默认推荐），低端设备或特殊源可切回内置引擎"
            :switch-value="settings.settings?.experimentalNativePlayer ?? true"
            @update:switch-value="setExperimentalNativePlayer"
          />
        </SettingsGroup>

        <SettingsGroup title="关于">
          <SettingsRow label="关于 PeanutMov" :value="APP_VERSION" chevron @click="go('/settings/about')" />
          <SettingsRow label="合规声明" chevron @click="go('/legal/compliance')" />
          <SettingsRow label="源合规提示" description="请仅添加你有访问权限的源" @click="sourceSectionOpen = true" />
        </SettingsGroup>

        <p class="settings-footer">本 App 不提供任何影视片源 · 数据仅保存在本机</p>
      </template>
    </div>

    <!-- 倍速 -->
    <BottomSheet v-model="speedOpen" title="默认倍速">
      <ul class="sheet-list">
        <li v-for="rate in PLAYBACK_RATES" :key="rate">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': playerSettings.defaultRate === rate }"
            type="button"
            @click="setRate(rate)"
          >
            {{ rate }}x
            <span v-if="rate === playerSettings.defaultRate" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">下次播放生效；播放页内也可临时切换倍速。</p>
    </BottomSheet>

    <!-- 画面比例 -->
    <BottomSheet v-model="displayModeOpen" title="画面比例">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 'contain', l: '适应', d: '完整显示，留黑边' },
          { v: 'cover', l: '铺满', d: '裁剪边缘，不变形' },
          { v: 'fill', l: '拉伸', d: '填满屏幕，会变形' },
        ] as const" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': playerSettings.resizeMode === opt.v }"
            type="button"
            @click="setDisplayMode(opt.v)"
          >
            {{ opt.l }}
            <span class="sheet-list__hint">{{ opt.d }}</span>
            <span v-if="playerSettings.resizeMode === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">立即生效；播放页内也可临时切换画面比例。</p>
    </BottomSheet>

    <!-- 主题 -->
    <BottomSheet v-model="themeOpen" title="主题">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 'system', l: '跟随系统（默认）' },
          { v: 'dark', l: '深色' },
          { v: 'light', l: '浅色' },
        ] as const" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.theme ?? 'system') === opt.v }"
            type="button"
            @click="setTheme(opt.v)"
          >
            {{ opt.l }}
          </button>
        </li>
      </ul>
    </BottomSheet>

    <!-- OPT-04：搜索超时预算 -->
    <BottomSheet v-model="searchBudgetOpen" title="搜索超时预算">
      <ul class="sheet-list">
        <li v-for="opt in searchBudgetOptions" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': searchBudget === opt.v }"
            type="button"
            @click="setSearchBudget(opt.v)"
          >
            {{ opt.label }}
            <span class="sheet-list__hint">{{ opt.hint }}</span>
            <span v-if="searchBudget === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">单源超过预算即中止并计入失败源，可在搜索结果页「重试失败源」，只重跑失败的源。</p>
    </BottomSheet>

    <!-- 手势灵敏度 -->
    <BottomSheet v-model="sensitivityOpen" title="手势灵敏度">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 'low', l: '低（拖动更稳）' },
          { v: 'medium', l: '中（推荐）' },
          { v: 'high', l: '高（拖动更快）' },
        ] as const" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.gesture.sensitivity ?? 'medium') === opt.v }"
            type="button"
            @click="setSensitivity(opt.v)"
          >
            {{ opt.l }}
          </button>
        </li>
      </ul>
    </BottomSheet>

    <!-- P1-4：快进退秒数 -->
    <BottomSheet v-model="seekStepOpen" title="快进退步长">
      <ul class="sheet-list">
        <li v-for="sec in [5, 10, 15, 30]" :key="sec">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.player.seekStepSec ?? 10) === sec }"
            type="button"
            @click="setSeekStepSec(sec)"
          >
            {{ sec }} 秒
          </button>
        </li>
      </ul>
    </BottomSheet>

    <!-- P1-4：长按倍速 -->
    <BottomSheet v-model="longPressRateOpen" title="长按倍速">
      <ul class="sheet-list">
        <li v-for="rate in [1.5, 2, 2.5, 3]" :key="rate">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.player.longPressRate ?? 2) === rate }"
            type="button"
            @click="setLongPressRate(rate)"
          >
            {{ rate }}x
          </button>
        </li>
      </ul>
    </BottomSheet>

    <!-- 清空数据 -->
    <BottomSheet v-model="clearDataOpen" title="清空全部数据">
      <p class="sheet-desc">
        将删除所有源、收藏、历史与下载记录。此操作不可恢复。
      </p>
      <label class="sheet-check">
        <input v-model="keepDemo" type="checkbox" />
        <span>保留演示源（推荐）</span>
      </label>
      <template #footer>
        <button class="btn btn--danger btn--lg" type="button" :disabled="clearing" @click="resetAll">
          <LoadingSpinner v-if="clearing" :size="16" />
          {{ clearing ? '正在清空…' : '确认清空' }}
        </button>
      </template>
    </BottomSheet>

    <!-- v1.7/CHG-22：弹幕设置 -->
    <DanmakuSettingsSheet v-model:open="danmakuOpen" />

    <!-- OPT-15：预加载存储上限选择 -->
    <BottomSheet v-model="preloadLimitOpen" title="预加载存储上限">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 500, l: '500 MB' },
          { v: 1024, l: '1 GB' },
          { v: 2048, l: '2 GB' },
          { v: 5120, l: '5 GB' },
          { v: 0, l: '无限制' },
        ] as const" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.preloadStorageLimitMb ?? 1024) === opt.v }"
            type="button"
            @click="setPreloadStorageLimitMb(opt.v)"
          >
            {{ opt.l }}
            <span v-if="(settings.settings?.preloadStorageLimitMb ?? 1024) === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">达到上限后将自动停止新的预加载任务。</p>
    </BottomSheet>

    <!-- EXT-04：下载设置 BottomSheet -->
    <BottomSheet v-model="speedLimitOpen" title="下载限速">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 'unlimited' as const, l: '不限速', d: '全速下载' },
          { v: 'high' as const, l: '快速（5 MB/s）', d: '适合 WiFi 环境' },
          { v: 'medium' as const, l: '中速（2 MB/s）', d: '平衡速度与带宽' },
          { v: 'low' as const, l: '慢速（512 KB/s）', d: '节省带宽，适合后台下载' },
        ]" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.download.speedLimit ?? 'unlimited') === opt.v }"
            type="button"
            @click="setSpeedLimit(opt.v)"
          >
            {{ opt.l }}
            <span class="sheet-list__desc">{{ opt.d }}</span>
            <span v-if="(settings.settings?.download.speedLimit ?? 'unlimited') === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">限速对所有下载任务生效，切换后 3 秒内生效。</p>
    </BottomSheet>

    <BottomSheet v-model="attachSubtitlesOpen" title="字幕随片下载">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 'preferred' as const, l: '仅首选语言', d: '只下载设置中首选语言的字幕' },
          { v: 'all' as const, l: '全部字幕', d: '下载所有可用字幕' },
          { v: 'none' as const, l: '不下载', d: '不下载字幕文件' },
        ]" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.download.attachSubtitles ?? 'preferred') === opt.v }"
            type="button"
            @click="setAttachSubtitles(opt.v)"
          >
            {{ opt.l }}
            <span class="sheet-list__desc">{{ opt.d }}</span>
            <span v-if="(settings.settings?.download.attachSubtitles ?? 'preferred') === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">字幕文件与视频保存在同一目录，离线播放时可切换。</p>
    </BottomSheet>

    <BottomSheet v-model="hlsQualityOpen" title="默认清晰度">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 'max' as const, l: '最高可用', d: '选择最高清晰度的变体' },
          { v: '1080p' as const, l: '1080p', d: '全高清，适合大屏' },
          { v: '720p' as const, l: '720p', d: '高清，节省空间' },
        ]" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.download.hlsQuality ?? 'max') === opt.v }"
            type="button"
            @click="setHlsQuality(opt.v)"
          >
            {{ opt.l }}
            <span class="sheet-list__desc">{{ opt.d }}</span>
            <span v-if="(settings.settings?.download.hlsQuality ?? 'max') === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">仅对 HLS 源生效，直链源使用线路自带的清晰度。</p>
    </BottomSheet>

    <BottomSheet v-model="maxQueueOpen" title="队列上限">
      <ul class="sheet-list">
        <li v-for="opt in [50, 100, 200, 500] as const" :key="opt">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.download.maxQueueTasks ?? 200) === opt }"
            type="button"
            @click="setMaxQueueTasks(opt)"
          >
            {{ opt }} 个任务
            <span v-if="(settings.settings?.download.maxQueueTasks ?? 200) === opt" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">超过上限的新任务将被拒绝，不影响已入队任务。</p>
    </BottomSheet>

    <BottomSheet v-model="concurrencyOpen" title="同时下载数">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 1 as const, l: '1 个任务', d: '最省带宽，单任务最快' },
          { v: 2 as const, l: '2 个任务', d: '默认，兼顾速度与稳定' },
          { v: 3 as const, l: '3 个任务', d: '批量下载更快，占用带宽更高' },
        ]" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.download.concurrency ?? 2) === opt.v }"
            type="button"
            @click="setConcurrency(opt.v)"
          >
            {{ opt.l }}
            <span class="sheet-list__desc">{{ opt.d }}</span>
            <span v-if="(settings.settings?.download.concurrency ?? 2) === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">修改后对随后开始的任务生效，已在下载的任务不中断。</p>
    </BottomSheet>

    <BottomSheet v-model="segmentConcurrencyOpen" title="分片并发数">
      <ul class="sheet-list">
        <li v-for="opt in [
          { v: 3 as const, l: '3 线程', d: '源站限流严格时更稳' },
          { v: 6 as const, l: '6 线程', d: '默认' },
          { v: 8 as const, l: '8 线程', d: '源站带宽充足时最快' },
        ]" :key="opt.v">
          <button
            class="sheet-list__item"
            :class="{ 'sheet-list__item--active': (settings.settings?.download.segmentConcurrency ?? 6) === opt.v }"
            type="button"
            @click="setSegmentConcurrency(opt.v)"
          >
            {{ opt.l }}
            <span class="sheet-list__desc">{{ opt.d }}</span>
            <span v-if="(settings.settings?.download.segmentConcurrency ?? 6) === opt.v" class="sheet-list__check">当前</span>
          </button>
        </li>
      </ul>
      <p class="sheet-hint">仅对 HLS 分片下载生效。线程过多可能被源站限流，反而更慢。</p>
    </BottomSheet>
  </SafeArea>
</template>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x) var(--layout-tabbar-safe);
}

.settings-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8);
  font: var(--text-label);
  color: var(--color-text-tertiary);
}

.overview {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-4);
  border-radius: 18px;
  background:
    linear-gradient(145deg, rgba(240, 168, 46, 0.16), rgba(240, 168, 46, 0.03) 58%, transparent),
    var(--color-bg-surface);
  border: 1px solid rgba(240, 168, 46, 0.22);
}

.overview__head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.overview__logo {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: var(--radius-card);
  background: var(--gradient-brand-cta);
  color: var(--color-brand-ink);
  box-shadow: var(--shadow-brand);
}

.overview__logo svg {
  width: 22px;
  height: 22px;
}

.overview__id {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.overview__name {
  font: var(--font-weight-bold) 15px / 1.3 var(--font-family-base);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
}

.overview__version {
  font: var(--font-weight-regular) 11px / 1.3 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.overview__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--color-border);
}

.overview__stat {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.overview__num {
  font: var(--font-weight-bold) 19px / 1.1 var(--font-family-number);
  color: var(--color-text-primary);
}

.overview__label {
  font: var(--font-weight-regular) 10.5px / 1.3 var(--font-family-base);
  color: var(--color-text-tertiary);
}

.overview__sub {
  font: var(--font-weight-regular) 11px / 1.4 var(--font-family-number);
  color: var(--color-text-tertiary);
}

.settings-footer {
  margin-top: var(--space-6);
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
  gap: var(--space-2);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  color: var(--color-text-primary);
  font: var(--text-body-strong);
  text-align: left;
}

.sheet-list__item--active {
  color: var(--color-brand-text);
}

.sheet-list__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.sheet-list__check {
  margin-left: auto;
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.sheet-hint {
  padding-top: var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.sheet-desc {
  padding: var(--space-3) 0;
  font: var(--text-label);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.sheet-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 44px;
  font: var(--text-label);
  color: var(--color-text-primary);
}

.sheet-check input {
  width: 18px;
  height: 18px;
  accent-color: var(--color-brand);
}

/* OPT-09: 内联源管理区容器 */
.settings-inline-section {
  padding: var(--space-2) 0 var(--space-3);
  border-bottom: 1px solid var(--color-divider);
  scroll-margin-top: var(--space-4);
}
</style>
