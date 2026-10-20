<script setup lang="ts">
/**
 * 404（页面蓝图 §17）
 *
 * 不做自动重定向（不猜测意图）；「返回上一页」在无历史时回首页。
 */
import { useRouter } from 'vue-router';

const router = useRouter();

function goHome(): void {
  void router.replace('/');
}

function goBack(): void {
  if (globalThis.history.length > 1) router.back();
  else void router.replace('/');
}
</script>

<template>
  <main class="not-found" data-route="not-found">
    <div class="not-found__content">
      <p class="not-found__code">404</p>
      <h1 class="not-found__title">页面不存在</h1>
      <p class="not-found__desc">链接可能已失效，或该内容已被移除。</p>
      <div class="not-found__actions">
        <button class="btn btn--primary btn--md" type="button" @click="goHome">返回首页</button>
        <button class="btn btn--ghost btn--md" type="button" @click="goBack">返回上一页</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.not-found {
  display: flex;
  flex-direction: column;
  justify-content: center;
  flex: 1 1 auto;
  min-height: 100%;
  padding: calc(var(--safe-top) + var(--space-7)) var(--layout-page-padding-x)
    calc(var(--safe-bottom) + var(--space-7));
  background-color: var(--color-bg-base);
}

.not-found__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  margin: auto;
  max-width: 320px;
  text-align: center;
}

.not-found__code {
  font: var(--text-display);
  font-family: var(--font-family-number);
  color: var(--color-brand-text);
}

.not-found__title {
  font: var(--text-body-strong);
  color: var(--color-text-secondary);
}

.not-found__desc {
  font: var(--text-caption);
  color: var(--color-text-tertiary);
}

.not-found__actions {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-5);
}
</style>
