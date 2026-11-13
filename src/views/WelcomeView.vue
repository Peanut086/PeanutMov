<script setup lang="ts">
/**
 * 欢迎页 / 首启合规门禁（页面蓝图 §1）
 *
 * - 未同意当前合规版本时，路由守卫会把所有业务页重定向到本页
 * - 「不同意」在 Web 下只 Toast 并停留（无跳过入口，AC-100）
 * - 读取设置失败不阻塞阅读：顶部提示 + 主按钮仍可点（重试写入）
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import logoUrl from '@/assets/logo.svg';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToast } from '@/composables/useToast';
import { useHaptic } from '@/composables/useHaptic';
import { prefersReducedMotion } from '@/composables/useSpring';
import { isNative } from '@/shared/platform';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';

/** F1：开灯放映只在首启播一次（跨重挂载守卫；合规通过后本就不会再回到欢迎页） */
let curtainPlayed = false;

const router = useRouter();
const settings = useSettingsStore();
const ui = useUiStore();
const toast = useToast();
const { haptic } = useHaptic();

const accepting = ref(false);
const loadError = ref<string | null>(null);
const checking = ref(true);

/** F1：幕布过渡状态 */
const showCurtain = ref(false);
const curtainOpen = ref(false);
const curtainLogoIn = ref(false);
const curtainReduced = ref(false);
let curtainResolve: (() => void) | null = null;
let curtainTimers: ReturnType<typeof setTimeout>[] = [];

function clearCurtainTimers(): void {
  curtainTimers.forEach(clearTimeout);
  curtainTimers = [];
}

/** 收尾（动画完成 / 轻触跳过 / 超时兜底共用）：幂等，只兑现一次 */
function finishCurtain(): void {
  if (!curtainResolve) return;
  clearCurtainTimers();
  const done = curtainResolve;
  curtainResolve = null;
  showCurtain.value = false;
  done();
}

/**
 * 同意合规后、跳转首页前播放一次「开灯放映」：
 * logo 300ms 淡入 → 幕布左右拉开 600ms（放映机光束低频闪烁 ≤2 次/秒）→ reveal 首页。
 * reduced-motion 仅保留 logo 淡入；全程可轻触跳过，2.5s 超时自动进入。
 */
function playCurtain(): Promise<void> {
  if (curtainPlayed) return Promise.resolve();
  curtainPlayed = true;
  const reduced = prefersReducedMotion();
  curtainReduced.value = reduced;
  curtainOpen.value = false;
  curtainLogoIn.value = false;
  showCurtain.value = true;
  haptic('light');
  return new Promise<void>((resolve) => {
    curtainResolve = resolve;
    curtainTimers.push(setTimeout(() => (curtainLogoIn.value = true), 30));
    if (reduced) {
      curtainTimers.push(setTimeout(finishCurtain, 360));
    } else {
      curtainTimers.push(
        setTimeout(() => {
          curtainOpen.value = true;
          haptic('medium');
        }, 520),
      );
      curtainTimers.push(setTimeout(finishCurtain, 1160));
    }
    // 兜底：任何异常都在 2.5s 内进入首页，绝不卡死首启
    curtainTimers.push(setTimeout(finishCurtain, 2500));
  });
}

onMounted(async () => {
  try {
    await settings.load();
    // 真实 settingsStore 不抛错，错误记录在 store.error（契约不同，调用方适配）
    if (settings.error) loadError.value = settings.error.message;
  } catch (e) {
    loadError.value = toErrorShape(e, 'E_DB').message;
  } finally {
    checking.value = false;
  }
});

async function accept(): Promise<void> {
  if (accepting.value) return;
  accepting.value = true;
  try {
    await settings.acceptCompliance();
    if (settings.error) throw new Error(settings.error.message);
    await playCurtain();
    await router.replace('/');
  } catch (e) {
    toast.error(`保存失败：${toErrorShape(e, 'E_DB').message}`);
  } finally {
    accepting.value = false;
  }
}

onBeforeUnmount(() => {
  clearCurtainTimers();
  const done = curtainResolve;
  curtainResolve = null;
  done?.();
});

async function decline(): Promise<void> {
  if (isNative()) {
    const ok = await ui.confirm({
      title: '退出 App？',
      message: '需同意合规声明后才能使用 PeanutMov。',
      confirmText: '退出',
      cancelText: '再看一下',
      danger: true,
    });
    if (ok) {
      // 原生退出：deviceService 由数据包提供；此处仅提示，避免越界引用
      toast.info('请从系统最近任务中关闭 App');
    }
    return;
  }
  toast.info('已取消，本 App 需同意后才能使用');
}
</script>

<template>
  <main class="welcome" data-route="welcome">
    <div class="welcome__scroll">
      <header class="welcome__head">
        <img class="welcome__logo" :src="logoUrl" alt="PeanutMov 标志" width="44" height="44" />
        <h1 class="welcome__title">PeanutMov</h1>
        <p class="welcome__slogan">把你拥有的影视内容<br />收进一个海报墙</p>
      </header>

      <ComplianceNotice
        v-if="loadError"
        :text="`无法读取合规状态（${loadError}）。你仍可阅读并同意，若保存失败请检查存储空间。`"
      />

      <section class="welcome__card" aria-labelledby="welcome-compliance-title">
        <h2 id="welcome-compliance-title" class="welcome__card-title">请先阅读并确认</h2>
        <ul class="welcome__list">
          <li>本 App 不内置、不提供、不分发任何影视片源，不提供破解、盗版聚合或 DRM 绕过能力。</li>
          <li>你添加的源与播放内容由你自行负责，仅可用于播放本人拥有版权或已获授权的内容。</li>
          <li>所有数据仅保存在本机，不上传服务器；无账号、无统计 SDK。</li>
          <li>内置演示内容为公开版权样片（Blender 开放影片），仅用于功能演示。</li>
        </ul>
        <RouterLink class="welcome__more" to="/legal/compliance">查看完整声明 →</RouterLink>
      </section>
    </div>

    <footer class="welcome__footer">
      <button
        class="btn btn--primary btn--lg"
        type="button"
        :disabled="accepting || checking"
        @click="accept"
      >
        <LoadingSpinner v-if="accepting" :size="16" />
        {{ accepting ? '正在保存…' : '我已阅读并同意' }}
      </button>
      <button class="btn btn--ghost btn--lg" type="button" :disabled="accepting" @click="decline">
        不同意，退出
      </button>
    </footer>

    <Teleport to="body">
      <div
        v-if="showCurtain"
        class="curtain"
        :class="{ 'curtain--open': curtainOpen, 'curtain--reduced': curtainReduced }"
        role="presentation"
        @click="finishCurtain"
      >
        <div class="curtain__beam" aria-hidden="true" />
        <div class="curtain__half curtain__half--left" aria-hidden="true" />
        <div class="curtain__half curtain__half--right" aria-hidden="true" />
        <div class="curtain__logo" :class="{ 'curtain__logo--in': curtainLogoIn }" aria-hidden="true">
          <img :src="logoUrl" alt="" width="72" height="72" />
          <span class="curtain__brand">PeanutMov</span>
        </div>
        <span class="curtain__hint">轻触跳过</span>
      </div>
    </Teleport>
  </main>
</template>

<style scoped>
.welcome {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  padding-top: calc(var(--safe-top) + var(--space-6));
  padding-bottom: calc(var(--safe-bottom) + var(--space-4));
  background-color: var(--color-bg-base);
}

.welcome__scroll {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 var(--layout-page-padding-x);
}

.welcome__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: var(--space-2);
}

.welcome__logo {
  width: 44px;
  height: 44px;
  border-radius: var(--radius-md);
}

.welcome__title {
  font: var(--text-display);
  letter-spacing: var(--letter-spacing-tight);
  color: var(--color-text-primary);
}

.welcome__slogan {
  font: var(--text-body);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.welcome__card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-6);
  border-radius: var(--radius-lg);
  background-color: var(--color-bg-surface);
  border: var(--border-default);
}

.welcome__card-title {
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.welcome__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-left: var(--space-4);
  list-style: disc;
  font: var(--text-body);
  color: var(--color-text-primary);
  line-height: 1.6;
}

.welcome__list li::marker {
  color: var(--color-brand);
}

.welcome__more {
  align-self: flex-start;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  font: var(--text-label);
  color: var(--color-brand-text);
}

.welcome__footer {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-4) var(--layout-page-padding-x) 0;
  background: linear-gradient(180deg, transparent 0%, var(--color-bg-base) 32%);
}

/* F1：开灯放映 —— 首启幕布过渡（Teleport 到 body，盖住一切） */
.curtain {
  position: fixed;
  inset: 0;
  z-index: calc(var(--z-toast) + 20);
  overflow: hidden;
  background-color: #050307;
  cursor: pointer;
}

/* 放映机光束：暖白锥形光，低频呼吸（700ms 周期 ≈ 1.4 次/秒，远低于闪烁红线） */
.curtain__beam {
  position: absolute;
  top: -12%;
  left: 50%;
  width: 150%;
  height: 125%;
  transform: translateX(-50%);
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(
    ellipse 60% 70% at 50% 0%,
    rgba(255, 240, 210, 0.28),
    rgba(255, 214, 140, 0.08) 42%,
    transparent 72%
  );
}

.curtain--open .curtain__beam {
  animation: curtain-beam 700ms var(--ease-standard) infinite;
}

@keyframes curtain-beam {
  0%,
  100% {
    opacity: 0.32;
  }
  50% {
    opacity: 0.7;
  }
}

/* 幕布：深酒红丝绒 + 竖向褶皱 + 顶部金色帷幔，左右各半屏 */
.curtain__half {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 50.5%;
  transition: transform 600ms var(--ease-decelerate);
  background-image:
    repeating-linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.34) 0 2px,
      rgba(255, 255, 255, 0.04) 8px,
      rgba(0, 0, 0, 0.34) 26px
    ),
    linear-gradient(90deg, #2c0a10 0%, #6e1622 48%, #43101a 100%);
  box-shadow: inset 0 0 80px rgba(0, 0, 0, 0.6);
}

.curtain__half::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 14px;
  background: linear-gradient(180deg, var(--color-brand-strong), var(--color-brand) 60%, #8a5606);
  opacity: 0.85;
}

.curtain__half--left {
  left: 0;
  transform: translateX(0);
  border-right: 1px solid rgba(0, 0, 0, 0.5);
}

.curtain__half--right {
  right: 0;
  transform: translateX(0);
  border-left: 1px solid rgba(0, 0, 0, 0.5);
  background-image:
    repeating-linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.34) 0 2px,
      rgba(255, 255, 255, 0.04) 8px,
      rgba(0, 0, 0, 0.34) 26px
    ),
    linear-gradient(270deg, #2c0a10 0%, #6e1622 48%, #43101a 100%);
}

.curtain--open .curtain__half--left {
  transform: translateX(-100%);
}

.curtain--open .curtain__half--right {
  transform: translateX(100%);
}

/* logo：投影在幕布上，300ms 淡入；幕布拉开时同步淡出 */
.curtain__logo {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms var(--ease-standard);
}

.curtain__logo--in {
  opacity: 1;
}

.curtain--open .curtain__logo {
  opacity: 0;
}

.curtain__logo img {
  width: 72px;
  height: 72px;
  border-radius: var(--radius-lg);
  filter: drop-shadow(0 6px 26px rgba(240, 168, 46, 0.55));
}

.curtain__brand {
  font: var(--text-title-2);
  letter-spacing: var(--letter-spacing-tight);
  color: #fff;
  text-shadow: 0 2px 18px rgba(0, 0, 0, 0.6);
}

.curtain__hint {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(var(--safe-bottom) + var(--space-6));
  text-align: center;
  font: var(--text-caption);
  color: rgba(255, 255, 255, 0.62);
  opacity: 0;
  pointer-events: none;
  transition: opacity 300ms var(--ease-standard) 220ms;
}

.curtain__logo--in ~ .curtain__hint {
  opacity: 1;
}

.curtain--open .curtain__hint {
  opacity: 0;
  transition-delay: 0ms;
}

/* reduced-motion：无幕布、无光束，仅 logo 淡入 */
.curtain--reduced {
  background-color: var(--color-bg-base);
}

.curtain--reduced .curtain__half,
.curtain--reduced .curtain__beam {
  display: none;
}

@media (prefers-reduced-motion: reduce) {
  .curtain__half {
    transition: none;
  }
  .curtain--open .curtain__beam {
    animation: none;
  }
}
</style>
