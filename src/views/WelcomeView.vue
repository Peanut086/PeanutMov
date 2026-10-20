<script setup lang="ts">
/**
 * 欢迎页 / 首启合规门禁（页面蓝图 §1）
 *
 * - 未同意当前合规版本时，路由守卫会把所有业务页重定向到本页
 * - 「不同意」在 Web 下只 Toast 并停留（无跳过入口，AC-100）
 * - 读取设置失败不阻塞阅读：顶部提示 + 主按钮仍可点（重试写入）
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import logoUrl from '@/assets/logo.svg';
import ComplianceNotice from '@/components/common/ComplianceNotice.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import { useSettingsStore } from '@/stores/settingsStore';
import { useToast } from '@/composables/useToast';
import { isNative } from '@/shared/platform';
import { useUiStore } from '@/stores/uiStore';
import { toErrorShape } from '@/shared/errors';

const router = useRouter();
const settings = useSettingsStore();
const ui = useUiStore();
const toast = useToast();

const accepting = ref(false);
const loadError = ref<string | null>(null);
const checking = ref(true);

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
    await router.replace('/');
  } catch (e) {
    toast.error(`保存失败：${toErrorShape(e, 'E_DB').message}`);
  } finally {
    accepting.value = false;
  }
}

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
</style>
