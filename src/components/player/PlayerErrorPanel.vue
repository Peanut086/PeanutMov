<script setup lang="ts">
/**
 * 播放错误面板（AC-59）
 *
 * 覆盖画面：错误标题（ERROR_MESSAGES）+ 可能原因 + 重试/切换线路/返回/复制错误信息。
 * `retryable === false` 时隐藏"重试"，保留"切换线路/返回"。
 * v1.8/CHG-26：新增「换源重播」（同名同年跨源手动兜底）与「源体检」（源疑似失效时跳源管理）。
 */
import { computed } from 'vue';

import type { AppErrorShape } from '@/types';
import { ERROR_MESSAGES } from '@/shared/errors';

const props = withDefaults(
  defineProps<{
    error: AppErrorShape | null;
    /** 是否可切换线路 */
    canSwitchLine?: boolean;
    /** v1.8/CHG-26：是否显示「换源重播」（同名同年跨源） */
    canSwitchSource?: boolean;
    /** v1.8/CHG-26：是否显示「源体检」入口（错误码指向源健康问题时为真） */
    canHealthCheck?: boolean;
    /** 复制错误信息回调 */
    copyText?: string;
  }>(),
  { canSwitchLine: true, canSwitchSource: false, canHealthCheck: false, copyText: '' },
);

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'switch-line'): void;
  (e: 'switch-source'): void;
  (e: 'health-check'): void;
  (e: 'back'): void;
  (e: 'copy'): void;
}>();

const title = computed(() => {
  if (!props.error) return '播放失败';
  return props.error.message || ERROR_MESSAGES[props.error.code];
});

const hint = computed(() => {
  switch (props.error?.code) {
    case 'E_NETWORK':
      return '可能原因：网络已断开或源站不可达。请检查网络，或切换线路。';
    case 'E_TIMEOUT':
      return '可能原因：源站响应超时。可重试，或切换其他线路。';
    case 'E_HTTP_403':
    case 'E_HTTP_401':
    case 'E_AUTH':
      return '可能原因：播放地址鉴权失效。可切换线路，或回到详情页重新解析。';
    case 'E_HTTP_404':
      return '可能原因：播放地址已失效。可切换线路，或重新进入本集。';
    case 'E_DECODE':
    case 'E_UNSUPPORTED_FORMAT':
    case 'E_DRM_PROTECTED':
      return '可能原因：当前编码或封装不受支持。请切换其他线路或清晰度。';
    case 'E_NO_PLAY_URL':
      return '可能原因：该集暂无可用地址。请在详情页切换线路后重试。';
    default:
      return '可能原因：播放过程中出现异常。可重试；若持续失败请返回详情页。';
  }
});

const showRetry = computed(() => props.error?.retryable !== false);
</script>

<template>
  <div class="player-error" role="alert">
    <div class="player-error__panel">
      <svg
        class="player-error__art"
        viewBox="0 0 96 96"
        fill="none"
        stroke="var(--color-danger)"
        stroke-opacity="0.85"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M48 22 82 74H14Z" />
        <path d="M48 40v16" />
        <circle cx="48" cy="64" r="1.4" fill="var(--color-danger)" stroke="none" />
      </svg>

      <h2 class="player-error__title">{{ title }}</h2>
      <p class="player-error__hint">{{ hint }}</p>
      <p v-if="error?.detail" class="player-error__detail">{{ error.detail }}</p>

      <div class="player-error__actions">
        <button
          v-if="showRetry"
          class="btn btn--primary btn--md"
          type="button"
          @click="emit('retry')"
        >
          重试
        </button>
        <button
          v-if="canSwitchLine"
          class="btn btn--secondary btn--md"
          type="button"
          @click="emit('switch-line')"
        >
          切换线路
        </button>
        <!-- v1.8/CHG-26：自动兜底只各试一次，手动换源让用户再推一把 -->
        <button
          v-if="canSwitchSource"
          class="btn btn--secondary btn--md"
          type="button"
          @click="emit('switch-source')"
        >
          换源重播
        </button>
        <button class="btn btn--ghost btn--md" type="button" @click="emit('back')">返回</button>
      </div>

      <!-- v1.8/CHG-26：错误码指向源健康问题时给去体检的路径 -->
      <button
        v-if="canHealthCheck"
        class="player-error__copy"
        type="button"
        @click="emit('health-check')"
      >
        去源体检
      </button>

      <button class="player-error__copy" type="button" @click="emit('copy')">
        复制错误信息
      </button>
    </div>
  </div>
</template>

<style scoped>
.player-error {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-4);
  background-color: rgba(0, 0, 0, 0.86);
}

.player-error__panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  width: min(88vw, 400px);
  padding: var(--space-5);
  border-radius: var(--radius-xl);
  background-color: var(--color-bg-elevated);
  border: var(--border-default);
  text-align: center;
}

.player-error__art {
  width: 64px;
  height: 64px;
  margin-bottom: var(--space-2);
}

.player-error__title {
  font: var(--text-title-3);
  color: var(--color-text-primary);
}

.player-error__hint {
  font: var(--text-caption);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.player-error__detail {
  max-width: 100%;
  font: var(--text-caption);
  color: var(--color-text-disabled);
  overflow-wrap: anywhere;
}

.player-error__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.player-error__copy {
  margin-top: var(--space-2);
  min-height: 44px;
  padding: 0 var(--space-3);
  font: var(--text-caption);
  color: var(--color-text-tertiary);
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
