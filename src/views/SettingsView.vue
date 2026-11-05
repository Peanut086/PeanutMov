<script setup lang="ts">
/**
 * 设置（我的）页（页面蓝图 §10）
 *
 * 数据概览 → 内容入口 → 播放偏好 → 外观 → 数据 → 关于。
 * 所有改动立即写设置并持久化；失败回滚 UI + Toast。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import type { GestureSettings, PlayerSettings, PlaybackRate, ResizeMode, Sensitivity, ThemeMode } from '@/types';
import { APP_VERSION, PLAYBACK_RATES } from '@/shared/constants';

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
const rememberVolumeBrightness = computed(() => settings.settings?.player.rememberVolumeBrightness ?? true);
const hapticEnabled = computed(() => settings.settings?.hapticEnabled ?? true);
const pipAutoEnter = computed(() => settings.settings?.pipAutoEnter ?? false);

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

async function setSeekStepSec(value: number): Promise<void> {
  seekStepOpen.value = false;
  await update({ player: { ...playerSettings.value, seekStepSec: value } }, `快进退步长已设为 ${value} 秒`);
}

async function setLongPressRate(value: number): Promise<void> {
  longPressRateOpen.value = false;
  await update({ player: { ...playerSettings.value, longPressRate: value } }, `长按倍速已设为 ${value}x`);
}

async function setRememberVolumeBrightness(value: boolean): Promise<void> {
  await update({ player: { ...playerSettings.value, rememberVolumeBrightness: value } });
}

async function setHapticEnabled(value: boolean): Promise<void> {
  await update({ hapticEnabled: value }, value ? '触觉反馈已开启' : '触觉反馈已关闭');
}

// OPT-06：自动进入画中画
async function setPipAutoEnter(value: boolean): Promise<void> {
  await update({ pipAutoEnter: value }, value ? '已开启自动画中画' : '已关闭自动画中画');
}

// OPT-15：智能预加载
const preloadLimitOpen = ref(false);

async function setSmartPreloadEnabled(value: boolean): Promise<void> {
  await update({ smartPreloadEnabled: value }, value ? '已开启智能预加载' : '已关闭智能预加载');
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
    message: `将删除源、收藏、历史与下载记录${keepDemo.value ? '（保留演示源）' : ''}。此操作不可恢复。`,
    confirmText: '清空',
    danger: true,
  });
  if (!ok) return;
  clearing.value = true;
  try {
    await settings.resetAllData(keepDemo.value);
    await Promise.all([sources.load(), favorites.load(), history.load(), downloads.load()]);
    clearDataOpen.value = false;
    toast.success('已清空全部数据');
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

    <div class="settings-body">
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
          <div v-if="sourceSectionOpen" class="settings-inline-section">
            <SourceManageSection />
          </div>
          <SettingsRow label="观看历史" :value="`${history.items.length} 条`" chevron @click="go('/history')" />
          <SettingsRow label="我的收藏" :value="`${favorites.items.length} 个`" chevron @click="go('/favorites')" />
          <SettingsRow label="网盘账号" description="夸克/UC/天翼/123/阿里" chevron @click="go('/settings/netdisk')" />
        </SettingsGroup>

        <SettingsGroup title="播放">
          <SettingsRow label="默认倍速" :value="rateLabel" chevron @click="speedOpen = true" />
          <SettingsRow label="画面比例" :value="displayModeLabel" chevron @click="displayModeOpen = true" />
          <SettingsRow
            label="自动连播下一集"
            :switch-value="autoPlayNext"
            @update:switch-value="setAutoPlayNext"
          />
          <SettingsRow label="手势灵敏度" :value="sensitivityLabel" chevron @click="sensitivityOpen = true" />
          <SettingsRow label="手势说明" description="查看播放页手势操作指引" chevron @click="showGestureGuide" />
          <SettingsRow label="快进退秒数" :value="`${seekStepSecLabel}s`" chevron @click="seekStepOpen = true" />
          <SettingsRow label="长按倍速" :value="`${longPressRateLabel}x`" chevron @click="longPressRateOpen = true" />
          <SettingsRow
            label="记忆音量/亮度"
            description="退出播放时保存，下次进入自动恢复"
            :switch-value="rememberVolumeBrightness"
            @update:switch-value="setRememberVolumeBrightness"
          />
          <SettingsRow
            label="触觉反馈"
            description="操作时振动确认（播放/长按/Tab 切换/错误提示）"
            :switch-value="hapticEnabled"
            @update:switch-value="setHapticEnabled"
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

        <SettingsGroup title="外观">
          <SettingsRow label="主题" :value="themeLabel" chevron @click="themeOpen = true" />
          <SettingsRow
            label="隐藏演示内容"
            description="隐藏内置公开版权样片"
            :switch-value="settings.settings?.hideDemoContent ?? false"
            @update:switch-value="setHideDemo"
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
}
</style>
