<script setup lang="ts">
/**
 * 安全模式横幅：近期连续崩溃后原生会暂停爬虫源与原生播放器，
 * 过去 UI 无任何说明（表现为"全部资源不可用"）。这里给出原因与一键恢复出口。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import { useToast } from '@/composables/useToast';
import { onAppStateChange } from '@/native/appLifecycle';
import { Spider } from '@/native/spiderPlugin';
import { isNative } from '@/shared/platform';

const toast = useToast();
const active = ref(false);
const busy = ref(false);

let stopState: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function check(): Promise<void> {
  if (!isNative()) return;
  try {
    const result = await Spider.getSafeMode();
    active.value = result.active;
  } catch {
    /* 查询失败不展示横幅 */
  }
}

async function recover(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  try {
    await Spider.exitSafeMode();
    active.value = false;
    toast.success('已恢复，爬虫源重新可用');
  } catch {
    toast.error('恢复失败，请重启 App 重试');
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void check();
  stopState = onAppStateChange((state) => {
    if (state === 'active') void check();
  });
  // 设置页/源体检也可能解除安全模式，低频轮询同步横幅状态
  pollTimer = setInterval(() => void check(), 20_000);
});

onBeforeUnmount(() => {
  stopState?.();
  stopState = null;
  if (pollTimer !== null) clearInterval(pollTimer);
  pollTimer = null;
});
</script>

<template>
  <div v-if="active" class="safe-mode-banner" role="alert">
    <span class="safe-mode-banner__text">安全模式：近期连续崩溃，爬虫源已暂停保护</span>
    <button class="safe-mode-banner__btn" type="button" :disabled="busy" @click="recover">
      {{ busy ? '恢复中…' : '恢复' }}
    </button>
  </div>
</template>

<style scoped>
.safe-mode-banner {
  position: sticky;
  top: 0;
  z-index: var(--z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  min-height: 36px;
  padding: var(--space-1) var(--layout-page-padding-x);
  background-color: var(--color-warning-soft);
  color: var(--color-warning);
  font: var(--text-caption);
}

.safe-mode-banner__text {
  flex: 0 1 auto;
}

.safe-mode-banner__btn {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-full);
  border: var(--border-strong);
  background-color: var(--color-bg-surface);
  color: var(--color-text-primary);
  font: var(--text-button-sm);
}

.safe-mode-banner__btn:disabled {
  opacity: 0.6;
}
</style>