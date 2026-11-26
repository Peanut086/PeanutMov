<script setup lang="ts">
/**
 * 关于（页面蓝图 §15）
 *
 * LOGO + 版本 + 合规/开源许可/投屏说明/反馈；连点版本号 7 次展开调试信息。
 * F3 彩蛋：连点版本号 5 次（2s 窗口）触发「NG 场记板」，与 7 次调试共用计数器，
 * 受设置「趣味彩蛋」开关 gate，reduced-motion 仅静态文案。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';

import { APP_NAME, APP_VERSION, BUILD_TIME, DB_VERSION } from '@/shared/constants';
import { getPlatform, isAndroid } from '@/shared/platform';
import { formatDateStamp } from '@/shared/time';

import AppHeader from '@/components/layout/AppHeader.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { formatBytes } from '@/components/common/format';
import SettingsGroup from '@/components/settings/SettingsGroup.vue';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import logoUrl from '@/assets/logo.svg';
import { useToast } from '@/composables/useToast';
import { useOnlineStatus } from '@/composables/useOnlineStatus';
import { useHaptic } from '@/composables/useHaptic';
import { prefersReducedMotion } from '@/composables/useSpring';
import { useSettingsStore } from '@/stores/settingsStore';
import { onAppStateChange } from '@/native/appLifecycle';
import { playClack } from '@/services/sfxService';
import { updateErrorMessage, updateService } from '@/services/updateService';
import type { UpdateManifest } from '@/services/updateService';
import type { DownloadedApk } from '@/native/updatePlugin';

const router = useRouter();
const toast = useToast();
const { isOffline } = useOnlineStatus();
const { haptic } = useHaptic();
const settings = useSettingsStore();

const taps = ref(0);
const tapTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const debugVisible = ref(false);
const licensesOpen = ref(false);
const castOpen = ref(false);

const updateSheetOpen = ref(false);
const updateChecking = ref(false);
const updateDownloading = ref(false);
const updateProgress = ref(0);
const updateInfo = ref<UpdateManifest | null>(null);
const downloadedUpdate = ref<DownloadedApk | null>(null);
const updateError = ref<string | null>(null);
const updateStatusText = ref('检查更新');
const installPermissionAllowed = ref(true);

const updateSizeText = computed(() => updateInfo.value ? formatBytes(updateInfo.value.apk.sizeBytes) : '');

/* F3：NG 场记板 overlay 状态 */
const clapperOpen = ref(false);
const clapperClack = ref(false);
const clapperReduced = ref(false);
let clapperTimers: ReturnType<typeof setTimeout>[] = [];

const versionText = computed(() => (APP_VERSION === '未知版本' ? '未知版本' : `版本 ${APP_VERSION}`));
/** 构建日期由 `vite define: __BUILD_TIME__` 注入（REV-19）；未注入时不展示，避免显示假日期 */
const buildDateText = BUILD_TIME === null ? null : formatDateStamp(BUILD_TIME);
const buildText = computed(() =>
  buildDateText === null ? '开发构建' : `构建日期 ${buildDateText}`,
);

const platformText = computed(() => {
  switch (getPlatform()) {
    case 'android':
      return 'Android';
    case 'ios':
      return 'iOS';
    default:
      return 'Web';
  }
});

async function refreshInstallPermission(): Promise<void> {
  if (!updateInfo.value) return;
  try {
    installPermissionAllowed.value = await updateService.canInstallPackages();
  } catch (error) {
    updateError.value = updateErrorMessage(error);
  }
}

async function onCheckUpdate(): Promise<void> {
  if (!isAndroid()) {
    toast.info('仅 Android 客户端支持应用内更新');
    return;
  }
  if (isOffline.value) {
    toast.info('当前离线，暂无法检查更新');
    return;
  }

  updateChecking.value = true;
  updateDownloading.value = false;
  updateProgress.value = 0;
  updateInfo.value = null;
  downloadedUpdate.value = null;
  updateError.value = null;
  updateStatusText.value = '检查中…';
  updateSheetOpen.value = true;
  try {
    const result = await updateService.checkForUpdate();
    if (result.status === 'unsupported') {
      updateSheetOpen.value = false;
      toast.info('仅 Android 客户端支持应用内更新');
      return;
    }
    if (result.status === 'up-to-date') {
      updateStatusText.value = '已是最新';
      updateSheetOpen.value = false;
      toast.success(`已是最新版本 ${result.currentVersion.versionName}`);
      return;
    }
    updateInfo.value = result.update;
    updateStatusText.value = `发现 v${result.update.versionName}`;
    await refreshInstallPermission();
  } catch (error) {
    updateError.value = updateErrorMessage(error);
    updateStatusText.value = '检查失败';
  } finally {
    updateChecking.value = false;
  }
}

async function onOpenInstallPermission(): Promise<void> {
  try {
    await updateService.openUnknownSourcesSettings();
    toast.info('允许安装后返回，即可继续安装更新');
  } catch (error) {
    toast.error(updateErrorMessage(error));
  }
}

async function onDownloadUpdate(): Promise<void> {
  if (!updateInfo.value || updateDownloading.value) return;
  if (isOffline.value) {
    toast.info('当前离线，暂无法下载更新');
    return;
  }

  updateDownloading.value = true;
  updateProgress.value = 0;
  updateError.value = null;
  updateStatusText.value = '下载中…';
  try {
    downloadedUpdate.value = await updateService.downloadUpdate(
      updateInfo.value,
      (percent) => { updateProgress.value = percent; },
    );
    updateStatusText.value = '下载完成';
    toast.success('更新包已下载，可以开始安装');
  } catch (error) {
    updateError.value = updateErrorMessage(error);
    updateStatusText.value = '下载失败';
  } finally {
    updateDownloading.value = false;
  }
}

async function onInstallUpdate(): Promise<void> {
  if (!downloadedUpdate.value) return;
  updateError.value = null;
  try {
    await updateService.installDownloadedUpdate(downloadedUpdate.value);
    toast.success('已打开系统安装器');
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.startsWith('APK_HASH_') || message.startsWith('INVALID_APK')) {
      downloadedUpdate.value = null;
      updateProgress.value = 0;
    }
    updateError.value = updateErrorMessage(error);
    updateStatusText.value = '安装失败';
  }
}

function onRetryUpdate(): void {
  if (downloadedUpdate.value) {
    void onInstallUpdate();
  } else if (updateInfo.value) {
    void onDownloadUpdate();
  } else {
    void onCheckUpdate();
  }
}

const stopAppStateListener = onAppStateChange((state) => {
  if (state === 'active' && updateSheetOpen.value && updateInfo.value && !updateDownloading.value) {
    void refreshInstallPermission();
  }
});

function onVersionTap(): void {
  if (tapTimer.value !== null) clearTimeout(tapTimer.value);
  taps.value += 1;
  // 2s 窗口（F3 规格）：比旧 1.2s 更宽松，7 次调试路径不受影响
  tapTimer.value = setTimeout(() => {
    taps.value = 0;
    tapTimer.value = null;
  }, 2000);
  // 5 次彩蛋：不重置计数，仍可继续点到 7 次调试
  if (taps.value === 5) triggerClapper();
  if (taps.value >= 7) {
    taps.value = 0;
    dismissClapper();
    debugVisible.value = !debugVisible.value;
    toast.info(debugVisible.value ? '已展开调试信息' : '已收起调试信息');
  }
}

/* ---------- F3：NG 场记板 ----------
 * 合板（clack）→ 板身 shake → 「NG! 再来一条」盖章；haptic("heavy") + clack 音效
 * 在合板瞬间触发。reduced-motion 下所有动画时长被全局规则压到 0，直接呈现静态终态。
 * overlay 自动消散 + 可点跳过，不阻塞关于页阅读。
 */
function clearClapperTimers(): void {
  for (const t of clapperTimers) clearTimeout(t);
  clapperTimers = [];
}

function dismissClapper(): void {
  clearClapperTimers();
  clapperOpen.value = false;
  clapperClack.value = false;
}

function triggerClapper(): void {
  if (!settings.easterEggsEnabled || clapperOpen.value) return;
  clapperReduced.value = prefersReducedMotion();
  clapperOpen.value = true;
  clapperClack.value = false;
  const clackDelay = clapperReduced.value ? 0 : 220;
  clapperTimers.push(
    setTimeout(() => {
      clapperClack.value = true;
      haptic('heavy');
      playClack();
    }, clackDelay),
  );
  clapperTimers.push(setTimeout(dismissClapper, clapperReduced.value ? 1500 : 1750));
}

onBeforeUnmount(() => {
  clearClapperTimers();
  stopAppStateListener();
  if (tapTimer.value !== null) clearTimeout(tapTimer.value);
});

function go(path: string): void {
  void router.push(path);
}

function onFeedback(): void {
  if (isOffline.value) {
    toast.info('当前离线，暂无法发送反馈');
    return;
  }
  try {
    globalThis.location.href = 'mailto:feedback@peanutmov.local?subject=PeanutMov%20反馈';
  } catch {
    toast.info('未找到可用的邮件应用');
  }
}

</script>

<template>
  <main class="about-page" data-route="about">
    <AppHeader title="关于" back />

    <div class="about-body">
      <section class="about-hero">
        <img class="about-hero__logo" :src="logoUrl" :alt="`${APP_NAME} 标志`" width="72" height="72" />
        <h1 class="about-hero__name">{{ APP_NAME }}</h1>
        <button class="about-hero__version" type="button" @click="onVersionTap">
          {{ versionText }}
        </button>
        <p class="about-hero__build">{{ buildText }}</p>
      </section>

      <SettingsGroup>
        <SettingsRow
          v-if="isAndroid()"
          label="检查更新"
          :value="updateStatusText"
          :disabled="updateChecking || updateDownloading"
          chevron
          @click="onCheckUpdate"
        />
        <SettingsRow label="合规声明" chevron @click="go('/legal/compliance')" />
        <SettingsRow label="开源许可" chevron @click="licensesOpen = true" />
        <SettingsRow label="投屏能力说明" chevron @click="castOpen = true" />
        <SettingsRow label="反馈方式" value="邮件" chevron @click="onFeedback" />
      </SettingsGroup>

      <section class="about-card">
        <h2 class="about-card__title">投屏说明</h2>
        <p class="about-card__text">
          首版为系统级投屏/分享，不含 App 内 DLNA 设备发现；如需完整 DLNA 请等待二期。
          在浏览器中运行时，投屏按钮会给出「当前平台不支持」的提示，不会报错。
        </p>
      </section>

      <section v-if="debugVisible" class="about-card about-card--debug">
        <h2 class="about-card__title">调试信息</h2>
        <ul class="about-debug">
          <li>平台：{{ platformText }}</li>
          <li>应用版本：{{ APP_VERSION }}</li>
          <li>DB 版本：{{ DB_VERSION }}</li>
          <li>构建日期：{{ buildDateText ?? '未注入' }}</li>
          <li>离线状态：{{ isOffline ? '离线' : '在线' }}</li>
        </ul>
      </section>

      <footer class="about-footer">
        <p class="about-footer__line">本 App 不提供任何影视片源</p>
        <p class="about-footer__line">© 2026 {{ APP_NAME }}</p>
      </footer>
    </div>

    <BottomSheet v-model="licensesOpen" title="开源许可">
      <ul class="license-list">
        <li><span>Vue</span><span>MIT</span></li>
        <li><span>Vue Router</span><span>MIT</span></li>
        <li><span>Pinia</span><span>MIT</span></li>
        <li><span>hls.js</span><span>Apache-2.0</span></li>
        <li><span>Capacitor</span><span>MIT</span></li>
        <li><span>idb</span><span>ISC</span></li>
      </ul>
      <p class="license-note">以上依赖均以许可证允许的方式使用；本 App 不包含第三方图标库。</p>
    </BottomSheet>

    <BottomSheet v-model="castOpen" title="投屏能力说明">
      <p class="cast-text">
        投屏使用 Android 系统选择器（Intent.ACTION_SEND），把当前播放地址或已下载文件交给系统中的投屏/播放应用。
      </p>
      <ul class="cast-list">
        <li>不支持 App 内 DLNA 设备发现与遥控（二期）。</li>
        <li>部分视频 App 仅支持接收 URL，受版权保护的内容可能拒绝播放。</li>
        <li>浏览器环境通常不支持系统投屏，会提示「当前平台不支持」。</li>
      </ul>
    </BottomSheet>

    <BottomSheet v-model="updateSheetOpen" title="检查更新">
      <div class="update-sheet">
        <div v-if="updateChecking" class="update-sheet__loading">
          <LoadingSpinner :size="24" />
          <span>正在向 GitHub 检查更新…</span>
        </div>

        <div v-else-if="updateError" class="update-sheet__error" role="alert">
          <p>{{ updateError }}</p>
          <button
            v-if="updateInfo && !installPermissionAllowed"
            class="btn btn--primary"
            type="button"
            @click="onOpenInstallPermission"
          >
            允许安装未知应用
          </button>
          <button v-else class="btn btn--ghost" type="button" @click="onRetryUpdate">
            {{ downloadedUpdate ? '重试安装' : updateInfo ? '重试下载' : '重新检查' }}
          </button>
        </div>

        <template v-else-if="updateInfo">
          <div class="update-sheet__version">
            <span class="update-sheet__eyebrow">发现新版本</span>
            <strong>v{{ updateInfo.versionName }}</strong>
            <span>{{ updateSizeText }}</span>
          </div>
          <p v-if="updateInfo.notes" class="update-sheet__notes">{{ updateInfo.notes }}</p>

          <div v-if="updateDownloading || downloadedUpdate" class="update-sheet__progress">
            <div class="update-sheet__progress-label">
              <span>{{ updateDownloading ? '正在下载更新包' : '更新包已下载' }}</span>
              <span>{{ updateProgress }}%</span>
            </div>
            <progress :value="updateProgress" max="100" :aria-label="`更新下载进度 ${updateProgress}%`" />
          </div>

          <button
            v-if="!installPermissionAllowed"
            class="btn btn--primary update-sheet__action"
            type="button"
            @click="onOpenInstallPermission"
          >
            允许安装未知应用
          </button>
          <button
            v-else-if="!downloadedUpdate"
            class="btn btn--primary update-sheet__action"
            type="button"
            :disabled="updateDownloading"
            @click="onDownloadUpdate"
          >
            {{ updateDownloading ? '正在下载…' : '下载并安装' }}
          </button>
          <button
            v-else
            class="btn btn--primary update-sheet__action"
            type="button"
            @click="onInstallUpdate"
          >
            安装更新
          </button>
          <p class="update-sheet__hint">更新包经 SHA-256 与签名校验后交给系统安装器。</p>
        </template>
      </div>
    </BottomSheet>

    <!-- F3：NG 场记板彩蛋（连点版本号 5 次） -->
    <Teleport to="body">
      <div
        v-if="clapperOpen"
        class="clapper"
        :class="{ 'clapper--clack': clapperClack, 'clapper--reduced': clapperReduced }"
        role="presentation"
        @click="dismissClapper"
      >
        <div class="clapper__board">
          <div class="clapper__stick">
            <span class="clapper__stripes"></span>
          </div>
          <div class="clapper__slate">
            <div class="clapper__row">
              <span class="clapper__field">PROD</span>
              <span class="clapper__value">{{ APP_NAME }}</span>
            </div>
            <div class="clapper__row">
              <span class="clapper__field">SCENE</span>
              <span class="clapper__value">关于</span>
              <span class="clapper__field">TAKE</span>
              <span class="clapper__value">{{ APP_VERSION }}</span>
            </div>
            <div class="clapper__ng">NG! 再来一条</div>
          </div>
        </div>
        <p class="clapper__hint">轻触跳过</p>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.about-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  background-color: var(--color-bg-base);
}

.about-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4) var(--layout-page-padding-x) calc(var(--space-6) + var(--safe-bottom));
}

.about-hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) 0 var(--space-3);
  text-align: center;
}

.about-hero__logo {
  width: 72px;
  height: 72px;
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-3);
}

.about-hero__name {
  margin-top: var(--space-2);
  font: var(--text-title-1);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
}

.about-hero__version {
  min-height: 32px;
  padding: 0 var(--space-2);
  font: var(--text-label);
  color: var(--color-text-secondary);
}

.about-hero__build {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.about-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-5);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.about-card__title {
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.about-card__text {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.about-card--debug {
  border-style: dashed;
}

.about-debug {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.about-footer {
  margin-top: var(--space-7);
  text-align: center;
}

.about-footer__line {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.8;
}

.update-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.update-sheet__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-6) 0;
  color: var(--color-text-secondary);
  font: var(--text-label);
}

.update-sheet__version {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: var(--space-1) var(--space-3);
}

.update-sheet__eyebrow {
  grid-column: 1 / -1;
  font: var(--text-caption);
  color: var(--color-brand-text);
}

.update-sheet__version strong {
  font: var(--text-title-2);
  color: var(--color-text-primary);
}

.update-sheet__version > span:last-child {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.update-sheet__notes {
  font: var(--text-body);
  color: var(--color-text-secondary);
  line-height: 1.65;
  white-space: pre-line;
}

.update-sheet__progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.update-sheet__progress-label {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-secondary);
}

.update-sheet__progress progress {
  width: 100%;
  height: 8px;
  overflow: hidden;
  border: none;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-elevated);
  accent-color: var(--color-brand);
}

.update-sheet__progress progress::-webkit-progress-bar {
  border-radius: var(--radius-full);
  background-color: var(--color-bg-elevated);
}

.update-sheet__progress progress::-webkit-progress-value {
  border-radius: var(--radius-full);
  background-color: var(--color-brand);
  transition: width var(--duration-fast) var(--ease-standard);
}

.update-sheet__action {
  width: 100%;
  min-height: 44px;
}

.update-sheet__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.update-sheet__error {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-3);
  padding: var(--space-4);
  border-radius: var(--radius-lg);
  background-color: var(--color-danger-soft);
  color: var(--color-danger);
  font: var(--text-label);
  line-height: 1.6;
}

.update-sheet__error p {
  margin: 0;
}

.license-list {
  display: flex;
  flex-direction: column;
}

.license-list li {
  display: flex;
  justify-content: space-between;
  padding: var(--space-3) var(--space-2);
  border-bottom: 1px solid var(--color-divider);
  font: var(--text-label);
  color: var(--color-text-primary);
}

.license-list li span:last-child {
  color: var(--color-text-tertiary);
}

.license-note {
  padding-top: var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

.cast-text {
  font: var(--text-label);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.cast-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding-left: var(--space-4);
  list-style: disc;
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  line-height: 1.6;
}

/* ---------- F3：NG 场记板 ---------- */
.clapper {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-toast) + 10);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  background-color: rgba(3, 4, 7, 0.82);
  backdrop-filter: blur(3px);
  cursor: pointer;
  animation: clapper-in 180ms var(--ease-decelerate) both;
}

.clapper__board {
  position: relative;
  width: min(80vw, 300px);
  filter: drop-shadow(0 18px 40px rgba(0, 0, 0, 0.55));
}

.clapper--clack .clapper__board {
  animation: clapper-shake 320ms var(--ease-standard) 110ms both;
}

.clapper__stick {
  position: relative;
  height: 26px;
  border-radius: 6px 6px 0 0;
  background-color: #1b1d22;
  border: 1px solid rgba(255, 255, 255, 0.08);
  transform-origin: left bottom;
  transform: rotate(-24deg);
  overflow: hidden;
}

.clapper--clack .clapper__stick {
  animation: stick-snap 150ms cubic-bezier(0.3, 0.7, 0.4, 1) both;
}

.clapper__stripes,
.clapper__slate::before {
  background-image: repeating-linear-gradient(
    -55deg,
    var(--color-brand) 0 14px,
    #14161b 14px 28px
  );
}

.clapper__stripes {
  position: absolute;
  inset: 0;
}

.clapper__slate {
  position: relative;
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-radius: 0 0 10px 10px;
  background: linear-gradient(180deg, #23262d, #15171c);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-top: none;
  overflow: hidden;
}

.clapper__slate::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 12px;
  opacity: 0.9;
}

.clapper__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.clapper__field {
  font: var(--text-caption);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
}

.clapper__value {
  font: var(--text-label-strong);
  color: var(--color-text-primary);
}

.clapper__ng {
  margin-top: var(--space-4);
  text-align: center;
  font: var(--font-weight-semibold) 26px / 1.1 var(--font-family-base);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-danger);
  text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
  opacity: 0;
}

.clapper--clack .clapper__ng {
  animation: ng-stamp 240ms var(--ease-decelerate) 200ms both;
}

.clapper__hint {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

@keyframes clapper-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes stick-snap {
  0% {
    transform: rotate(-24deg);
  }
  60% {
    transform: rotate(3deg);
  }
  100% {
    transform: rotate(0);
  }
}

@keyframes clapper-shake {
  0%,
  100% {
    transform: translateX(0) rotate(0);
  }
  20% {
    transform: translateX(-5px) rotate(-1.1deg);
  }
  40% {
    transform: translateX(5px) rotate(1.1deg);
  }
  60% {
    transform: translateX(-3px) rotate(-0.6deg);
  }
  80% {
    transform: translateX(3px) rotate(0.6deg);
  }
}

@keyframes ng-stamp {
  0% {
    opacity: 0;
    transform: scale(1.5) rotate(-6deg);
  }
  60% {
    opacity: 1;
    transform: scale(0.94) rotate(-2deg);
  }
  100% {
    opacity: 1;
    transform: scale(1) rotate(-2deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .clapper,
  .clapper__board,
  .clapper__stick,
  .clapper__ng {
    animation: none !important;
  }
  .clapper__stick {
    transform: rotate(0);
  }
  .clapper__ng {
    opacity: 1;
    transform: rotate(-2deg);
  }
}
</style>
