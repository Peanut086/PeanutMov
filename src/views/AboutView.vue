<script setup lang="ts">
/**
 * 关于（页面蓝图 §15）
 *
 * LOGO + 版本 + 合规/开源许可/投屏说明/反馈；连点版本号 7 次展开调试信息。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { APP_NAME, APP_VERSION, DB_VERSION } from '@/shared/constants';
import { getPlatform } from '@/shared/platform';
import { formatDateStamp } from '@/shared/time';

import AppHeader from '@/components/layout/AppHeader.vue';
import BottomSheet from '@/components/common/BottomSheet.vue';
import SettingsGroup from '@/components/settings/SettingsGroup.vue';
import SettingsRow from '@/components/settings/SettingsRow.vue';
import logoUrl from '@/assets/logo.svg';
import { useToast } from '@/composables/useToast';
import { useOnlineStatus } from '@/composables/useOnlineStatus';

const router = useRouter();
const toast = useToast();
const { isOffline } = useOnlineStatus();

const taps = ref(0);
const tapTimer = ref<ReturnType<typeof setTimeout> | null>(null);
const debugVisible = ref(false);
const licensesOpen = ref(false);
const castOpen = ref(false);

const versionText = computed(() => (APP_VERSION === '未知版本' ? '未知版本' : `版本 ${APP_VERSION}`));
const buildText = computed(() => `构建日期 ${formatDateStamp(Date.parse('2026-10-20T00:00:00Z'))}`);

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

onMounted(() => {
  // 只读展示，无副作用
});

function onVersionTap(): void {
  if (tapTimer.value !== null) clearTimeout(tapTimer.value);
  taps.value += 1;
  tapTimer.value = setTimeout(() => {
    taps.value = 0;
    tapTimer.value = null;
  }, 1200);
  if (taps.value >= 7) {
    taps.value = 0;
    debugVisible.value = !debugVisible.value;
    toast.info(debugVisible.value ? '已展开调试信息' : '已收起调试信息');
  }
}

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
          <li>构建日期：{{ formatDateStamp(Date.parse('2026-10-20T00:00:00Z')) }}</li>
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
</style>
